# 066 cf-auth 与 lottery 生产接入：差距分析与完整方案

> 日期：2026-08-03  
> 结合：`docs/065_auth.eforge.xyz生产接入操作手册_2026-08-03.md`  
> 对照：本机 cf-auth / cf-lottery 代码 + **当日可重复 HTTP 实测**  
> 性质：**分析 + 完整接入方案**（默认不代执行生产 deploy / secret put）

---

## 一、一句话结论

| 问题 | 结论 |
|------|------|
| **cf-auth 是否满足 065 对下游 IdP 的要求？** | **协议与生产面：满足。** discovery、authorize/token/userinfo、PKCE S256、TRUSTED_ORIGINS 含 lucky、create-client 路由存在、动态注册关闭——均与 065 / lottery RP 代码契约一致。 |
| **是否已可「开箱即用」接 lottery？** | **否。** 缺：**专用 OAuth client 正式登记与 secret 保管**、**client 治理（Admin/脚本路径）**、以及 lottery 侧 **代码上生产 + 迁移 + Worker 配置**。 |
| **lottery 现在怎么接最好？** | **严格按 065 顺序，不抄捷径：** 先推送 RP 代码 → 在 auth 登记**专用** client（redirect 精确）→ 生产库 0025 → wrangler vars/secrets → 部署 → meta/真人验收。本地 `CLIENT_ID=cf-lottery` + 空 secret **不能**当生产配置。 |

**总判：**  
IdP 已是可用的多项目底座；**阻塞点 90% 在 lottery 交付链（git/origin/Worker），10% 在 auth 运维（正式 client + 脚本路径修正）**。  
不是「再改一套认证协议」，而是 **把 065 清单执行完**。

---

## 二、065 要求 vs 实测对照表

### 2.1 cf-auth（IdP）— 065「A. cf-auth 侧」

| 065 要求 | 实测 / 代码 | 判定 |
|----------|-------------|------|
| IdP 进程可用 | `GET /api/auth/ok` → `{"ok":true}`；`/api/health` → `ok/db/social` 全绿 | **满足** |
| OIDC discovery 路径 | `authorization/token/userinfo` = `/api/auth/oauth2/*` | **满足** |
| PKCE S256 | discovery `code_challenge_methods_supported: ["S256"]` | **满足** |
| token 认证 basic/post | discovery 含 `client_secret_basic` / `client_secret_post` | **满足**（与 `cf-auth-oauth.ts` 交换方式兼容） |
| `TRUSTED_ORIGINS` 含 lucky | `wrangler.jsonc` vars 含 `https://lucky.eforge.xyz` + auth + 本地 8787/8788 | **配置满足** |
| 动态注册关闭 | `POST .../oauth2/register` → 403（065 已测；docs/012 一致） | **满足（安全默认）** |
| 登录会话可 create-client | 无 cookie → 401；有路由 `POST /api/auth/oauth2/create-client` | **满足** |
| 仓库 register 脚本路径 | 仍默认 `POST .../oauth2/client` → 生产 **404** | **不满足运维体验**（须改脚本或改用 create-client） |
| 用户可登录（邮箱/社交） | health：`emailPassword=true`，`socialProviders=[google,github]` | **能力满足**；真人 Google 同意页依赖控制台 URI/网络（非 RP 契约） |
| 登记 **lottery 专用** client | 本地 `.env` 的 `cf-lottery` **不是**生产真实 id；smoke client 曾用于探测，**不等于**已完成正式接入 | **正式 client 未闭环** |
| `skip_consent` 第一方 | 插件支持 `adminUpdateOAuthClient`；需创建后二次设置 | **能力有；须在登记流程执行** |

**IdP 契约结论：**  
065 对「下游能连上」的 **HTTP/OAuth 契约，cf-auth 已满足**。  
剩余是 **运维动作**（登记专用 client、修脚本、可选 Admin）与 **上游社交控制台**，不是「IdP 协议不可用」。

