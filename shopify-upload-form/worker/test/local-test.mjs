// Offline test of the Worker: mocks SendGrid and R2. Run: node test/local-test.mjs
import assert from "node:assert/strict";
import worker from "../src/index.js";

const sent = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes("api.sendgrid.com")) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "test" }), { status: 202 });
  }
  throw new Error("unexpected fetch " + url);
};

const r2 = new Map();
const FILES = {
  put: async (key, body, opts) => r2.set(key, { body: new Uint8Array(body), opts }),
  get: async (key) => (r2.has(key) ? { body: r2.get(key).body, httpMetadata: r2.get(key).opts.httpMetadata } : null),
};

const ORIGIN = "https://shop.example";
const baseEnv = {
  ALLOWED_ORIGINS: ORIGIN,
  MAIL_FROM: "Form <forms@shop.example>",
  MAIL_TO: "owner@shop.example",
  SENDGRID_API_KEY: "SG.test",
  ALLOWED_EXTENSIONS: "jpg,png,pdf",
  MAX_FILE_MB: "20",
  ATTACH_LIMIT_MB: "1",
  PUBLIC_URL: "https://worker.example",
  LINK_SECRET: "secret",
};

function submit(fields, files = [], env = baseEnv, origin = ORIGIN) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append("files", f);
  return worker.fetch(new Request("https://worker.example/submit", { method: "POST", body: fd, headers: { origin } }), env);
}
const file = (name, size) => new File([new Uint8Array(size).fill(65)], name);
const ok = { name: "Ann <b>", email: "ann@x.com", order_number: "1001", message: "hi" };

let res = await submit(ok, [file("a.jpg", 1000)]);
assert.equal(res.status, 200);
assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
assert.equal(sent.at(-1).reply_to.email, "ann@x.com");
assert.deepEqual(sent.at(-1).from, { name: "Form", email: "forms@shop.example" });
assert.deepEqual(sent.at(-1).personalizations[0].to, [{ email: "owner@shop.example" }]);
assert.equal(sent.at(-1).attachments[0].disposition, "attachment");
assert.equal(sent.at(-1).attachments[0].content, Buffer.alloc(1000, 65).toString("base64"));
assert.ok(sent.at(-1).content[1].value.includes("Ann &lt;b&gt;"), "html escaped");
assert.ok(sent.at(-1).subject.includes("#1001"));
console.log("✓ small file attached, html escaped");

res = await submit(ok, [file("a.jpg", 1000)], baseEnv, "https://evil.example");
assert.equal(res.status, 403);
console.log("✓ foreign origin rejected");

res = await submit(ok, [file("a.exe", 10)]);
assert.equal(res.status, 400);
console.log("✓ disallowed type rejected:", (await res.json()).error);

res = await submit({ ...ok, email: "nope" });
assert.equal(res.status, 400);
console.log("✓ bad email rejected");

const before = sent.length;
res = await submit({ ...ok, _gotcha: "bot" });
assert.equal(res.status, 200);
assert.equal(sent.length, before);
console.log("✓ honeypot silently dropped");

// 1 MB attach limit: first file attached, second goes to R2 as a link
res = await submit(ok, [file("small.png", 600_000), file("big.pdf", 900_000)], { ...baseEnv, FILES });
assert.equal(res.status, 200);
const mail = sent.at(-1);
assert.equal(mail.attachments.length, 1);
const link = mail.content[0].value.match(/https:\/\/worker\.example\/file\/\S+/)[0];
console.log("✓ overflow file stored in R2, link:", link.slice(0, 70) + "…");

res = await worker.fetch(new Request(link), { ...baseEnv, FILES });
assert.equal(res.status, 200);
assert.equal((await res.arrayBuffer()).byteLength, 900_000);
console.log("✓ signed link downloads");

res = await worker.fetch(new Request(link.replace(/sig=\w/, "sig=0")), { ...baseEnv, FILES });
assert.equal(res.status, 403);
console.log("✓ tampered link rejected");

res = await submit(ok, [file("small.png", 600_000), file("big.pdf", 900_000)]);
assert.equal(res.status, 400);
console.log("✓ over attach limit without R2 rejected");

// Request-a-quote style: arbitrary field names, _subject, checkbox, file under "attachment"
{
  const fd = new FormData();
  fd.append("_subject", "New Quote Request");
  fd.append("_honey", "");
  fd.append("_next", "https://x");
  fd.append("First Name", "Bob");
  fd.append("Last Name", "Lee");
  fd.append("Email", "bob@x.com");
  fd.append("Company Type", "Restaurant");
  fd.append("Requested Items", "\n1. PLM-54RS  x 2");
  fd.append("Notes: Tax-exempt organization", "Yes");
  fd.append("attachment", file("list.pdf", 2000));
  res = await worker.fetch(new Request("https://worker.example/submit", { method: "POST", body: fd, headers: { origin: ORIGIN } }), baseEnv);
  assert.equal(res.status, 200, await res.clone().text());
  const m = sent.at(-1);
  assert.equal(m.subject, "New Quote Request: Bob Lee");
  assert.equal(m.reply_to.email, "bob@x.com");
  assert.equal(m.attachments[0].filename, "list.pdf");
  const t = m.content[0].value;
  assert.ok(t.includes("Company Type: Restaurant") && t.includes("Notes: Tax-exempt organization: Yes") && !t.includes("_next"), t);
  console.log("✓ quote form: arbitrary fields, _subject, attachment field name");
}

// Plain HTML form post: redirect to _next on success, HTML error page otherwise
{
  const mk = (next, email) => { const fd = new FormData(); fd.append("_next", next); fd.append("Email", email); fd.append("First Name", "Z"); return fd; };
  const html = { origin: ORIGIN, accept: "text/html,application/xhtml+xml" };
  res = await worker.fetch(new Request("https://worker.example/submit", { method: "POST", body: mk(ORIGIN + "/pages/request-quote?submitted=1", "z@x.com"), headers: html }), baseEnv);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), ORIGIN + "/pages/request-quote?submitted=1");
  res = await worker.fetch(new Request("https://worker.example/submit", { method: "POST", body: mk("https://evil.example/", "z@x.com"), headers: html }), baseEnv);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("Thank you"));
  res = await worker.fetch(new Request("https://worker.example/submit", { method: "POST", body: mk(ORIGIN + "/", "bad"), headers: html }), baseEnv);
  assert.equal(res.status, 400);
  assert.ok((await res.text()).includes("valid email"));
  console.log("✓ HTML form post: safe redirect, no open redirect, HTML error page");
}

res = await worker.fetch(new Request("https://worker.example/submit", { method: "OPTIONS", headers: { origin: ORIGIN } }), baseEnv);
assert.equal(res.status, 204);
console.log("✓ CORS preflight\nall passed");
