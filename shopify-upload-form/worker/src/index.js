/**
 * Shopify upload form backend (Cloudflare Worker).
 *
 *   POST /submit        multipart/form-data from the Shopify section
 *   GET  /file/<key>    signed download link for files stored in R2 (optional)
 *
 * Text fields + files are emailed to MAIL_TO via Resend. Files are attached to
 * the email while the total stays under ATTACH_LIMIT_MB; anything beyond that
 * is stored in R2 (if the FILES bucket is bound) and sent as a download link.
 */

const FIELDS = [
  // [form field name, label in the email, required]
  ["name", "Name", true],
  ["email", "Email", true],
  ["phone", "Phone", false],
  ["order_number", "Order number", false],
  ["message", "Message", false],
];

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
    if (!cors) {
      return json({ ok: false, error: "Origin not allowed" }, 403);
    }

    try {
      return await handleSubmit(request, env, cors);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      return json({ ok: false, error: "Server error, please try again later." }, 500, cors);
    }
  },
};

async function handleSubmit(request, env, cors) {
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

  // Honeypot: real users never fill this hidden field. Pretend success for bots.
  if (String(form.get("_gotcha") || "").trim() !== "") {
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

  // ---- text fields ----
  const values = {};
  for (const [key, label, required] of FIELDS) {
    const v = String(form.get(key) || "").trim().slice(0, MAX_TEXT_LENGTH);
    if (required && !v) {
      return json({ ok: false, error: `${label} is required.` }, 400, cors);
    }
    values[key] = v;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    return json({ ok: false, error: "Please enter a valid email address." }, 400, cors);
  }

  // ---- files ----
  const files = form.getAll("files").filter((f) => typeof f === "object" && f && f.size > 0);
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
  const subjectBits = [values.name, values.order_number && `#${values.order_number}`].filter(Boolean);
  const email = {
    from: env.MAIL_FROM,
    to: env.MAIL_TO.split(",").map((s) => s.trim()).filter(Boolean),
    reply_to: values.email,
    subject: `${env.SUBJECT_PREFIX || "New upload"}: ${subjectBits.join(" ")}`,
    html: renderHtml(values, files, attachments.length, links),
    text: renderText(values, files, attachments.length, links),
  };
  if (attachments.length) email.attachments = attachments;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(email),
  });
  if (!res.ok) {
    console.error("Resend error", res.status, await res.text());
    return json({ ok: false, error: "Could not send your submission, please try again later." }, 502, cors);
  }

  return json({ ok: true }, 200, cors);
}

// ---------------------------------------------------------------- config

function config(env) {
  const mb = (v, d) => Number(v || d);
  const maxFileMb = mb(env.MAX_FILE_MB, 20);
  const maxTotalMb = mb(env.MAX_TOTAL_MB, 50);
  // Resend caps an email at 40 MB *after* base64 (+33%), so ~28 MB raw is the ceiling.
  const attachLimitMb = Math.min(mb(env.ATTACH_LIMIT_MB, 25), 28);
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

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (!allowed.includes(origin)) return null;
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

function renderHtml(values, files, attachedCount, links) {
  const rows = FIELDS.filter(([k]) => values[k])
    .map(
      ([k, label]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${label}</td>` +
        `<td style="padding:6px 0;white-space:pre-wrap">${escapeHtml(values[k])}</td></tr>`
    )
    .join("");
  let filesHtml = "";
  if (files.length) {
    const attached = files.slice(0, attachedCount).map((f) => `<li>${escapeHtml(safeFilename(f.name))} (${formatSize(f.size)}) — attached</li>`);
    const linked = links.map((l) => `<li><a href="${escapeHtml(l.url)}">${escapeHtml(l.filename)}</a> (${formatSize(l.size)}) — download link</li>`);
    filesHtml = `<h3 style="margin:20px 0 8px">Files (${files.length})</h3><ul>${attached.concat(linked).join("")}</ul>`;
  }
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
<h2 style="margin:0 0 12px">New customer upload</h2>
<table style="border-collapse:collapse">${rows}</table>${filesHtml}
<p style="color:#999;font-size:12px;margin-top:24px">Reply to this email to answer the customer directly.</p></div>`;
}

function renderText(values, files, attachedCount, links) {
  const lines = FIELDS.filter(([k]) => values[k]).map(([k, label]) => `${label}: ${values[k]}`);
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