### 2.2 discovery.issuer 陷阱（065 已写，再强调）

| 项 | 值 |
|----|-----|
| discovery `issuer` | `https://auth.eforge.xyz/api/auth` |
| lottery 应配 `CF_AUTH_ISSUER` | **`https://auth.eforge.xyz`（无路径）** |
| 代码拼接 | `` `${CF_AUTH_ISSUER}/api/auth/oauth2/authorize` `` → 与 discovery 的 `authorization_endpoint` **一致** |

若把 discovery 的 `issuer` 原样写入 `CF_AUTH_ISSUER`，会拼出  
`https://auth.eforge.xyz/api/auth/api/auth/oauth2/...` → **必挂**。  
**这是配置错误，不是 IdP 缺陷。**

### 2.3 cf-lottery（RP）— 065「B/C/D」

| 065 要求 | 本机 main | origin/main | 生产 lucky.eforge.xyz |
|----------|-----------|-------------|------------------------|
| `cf-auth-oauth.ts` + meta/exchange | **有** | **无**（`git cat-file` 失败） | **无**（POST exchange **404**；GET meta **200 HTML** SPA） |
| 062 provision + `auth_identities` | **有**（迁移文件 `0025`） | 随 RP 提交未上 origin | 生产是否已迁 **未知**（065 未核实） |
| 061 无 Logto 主路径 | **有** | origin 仍可能含 logto-exchange（065） | 仍见旧 `/api/auth/login` 用户名密码面；**无** cf-auth 路由 |
| `wrangler.jsonc` CF_AUTH vars | **无**（仅 `APP_ORIGIN`） | 同 | 同 → 即使误部署旧包也无 RP 开关 |
| Worker secrets `CF_AUTH_*` | 本地 `.env`：ENABLED/ISSUER/REDIRECT 有；**SECRET 空**；CLIENT_ID=`cf-lottery`（占位） | — | 065：`wrangler secret list` **无 CF_AUTH_***，仍有 LOGTO_* |
| 单元/集成测 | 本地有 oauth + exchange + session 测 | 未进 origin 则 CI/他人机无 | — |

**当日复测（与 065 一致，未过时）：**

```text
GET  https://lucky.eforge.xyz/api/health              → JSON ok
GET  https://lucky.eforge.xyz/api/auth/cf-auth/meta   → 200 text/html（SPA，不是 JSON meta）
POST https://lucky.eforge.xyz/api/auth/cf-auth/exchange → 404
```

**RP 结论：**  
代码在**本机 main 已实现且可测**；**生产与 origin 未承载该实现**。  
「auth 已上线」**不会**自动让 lucky 出现统一登录闭环——065 第 14 行判断仍然正确。

### 2.4 附加实测（补充 065）

对曾登记的 smoke `client_id` + `redirect_uri=https://lucky.eforge.xyz/auth/callback`：

- authorize → **进入 `/sign-in?…` 且保留 OAuth 参数**（说明：**至少有一个** client 的 redirect 已含 lucky 回调）。  
- **仍不建议**把 smoke 探测 client 直接当生产 lottery 长期 client（命名、权限、secret 流转不清）。  
- 正式接入应 **新建** `client_name=cf-lottery-web`（或同类），redirect 含：  
  - `https://lucky.eforge.xyz/auth/callback`  
  - 可选 `http://localhost:8787/auth/callback`  
  并 `skip_consent=true`（第一方）。

---

## 三、cf-auth 是否「满足下游接入」— 分层回答

用 065 的隐含验收定义拆开：

