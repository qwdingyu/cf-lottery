# 身份架构分析：authIdentities 与 cf-auth 边界 & 主 provider 分析

> 日期：2026-08-10
> 定位：Phase B（QQ/Telegram 身份自动关联 users 表）后的架构论证文档
> 关联：docs/167（平台抽象）、docs/176（统一账号体系）
> 状态：分析结论已定，作为 Phase B 实现与 Phase C 规划的边界依据

---

## 1. 背景与目标

Phase B 已在 cf-lottery 实现：平台入站时通过 `provisionPlatformUser` 为每个
QQ/Telegram 用户创建 `users` + `authIdentities` 记录，为 Web 登录（Phase C）铺路。

本文档回答两个关键架构问题：

1. **cf-auth 边界**：能否/是否应该在 cf-auth 中强行加入 QQ/Telegram 身份处理？
2. **主 provider**：`authIdentities` 是否需要引入「主 provider（primary provider）」概念？

结论先行：

- **cf-auth 现阶段不得加入 QQ/Telegram 身份逻辑**（Bot 身份非 OAuth 流，强行引入
  会破坏 Better Auth 语义）
- **`authIdentities` 不需要、也不应该引入「主 provider」概念**（`users.id` 本身就是
  主身份标识，符合 Auth0/Cognito/Keycloak 行业实践）

---

## 2. 完整架构图

```
                 ┌─────────────────────────────────────────────────┐
                 │                  cf-lottery                     │
                 └─────────────────────────────────────────────────┘

  ┌──────────────┐       ┌──────────────────┐       ┌────────────────────────────┐
  │   QQ Bot     │       │   Telegram Bot   │       │      Web 前端（Phase C）     │
  │  (NapCat)    │       │   (Bot API)      │       │      登录页 / 活动页         │
  └──────┬───────┘       └────────┬─────────┘       └─────────────┬──────────────┘
         │ 群/私聊消息              │ 群/私聊消息                     │ QQ OAuth/TG
         │ (qqUserId, groupId)     │ (tgUserId, chatId)             │ /email OTP
         ▼                          ▼                               ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │                         入站层  (inbound.ts)                                  │
  │  ┌────────────────────────────────────────────────┐                          │
  │  │ provisionPlatformUser(provider, providerUserId)│  ← Phase B，幂等          │
  │  │   → 确保 users + authIdentities 记录存在        │                          │
  │  └────────────────────────────────────────────────┘                          │
  └───────────────┬──────────────────────────────────────────────────────────────┘
                  │  注入 user.userId（可选，失败降级）
                  ▼
  ┌──────────────────┐         ┌──────────────────────────────┐
  │   命令服务        │         │  users 表（业务主身份）       │
  │  (commands.ts)   │         │  ┌──────────────────────────┐│
  │  抽奖/签到/卡密    │         │  │ id: "uuid-1"（主键）     ││
  │                  │         │  │ username / email          ││
  │  identityType +  │         │  │ passwordHash: OAUTH_...   ││
  │  identityValue    │         │  └────────────┬─────────────┘│
  └──────────────────┘         │               │ 1:N          │
                               │  ┌────────────▼─────────────┐│
                               │  │ authIdentities（映射表）  ││
                               │  │ provider: email/cf-auth/ ││
                               │  │           qq/telegram    ││
                               │  │ providerUserId: 外部ID   ││
                               │  └──────────────────────────┘│
                               └──────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────────┐
  │                          cf-auth（集中授权微服务）                            │
  │  Better Auth 工厂（src/lib/auth.ts）                                          │
  │  ┌────────────────────────────────────────────────────────────────────────┐ │
  │  │ 上游 Social IdP：google/github/microsoft/apple/discord/gitlab         │ │
  │  │   （SOCIAL_PROVIDER_REGISTRY，按 env 密钥动态启用）                      │ │
  │  │   ❌ 现阶段【不】加入 qq / telegram（见 §4）                             │ │
  │  ├────────────────────────────────────────────────────────────────────────┤ │
  │  │ user 表 + account 表（Better Auth 管理）                                │ │
  │  │   account.providerId + accountId → user.id（OAuth 绑定）               │ │
  │  ├────────────────────────────────────────────────────────────────────────┤ │
  │  │ OAuth Provider（Outbound）：业务 RP 用授权码 + PKCE 接入                 │ │
  │  │   → 签发 JWT.sub = cf-auth user.id                                    │ │
  │  └────────────────────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────────────────────┘
                  │   JWT（sub = cf-auth user.id / 或本地 users.id）
                  ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │                        cf-lottery 登录处理（Phase C 规划）                    │
  │  1. 校验 JWT → 提取身份                                                       │
  │  2. 查 authIdentities(provider="cf-auth", providerUserId=sub)                │
  │  3. 命中 → 返回 users.id；未命中 → 按需创建并绑定                               │
  └──────────────────────────────────────────────────────────────────────────────┘
```

