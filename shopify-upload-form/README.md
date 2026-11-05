# Shopify 客户上传表单（可带附件）

客户在 Shopify 页面上填表 + 上传文件 → Cloudflare Worker 接收 → 通过 Resend 发到你的邮箱。
文件是邮件附件；总大小超过 25MB 时（可选开启 R2）大文件改为下载链接。

```
shopify/sections/customer-upload-form.liquid   Shopify 主题 Section（表单页面）
worker/src/index.js                            Cloudflare Worker（接收、校验、发邮件）
worker/wrangler.toml                           Worker 配置（邮箱、域名、大小限制）
worker/test/local-test.mjs                     离线测试：node test/local-test.mjs
```

费用：Cloudflare Workers 免费版每天 10 万次请求；Resend 免费版每月 3000 封、每天 100 封。

---

## 第 1 步：Resend（发邮件）

1. 注册 https://resend.com
2. **Domains → Add Domain**，填你的店铺域名（如 `your-store.com`），按提示在域名 DNS 里添加几条记录，等状态变成 Verified。
3. **API Keys → Create API Key**，复制保存（`re_` 开头）。

## 第 2 步：部署 Worker

电脑上需要 Node.js 18+。

```bash
cd shopify-upload-form/worker
npx wrangler login                       # 浏览器里登录 Cloudflare
```

编辑 `wrangler.toml` 的 `[vars]`：

| 变量 | 填什么 |
|---|---|
| `ALLOWED_ORIGINS` | 店铺所有域名，逗号分隔，**要带 `https://`**，包括 `xxx.myshopify.com`（主题预览用） |
| `MAIL_FROM` | 发件人，域名必须是第 1 步在 Resend 验证过的，如 `Upload Form <forms@your-store.com>` |
| `MAIL_TO` | 收件邮箱，多个用逗号分隔 |
| `MAX_FILE_MB` / `MAX_FILES` | 单个文件上限 / 最多几个文件 |
| `ALLOWED_EXTENSIONS` | 允许的扩展名，留空 = 不限 |

然后：

```bash
npx wrangler secret put RESEND_API_KEY   # 粘贴第 1 步的 key
npx wrangler deploy
```

部署后会显示网址，如 `https://shopify-upload-form.xxx.workers.dev`。**表单地址 = 这个网址 + `/submit`**。

## 第 3 步：放进 Shopify

1. Shopify 后台 → **Online Store → Themes → 当前主题 ··· → Edit code**
2. `sections` 文件夹 → **Add a new section** → 命名 `customer-upload-form` → 把 `shopify/sections/customer-upload-form.liquid` 的内容整个粘贴进去 → Save
3. **Online Store → Pages → Add page**，比如叫 “Upload Files”。如需单独模板：Customize → 顶部切到 Pages → Create template。
4. 主题编辑器里打开这个页面 → **Add section → Customer upload form**
5. 在右侧设置里填 **Form endpoint** = 第 2 步的 `…/submit` 地址，保存。
6. 标题、字段名、提示语都能在右侧改（可以改成中文）。

## 第 4 步：测试

打开页面，填表、选一张图片提交，邮箱应该收到带附件的邮件；直接点「回复」就是回复客户。

收不到就看 Worker 日志：`npx wrangler tail`，再提交一次。常见原因：
- 页面提示 “Origin not allowed” → `ALLOWED_ORIGINS` 少了当前访问的域名（注意 `www`、`myshopify.com`）。
- “Could not send your submission” → Resend 域名没验证通过，或 `MAIL_FROM` 的域名不对。
- 邮件进了垃圾箱 → 在 Resend 里把 DNS 记录（SPF、DKIM）都配好。

---

## 可选：防垃圾验证（Cloudflare Turnstile）

表单已经自带蜜罐字段，能挡掉大部分机器人。如果还有垃圾提交：

1. Cloudflare 后台 → **Turnstile → Add site**，域名填店铺域名，得到 Site Key 和 Secret Key。
2. `npx wrangler secret put TURNSTILE_SECRET`（粘贴 Secret Key），然后再执行一次 `npx wrangler deploy`
3. Shopify Section 设置里填 **Turnstile site key**。

## 可选：大文件（超过 25MB）用下载链接

邮件附件总大小最多约 25MB（Resend 的上限）。如果要收视频等大文件：

```bash
npx wrangler r2 bucket create shopify-uploads
npx wrangler secret put LINK_SECRET      # 随便输入一长串随机字符
```

在 `wrangler.toml` 中取消 `[[r2_buckets]]` 那三行的注释，`PUBLIC_URL` 填 Worker 网址，按需调大 `MAX_FILE_MB`、`MAX_TOTAL_MB`，再执行一次 `npx wrangler deploy`。
Shopify Section 里的 “Max size per file / Max total size” 也要调成同样的数值。

之后 25MB 以内的部分照常作为附件，其余文件存进 R2，邮件里给下载链接（默认 30 天过期，由 `LINK_EXPIRES_DAYS` 控制）。
建议在 R2 存储桶设置里加一条生命周期规则：30 天后自动删除，避免一直占空间。
R2 免费额度是 10GB 存储空间。

注意：免费版 Worker 每次请求的上传上限是 100MB，所以单次提交的总大小不要超过约 95MB。

## 改字段

想加或删字段：
- Worker：改 `src/index.js` 顶部的 `FIELDS` 列表（字段名、邮件里显示的名称、是否必填）
- Shopify：在 Section 里加对应的 `<input name="字段名">`

两边的字段名要一致。