| 层级 | 下游需要什么 | cf-auth 现状 | 对 lottery |
|------|--------------|--------------|------------|
| **L0 发现与协议** | well-known、authorize/token/userinfo、S256 | **满足** | 可按文档拼 URL |
| **L1 信任与安全默认** | 关动态注册、trusted origins、confidential client | **满足** | 须会话创建 client |
| **L2 身份内容** | openid profile email；稳定 `sub` | **满足**（userinfo） | provision 用 sub+email |
| **L3 第一方体验** | skip_consent、稳定 redirect | **能力满足** | 登记时必须设置 |
| **L4 可运维多 RP** | 列表/禁用/审计/Admin | **不足**（docs/013） | 前几个 RP 可用脚本；规模化要 Admin |
| **L5 上游社交** | Google/GitHub 回调 | **密钥与 URL 生成满足**；控制台/网络另论 | 不阻塞「邮箱登录 IdP→RP」路径 |

**对「现在接 lottery」：**  
L0–L3 **足够**。  
L4 不阻塞第一次接入，但应并行排期（cf-auth docs/013）。  
L5 影响「用户用 Google 登录 auth」，**不**影响「RP 协议是否正确」。

---

## 四、当前最大阻塞（按优先级）

```text
P0  lottery RP 代码未在 origin/生产
P0  生产未配 CF_AUTH_* vars/secrets；meta 非 JSON
P0  本地 CLIENT_ID=cf-lottery 且 SECRET 空 → 即使本地也对不齐生产 IdP
P1  生产 Turso 是否已 0025 未知；未迁则 exchange 建档失败
P1  正式 OAuth client 未按运维流程固化（id/secret 保险箱 + skip_consent）
P2  cf-auth register 脚本路径错误（/oauth2/client）
P2  任意登录用户可 create-client（权限模型，docs/013）
P3  Google 浏览器同意页 / 控制台 URI（体验，非 RP 契约）
```

---

## 五、完整接入方案（推荐唯一主路径）

> 原则与 065 第五节一致，本节补全 **责任边界、配置真值、验收门禁、回滚、本地/生产分轨**。  
> **禁止：** 只改 `.env` 宣称上线；把 discovery issuer 带路径写入；共用随意 smoke client 且不记 secret；未推 origin 就 deploy「以为有 RP」。

### 5.0 架构（冻结，与 065 相同）

```text
浏览器
  │ ① /api/auth/cf-auth/meta → 前端 PKCE + 跳转 authorize
  ▼
auth.eforge.xyz
  │ ② 用户登录（邮箱或社交）→ 同意/skip → redirect?code=&state=
  ▼
lucky.eforge.xyz/auth/callback
  │ ③ POST /api/auth/cf-auth/exchange { code, codeVerifier }
  │    token → userinfo → provisionIdpUser → 自签 JWT
  ▼
admin_token + lottery_registered_token
  │ needsTenant → /admin/onboarding
  └ 活动页 verify-join / access-code
```

| 做 | 不做 |
|----|------|
| Code + PKCE；secret 仅 Worker | 共享 auth Cookie 到 `.eforge.xyz` |
| JWT.sub = 本地 `users.id` | 业务直连 auth 库 |
| 邮箱密码 / 公开 OTP 与 cf-auth **并存** | 再引入 Logto |
| `CF_AUTH_ISSUER` 无路径 | 双路径拼接 |

### 5.1 阶段 0 — 代码与分支门禁（lottery）

**目标：** 将要部署的 git 引用 **必须** 含 RP。

```bash
cd templates/cf-lottery
# 门禁：这些路径必须在「即将 deploy 的 commit」里
test -f src/lib/cf-auth-oauth.ts
test -f src/services/idp-user-provision.ts
test -f migrations/0025_auth_identities.sql
rg -n "cf-auth/exchange" src/routes/auth.ts
rg -n "logto-exchange" src/ || echo "no logto-exchange ok"

npx tsc --noEmit
npx vitest run src/lib/cf-auth-oauth.test.ts src/routes/cf-auth-exchange.integration.test.ts \
  frontend/src/composables/cf-auth-session.test.ts
npm run frontend:build
```

**动作：**