### 关键分层

| 层 | 归属 | 职责 | 是否涉及 QQ/Telegram |
|----|------|------|----------------------|
| Bot 出/入站 | cf-lottery | 消息收发、平台身份识别 | ✅ 是（Phase B 已实现） |
| 平台身份映射 | cf-lottery | `authIdentities(provider: "qq"/"telegram")` | ✅ 是（Phase B） |
| 集中认证 | cf-auth | email + 标准 OAuth IdP + JWT 签发 | ❌ 否（现阶段不加） |
| 业务主身份 | cf-lottery | `users.id`（所有业务引用） | 主身份不区分平台 |

---

## 3. 两个独立身份流（不可混淆）

### 流 A：Bot 身份（Phase B，已实现）

- **触发**：用户在 QQ/Telegram 群/私聊发消息
- **身份来源**：平台消息携带的 `(userId, groupId)`，如 `qqUserId: "123456789"`
- **协议**：非 OAuth。无浏览器、无重定向、无授权码、无 PKCE
- **验证权威**：平台适配器（NapCat / Bot API）+ 入站 secret
- **落地**：`authIdentities(provider: "qq", providerUserId: "123456789") → users.id`

### 流 B：Web 登录（Phase C，规划中）

- **触发**：用户浏览器点击登录按钮
- **身份来源**：OAuth 2.0 授权码流程（QQ互联 / Telegram Login Widget / email OTP）
- **协议**：标准 OAuth（有浏览器重定向）
- **验证权威**：cf-auth（Better Auth）
- **落地**：cf-auth 签发 JWT → cf-lottery 建 `authIdentities(provider: "cf-auth")`

### 判断依据

| 维度 | 流 A（Bot） | 流 B（Web） |
|------|------------|------------|
| 需要 cf-auth 参与？ | ❌ 不需要 | ✅ 需要 |
| OAuth 语义？ | ❌ 无 | ✅ 有 |
| 可被 Better Auth account 表表达？ | ❌ 不能 | ✅ 能 |
| 归属工程 | cf-lottery | cf-auth + cf-lottery |

**结论：流 A 与流 B 是两个独立工程问题，不能混为一谈。**
---

## 4. cf-auth 边界：现阶段不得加入 QQ/Telegram

### 4.1 现状事实（已核实，非推断）

- cf-auth 当前 `SOCIAL_PROVIDER_REGISTRY`（`src/lib/social-providers.ts`）仅含：
  `google / github / microsoft / apple / discord / gitlab`
- cf-auth 全仓（`src/` + `docs/`）**无任何** QQ/Telegram 登录/OAuth 相关代码
  （仅 `email-policy` 白名单出现 `qq.com` 邮箱域名，属业务配置，非身份逻辑）
- cf-lottery 的 `authIdentities` 已支持 `provider: "qq"/"telegram"`（Phase B）

### 4.2 为什么现阶段不加入

1. **Bot 身份不是 OAuth**：cf-auth 的 `account` 表（`providerId + accountId`）语义是
   「用户通过哪个 OAuth IdP 登录过」。Bot 消息的 `qqUserId` 不是 OAuth token，
   强行写入会破坏 Better Auth 的 `accountLinking` / `trustedProviders` 语义。

2. **ID 体系不一致**：QQ互联 OAuth 给 `openid`，QQ Bot 消息给 `qqUserId`，两者不同。
   同一人在 cf-auth `account` 表会得到两个无法关联的 `accountId`。

3. **防范灾难**：在未充分设计前向 cf-auth 注入平台身份，可能触发：
   - 账号合并误判（`allowDifferentEmails: false` 的边界被绕过）
   - 会话/create session 钩子（blocklist/email 策略）对非 OAuth 身份不适配
   - 多 RP 共享身份时，平台身份意外出现在其它业务域

### 4.3 边界红线（务必遵守）

