/**
 * Shopify upload form backend (Cloudflare Worker).
 *
 *   POST /submit        multipart/form-data from the Shopify section
 *   GET  /file/<key>    signed download link for files stored in R2 (optional)
 *
 * Text fields + files are emailed to MAIL_TO via SendGrid. Files are attached to
 * the email while the total stays under ATTACH_LIMIT_MB; anything beyond that
 * is stored in R2 (if the FILES bucket is bound) and sent as a download link.
 */

// Any form field is accepted and emailed in form order (like FormSubmit).
// Names starting with "_" are control fields and are not shown. These known
// names get a nicer label; any other field name is used as its own label.
const LABELS = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  order_number: "Order number",
  topic: "Related",
  message: "Message",
};
const SKIP_FIELDS = new Set(["cf-turnstile-response", "g-recaptcha-response"]);
const MAX_FIELDS = 100;

const MAX_TEXT_LENGTH = 5000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }
    if (url.pathname.startsWith("/file/") && request.method === "GET") {
      return serveFile(url, env);
    }
    if (url.pathname !== "/submit" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    // A plain HTML <form> post (browser navigation) gets a redirect or an HTML
    // page back, like FormSubmit; fetch/XHR callers get JSON.
    const wantsHtml = (request.headers.get("accept") || "").includes("text/html");
    const ctx = {};
    let res;
    if (!cors) {
      res = json({ ok: false, error: "Origin not allowed" }, 403);
    } else {
      try {
        res = await handleSubmit(request, env, cors, ctx);
      } catch (err) {
        console.error(err && err.stack ? err.stack : err);
        res = json({ ok: false, error: "Server error, please try again later." }, 500, cors);
      }
    }
    return wantsHtml ? toHtmlResponse(res, ctx.next, env) : res;
  },
};