1. Review 本机领先 `origin/main` 的提交（当前约十余枚含 059–065 相关）。  
2. **推送**到将部署的远程分支（通常 `main`），或打 tag / PR 合并。  
3. 推送后自检：`git cat-file -e origin/main:src/lib/cf-auth-oauth.ts`。  

**失败则停：** 未推送就配置生产 secret = 部署旧包后 meta 仍 404/HTML。

### 5.2 阶段 1 — IdP 登记专用 OAuth Client（cf-auth）

**目标：** 得到**仅用于 lottery** 的 `client_id` / `client_secret`。

| 字段 | 生产推荐值 |
|------|------------|
| client_name | `cf-lottery-web` |
| redirect_uris | `https://lucky.eforge.xyz/auth/callback`（必填） |
| redirect_uris 可选 | `http://localhost:8787/auth/callback`（同一 client 或另开 dev client） |
| scope | `openid profile email` |
| skip_consent | **true**（第一方；create 后 adminUpdate） |
| token 认证 | client_secret_post 或 basic（RP 已支持） |

**推荐操作方式（三选一，优先上到下）：**

1. **已登录浏览器会话** + 调用 `POST https://auth.eforge.xyz/api/auth/oauth2/create-client`  
   - body 至少含 `redirect_uris: string[]`；名称字段以实测为准（常见 `client_name`）  
   - 无 session → **401**（正常）  
2. **修好后的** `cf-auth/scripts/register-oauth-client.mjs`（必须改为 `create-client`，见 5.7）  
3. 本地 Node 临时脚本调 `auth.api.createOAuthClient`（连生产库 **高风险**，不推荐）

**登记后立刻：**

```bash
# 浏览器 UA；期望进 sign-in 或带 OAuth query，而非长期 invalid_client
curl -sS -A 'Mozilla/5.0' -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  'https://auth.eforge.xyz/api/auth/oauth2/authorize?response_type=code&client_id=<真实id>&redirect_uri=https%3A%2F%2Flucky.eforge.xyz%2Fauth%2Fcallback&scope=openid%20profile%20email&state=x&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256'
```

**保管：** secret 只进密码管理器 + 下一步 wrangler secret；**禁止**进 git / 065 类文档正文 / 聊天长期存档。

**失败则停：** 未拿到真实 id/secret 前，不要 `secret put` 占位符 `cf-lottery`。

### 5.3 阶段 2 — 生产库迁移 0025（lottery Turso）

```bash
cd templates/cf-lottery
# 脚本读 TURSO_TOKEN（不是 TURSO_AUTH_TOKEN）
TURSO_URL='libsql://…' TURSO_TOKEN='…' npm run db:migrate
# 确认 auth_identities 表 + (provider, provider_user_id) 唯一约束
```

**失败则停：** 未迁就开 exchange → provision 失败 → 用户卡在 callback。

### 5.4 阶段 3 — Worker 配置（lottery）

**`wrangler.jsonc` → `vars`（非敏感，可进仓库）：**

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
npx wrangler secret put CF_AUTH_CLIENT_ID      # 贴阶段 1 的真实 id
npx wrangler secret put CF_AUTH_CLIENT_SECRET  # 贴阶段 1 的 secret
# JWT_SECRET / TURSO_* / RESEND_* 保持
```

可选：删除无用 `LOGTO_*` secret，避免后人误以为双轨仍在。

**本地 `.dev.vars` / `.env`：**

| 场景 | REDIRECT_URI | CLIENT |
|------|--------------|--------|
| 本地 RP + 生产 IdP | `http://localhost:8787/auth/callback` | 建议 **dev 专用 client** 或生产 client 已登记该 redirect |
| 本地 RP + 本地 IdP | `http://localhost:8787/auth/callback` | 本地 auth 登记的 client |
| 生产 | `https://lucky.eforge.xyz/auth/callback` | 生产专用 client |

当前本机问题：**SECRET 空、CLIENT_ID=`cf-lottery`** → 本地也无法完成真交换；阶段 1 完成后同步改本地。