- ❌ 现阶段不在 cf-auth 加 QQ/Telegram 的 `SOCIAL_PROVIDER_REGISTRY` 项
- ❌ 现阶段不直接向 cf-auth 的 `account` 表插入 Bot 身份
- ✅ cf-lottery 的 `authIdentities` 保留 `provider: "qq"/"telegram"`（Phase B）
- ✅ 若未来 Phase C 需要 Web 端 QQ/Telegram 登录，再**单独评估**以最小侵入方式扩展
  （QQ互联/Telegram Login Widget 的真实验证，而非臆测）

---

## 5. authIdentities 主 provider 分析（行业最佳实践）

### 5.1 问题

是否需要给 `authIdentities` 增加「主 provider / primaryProvider」标记，
以指明某个 provider 是用户的「主身份」？

### 5.2 行业最佳实践对照

| 系统 | 主身份如何表达 | 是否有「主 provider」标记 |
|------|---------------|--------------------------|
| **Auth0** | `user.user_id`（系统生成）就是主身份 | 无。`user.identities[]` 是关联身份数组，provider 之间对等 |
| **AWS Cognito** | `sub`（用户池内唯一）就是主身份 | 无。`UserAttributes` 中 email/phone 是属性，不是 provider 主次 |
| **Keycloak** | `user.id` 就是主身份，`federatedIdentities` 存关联 | 无。联邦身份表对等，不做 primary 标记 |
| **Better Auth** | `user` 表主记录，`account` 表存关联 provider | 无 "primary account" 概念。`user.email` 是跨 provider 关联桥梁 |
| **cf-lottery** | `users.id` 就是主身份 | ❌ 不引入。`authIdentities` 仅作关联映射 |

### 5.3 行业共识提炼

1. **主身份 = 业务用户主键**：应当由 `users.id` 承担，而不是某个 provider。
   所有业务（tenantMembers、lotteryEntries、audit）都引用 `users.id`，它天然是主身份。

2. **关联身份对等**：Auth0/Cognito/Keycloak 均不标记 provider 主次。
   多个 provider 是对等的「这个 user 认识哪些外部身份」，而非「谁是主人」。

3. **避免语义污染**：若在 `authIdentities` 加 `isPrimary`，会引入「哪些 provider 是
   权威」的歧义，且与 `UNIQUE(provider, providerUserId)` 约束无直接关系，增加复杂度。

### 5.4 结论

- **`authIdentities` 不引入「主 provider」字段。**
- `users.id` 是唯一主身份标识（行业标准）。
- 若未来需要「默认登录方式」或「通知渠道优先级」，属于**业务策略**，
  应放在 `users` 表或独立策略表（如 `user_preferences`），而非 `authIdentities`。

### 5.5 防灾难注意事项

- 不要在 `authIdentities` 上建「每用户仅一个 primary」的唯一约束（会阻止多平台绑定）。
- 不要用 provider 顺序隐含主次（注册表顺序 ≠ 身份优先级）。
- email 合并（`allowDifferentEmails: false`）在跨平台绑定时需保持现状，避免账号接管。

---

## 6. 与 Phase 规划的关系

| Phase | 范围 | 状态 | 本文档结论 |
|-------|------|------|-----------|
| Phase A | `/我的卡密` 命令 | 已实现 | 不涉及账号体系 |
| Phase B | QQ/Telegram 身份关联 `users` 表 | 已实现 | `authIdentities` 保留 `qq/telegram`，不引入主 provider |
| Phase C | Web 端 QQ/Telegram 登录入口 | 规划中 | 需单独评估 cf-auth 扩展，最小侵入 |
| Phase D | 跨平台身份合并 | 远期 | 同一 `users.id` 绑定多 provider，`authIdentities` 多行对等 |

### 下一步（Phase C 前置确认）

1. Phase B 已就绪（`authIdentities` 已有 `qq/telegram` 记录）。
2. Phase C 前需**真实验证** QQ互联 / Telegram Login Widget 的接入成本与资质要求，
   再决定是否以及在多大程度上扩展 cf-auth。
3. 在 Phase C 完成前，**保持 cf-auth 纯净**，不加入任何 QQ/Telegram 身份逻辑。

---

## 7. 验证与记录

- 本文档结论基于对 cf-auth、cf-lottery 源码与 docs 的实读，无臆测。
- cf-auth 当前无 QQ/Telegram 身份代码（已 grep 核实）。
- docs/176 的 Phase B 状态已更新为「已实现」，本文档作为其架构边界补充。