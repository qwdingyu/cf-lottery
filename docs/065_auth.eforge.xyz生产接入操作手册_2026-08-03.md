# 065 auth.eforge.xyz 生产接入操作手册（cf-lottery RP）

> 日期：2026-08-03  
> 前提：`https://auth.eforge.xyz` 已部署可用（OIDC discovery / `/api/auth/ok` 实测通过）  
> 代码侧：docs/059–064（OAuth RP + 本地 users 建档 + 不依赖 cf-auth 的公开 OTP）

---

## 一、一句话结论

**IdP 已就绪；lottery 作为 RP 的代码已在仓库闭环；生产 `lucky.eforge.xyz` 尚未接通。**  
接入不是「再写一套登录」，而是按序完成：**登记 OAuth Client → 配 Worker 密钥 → 跑库迁移 0025 → 部署含 062 的 Worker → 验收 meta/真人 OAuth**。

---

## 二、实测现状（2026-08-03，只读探测）

| 检查项 | 结果 | 含义 |
|--------|------|------|
| `https://auth.eforge.xyz/api/auth/ok` | `{"ok":true}` | IdP 活着 |
| `/.well-known/openid-configuration` | authorize/token/userinfo 均在 `/api/auth/oauth2/*` | 与 lottery `cf-auth-oauth.ts` 路径一致 |
| `code_challenge_methods_supported` | 含 **S256** | 与前端 PKCE 一致 |
| `GET …/oauth2/authorize?client_id=cf-lottery&…` | 302 → `error=invalid_client` | **生产 auth 上尚未有可用的 lottery client**（或 id 不是本地 `.env` 写的 `cf-lottery`） |
| `https://lucky.eforge.xyz/api/health` | JSON ok | lottery Worker/库基础可用 |
| `https://lucky.eforge.xyz/api/auth/cf-auth/meta` | **HTML SPA**（缓存 HIT） | 线上 Worker **未暴露**该 API（旧构建 / 未开 vars / 未部署 059+ 代码） |
| `wrangler secret list`（lottery） | 有 `JWT_SECRET`/`TURSO_*`/`RESEND_*`，**无任何 `CF_AUTH_*`**；仍残留 **Logto** secret | 生产未配 RP；Logto 可后续删 |
| 本地 lottery `.env` | 已写 `CF_AUTH_ENABLED=true`、`ISSUER=https://auth.eforge.xyz`、`CLIENT_ID=cf-lottery`、`REDIRECT=https://lucky.eforge.xyz/auth/callback` | **仅本地文件**；不等于 Worker 已配，且 client 在 IdP 侧无效 |

### 架构边界（冻结，禁止改捷径）

```text
浏览器
  │ ① authorize（PKCE S256）
  ▼
auth.eforge.xyz  (IdP / Better Auth OAuth Provider)
  │ ② redirect?code=
  ▼
lucky.eforge.xyz/auth/callback
  │ ③ POST /api/auth/cf-auth/exchange（code + code_verifier）
  │    服务端：token → userinfo → provisionIdpUser → 自签业务 JWT
  ▼
admin_token + lottery_registered_token
  │ needsTenant → /admin/onboarding → create-tenant
  └ 参与页 → verify-join / access-code（Bearer 可选跳 OTP）
```

| 做 | 不做 |
|----|------|
| 标准授权码 + PKCE；secret 只在 Worker | 共享 Better Auth cookie 到 `.eforge.xyz` |
| JWT.`sub` = 本地 `users.id`（062） | 直连 auth 的 Turso |
| 与邮箱密码 / 邮箱 OTP **并存** | 再引入 Logto |
| `CF_AUTH_ISSUER=https://auth.eforge.xyz`（**无**路径） | 把 discovery 的 `issuer`（带 `/api/auth`）原样当 base（会拼出双路径） |

> 代码拼 URL：`${CF_AUTH_ISSUER}/api/auth/oauth2/authorize` → 与 discovery 的 `authorization_endpoint` 一致。

---

## 三、端到端需要什么（清单）

### A. cf-auth（IdP）侧

1. **登记 confidential OAuth client**（生产动态注册关闭，需已登录用户创建）  
   - `redirect_uris` **精确**包含：  
     - 生产：`https://lucky.eforge.xyz/auth/callback`  
     - 本地联调（可选）：`http://localhost:8787/auth/callback`  
   - scopes：`openid profile email`  
   - **推荐** `skip_consent: true`（第一方 RP，免同意页；见 cf-auth docs/006）  