### 5.5 阶段 4 — 构建与部署（lottery）

```bash
npm run frontend:build
# 仅在明确授权后：
npx wrangler deploy
# 或 bash local-deploy-cloudeflare.sh（若其会 put 全套 secret，先确认 .env 已是真实值）
```

**部署对象必须是阶段 0 已含 RP 的 commit。**

### 5.6 阶段 5 — 验收门禁（必须全绿）

| # | 检查 | 期望 |
|---|------|------|
| 1 | `POST/GET` `https://lucky.eforge.xyz/api/auth/cf-auth/meta` + `Accept: application/json` | **JSON**，`enabled:true`，`issuer` 无误路径，**无** `client_secret` |
| 2 | `POST .../cf-auth/exchange` 空 body | **非** 404（多为 400/401 JSON） |
| 3 | 管理端「统一认证」 | 跳转 auth → 登录 → 回 `/auth/callback` → 有 `admin_token` |
| 4 | 首次用户 | `needsTenant` → onboarding → create-tenant 成功 |
| 5 | 再次登录 | 带 `tenantId` 进后台 |
| 6 | （可选）活动页 OAuth | `lottery_registered_token` + verify-join |
| 7 | 公开 OTP | 未登录仍可走邮箱码（064）；`enable_email_verification` 保持合理默认 |

**灰度：** 先管理端，再参与端 OAuth；公开验证码不要为「逼用 cf-auth」而关掉。

### 5.7 阶段 6 — 回滚

| 手段 | 效果 |
|------|------|
| `CF_AUTH_ENABLED=false`（vars 或 secret 覆盖）+ 重新 deploy | meta.enabled=false；邮箱密码仍可用 |
| 不部署半截 RP | 避免「有按钮无 exchange」 |
| 保留 JWT_SECRET / 用户表 | 业务会话模型不变 |

### 5.8 必须同步修的工程债（小改，强烈建议接入前做）

| 项 | 仓库 | 说明 |
|----|------|------|
| register 脚本路径 | **cf-auth** | `.../oauth2/client` → **`.../oauth2/create-client`**；admin-update 路径以实测为准 |
| 065/本文 | lottery | 登记成功后回写「真实步骤」；**不**写 secret |
| wrangler vars 模板 | lottery | 阶段 3 的非敏感 CF_AUTH_* 进 `wrangler.jsonc`，减少「只配 secret 忘了 ENABLED」 |
| 禁止 CLIENT_ID 文学名 | 两边 | `cf-lottery` 只作 **name**，不是 OAuth client_id |

---

## 六、推荐时间盒执行清单（复制用）

```text
□ 0.1  lottery：tsc + 关键 vitest + frontend:build 绿
□ 0.2  lottery：push 含 cf-auth-oauth 的 commit；origin 可 cat-file
□ 1.1  auth：登录 → create-client（lucky + 可选 localhost redirect）
□ 1.2  auth：skip_consent=true；authorize 自检进 sign-in
□ 1.3  密码器保存 client_id/secret
□ 2.1  lottery 生产库 migrate 0025；确认 auth_identities
□ 3.1  wrangler.jsonc vars 四项 CF_AUTH 非敏感
□ 3.2  wrangler secret put CLIENT_ID + CLIENT_SECRET
□ 3.3  本地 .env 同步真实 id/secret（或 dev client）
□ 4.1  frontend:build + wrangler deploy（授权后）
□ 5.1  meta = JSON enabled
□ 5.2  真人管理端统一登录 → onboarding/进后台
□ 5.3  （可选）参与页 OAuth
□ 6.1  （并行）cf-auth 修 register 脚本；docs/013 Admin 排期
```

---

## 七、方案选择：还有没有「更好」的捷径？