async function handleSubmit(request, env, cors, ctx = {}) {
  const cfg = config(env);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > cfg.maxTotal + 1024 * 1024) {
    return json({ ok: false, error: `Total upload must be under ${cfg.maxTotalMb} MB.` }, 413, cors);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "Invalid form submission." }, 400, cors);
  }

  ctx.next = String(form.get("_next") || "");

  // Honeypot: real users never fill this hidden field. Pretend success for bots.
  if (String(form.get("_gotcha") || form.get("_honey") || "").trim() !== "") {
    return json({ ok: true }, 200, cors);
  }

  if (env.TURNSTILE_SECRET) {
    const passed = await verifyTurnstile(
      String(form.get("cf-turnstile-response") || ""),
      env.TURNSTILE_SECRET,
      request.headers.get("cf-connecting-ip")
    );
    if (!passed) {
      return json({ ok: false, error: "Verification failed, please refresh and try again." }, 400, cors);
    }
  }

  // ---- text fields (any name, in form order; repeated names are joined) ----
  const rows = new Map();
  const files = [];
  for (const [key, value] of form.entries()) {
    if (typeof value === "object" && value !== null) {
      if (value.size > 0) files.push(value);
      continue;
    }
    if (key.startsWith("_") || SKIP_FIELDS.has(key)) continue;
    const v = String(value).trim().slice(0, MAX_TEXT_LENGTH);
    if (!v) continue;
    const label = (LABELS[key] || key).slice(0, 100);
    rows.set(label, rows.has(label) ? `${rows.get(label)}, ${v}` : v);
    if (rows.size > MAX_FIELDS) {
      return json({ ok: false, error: "Too many fields." }, 400, cors);
    }
  }
  const lower = (k) => String(form.get(k) || form.get(k.toLowerCase()) || "").trim();
  const replyEmail = lower("Email");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail)) {
    return json({ ok: false, error: "Please enter a valid email address." }, 400, cors);
  }
  const displayName = (lower("Name") || [lower("First Name"), lower("Last Name")].filter(Boolean).join(" ")).slice(0, 100);
  const orderNo = lower("order_number");

  // ---- files ----
  if (files.length > cfg.maxFiles) {
    return json({ ok: false, error: `You can upload at most ${cfg.maxFiles} files.` }, 400, cors);
  }
  if (cfg.requireFile && files.length === 0) {
    return json({ ok: false, error: "Please attach at least one file." }, 400, cors);
  }
  let total = 0;
  for (const f of files) {
    if (!isAllowedType(f.name, cfg.allowedExt)) {
      return json({ ok: false, error: `File type not allowed: ${f.name}` }, 400, cors);
    }
    if (f.size > cfg.maxFile) {
      return json({ ok: false, error: `${f.name} is larger than ${cfg.maxFileMb} MB.` }, 400, cors);
    }
    total += f.size;
  }
  if (total > cfg.maxTotal) {
    return json({ ok: false, error: `Total upload must be under ${cfg.maxTotalMb} MB.` }, 400, cors);
  }

  // Attach while under the email limit; the rest goes to R2 as links.
  const attachments = [];
  const links = [];
  let attachedBytes = 0;
  const submissionId = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}`;
  for (const f of files) {
    const filename = safeFilename(f.name);
    if (attachedBytes + f.size <= cfg.attachLimit) {
      attachments.push({ filename, content: toBase64(await f.arrayBuffer()) });
      attachedBytes += f.size;
    } else if (env.FILES) {
      const key = `${submissionId}/${filename}`;
      await env.FILES.put(key, await f.arrayBuffer(), {
        httpMetadata: { contentType: f.type || "application/octet-stream" },
      });
      links.push({ filename, size: f.size, url: await signedUrl(env, cfg, key) });
    } else {
      return json(
        { ok: false, error: `Total upload must be under ${cfg.attachLimitMb} MB.` },
        400,
        cors
      );
    }
  }

  // ---- email ----
  const subjectBits = [displayName, orderNo && `#${orderNo}`].filter(Boolean);
  const subjectBase = String(form.get("_subject") || env.SUBJECT_PREFIX || "New upload")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  const email = {
    personalizations: [
      { to: env.MAIL_TO.split(",").map((s) => s.trim()).filter(Boolean).map((e) => ({ email: e })) },
    ],
    from: parseAddress(env.MAIL_FROM),
    reply_to: displayName ? { email: replyEmail, name: displayName } : { email: replyEmail },
    subject: subjectBits.length ? `${subjectBase}: ${subjectBits.join(" ")}` : subjectBase,
    content: [
      { type: "text/plain", value: renderText(rows, files, attachments.length, links) },
      { type: "text/html", value: renderHtml(subjectBase, rows, files, attachments.length, links) },
    ],
  };
  if (attachments.length) {
    email.attachments = attachments.map((a) => ({ ...a, disposition: "attachment" }));
  }

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(email),
  });
  if (!res.ok) {
    console.error("SendGrid error", res.status, await res.text());
    return json({ ok: false, error: "Could not send your submission, please try again later." }, 502, cors);
  }

  return json({ ok: true }, 200, cors);
}

// ---------------------------------------------------------------- HTML form posts

async function toHtmlResponse(res, next, env) {
  const body = await res.json().catch(() => ({}));
  if (body.ok) {
    if (isSafeRedirect(next, env)) {
      return new Response(null, { status: 303, headers: { Location: next } });
    }
    return htmlPage("Thank you!", "We received your submission and will reply by email soon.", 200);
  }
  return htmlPage(
    "Submission not sent",
    `${escapeHtml(body.error || "Something went wrong.")}<br><br><a href="javascript:history.back()">&larr; Go back and try again</a>`,
    res.status
  );
}

function isSafeRedirect(next, env) {
  try {
    const u = new URL(next);
    return allowedOrigins(env).includes(u.origin);
  } catch {
    return false;
  }
}

