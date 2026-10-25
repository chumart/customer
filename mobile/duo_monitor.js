/*
 * iPhone Duo 库存监控 —— iOS 后台定时脚本
 * 支持 Surge / Loon / Quantumult X / Shadowrocket（小火箭）/ Stash
 *
 * 定时查询附近 Apple Store 的门店取货库存，某门店某型号从「无货」变成「可取货」时
 * 通过 Bark 推送（同时发一条 App 本地通知）。
 *
 * 配置（按优先级）：
 *   1. 模块 / 插件参数（Surge、Loon、小火箭）：bark=KEY&parts=A,B&zip=91748&stores=R123
 *   2. 下面 CONFIG 里直接填写（Quantumult X 用本地脚本时用这种方式）
 *
 * parts 留空时进入「发现模式」：抓取购买页里所有型号编号，用通知发给你，复制想要的填回 parts。
 */

const CONFIG = {
  bark: "",                                  // Bark 设备 Key
  barkServer: "https://api.day.app",
  level: "timeSensitive",                    // timeSensitive 可突破专注模式；critical 静音也响
  host: "https://www.apple.com",             // 国行 https://www.apple.com.cn
  path: "/shop/buy-iphone/iphone-duo",
  // 美国填邮编，多个用逗号分隔可以查更大范围（Apple 每个邮编只返回最近的十几家店）
  zip: "91748",
  // 型号编号，逗号分隔。美版全部 8 个：MK1E4LL/A,MK1F4LL/A,MK1G4LL/A,MK1H4LL/A,MK1J4LL/A,MK1L4LL/A,MK1Q4LL/A,MK1R4LL/A
  parts: "MK1L4LL/A",
  stores: "",                                // 只关注这些门店（如 "R123,R456"），留空=附近全部
};

const STATE_KEY = "iphone_duo_monitor_state";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

// ---------------------------------------------------------------- 运行环境适配

const isQX = typeof $task !== "undefined";

function request(method, opts) {
  if (isQX) {
    return $task
      .fetch({ ...opts, method })
      .then((r) => ({ status: r.statusCode, body: r.body }));
  }
  return new Promise((resolve, reject) => {
    const fn = method === "POST" ? $httpClient.post : $httpClient.get;
    fn(opts, (err, resp, body) => {
      if (err) reject(new Error(String(err)));
      else resolve({ status: resp.status || resp.statusCode, body });
    });
  });
}

function storeRead(key) {
  return isQX ? $prefs.valueForKey(key) : $persistentStore.read(key);
}

function storeWrite(value, key) {
  return isQX ? $prefs.setValueForKey(value, key) : $persistentStore.write(value, key);
}

function localNotify(title, subtitle, body, url) {
  if (isQX) $notify(title, subtitle, body, url ? { "open-url": url } : undefined);
  else $notification.post(title, subtitle, body, url ? { url } : undefined);
}

function done() {
  if (typeof $done !== "undefined") $done();
}

