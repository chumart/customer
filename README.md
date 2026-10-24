# iPhone Duo 库存监控（Bark 推送）

轮询 Apple Store 官网的门店取货接口（`/shop/fulfillment-messages`），只要任意门店的任意关注型号从「无货」变成「可取货」，就通过 [Bark](https://github.com/Finb/Bark) 推送到 iPhone，点开通知会直接跳到购买页。

只依赖 Python 3.8+ 标准库，无需 `pip install`。

## 使用

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
| `interval_seconds` | 轮询间隔，建议不低于 30 秒，太频繁会被 Apple 限流（HTTP 541/403） |
| `bark.level` | `timeSensitive` 能突破专注模式；改成 `critical` 静音时也会响 |
| `bark.server` | 自建 Bark 服务端时填写 |
| `store_host` | 美国 `https://www.apple.com`（示例配置的默认值）；国行 `https://www.apple.com.cn`；香港 `https://www.apple.com/hk-zh` |

## 行为

- 同一门店×型号只在「无货 → 有货」时推送一次，卖完后再到货会再推送。
- 请求失败时指数退避（最长 10 分钟）；连续 10 次失败会推送一条异常提醒。