function htmlPage(title, message, status) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;text-align:center;color:#222">` +
      `<h1 style="font-size:24px">${title}</h1><p style="line-height:1.6">${message}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// ---------------------------------------------------------------- config

function config(env) {
  const mb = (v, d) => Number(v || d);
  const maxFileMb = mb(env.MAX_FILE_MB, 20);
  const maxTotalMb = mb(env.MAX_TOTAL_MB, 50);
  // SendGrid caps a whole message at 30 MB *after* base64 (+33%), so ~20 MB raw is a safe ceiling.
  const attachLimitMb = Math.min(mb(env.ATTACH_LIMIT_MB, 20), 20);
  return {
    maxFileMb,
    maxTotalMb,
    attachLimitMb,
    maxFile: maxFileMb * 1024 * 1024,
    maxTotal: maxTotalMb * 1024 * 1024,
    attachLimit: attachLimitMb * 1024 * 1024,
    maxFiles: Number(env.MAX_FILES || 10),
    requireFile: String(env.REQUIRE_FILE || "false") === "true",
    allowedExt: String(env.ALLOWED_EXTENSIONS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean),
    linkDays: Number(env.LINK_EXPIRES_DAYS || 30),
  };
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  if (!allowedOrigins(env).includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// ---------------------------------------------------------------- helpers

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

// "Upload Form <forms@shop.com>" -> { name, email }
function parseAddress(s) {
  const m = String(s || "").match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? (m[1] ? { name: m[1], email: m[2].trim() } : { email: m[2].trim() }) : { email: String(s).trim() };
}

function isAllowedType(name, allowedExt) {
  if (!allowedExt.length) return true;
  const ext = (name.split(".").pop() || "").toLowerCase();
  return name.includes(".") && allowedExt.includes(ext);
}

function safeFilename(name) {
  const cleaned = String(name || "file")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .slice(-150);
  return cleaned || "file";
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function renderHtml(title, rows, files, attachedCount, links) {
  const rowsHtml = [...rows]
    .map(
      ([label, v]) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#666;vertical-align:top">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;white-space:pre-wrap">${escapeHtml(v.replace(/^\n+/, ""))}</td></tr>`
    )
    .join("");
  let filesHtml = "";
  if (files.length) {
    const attached = files.slice(0, attachedCount).map((f) => `<li>${escapeHtml(safeFilename(f.name))} (${formatSize(f.size)}) — attached</li>`);
    const linked = links.map((l) => `<li><a href="${escapeHtml(l.url)}">${escapeHtml(l.filename)}</a> (${formatSize(l.size)}) — download link</li>`);
    filesHtml = `<h3 style="margin:20px 0 8px">Files (${files.length})</h3><ul>${attached.concat(linked).join("")}</ul>`;
  }
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
<h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
<table style="border-collapse:collapse">${rowsHtml}</table>${filesHtml}
<p style="color:#999;font-size:12px;margin-top:24px">Reply to this email to answer the customer directly.</p></div>`;
}

function renderText(rows, files, attachedCount, links) {
  const lines = [...rows].map(([label, v]) => `${label}: ${v}`);
  if (files.length) {
    lines.push("", `Files (${files.length}):`);
    files.slice(0, attachedCount).forEach((f) => lines.push(`- ${safeFilename(f.name)} (attached)`));
    links.forEach((l) => lines.push(`- ${l.filename}: ${l.url}`));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- Turnstile

async function verifyTurnstile(token, secret, ip) {
  if (!token) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

// ---------------------------------------------------------------- R2 signed links

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signedUrl(env, cfg, key) {
  if (!env.LINK_SECRET) throw new Error("LINK_SECRET must be set when the FILES bucket is bound");
  const exp = Math.floor(Date.now() / 1000) + cfg.linkDays * 86400;
  const sig = await hmac(env.LINK_SECRET, `${key}:${exp}`);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${env.PUBLIC_URL.replace(/\/$/, "")}/file/${encodedKey}?exp=${exp}&sig=${sig}`;
}

async function serveFile(url, env) {
  if (!env.FILES || !env.LINK_SECRET) return new Response("Not found", { status: 404 });
  const key = url.pathname.slice("/file/".length).split("/").map(decodeURIComponent).join("/");
  const exp = Number(url.searchParams.get("exp") || 0);
  const sig = url.searchParams.get("sig") || "";
  if (!exp || exp < Date.now() / 1000) return new Response("Link expired", { status: 410 });
  const expected = await hmac(env.LINK_SECRET, `${key}:${exp}`);
  if (!timingSafeEqual(sig, expected)) return new Response("Forbidden", { status: 403 });

  const obj = await env.FILES.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const filename = key.split("/").pop();
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