// $argument 在不同 App 里可能是 "a=1&b=2" 字符串、对象或数组（Loon 插件）
function readArguments() {
  if (typeof $argument === "undefined" || $argument === null) return {};
  const arg = $argument;
  const order = ["bark", "parts", "zip", "stores"];
  if (Array.isArray(arg)) {
    const out = {};
    order.forEach((k, i) => (out[k] = arg[i]));
    return out;
  }
  if (typeof arg === "object") {
    const out = {};
    for (const [k, v] of Object.entries(arg)) out[k.toLowerCase().replace("bark_key", "bark")] = v;
    return out;
  }
  const out = {};
  for (const pair of String(arg).split("&")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

function loadConfig() {
  const cfg = { ...CONFIG };
  for (const [k, v] of Object.entries(readArguments())) {
    // 忽略空值和 Surge 未替换的占位符
    if (v !== undefined && v !== null && String(v).trim() !== "" && !/^\{+.*\}+$/.test(String(v))) {
      cfg[k] = String(v).trim();
    }
  }
  const list = (s) => String(s || "").split(/[,，\s]+/).filter(Boolean);
  cfg.parts = list(cfg.parts);
  cfg.stores = list(cfg.stores);
  return cfg;
}

// ---------------------------------------------------------------- Bark

async function barkPush(cfg, title, body, url) {
  if (!cfg.bark) return;
  const payload = { device_key: cfg.bark, title, body, group: "iPhone Duo", level: cfg.level, sound: "alarm" };
  if (url) payload.url = url;
  try {
    const r = await request("POST", {
      url: cfg.barkServer.replace(/\/+$/, "") + "/push",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (r.status !== 200) console.log(`Bark 返回 HTTP ${r.status}: ${r.body}`);
  } catch (e) {
    console.log(`Bark 推送失败: ${e.message}`);
  }
}

async function notifyAll(cfg, title, body, url) {
  localNotify(title, "", body, url);
  await barkPush(cfg, title, body, url);
}

// ---------------------------------------------------------------- Apple

async function discover(cfg) {
  const r = await request("GET", { url: cfg.host + cfg.path, headers: { "User-Agent": UA } });
  const html = r.body || "";
  const found = {};
  const re = /\{[^{}]*"partNumber"\s*:\s*"([A-Z0-9]+\/[A-Z])"[^{}]*\}/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = [];
    const are = /"(dimension\w+)"\s*:\s*"([^"]*)"/g;
    let a;
    while ((a = are.exec(m[0]))) if (a[2]) attrs.push([a[1], a[2]]);
    attrs.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    found[m[1]] = attrs.map((x) => x[1]).join(" ");
  }
  if (!Object.keys(found).length) {
    for (const p of html.match(/M[A-Z0-9]{3,4}[A-Z]{1,2}\/A/g) || []) found[p] = "";
  }
  return found;
}

async function queryAvailability(cfg) {
  // 美国站新接口 fulfillment-messages 会返回 541/404，旧接口 retail/pickup-message 实测可用
  const q = ["pl=true"];
  cfg.parts.forEach((p, i) => q.push(`parts.${i}=${encodeURIComponent(p)}`));
  const zips = String(cfg.zip || "").split(/[,，;；]/).map((z) => z.trim()).filter(Boolean);
  const queries = zips.length
    ? zips.map((z) => `location=${encodeURIComponent(z)}`)
    : cfg.stores.slice(0, 1).map((s) => `store=${encodeURIComponent(s)}`);

  const byNum = {};
  for (const extra of queries) {
    const r = await request("GET", {
      url: `${cfg.host}/shop/retail/pickup-message?${[...q, extra].join("&")}`,
      headers: { "User-Agent": UA, Referer: cfg.host + cfg.path, Accept: "application/json" },
    });
    if (r.status !== 200) throw new Error(`Apple 接口返回 HTTP ${r.status}`);
    const body = JSON.parse(r.body)?.body || {};
    for (const st of body.stores || body?.content?.pickupMessage?.stores || []) {
      if (!byNum[st.storeNumber]) byNum[st.storeNumber] = st;
    }
  }
  const stores = Object.values(byNum);
  const result = {};
  for (const store of stores) {
    if (cfg.stores.length && !cfg.stores.includes(store.storeNumber)) continue;
    for (const [part, pa] of Object.entries(store.partsAvailability || {})) {
      result[`${part}|${store.storeNumber}`] = {
        available: pa.pickupDisplay === "available",
        store: store.storeName || store.storeNumber,
        title: pa?.messageTypes?.regular?.storePickupProductTitle || pa.storePickupProductTitle || part,
        quote: pa.pickupSearchQuote || pa.storePickupQuote || "",
      };
    }
  }
  return result;
}

// ---------------------------------------------------------------- main

async function main() {
  const cfg = loadConfig();
  const buyUrl = cfg.host + cfg.path;

  if (!cfg.parts.length) {
    const found = await discover(cfg);
    const lines = Object.entries(found).map(([p, d]) => `${p} ${d}`);
    console.log("发现的型号编号：\n" + lines.join("\n"));
    if (lines.length) {
      await notifyAll(cfg, "iPhone Duo 型号编号（填到 parts 参数里）", lines.join("\n"));
    } else {
      localNotify("iPhone Duo 监控", "没找到型号编号", "请在官网页面源码里搜 LL/A 手动复制");
    }
    return;
  }

  let last = {};
  try {
    last = JSON.parse(storeRead(STATE_KEY) || "{}");
  } catch (e) {}

  const avail = await queryAvailability(cfg);
  const hits = [];
  const next = {};
  for (const [key, info] of Object.entries(avail)) {
    next[key] = info.available;
    if (info.available && !last[key]) hits.push(info);
  }
  storeWrite(JSON.stringify(next), STATE_KEY);

  const inStock = Object.values(avail).filter((i) => i.available).length;
  console.log(`查询 ${Object.keys(avail).length} 个 门店×型号，有货 ${inStock} 个，新到货 ${hits.length} 个`);
  for (const i of Object.values(avail)) {
    console.log(`${i.available ? "✅" : "❌"} ${i.store} | ${i.title} | ${i.quote}`);
  }

  if (hits.length) {
    const lines = hits.slice(0, 8).map((i) => `${i.store}：${i.title}`);
    if (hits.length > 8) lines.push(`……共 ${hits.length} 条`);
    await notifyAll(cfg, "iPhone Duo 有货了！", lines.join("\n"), buyUrl);
  }
}

main()
  .catch((e) => console.log(`iPhone Duo 监控出错: ${e.message}`))
  .finally(done);