2. 安全保存返回的 **`client_id` / `client_secret`（只显示一次）**  
3. 确认 `TRUSTED_ORIGINS` 已含 `https://lucky.eforge.xyz`、`https://auth.eforge.xyz`（及本地 8787/8788 若要联调）  
4. 用户能在 auth 上登录（邮箱密码和/或 Google/GitHub，以你方已开社交为准）

**注册脚本（在 cf-auth 仓库，对生产 base）：**

```bash
cd /path/to/cf-auth
# 使用你在 auth 上已有的管理员/运营账号（勿把密码写进 git）
node scripts/register-oauth-client.mjs \
  --base https://auth.eforge.xyz \
  --email '<你的auth账号>' \
  --password '<密码>' \
  --name cf-lottery-web \
  --redirect https://lucky.eforge.xyz/auth/callback \
  --redirect http://localhost:8787/auth/callback \
  --skip-consent
```

> 若脚本路径与生产实际 HTTP 路由不一致（create 返回非 2xx），以 cf-auth 已登录会话 + 官方 `createOAuthClient` / 文档 012 所述 `POST …/oauth2/create-client` 为准，**以实测成功响应里的 client_id 为准**，不要假设本地 `.env` 的 `cf-lottery` 字符串已在库中。

**登记后自检：**

```bash
# 应进入 sign-in 或带 code 的 redirect，而不是 invalid_client
curl -sSI 'https://auth.eforge.xyz/api/auth/oauth2/authorize?response_type=code&client_id=<真实id>&redirect_uri=https%3A%2F%2Flucky.eforge.xyz%2Fauth%2Fcallback&scope=openid%20profile%20email&state=x&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256' | head -15
```

### B. cf-lottery 数据库

| 步骤 | 命令/说明 |
|------|-----------|
| 迁移 `0025_auth_identities` | `TURSO_URL=… TURSO_TOKEN=… npm run db:migrate`（脚本读 **`TURSO_TOKEN`**，不是 `TURSO_AUTH_TOKEN`） |
| 验证 | 库中存在表 `auth_identities` 与唯一索引 `(provider, provider_user_id)` |

**未迁 0025 就开 exchange → 建档失败 → 用户卡在回调。**

### C. cf-lottery Worker 配置

**`wrangler.jsonc` → `vars`（非敏感）：**

```jsonc
"vars": {
  "APP_ORIGIN": "https://lucky.eforge.xyz",
  "CF_AUTH_ENABLED": "true",
  "CF_AUTH_ISSUER": "https://auth.eforge.xyz",
  "CF_AUTH_REDIRECT_URI": "https://lucky.eforge.xyz/auth/callback",
  "CF_AUTH_SCOPES": "openid profile email"
}
```

**Secrets（勿进仓库）：**

```bash
npx wrangler secret put CF_AUTH_CLIENT_ID
npx wrangler secret put CF_AUTH_CLIENT_SECRET
# 已有 JWT_SECRET / TURSO_* 保持不动
```

可选清理（Logto 已删代码）：删除无用的 `LOGTO_APP_ID` / `LOGTO_ENDPOINT` secret，避免误导。

**本地 dev（`.dev.vars` 或 `.env`，与生产 client 可共用或另开 dev client）：**

```env
CF_AUTH_ENABLED=true
CF_AUTH_ISSUER=https://auth.eforge.xyz
CF_AUTH_CLIENT_ID=<登记得到的 id>
CF_AUTH_CLIENT_SECRET=<secret>
CF_AUTH_REDIRECT_URI=http://localhost:8787/auth/callback   # 本地
# 或生产回调联调时用 https://lucky.eforge.xyz/auth/callback
```

### D. 部署代码

必须包含至少：

- 059：`/api/auth/cf-auth/meta|exchange`、前端 callback、PKCE  
- 062：`provisionIdpUser` + `auth_identities`  
- 061：无 Logto  

```bash
# 门禁
npx tsc --noEmit && npx vitest run src/routes/cf-auth-exchange.integration.test.ts src/lib/cf-auth-oauth.test.ts
npm run frontend:build
npx wrangler deploy   # 仅在你明确授权后执行
```

