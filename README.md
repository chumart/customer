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

## 云端运行：每天 5:00-6:00 每分钟查一次（GitHub Actions）

GitHub 每天凌晨 2-4 点（太平洋时间）提前启动任务，任务里等到 5:00 开始每分钟查一次，6:00 结束。
用的是 GitHub 的 IP，和家里电脑互不影响限流，两边可以同时跑。

只需要设置一次：仓库 → Settings → Secrets and variables → Actions → New repository secret，
名称 `BARK_KEY`，值填 Bark Key。型号和邮编在 `config.cloud.json` 里改。

手动测试：Actions → 「iPhone Duo 库存监控」→ Run workflow，选 `test-bark` 测推送，选 `once` 看当前库存。

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
| `interval_seconds` | 常规时段的轮询间隔，默认 120 秒；被 Apple 限流（HTTP 541）时会临时放慢，连续正常 30 次后恢复 |
| `schedule` | 分时段频率，按电脑本地时间。默认 `00:00-05:00` 每 3600 秒一次，5 点切回常规频率时 Bark 推送「监控运行中」 |
| `bark.level` | `timeSensitive` 能突破专注模式；改成 `critical` 静音时也会响 |
| `bark.server` | 自建 Bark 服务端时填写 |
| `store_host` | 美国 `https://www.apple.com`（示例配置的默认值）；国行 `https://www.apple.com.cn`；香港 `https://www.apple.com/hk-zh` |

## 行为

- 同一门店×型号只在「无货 → 有货」时推送一次，卖完后再到货会再推送。
- 请求失败时指数退避（最长 10 分钟）；连续 10 次失败会推送一条异常提醒。
