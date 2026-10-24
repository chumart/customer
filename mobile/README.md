# iPhone 后台版（Surge / Loon / Quantumult X / 小火箭）

脚本 `duo_monitor.js` 由代理 App 定时在后台运行（默认每 2 分钟一次），只要 App 的 VPN 开着就会一直监控，不需要电脑。
有新到货时，会发一条 App 本地通知，同时通过 Bark 推送，点开通知直接跳到购买页。

> ⚠️ 下面的远程链接需要仓库是**公开**的才能加载。仓库保持私有的话，请用每节里的「本地脚本」方式。

## Surge

1. 首页 → 模块 → 安装新模块，链接填
   `https://raw.githubusercontent.com/chumart/customer/master/mobile/iphone-duo.sgmodule`
2. 安装后点模块 → 参数：`BARK_KEY` 填你的 Key，`PARTS` 先留空。
3. 脚本 → 找到「iPhone Duo 库存」→ 手动运行一次，会收到一条列出所有型号编号的通知（也会推到 Bark）。
4. 把想要的编号填进 `PARTS`（多个用逗号隔开，美版注意选对运营商版本），之后就会自动监控。

## Loon

1. 配置 → 插件 → 添加，链接填
   `https://raw.githubusercontent.com/chumart/customer/master/mobile/iphone-duo.plugin`
2. 点插件进入参数设置：填 Bark Key，型号编号先留空，然后手动运行一次脚本拿到编号列表，再把编号填回去。

## Quantumult X

QX 不支持传参数，需要把配置直接写进脚本：

1. 把 `duo_monitor.js` 下载到 iCloud 云盘 → Quantumult X → Scripts 文件夹。
2. 编辑脚本开头的 `CONFIG`：填 `bark`；`parts` 先留空，运行一次拿到编号后再填进去。
3. 在配置文件 `[task_local]` 里加一行：
   ```
   */2 * * * * duo_monitor.js, tag=iPhone Duo 库存, enabled=true
   ```

## 小火箭 / Stash

小火箭用 Surge 的 `.sgmodule` 链接（配置 → 模块 → 添加）；如果参数界面不生效，可以像 QX 那样直接改脚本里的 `CONFIG`。

## 本地脚本（仓库私有时用）

Surge / Loon 也可以把 `duo_monitor.js` 放进 iCloud 里对应 App 的文件夹，然后在配置文件里直接写：

- Surge `[Script]`：
  `iPhone Duo 库存 = type=cron,cronexp="*/2 * * * *",timeout=30,wake-system=1,script-path=duo_monitor.js,argument=bark=你的Key&parts=编号1,编号2&zip=91748`
- Loon `[Script]`：
  `cron "*/2 * * * *" script-path=duo_monitor.js, timeout=30, tag=iPhone Duo 库存, argument=bark=你的Key&parts=编号1,编号2&zip=91748`

## 参数

| 参数 | 说明 |
| --- | --- |
| `bark` / `BARK_KEY` | Bark 设备 Key；不填的话只有 App 本地通知 |
| `parts` / `PARTS` | 型号编号，逗号分隔；**留空时进入发现模式**，把所有型号编号推送给你 |
| `zip` / `ZIP` | 美国邮编，默认 91748；国行改 `CONFIG.host` 为 `https://www.apple.com.cn`，zip 填 `上海 上海 黄浦区` |
| `stores` / `STORES` | 只看这些门店（如 `R123`），留空 = 附近全部；门店编号在脚本日志里能看到 |