部署后 **立刻** 验收（期望 JSON，不是 HTML）：

```bash
curl -sS -H 'Accept: application/json' https://lucky.eforge.xyz/api/auth/cf-auth/meta
# {"ok":true,"enabled":true,"issuer":"https://auth.eforge.xyz","clientId":"…", …}
# 响应中不得出现 client_secret
```

若仍是 HTML：查 `assets.run_worker_first: ["/api/*"]`、是否打到旧 Worker、CDN 缓存（可带 cache-bust query 或等失效）。

---

## 四、用户路径（接入成功后）

### 管理端

1. 打开 `https://lucky.eforge.xyz/admin/login`  
2. 点「统一认证」→ 跳转 auth → 登录（邮箱/社交）  
3. 回 `/auth/callback` → exchange → 写 `admin_token`  
4. **首次**：`needsTenant=true` → `/admin/onboarding` → 创建工作区 → 新 JWT 带 `tenantId`  
5. **再次**：直接进后台  

### 公开参与（可选加速）

- open 系：仍可用邮箱 OTP（与 cf-auth **无关**，见 064）  
- 弹窗里若 `meta.enabled`：可走统一认证，回调后 `lottery_registered_token` + 自动 verify-join  
- `registered` 活动：必须登录态（密码或 cf-auth）  

---

## 五、推荐落地顺序（防灾难）

| 序 | 动作 | 失败则停 |
|----|------|----------|
| 1 | IdP 登记 client + skip_consent；authorize 自检非 `invalid_client` | 不要配 lottery |
| 2 | 生产库 `db:migrate` 含 0025 | 不要开 exchange |
| 3 | Worker vars + `CF_AUTH_CLIENT_*` secrets | 不要宣称可用 |
| 4 | 部署含 062 的代码 | — |
| 5 | `curl meta` = JSON enabled true | 查部署/缓存 |
| 6 | 真人：登录 → onboarding → 建租户 → 再登录 | 查 exchange 日志 / identity 表 |
| 7 | （可选）活动页统一认证 join | 查 pendingJoin / Bearer |

**灰度：** 先只开管理端按钮；公开 OTP 保持 `enable_email_verification=true`。  
**回滚：** `CF_AUTH_ENABLED=false`（vars）→ meta `enabled:false` → UI 隐藏按钮；邮箱密码与 OTP 仍可用。

---

## 六、常见故障

| 现象 | 排查 |
|------|------|
| `invalid_client` | IdP 未登记或 id/secret 与 Worker 不一致 |
| `redirect_uri_mismatch` | 登记 URI 与 `CF_AUTH_REDIRECT_URI`、浏览器回调 **逐字符**一致（https/路径/无尾斜杠） |
| meta 返回 HTML | 未部署新 Worker 或 `/api/*` 未 run_worker_first |
| exchange 500 建档失败 | 未迁 `auth_identities` |
| 进 /admin 403 无租户 | 正常：走 onboarding；检查 `needsTenant` 与 JWT.tenantId |
| 参与页仍要验证码 | 未写 `lottery_registered_token` 或 Bearer email 与表单不一致 |
| 本地 secret 有、线上无 | 只改了 `.env`，未 `wrangler secret put` |

---

## 七、与「还要不要改代码」

| 项 | 状态 |
|----|------|
| RP 授权码 + PKCE + exchange | ✅ 已实现 |
| 本地 users + auth_identities + onboarding | ✅ 062 |
| HTTP/真 IdP 测试 | ✅ 063 |
| 生产 Client 登记 / secrets / migrate / deploy | ❌ **运维动作，本手册** |
| 自动探测 IdP 回退发码 | ❌ 错误需求（064） |

当前**不必**为「auth 已上线」再堆功能；按本手册把配置与部署闭环即可。若登记脚本对生产 HTTP 路径与 Better Auth 版本有偏差，以实测 create 响应为准并回写本页。

---

## 八、安全提醒

- `client_secret` 只进 Worker secret / 本地 `.dev.vars`，禁止提交 git、禁止 meta 下发。  
- 生产保持 `enable_email_verification=true`。  
- 旧 Logto secret 删除前确认无代码引用（061 已删实现）。  
- 本助手默认**不**代你执行：生产 `wrangler deploy`、写 secret、用真实密码跑 register（需你显式授权与凭证）。
