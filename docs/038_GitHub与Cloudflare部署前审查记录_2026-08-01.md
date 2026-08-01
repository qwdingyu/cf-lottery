# GitHub 与 Cloudflare 部署前审查记录

> 文档编号：038  
> 日期：2026-08-01  
> 结论：可以推送 GitHub；可以部署到 Cloudflare 做受控 Beta/测试环境；不建议直接开放正式托管 SaaS 注册。

## 一、当前结论

代码层面的验证已经通过，当前仓库可以提交并推送到 GitHub。

Cloudflare 部署层面仍有两个环境前置条件必须完成：

1. 创建或调整 R2 bucket：`wrangler.jsonc` 绑定的是 `cf-lottery-media`，当前账号只查到 `cf-shop-public-media`。
2. 补齐 secrets：当前 Worker 已有 `TURSO_URL`、`TURSO_TOKEN`、`JWT_SECRET`、`RESEND_API_KEY`、`EMAIL_FROM`、`CRON_SECRET`；仍需补 `PASSWORD_PEPPER` 和 `CREDENTIALS_ENCRYPTION_KEY`。

## 二、本次发现并修复的发布风险

`src/index.ts` 中存在公开 `/api/platform/bootstrap` 初始化入口。虽然需要 `BOOTSTRAP_SECRET`，但它与既定基线“不提供公开 bootstrap endpoint，只使用本地脚本初始化首个 platform_owner”冲突。

已处理：

1. 删除公开 `/api/platform/bootstrap`。
2. 删除 `PLATFORM_BOOTSTRAP_EMAIL` / `BOOTSTRAP_SECRET` Worker bindings。
3. 保留 `scripts/bootstrap-platform-owner.mjs` 作为唯一首个平台 owner 初始化入口。
4. `local-deploy.sh` 补写 `CREDENTIALS_ENCRYPTION_KEY` secret。

## 三、部署前必须执行

```bash
npx wrangler r2 bucket create cf-lottery-media
npx wrangler secret put PASSWORD_PEPPER
npx wrangler secret put CREDENTIALS_ENCRYPTION_KEY
```

如果选择复用已有 `cf-shop-public-media`，必须先把 `wrangler.jsonc` 的 bucket 名改成一致，并确认不会把两个项目的媒体 key 空间混在一起。当前更推荐新建 `cf-lottery-media`。

## 四、部署后必须演练

1. 注册首个普通用户。
2. 本地执行：

```bash
node scripts/bootstrap-platform-owner.mjs --email owner@example.com --role platform_owner
```

3. 登录平台后台，确认 `/api/platform/*` 可访问。
4. 创建租户活动，上传奖品图片，确认 R2 读写正常。
5. 创建抽奖、接龙、问卷、投票各一个草稿，跑发布预检并完成公开参与。
6. 确认 Cron 手动入口和 Cloudflare scheduled trigger 不报错。

## 五、仍不建议立即正式开放的原因

TODOLIST 中仍有若干 P1/P2 增强项，例如 CORS 更细粒度收紧、媒体资产治理、提交记录导出、投票结果公开开关、Webhook/UI 专项测试。这些不阻塞受控 Beta，但不适合直接作为大规模公开 SaaS 承诺。