| 方案 | 评价 |
|------|------|
| **A. 065 标准 RP（本文主推）** | 与架构铁律一致；可多项目复制；**唯一推荐生产路径** |
| B. 共享 Cookie 到 `*.eforge.xyz` | **禁止**（第三方 Cookie / 升级耦合，docs/001） |
| C. lottery 再嵌 Better Auth 当 IdP | **禁止**（双 IdP、与 056/059 决策相反） |
| D. 恢复 Logto | **禁止**（061 已删；双轨成本） |
| E. 等 cf-auth Admin 做好再接 lottery | **不必要**；Admin 不阻塞第一次 client 登记 |
| F. 复用 smoke client 当生产 | **仅应急**；正式应独立 client + 轮换 secret |

**本地开发较好姿势：**

1. **生产 IdP + 本地 RP**：auth 上 client 同时登记 localhost redirect；本地 `.env` 指 `https://auth.eforge.xyz` + 该 client。  
2. **全本地**：`cf-auth dev:local :8788` + lottery `:8787`，自建 client——适合改 IdP 本身时。  
3. 日常接业务优先 **姿势 1**（少维护两套用户库）。

---

## 八、与 cf-auth docs/013 的衔接

| 013 项 | 对本次 lottery 接入 |
|--------|---------------------|
| 多项目协议已具备 | **同意**；本次验证了「协议够、交付链不够」 |
| 轻量 Admin | **不阻塞 M6**；接完 lottery 后做 M7，避免长期靠「任意用户 create-client」 |
| 限流 | lottery exchange 已有 DB 限流；auth 侧 authorize/token 仍建议后续补 |
| 照抄 lottery Admin UI | 做在 **cf-auth 仓库**，不是把 IdP 管理塞进 lucky 后台 |

---

## 九、风险与反幻觉

| 可说 | 不可说 |
|------|--------|
| auth 生产协议与 065 契约一致 | 「lottery 生产已接好 cf-auth」 |
| 本机 main 有完整 RP 实现 | 「origin/main 已有 cf-auth-oauth」 |
| smoke client + lucky redirect 曾能进 sign-in | 「生产 client_id 已是 cf-lottery 字符串」 |
| 按本文做完即可验收 | 「只 put secret 不 deploy 代码也行」 |
| Google 授权 URL 已在 auth 侧生成 | 「浏览器 Google 登录已对所有账号 E2E 通过」 |

---

## 十、文档与代码责任分工

| 仓库 | 责任 |
|------|------|
| **cf-auth** | 保持 IdP 稳定；修 register 脚本；TRUSTED_ORIGINS；正式 client 登记能力；中期 Admin（013） |
| **cf-lottery** | 推送 RP；0025；vars/secrets；deploy；meta/真人验收；保留邮箱/OTP 回退 |
| **运维执行** | 阶段 1–5 需持有生产凭证的人操作；自动化助手默认只分析与改代码/文档 |

---

## 十一、总结表（给决策者）

| 维度 | 状态 | 下一步 |
|------|------|--------|
| cf-auth 是否满足 065 下游协议要求 | **是** | 登记专用 client + 修脚本 |
| lottery 代码是否满足接入 | **本机是 / origin 与生产否** | **先 push 再 deploy** |
| 最佳接入方式 | **065 标准顺序 + 本文阶段 0–6** | 按清单勾选 |
| 是否先做 Admin | **否（可并行规划）** | 先打通 M6 真人路径 |
| 是否改协议/换 IdP | **否** | 执行配置与部署闭环 |

---

## 十二、参考

- lottery `docs/065` — 生产操作手册（步骤权威）  
- lottery `docs/059`–`064` — RP 设计、删 Logto、建档、测试、OTP 边界  
- cf-auth `docs/012` — IdP 生产冒烟  
- cf-auth `docs/013` — 多项目与 Admin 路线  
- 代码：`cf-lottery/src/lib/cf-auth-oauth.ts`、`src/routes/auth.ts`（meta/exchange）、`idp-user-provision.ts`  
