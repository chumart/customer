# iPhone Duo 库存监控（Bark 推送）

轮询 Apple Store 官网的门店取货接口（`/shop/fulfillment-messages`），只要任意门店的任意关注型号从「无货」变成「可取货」，就通过 [Bark](https://github.com/Finb/Bark) 推送到 iPhone，点开通知会直接跳到购买页。

只依赖 Python 3.8+ 标准库，无需 `pip install`。

## 电脑上运行（最简单）

1. 装 Python：Mac 一般自带；Windows 到 python.org 下载，安装时勾选「Add Python to PATH」。
2. GitHub 页面点 **Code → Download ZIP**，解压。
3. 双击运行：Windows 用 `start-windows.bat`，Mac 用 `start-mac.command`（第一次可能要右键 → 打开）。
4. 第一次运行时粘贴 Bark Key，手机收到测试通知就开始监控了。默认查美国邮编 91748 附近门店的 MK1L4LL/A。

窗口要一直开着，电脑别休眠。以后要改邮编或型号，编辑自动生成的 `config.json`。

## iPhone 后台运行（Surge / Loon / Quantumult X / 小火箭）

见 [mobile/README.md](mobile/README.md)。

## 云端运行（GitHub Actions，不需要电脑，全程手机操作）

> ❌ **已停用**：实测 Apple 库存接口对 GitHub 服务器返回 HTTP 541（按 IP 拦截），而且 GitHub 定时任务实际约 2 小时才跑一次。
> 定时任务已关闭，请改用上面的手机后台版。下面的步骤仅作保留。

用 GitHub Actions 定时运行，所有操作都可以在手机浏览器里打开 github.com 完成：

1. **填 Bark Key**：仓库 → Settings → Secrets and variables → Actions → New repository secret，
   名称填 `BARK_KEY`，值填 Bark App 里的设备 Key。
2. **测试推送**：仓库 → Actions → 「iPhone Duo 库存监控」→ Run workflow，模式选 `test-bark`，手机应该能收到通知。
3. **查型号编号**：同样 Run workflow，模式选 `discover`，运行完点进日志就能看到所有 part number。
4. **填配置**：在网页上编辑 `config.cloud.json`，把想要的型号填进 `parts`，例如
   `"parts": {"MABC1LL/A": "256G 黑色 无锁版"}`，然后 commit。
   `location` 默认是邮编 91748，可以按需修改。
5. **确认结果**：Run workflow 选 `once`，在日志里查看附近每家门店的当前状态。

之后就会每 20 分钟自动检查一次，有新到货时推送。私有仓库每月免费额度只有 2000 分钟，每 20 分钟一次刚好用得完；
把仓库改成公开（Key 存在 Secrets 里，不会泄露）后不限额度，可以把 `.github/workflows/duo-monitor.yml`
里的 cron 改成 `*/5 * * * *`。不想监控了就在 Actions 页面点「Disable workflow」。

> 注意：Apple 有时会拦截来自数据中心 IP 的请求。如果日志里一直是 HTTP 403/541，说明 GitHub 的服务器被挡了，需要换别的运行方式。

## 在电脑上运行

1. 在 iPhone 上安装 Bark App，复制设备 Key（推送 URL `https://api.day.app/XXXX/` 里的 `XXXX`）。
2. `cp config.example.json config.json`，填 `bark.key`；示例默认查美国官网、邮编 91748 附近门店，在别处就改 `store_host` 和 `location`。
3. 找 part number：
   ```bash
   python3 duo_monitor.py --discover
   ```
   把想买的颜色/容量对应的 part number 填进 `parts`（`{"part": "备注名"}` 或直接写成列表都可以）。
   如果抓不到，就在官网选好配置，从页面源码里搜 `LL/A`（美版）或 `CH/A`（国行）手动复制。
   美版 iPhone 每个运营商（AT&T / T-Mobile / Verizon / 无锁版）的 part number 都不一样，门店库存也分开算，记得选你要的那个版本。
4. 验证：
   ```bash
   python3 duo_monitor.py --test-bark   # 手机应收到测试通知
   python3 duo_monitor.py --once        # 打印每个门店×型号的当前状态
   ```
5. 长期运行：`nohup python3 duo_monitor.py > monitor.log 2>&1 &`，或者放到 NAS / 服务器 / 软路由上跑。

## 配置说明

| 字段 | 说明 |
| --- | --- |
| `location` | 查询附近门店。美国填邮编，如 `"91748"`；国行填 `"上海 上海 黄浦区"` 这种格式 |
| `stores` | 只关注指定门店（如 `["R389"]`），留空表示 location 附近的所有门店；`--once` 的输出里能看到门店名 |
| `parts` | 要监控的型号 part number |
| `interval_seconds` | 常规时段的轮询间隔，默认 60 秒；被 Apple 限流（HTTP 541）时会临时放慢，连续正常 30 次后恢复 |
| `schedule` | 分时段频率，按电脑本地时间。默认 `00:00-05:00` 每 3600 秒一次，5 点切回常规频率时 Bark 推送「监控运行中」 |
| `bark.level` | `timeSensitive` 能突破专注模式；改成 `critical` 静音时也会响 |
| `bark.server` | 自建 Bark 服务端时填写 |
| `store_host` | 美国 `https://www.apple.com`（示例配置的默认值）；国行 `https://www.apple.com.cn`；香港 `https://www.apple.com/hk-zh` |

## 行为

- 同一门店×型号只在「无货 → 有货」时推送一次，卖完后再到货会再推送。
- 请求失败时指数退避（最长 10 分钟）；连续 10 次失败会推送一条异常提醒。
