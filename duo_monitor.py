#!/usr/bin/env python3
"""iPhone Duo 库存监控：轮询 Apple Store 门店取货接口，有货时通过 Bark 推送。

用法:
    python3 duo_monitor.py                 # 按 config.json 持续监控
    python3 duo_monitor.py --once          # 只查一次并打印结果
    python3 duo_monitor.py --discover      # 从官网购买页抓取所有型号的 part number
    python3 duo_monitor.py --test-bark     # 发一条测试推送
只依赖 Python 3.8+ 标准库。
"""

import argparse
import http.cookiejar
import json
import os
import random
import shutil
import subprocess
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "config.json"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


# 共用 Cookie：先访问购买页拿到 Apple 下发的 Cookie，库存接口才不容易返回 541
_cookies = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cookies))


def log(msg):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def http_get(url, referer=None, timeout=15):
    headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/html, */*",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    }
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with _opener.open(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def first_run_setup(path):
    """没有配置文件时，问一下 Bark Key，按默认设置（美国 91748、MK1L4LL/A）生成 config.json。"""
    print("第一次运行，先做一下设置。")
    raw = input("粘贴你的 Bark Key（或 Bark App 里那整段 https://api.day.app/... 链接）：").strip()
    m = re.search(r"api\.day\.app/([A-Za-z0-9]+)", raw)
    key = m.group(1) if m else raw.strip("/ ")
    cfg = {
        "bark": {"key": key},
        "store_host": "https://www.apple.com",
        "product_path": "/shop/buy-iphone/iphone-duo",
        "location": "91748,90401,91355,93003,92562,92101,92260",
        "stores": [],
        "parts": {"MK1L4LL/A": ""},
        "interval_seconds": 60,
    }
    Path(path).write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已保存到 {path}，以后想改邮编或型号就编辑这个文件。")
    return key


def load_config(path, require_parts=True):
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("store_host", "https://www.apple.com.cn")
    cfg.setdefault("product_path", "/shop/buy-iphone/iphone-duo")
    cfg.setdefault("interval_seconds", 60)
    cfg.setdefault("stores", [])
    cfg.setdefault("bark", {})
    cfg["bark"].setdefault("server", "https://api.day.app")
    cfg["bark"].setdefault("group", "iPhone Duo")
    cfg["bark"].setdefault("level", "timeSensitive")
    cfg["bark"].setdefault("sound", "alarm")
    # 云端运行时 Key 放在 GitHub Secrets 里，通过环境变量传入，不写进仓库
    if os.environ.get("BARK_KEY"):
        cfg["bark"]["key"] = os.environ["BARK_KEY"]
    if not cfg.get("parts") and not require_parts:
        cfg["parts"] = {}
    elif not cfg.get("parts"):
        sys.exit("config.json 里 parts 为空，先运行 --discover 找到 part number 再填进去")
    if isinstance(cfg["parts"], list):
        cfg["parts"] = {p: "" for p in cfg["parts"]}
    return cfg


# ---------------------------------------------------------------- Bark

def bark_push(cfg, title, body, url=None):
    bark = cfg["bark"]
    if not bark.get("key"):
        log("未配置 bark.key，跳过推送")
        return False
    payload = {
        "device_key": bark["key"],
        "title": title,
        "body": body,
        "group": bark["group"],
        "level": bark["level"],
        "sound": bark["sound"],
    }
    if url:
        payload["url"] = url
    req = urllib.request.Request(
        bark["server"].rstrip("/") + "/push",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        ok = result.get("code") == 200
        if not ok:
            log(f"Bark 返回异常: {result}")
        return ok
    except (urllib.error.URLError, ValueError) as e:
        log(f"Bark 推送失败: {e}")
        return False


# ---------------------------------------------------------------- Apple

def discover_parts(cfg):
    """从购买页内嵌的 JSON 中抓出 part number 及其颜色/容量。"""
    url = cfg["store_host"] + cfg["product_path"]
    html = http_get(url)
    found = {}
    # 购买页的产品数据里每个 SKU 都是一个包含 partNumber 的扁平对象
    for obj in re.finditer(r'\{[^{}]*"partNumber"\s*:\s*"([A-Z0-9]+/[A-Z])"[^{}]*\}', html):
        part = obj.group(1)
        blob = obj.group(0)
        attrs = dict(re.findall(r'"(dimension\w+)"\s*:\s*"([^"]*)"', blob))
        found[part] = " ".join(v for k, v in sorted(attrs.items()) if v)
    if not found:
        for part in set(re.findall(r'"(M[A-Z0-9]{3,4}[A-Z]{1,2}/A)"', html)):
            found[part] = ""
    return found


def query_availability(cfg):
    """返回 {(part, storeNumber): info}，info 含 available/门店名/型号名/提示文本。"""
    # 美国站新接口 fulfillment-messages 会返回 541/404，旧接口 retail/pickup-message 实测可用
    params = {"pl": "true"}
    for i, part in enumerate(cfg["parts"]):
        params[f"parts.{i}"] = part
    # Apple 每次只返回离 location 最近的十几家店；填多个邮编（逗号分隔）可以覆盖更大范围
    loc = cfg.get("location") or ""
    locations = loc if isinstance(loc, list) else re.split(r"[,，;；]", loc)
    locations = [l.strip() for l in locations if str(l).strip()]
    queries = [{"location": l} for l in locations] or [{"store": s} for s in cfg["stores"][:1]]
    if not _cookies:
        http_get(cfg["store_host"] + cfg["product_path"])  # 先拿 Cookie

    stores_by_num = {}
    for i, extra in enumerate(queries):
        if i:
            time.sleep(1)
        url = cfg["store_host"] + "/shop/retail/pickup-message?" + urllib.parse.urlencode({**params, **extra})
        data = json.loads(http_get(url, referer=cfg["store_host"] + cfg["product_path"]))
        body = data.get("body", {})
        for st in body.get("stores") or body.get("content", {}).get("pickupMessage", {}).get("stores", []):
            stores_by_num.setdefault(st.get("storeNumber"), st)
    stores = list(stores_by_num.values())
    wanted_stores = set(cfg["stores"])
    result = {}
    for store in stores:
        num = store.get("storeNumber")
        if wanted_stores and num not in wanted_stores:
            continue
        for part, pa in (store.get("partsAvailability") or {}).items():
            title = cfg["parts"].get(part) or (
                pa.get("messageTypes", {}).get("regular", {}).get("storePickupProductTitle")
                or pa.get("storePickupProductTitle")
                or part
            )
            result[(part, num)] = {
                "available": pa.get("pickupDisplay") == "available",
                "store": store.get("storeName", num),
                "title": title,
                "quote": pa.get("pickupSearchQuote") or pa.get("storePickupQuote", ""),
            }
    return result


# ---------------------------------------------------------------- 诊断

BROWSER_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "x-aos-ui-fetch-call-1": "x",
    "x-skip-redirect": "true",
}


def diagnose(cfg):
    """用几种请求方式各试一次库存接口，打印哪种能拿到数据。"""
    host, page = cfg["store_host"], cfg["store_host"] + cfg["product_path"]
    part = next(iter(cfg["parts"]))
    loc = urllib.parse.quote(cfg.get("location") or "")
    pq = urllib.parse.quote(part)
    urls = {
        "A 现在的参数": f"{host}/shop/fulfillment-messages?fae=true&pl=true&mts.0=regular&mts.1=compact&parts.0={pq}&location={loc}",
        "B 精简参数": f"{host}/shop/fulfillment-messages?pl=true&mts.0=regular&parts.0={pq}&location={loc}",
        "C searchNearby": f"{host}/shop/fulfillment-messages?searchNearby=true&parts.0={pq}&location={loc}",
        "D 旧接口": f"{host}/shop/retail/pickup-message?pl=true&parts.0={pq}&location={loc}",
    }

    def py_get(url, extra):
        jar = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        try:
            jar.open(urllib.request.Request(page, headers={"User-Agent": UA}), timeout=15).read()
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": page, **extra})
            with jar.open(req, timeout=15) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception as e:
            return "ERR", str(e)

    curl = shutil.which("curl")

    def curl_get(url):
        cookie = str(HERE / ".diag_cookies.txt")
        base = [curl, "-sS", "-m", "15", "-c", cookie, "-b", cookie, "-A", UA]
        try:
            subprocess.run(base + ["-o", os.devnull, page], capture_output=True, timeout=20)
            hdrs = sum((["-H", f"{k}: {v}"] for k, v in BROWSER_HEADERS.items()), [])
            out = subprocess.run(
                base + hdrs + ["-e", page, "-w", "\n%{http_code}", url],
                capture_output=True, timeout=20,
            ).stdout.decode("utf-8", "replace")
            body, _, code = out.rpartition("\n")
            return code, body
        except Exception as e:
            return "ERR", str(e)

    print(f"诊断型号 {part}，位置 {cfg.get('location')}")
    for name, url in urls.items():
        clients = [("Python", lambda u=url: py_get(u, {})),
                   ("Python+浏览器头", lambda u=url: py_get(u, BROWSER_HEADERS))]
        if curl:
            clients.append(("curl", lambda u=url: curl_get(u)))
        for cname, fn in clients:
            code, body = fn()
            ok = "✅" if str(code) == "200" and "{" in body[:5] else "❌"
            snippet = " ".join(body[:100].split())
            print(f"{ok} {name} | {cname} | HTTP {code} | {snippet}")
            time.sleep(1)
    try:
        os.remove(HERE / ".diag_cookies.txt")
    except OSError:
        pass
    print("诊断完成，请把上面的结果截图发回来。")


# ---------------------------------------------------------------- main loop

def check_once(cfg, last_state, notify=True):
    avail = query_availability(cfg)
    if not avail:
        log("接口没有返回门店数据（location/stores 可能填错，或 part number 不对）")
        return
    if not last_state:  # 第一次查询把每家门店的状态都列出来
        for info in sorted(avail.values(), key=lambda i: i["store"]):
            log(f"  {'✅' if info['available'] else '❌'} {info['store']} | {info['title']} | {info['quote']}")
    hits = []
    for key, info in sorted(avail.items()):
        was = last_state.get(key, False)
        last_state[key] = info["available"]
        if info["available"] and not was:
            hits.append(info)
    in_stock = sum(1 for i in avail.values() if i["available"])
    log(f"查询 {len(avail)} 个 门店×型号，有货 {in_stock} 个，新到货 {len(hits)} 个")
    for info in hits:
        log(f"  ✅ {info['store']} | {info['title']} | {info['quote']}")
    if hits and notify:
        lines = [f"{i['store']}：{i['title']}" for i in hits[:8]]
        if len(hits) > 8:
            lines.append(f"……共 {len(hits)} 条")
        bark_push(
            cfg,
            "iPhone Duo 有货了！",
            "\n".join(lines),
            url=cfg["store_host"] + cfg["product_path"],
        )


def main():
    ap = argparse.ArgumentParser(description="iPhone Duo 库存监控 + Bark 推送")
    ap.add_argument("-c", "--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--once", action="store_true", help="只查一次，打印全部结果")
    ap.add_argument("--discover", action="store_true", help="列出购买页里的 part number")
    ap.add_argument("--test-bark", action="store_true", help="发送测试推送")
    ap.add_argument("--diagnose", action="store_true", help="用几种方式试库存接口，排查 HTTP 541")
    ap.add_argument("--state", help="单次检查并推送新到货，状态存到该文件（给定时任务用）")
    args = ap.parse_args()

    if args.discover:
        with open(args.config, encoding="utf-8") as f:
            raw = json.load(f)
        raw.setdefault("store_host", "https://www.apple.com.cn")
        raw.setdefault("product_path", "/shop/buy-iphone/iphone-duo")
        parts = discover_parts(raw)
        if not parts:
            sys.exit("没在页面里找到 part number，可在官网选好配置后从网址/页面源码里手动复制")
        print(json.dumps(parts, ensure_ascii=False, indent=2))
        return

    if not Path(args.config).exists() and Path(args.config) == DEFAULT_CONFIG:
        first_run_setup(args.config)
        cfg = load_config(args.config)
        if bark_push(cfg, "iPhone Duo 监控", "测试推送：设置成功，开始监控 ✅"):
            log("测试推送已发送，手机应该收到通知了")
    else:
        cfg = load_config(args.config, require_parts=not (args.state or args.test_bark))

    if args.diagnose:
        diagnose(cfg)
        return

    if args.test_bark:
        ok = bark_push(cfg, "iPhone Duo 监控", "测试推送：Bark 配置正常 ✅")
        sys.exit(0 if ok else 1)

    if args.state:
        if not cfg["parts"]:
            log("parts 还是空的：先手动运行一次 discover，把型号填进配置文件")
            return
        state_path = Path(args.state)
        try:
            saved = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            saved = {}
        last_state = {tuple(k.split("|", 1)): v for k, v in saved.items()}
        check_once(cfg, last_state)
        state_path.write_text(
            json.dumps({"|".join(k): v for k, v in last_state.items()}, ensure_ascii=False),
            encoding="utf-8",
        )
        return

    if args.once:
        for key, info in sorted(query_availability(cfg).items()):
            mark = "✅" if info["available"] else "❌"
            print(f"{mark} {info['store']} | {info['title']} | {info['quote']}")
        return

    log(f"开始监控 {len(cfg['parts'])} 个型号，间隔约 {cfg['interval_seconds']} 秒")
    last_state = {}
    failures = 0
    while True:
        try:
            check_once(cfg, last_state)
            failures = 0
        except urllib.error.HTTPError as e:
            failures += 1
            log(f"HTTP {e.code}（可能被限流），第 {failures} 次失败")
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            failures += 1
            log(f"请求失败: {e}，第 {failures} 次失败")
        if failures == 10:
            bark_push(cfg, "iPhone Duo 监控异常", "连续 10 次查询失败，请检查网络或配置")
        # 失败时指数退避，最长 10 分钟；正常时加随机抖动避免固定频率
        base = cfg["interval_seconds"] * (2 ** min(failures, 4))
        time.sleep(min(base, 600) * random.uniform(0.8, 1.2))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("已退出")
