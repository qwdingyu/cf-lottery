# 065 auth.eforge.xyz 生产接入操作手册（cf-lottery RP）

> 日期：2026-08-03  
> 前提：`https://auth.eforge.xyz` 已部署可用（OIDC discovery / `/api/auth/ok` 实测通过）  
> 代码侧：docs/059–064（OAuth RP + 本地 users 建档 + 不依赖 cf-auth 的公开 OTP）

---

## 一、一句话结论

**IdP（auth）生产已可用；lottery 的 cf-auth RP 实现主要在本机 `main`，尚未进入 `origin/main`，更未部署到 `lucky.eforge.xyz`。**  
线上 lucky 仍是 **Logto 时代** 构建（有 `/api/auth/login`，**无** `/api/auth/cf-auth/*`）。  
接入顺序必须是：**推送/合并 RP 代码 → 登记 OAuth Client → 配 Worker 密钥 → 迁移 0025 → 部署 → 验收**。  
「只改 `.env` / 只开 auth」**不会**让生产出现统一登录按钮后的可用闭环。

---

## 二、复审实测（2026-08-03 二次只读；修正初版过度推断）

### 2.1 已核实（可重复）

| 检查项 | 结果 | 可靠含义 |
|--------|------|----------|
| `https://auth.eforge.xyz/api/auth/ok` | `{"ok":true}` | IdP 进程/路由活着 |
| OIDC discovery | authorize/token/userinfo = `/api/auth/oauth2/*`；PKCE **S256**；token 认证 basic/post | 与本地 `cf-auth-oauth.ts` URL 拼接规则一致 |
| auth `wrangler.jsonc` `TRUSTED_ORIGINS` | 含 `https://lucky.eforge.xyz`、`https://auth.eforge.xyz` | **配置文件层面**已信任 lucky（不等于 client 已登记） |
| `POST /api/auth/oauth2/create-client` + 空 body | 400 validation | **路由存在** |
| 同上 + `redirect_uris` 无 session | **401 Unauthorized** | 需登录会话创建；不是 404 |
| `POST /api/auth/oauth2/register` | **403** `Client registration is disabled` | 生产关闭动态注册（与 cf-auth docs/012 一致） |
| `POST /api/auth/oauth2/client`（register 脚本路径） | **404** | **脚本默认路径与生产不一致**，不可照抄假成功 |
| `https://lucky.eforge.xyz/api/health` | JSON ok | 基础 Worker + DB 探测 ok |
| `POST /api/auth/login`（空 body） | 400 JSON「请输入用户名和密码」 | **旧认证路由在线上** |
| `GET/POST /api/auth/cf-auth/meta|exchange` | **404** text/plain 或 GET 被资产层打成 **HTML** | **线上没有 cf-auth RP 路由** |
| `wrangler secret list`（本机对 lottery 项目） | 有 JWT/Turso/Resend/**LOGTO_***；**无 CF_AUTH_*** | 生产 secret 面仍是 Logto，未配 RP |
| `wrangler.jsonc` `vars` | 仅 `APP_ORIGIN`，**无 CF_AUTH_*** | 非敏感 RP 开关也未进 Worker 配置 |
| `git`：`origin/main` vs 本机 `HEAD` | 本机超前多枚 commit；`origin` **无** `cf-auth-oauth.ts`、**无** `0025`；`origin` `auth.ts` 仍含 **logto-exchange** | **RP 代码未推远程**；生产若跟 origin，必无 cf-auth |
| 本地 `.env` | `CF_AUTH_ENABLED=true`、`ISSUER`/`CLIENT_ID=cf-lottery`/`REDIRECT` 有值；**`CF_AUTH_CLIENT_SECRET` 为空** | 本地也**未完成**可交换配置；且 ≠ 生产 |

### 2.2 曾写过、现降级或作废的说法

| 原表述 | 复审 |
|--------|------|
| authorize + `client_id=cf-lottery` → `invalid_client` | **GET（非 HEAD）** 对 `cf-lottery` 与随意 id 均 **302** → `error=invalid_client`（description 文案甚至是 `client_id is required`，属 IdP 文案，仍表示**未接受该 client**）。**HEAD** 同 URL 可能 **404**，勿用 HEAD 当业务结论。部分非浏览器 UA 会 **1010**，须与 OAuth 错误区分。**尚未**用「已登记真实 id」做正面对照，故不能排除「库里有别的 client、只是不是 cf-lottery」。 |
| meta 返回 HTML =「仅缓存问题」 | **不充分**。对 **POST** `/api/auth/cf-auth/meta|exchange` 得 **404**，更符合 **路由未部署**；GET HTML 多为 SPA/资产回退。 |
| 「代码已在仓库闭环」= 已上生产 | **错**。本机 main 有实现；**`origin/main` 无 cf-auth 文件、仍含 logto-exchange**；生产行为与 origin 一致。 |
| register 脚本可直接打生产 | **路径错**：脚本 `/oauth2/client` → 生产 **404**；应用 **`/oauth2/create-client`**（无会话 **401**）。 |

### 2.3 未核实（禁止当成事实）

- 生产 Turso 是否已执行 `0025_auth_identities`（无库只读查询则**未知**）  
- 生产 auth 库里是否已有任意 lottery OAuth client 行  
- 真人 Google/GitHub 在 auth 上是否对你账号可用（仅知 `ENABLED_SOCIAL_PROVIDERS` 配置存在）  
- 本机未提交的 `local-deploy.sh` / `bindings.ts` 注释级 diff **不改变**上述生产结论

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

**创建 client（生产）：**

1. 优先在 **已登录** 的 auth 会话下调用官方 API / 管理能力（cf-auth 测试用 `auth.api.createOAuthClient`；HTTP 面实测存在 **`POST /api/auth/oauth2/create-client`**，无 cookie → 401）。  
2. 仓库脚本 `scripts/register-oauth-client.mjs` 默认 POST **`/api/auth/oauth2/client`** → 生产 **404**，**不能**未改路径就当成功。应改为 `create-client` 或改用 API 客户端，并以返回 JSON 里的 `client_id`/`client_secret` 为准。  
3. body 使用插件要求字段（至少 `redirect_uris` 数组；名称字段以实测为准，常见 `client_name`）。  
4. 第一方可再 `adminUpdateOAuthClient` / 对应 HTTP 设 `skip_consent: true`（cf-auth docs/006：create 体里的 skip 可能不生效）。  
5. **不要**假设本地 `.env` 的 `cf-lottery` 已在生产库中。

**登记后自检（浏览器或带正常 UA 的客户端）：**

```bash
# 期望：302 到 /sign-in?... 或最终带 code 回 redirect；
# 若 Cloudflare 1010：换浏览器/UA，勿与 OAuth invalid_client 混淆
curl -sSI -A 'Mozilla/5.0' \
  'https://auth.eforge.xyz/api/auth/oauth2/authorize?response_type=code&client_id=<真实id>&redirect_uri=https%3A%2F%2Flucky.eforge.xyz%2Fauth%2Fcallback&scope=openid%20profile%20email&state=x&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256' | head -20
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
| 0 | **将本机 cf-auth RP 提交推到将要部署的分支**（确认 `origin` 含 `cf-auth-oauth`、无强制依赖 Logto exchange） | 不要部署旧 origin |
| 1 | IdP：登录后 `create-client` 登记 redirect；保存 id/secret；浏览器 authorize 能进登录 | 不要配 lottery secret |
| 2 | 生产库 `db:migrate` 含 0025（`TURSO_URL` + **`TURSO_TOKEN`**） | 不要开 exchange 建档 |
| 3 | Worker：`vars` 开 CF_AUTH_* 非敏感项；`secret put` CLIENT_ID/SECRET | 不要宣称可用 |
| 4 | `frontend:build` + **部署本机/已推送的 059+061+062 代码** | — |
| 5 | `POST/GET meta` = **JSON** `enabled:true`（不是 404/HTML） | 查是否仍部署旧包 |
| 6 | 真人：统一登录 → onboarding → 建租户 | 查 exchange / `auth_identities` |
| 7 | （可选）活动页 OAuth join | pendingJoin / Bearer |

**灰度：** 先管理端；公开 `enable_email_verification` 保持 true（见 064）。  
**回滚：** `CF_AUTH_ENABLED=false`；邮箱密码仍可用。若生产仍跑 Logto 包，回滚指「不要部署半截 RP」，不是只关开关。

---

## 六、常见故障

| 现象 | 排查 |
|------|------|
| `invalid_client` | IdP 未登记或 id/secret 与 Worker 不一致 |
| `redirect_uri_mismatch` | 登记 URI 与 `CF_AUTH_REDIRECT_URI`、浏览器回调 **逐字符**一致（https/路径/无尾斜杠） |
| meta/exchange **404** | 当前生产包根本没有该路由（最常见：未部署本机 RP 提交） |
| meta **HTML** | GET 被 SPA/资产接住；与 404 一并视为「RP 未上线」，勿只清缓存 |
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
