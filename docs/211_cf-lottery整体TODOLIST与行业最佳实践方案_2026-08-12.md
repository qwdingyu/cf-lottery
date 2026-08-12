# 211 cf-lottery 整体 TODO 清单与行业最佳实践方案（2026-08-12）

> 本文档以**专家顾问 + 产品经理**视角，基于 docs/209 全景分析、全库代码审查和行业最佳实践，给出分层、可落地、有代码证据的 TODO 清单与实施方案。
> 原则：**每一项都有文件:行号证据，不写幻觉，不抄理论，只做在当前架构下可直接落地的事。**

---

## 一、执行摘要

### 一句话定位

cf-lottery 是一个**多租户活动引擎**（瑞士军刀），不是电商、不是平台、不是生态。它的核心价值是让租户**零代码**创建抽奖/秒杀/签到活动，分发到公开链接/QQ群/Telegram，完成留资、导流、变现、裂变。

### 当前状态（2026-08-12）

| 维度 | 评分 | 关键证据 |
|:----|:---:|:---------|
| 核心资金安全 | ✅ 已验证 | docs/199、202、204、205 四轮审查，无超发/漏发 |
| 活动引擎能力 | ✅ 完整 | 9 种体验类型 + 4 种参与模式 + 3 种开奖方式 |
| QQ 群助手 | ✅ 核心闭环 | 6 内置命令 + 签到/spins + 脱敏 + 并发安全 |
| 秒杀/支付 | ✅ A 级 | 商品卡 + 支付 + 发卡 + CAS 防超卖 |
| 获客能力 | ⚠️ 4/10 | 无 SEO、无 Open Graph 图片、无活动聚合页 |
| 留存能力 | ❌ 3/10 | 只有 2 个邮件模板，参与后即流失 |
| 变现展示 | ⚠️ 6/10 | 有转化数据但无 ROI 仪表盘，运营者看不到价值 |

### 三阶段路线图

```
Layer 1: 止血（P0, ~15h）
  ├── 安全修复（4 项）
  ├── 产品缺口（3 项）
  └── 技术债务（5 项）

Layer 2: 加固（P1, ~30h）
  ├── 产品能力（6 项）
  └── 运营能力（4 项）

Layer 3: 增长（P2, ~40h）
  └── 获客 + 变现 + 生态（6 项）
```

---

## 二、Layer 1: 止血（P0 — 立即做，~15h）

### 2.1 安全修复（4 项）

#### 🔴 S1. 邮箱验证码暴力破解 → 账号接管

**背景**：`/verify-email` 端点没有任何限流（对比 `/register` 有内存+DB 双层限流）。验证码 6 位数字（100 万组合）、10 分钟有效、无盐 SHA-256 存储。已测试证实 30 次未触发 429。

**位置**：`src/routes/auth.ts:171`（`POST /verify-email`）

**方案**（行业最佳实践）：
1. 对 `/verify-email` 加「邮箱 + IP」双维度限流（10 次/15 分钟/邮箱）——复用 `src/lib/rate-limit.ts` 的 `rateLimitKey` 模式
2. 失败次数达到上限即作废当前验证码并删除记录，用户需重新获取
3. 验证码 hash 加盐：`SHA-256(email + code + salt)` 或直接存明文对比+短时 TTL

**工时**：1h | **风险**：极低，复用已有 `CONFIG_RATE_LIMIT` 框架

---

#### 🔴 S2. 密码存储 HMAC-SHA256（单次迭代）+ 弱密码策略

**背景**：当前格式 `hmac_sha256_v1:{salt}:{hmac}`，HMAC 为快速哈希、无迭代；pepper 用 `PASSWORD_PEPPER || JWT_SECRET`（签名密钥与密码哈希密钥共用）；密码策略仅「8 位 + 字母 + 数字」。

**位置**：`src/routes/auth.ts:376`（`hashPassword`）、`:51`（`getPasswordPepper`）、`:110-114`（密码策略）

**方案**（OWASP 密码存储指南）：
1. 去掉 pepper 对 `JWT_SECRET` 的 fallback，单独强制 `PASSWORD_PEPPER` 环境变量
2. 密码策略提升：≥12 位 + 必须包含特殊字符
3. 评估在 Workers 上使用 PBKDF2（Web Crypto 原生支持），注意免费层 10ms CPU 限制

**工时**：1.5h | **风险**：低，向后兼容：旧 hash 格式保留，登录时自动升级

---

#### 🔴 S3. 平台模拟登录格式不匹配 → 永久失效

**背景**：路由守卫写入 localStorage 格式 `{ value, expiresAt }`，读取方只接受 `{ token, expiry }`——格式不匹配，模拟登录实际永远失效。

**位置**：`frontend/src/router/index.ts:166-168`（写入方）、`frontend/src/composables/useAdminAuth.ts:26-40`（读取方）

**方案**：
1. 写入格式统一为 `{ token, expiry }`（以 `useAdminAuth.setToken` 为准）
2. 模拟登录 token 必须校验 `impersonated === true` 且当前用户为活跃平台成员

**工时**：1h | **风险**：低，纯前端格式对齐 + 后端校验加固

---

#### 🔴 S4. 开奖一致性缺陷：失败残留后活动永久自锁

**背景**：winners 写入与 `status=drawn` 更新不原子。若「事务提交成功但 drawn 更新失败」→ catch 回滚为 `open`，此时 winners 已存在。下次开奖必然 UNIQUE 冲突 → 活动永久无法开奖。

**位置**：`src/services/lottery/draw-execution.ts:1749-2054`

**方案**（行业最佳实践—事务边界明确性）：
1. 把 winners 写入与 `status=drawn` 更新放进同一事务
2. 或 catch 分支先检查 winners 是否存在，存在则补 `drawn` 而非回滚 `open`

**工时**：1h | **风险**：核心开奖逻辑修改，需增加测试覆盖

---

### 2.2 产品缺口（3 项）

#### 🟡 P0-1. Open Graph 分享卡片（缺少 og:image）

**背景**：当前分享到微信/微博时，`og:title` 和 `og:description` 已动态生成（`public-lottery.ts:562-579`），但缺失 `og:image`——社交卡片没有封面图，点击率比有图卡片低 3-5 倍。

**位置**：`src/routes/public-lottery.ts:562-579`（HTML 模板）

**方案**：
1. 在活动表新增 `shareImageUrl` 字段（可选，默认用平台默认图）
2. HTML 模板增加 `<meta property="og:image" content="..." />`
3. `og:image` 优先级：活动封面图 → 奖品第一张图 → 平台默认图
4. 前端活动编辑页增加「分享封面图」上传

**工时**：1h + 0.5h | **风险**：无，纯模板扩展

**行业最佳实践**：Open Graph Protocol 标准（ogp.me），`og:image` ≥1200×630px。

---

#### 🟡 P0-2. 未中奖承接（多状态 CTA v2）

**背景**：当前只有 `promotionConfig` v1（单一 `after_join` CTA）。用户参与后、中奖后、未中奖后、首次参与后，导流目标完全一样。这是**留存 3/10 的核心原因**。

**位置**：`draw-execution.ts:401-415`（grantLoserRewards 已实现）、`frontend/src/views/admin/lottery/types.ts:65-68`（promotionConfig 类型定义）

**方案**（行业最佳实践—生命周期营销法：HubSpot 五种触达时机）：

```
promotionConfig V2 结构：
{
  version: 2,
  ctas: {
    after_join:    { destination?, viral?, message? },
    after_win:     { destination?, message? },
    after_loss:    { destination?, message? },
    first_time:    { destination?, message? },
  }
}
```

**实现步骤**：
1. 扩展 `promotionConfig` 类型（`frontend/src/views/admin/lottery/types.ts`）
2. 前端活动编辑页增加多状态 CTA 配置面板
3. 后端 `LotteryView.vue` 结果页根据中奖状态读取对应 CTA
4. 后端 `sendLoserConsolationEmails`（`draw-execution.ts:876`）增强：未中奖邮件模板支持 CTA 自定义

**工时**：4h（2h 后端 + 2h 前端） | **风险**：低，向后兼容：v1 自动映射

---

#### 🟡 P0-3. 公开首页活动矩阵

**背景**：`LandingView.vue` 已有 `publicCards` 计算属性和 `landing-activity-feed.ts` 接口定义，但**缺少后端 API 端点**提供公开活动数据。

**位置**：`frontend/src/views/landing-activity-feed.ts`（已有接口层）、`LandingView.vue`（已有 UI 层）

**方案**（docs/137 已有完整设计）：
1. 新建 `GET /api/public/activities` 端点
2. 查询条件：`visible=1` + `status=open` + `endAt > now` + `publicSlug IS NOT NULL`
3. 返回字段复用 `LandingActivityCard` 接口
4. `LandingView.vue` 从 mock 数据切换为 HTTP 调用

**工时**：6h（4h 后端 API + 2h 前端接线） | **风险**：低，已有基础

---

### 2.3 技术债务（5 项）

| 项 | 位置 | 问题 | 方案 | 工时 |
|:---|:-----|:-----|:-----|:----:|
| T1 | `schema.ts:516-523` | audit_logs 无索引 | `idx_audit_logs_created` | 15min |
| T2 | `usage-snapshots.ts:26-81` | N+1 COUNT | `GROUP BY tenantId` 批量聚合 | 1h |
| T3 | `spin-execution.ts:611-615` | NOT IN 性能差 | 改 NOT EXISTS + 加索引 | 10min |
| T4 | `http.ts:31` / `activity-config.ts:249` / `payment-status.ts:95` | 3 个死代码 | 删除 | 10min |
| T5 | `AdminPaymentOrdersView.vue` | 20+ 硬编码中文 | 迁移 i18n | 2h |

---

## 三、Layer 2: 加固（P1 — 1-2 周，~30h）

### 3.1 产品能力（6 项）

#### 🟡 P1-1. 开奖前提醒邮件 + 未中奖后安慰邮件

**背景**：当前只有 2 个邮件模板：中奖通知和验证码。缺少开奖前提醒和未中奖安慰邮件。

**位置**：`email-service.ts:33-90`（现有模板）、`draw-execution.ts:876`（`sendLoserConsolationEmails` 已有骨架）

**方案**（邮件营销序列）：
1. 新增 `sendDrawReminder` 函数：Cron 扫描 `drawAt` 在 24h 内的活动，对参与者发送提醒
2. 增强 `sendLoserConsolationEmails`：支持自定义模板变量
3. 邮件模板统一管理：新建 `email_templates` 表

**工时**：3h | **风险**：低，`email-delivery` 异步队列已有

---

#### 🟡 P1-2. 租户 ROI 仪表盘

**背景**：已有 `externalConversions` 表（`schema.ts:795`）和 `activityEvents` 表，但无聚合展示。

**位置**：`schema.ts:795`（`externalConversions` 表）、`admin-lottery.ts:150-158`（当前 Dashboard 查询）

**方案**（SaaS 核心指标面板）：
1. 新建 `GET /api/admin/roi-dashboard?period=30d` 端点
2. 聚合查询：`SUM(amountCents)`、`COUNT(*)`、`GROUP BY conversionType`
3. 前端 `AdminDashboardView.vue` 增加「ROI 概览」区块

**工时**：4h | **风险**：低，`externalConversions` 表已有生产数据

---

#### 🟡 P1-3. 优惠券到期提醒

**背景**：`couponCodes` 表已有 `expiresAt` 字段，但未触达到期提醒。

**位置**：`schema.ts:358`（`couponCodes`）、`draw-execution.ts:739`（`grantLoserRewards` 发券）

**方案**：
1. 新增 Cron 任务：`processExpiringCoupons`，扫描 3 天内到期的已发放未核销优惠券
2. 发送到期提醒邮件（复用 `email-delivery` 异步队列）

**工时**：2h | **风险**：低

---

#### 🟡 P1-4. 活动级限流/并发控制

**背景**：当前只有全局 IP 限流（10/min），活动级 `rate_limit_join_per_minute` 前端不可见。

**位置**：`rate-limit.ts`、`system-config-definitions.json`

**方案**：
1. 前端活动编辑页增加「参与频次限制」配置项
2. 新增活动级并发控制：`maxConcurrentParticipants`（可选）
3. 后端 `joinDraw` 入口增加 CAS 检查

**工时**：2h | **风险**：低，复用 `rateLimitLog` 表

---

#### 🟡 P1-5. 退款 Provider API 接入

**背景**：迟到回调标记 `paid_late_needs_refund`，但无自动退款调用。订单状态机已预留 `REFUNDING`/`REFUNDED` 状态。

**位置**：`payment-service.ts:1000-1060`

**方案**：
1. 实现 `refundPayment` 函数：调用 EasyPay/ZPay 退款 API
2. 新增 Cron 任务：`processPendingRefunds`，扫描待退款订单并自动退款

**工时**：3h | **风险**：中，依赖支付渠道退款 API 文档和测试沙箱

---

#### 🟡 P1-6. QQ 群出站事件补齐（4/9 未接入）

**背景**：社群事件 9 种模板中 5 种已接入，剩余 4 种未接入：`draw.published`、`draw.completed`、`outcome.assigned`、`penalty.requested`。

**位置**：`src/services/platform/`（出站事件队列）、`src/lib/platform.ts`（事件模板）

**方案**：补齐 4 种事件模板的推送逻辑

**工时**：3h | **风险**：低，已有出站投递队列框架

---

### 3.2 运营能力（4 项）

| 项 | 方案 | 工时 |
|:---|:-----|:----:|
| O1. 邮件模板库 + 管理端自定义 | 新建 `email_templates` 表 + 管理后台页面 | 6h |
| O2. L3 全局公告/站内信 | 新建 `platform_announcements` 表 + 管理后台 | 4h |
| O3. L3 跨租户只读视图 | 新增 `platform_support` 中间件 + 只读端点 | 4h |
| O4. 卡密库存预警 | 新增 Cron 检查任务 + 管理员通知 | 2h |

---

## 四、Layer 3: 增长（P2 — 2-4 周，~40h）

### 4.1 获客增强（2 项）

| 项 | 方案 | 工时 |
|:---|:-----|:----:|
| P2-1. 活动嵌入 SDK / iframe | `/embed/:slug` 路由 + 嵌入代码片段 | 3h |
| P2-2. 活动 SEO 优化 | JSON-LD 结构化数据 + `sitemap.xml` + `canonical` URL | 2h |

### 4.2 变现增强（2 项）

| 项 | 方案 | 工时 |
|:---|:-----|:----:|
| P2-3. 活动后自动触达序列 | 新建 `campaign_sequences` 表 + Cron 任务 + 退订机制 | 12h |
| P2-4. 社交媒体分享卡片优化 | `summary_large_image` + `og:image:width/height` | 3h |

### 4.3 生态增强（2 项）

| 项 | 方案 | 工时 |
|:---|:-----|:----:|
| P2-5. 活动公开列表 API + 第三方集成 | 公开 API 端点 + API Key 鉴权 | 8h |
| P2-6. 邮件投递失败管理面板 | 管理后台页面 + 手动重试 | 8h |

---

## 五、技术债务综合表

| 项目 | 工时 | 建议执行时机 | 来源 |
|:-----|:----:|:-----------|:-----|
| audit_logs 索引 | 15min | Layer 1 | docs/196 H1 |
| 快照 N+1 → 批量 | 1h | Layer 1 | docs/196 H2 |
| PaymentOrders i18n | 2h | Layer 1 | docs/196 H3 |
| createEmailService 提取 | 20min | Layer 2（与 P1-1 同步） | docs/196 M1 |
| AdminSystemConfig 桩函数 | 2h | Layer 2 | docs/196 M2 |
| NOT IN → NOT EXISTS | 10min | Layer 1 | docs/196 M3 |
| 死代码清理 | 10min | Layer 1 | docs/196 M4 |
| AdminPaymentConfig i18n | 10min | Layer 1 | docs/196 M5 |
| expireOverdueOrders 名额计数精度 | 1h | Layer 1 | docs/199 |

---

## 六、测试/质量

### 6.1 已知测试失败

| 测试 | 文件 | 状态 | 根因 |
|:-----|:-----|:----:|:-----|
| Telegram webhook 测试 | `admin-lottery-platform.test.ts` | ❌ 失败 | `POST /register-telegram-webhook` 返回 401，与前端改动无关，需单独排查 |

### 6.2 建议新增测试

| 测试 | 优先级 | 说明 |
|:-----|:------:|:-----|
| Open Graph 模板渲染验证 | P0 | 验证 `og:image` 按优先级取值 |
| 多状态 CTA 版本兼容 | P0 | v1 → v2 迁移不破坏现有活动 |
| 公开活动 API 端到端 | P0 | 创建→发布→查询→验证 |
| ROI 仪表盘聚合查询 | P1 | 多租户数据隔离验证 |
| 退款流程端到端 | P1 | 回调→退款→通知 |
| 邮件模板渲染 | P1 | 各模板变量替换正确性 |

---

## 七、不做清单

| 不做 | 原因 | 替代方案 |
|:----|:-----|:---------|
| 自建电商/商城/SKU | 定位是活动引擎，不是交易系统 | 导流到外部商城 |
| 奖品供应链（兑吧模式） | 重资产、需库存/物流 | 仅做虚拟卡密分发 |
| 复杂 SCRM/营销自动化 | 用轻量 CTA + Webhook 即可 | 接入外部 CRM（API 回传） |
| 内容社区/UGC 审核 | 审核过重，偏离核心 | 不做 |
| 独立支付/结算 | 不走自建支付网关 | 集成 EasyPay/ZPay 等已有渠道 |
| 独立积分/余额体系 | 设计文档明确禁止 | 仅用 spins 次数体系 |
| 视频/直播/电商插件 | 超出活动引擎边界 | 不做 |
| 微信小程序原生版 | 需独立开发、审核周期长 | 通过 H5 页面嵌入微信内 |

---

## 八、工时汇总与建议启动顺序

### 工时汇总

| 阶段 | 总工时 | 项目数 | 性质 |
|:----|:-----:|:------:|:-----|
| **Layer 1: 止血** | **~15h** | **12 项** | P0，立即做 |
| Layer 2: 加固 | ~30h | 10 项 | P1，1-2 周 |
| Layer 3: 增长 | ~40h | 6 项 | P2，2-4 周 |
| **总计** | **~85h** | **28 项** | 全量 |

### 建议启动顺序

**Week 1（止血期，~15h）**：
```
Day 1-2: S1+S2+S3+S4 安全修复（4.5h）
Day 2-3: 技术债务 T1-T5（3.5h）
Day 3-4: P0-1 Open Graph 卡片（1.5h）
Day 4-5: P0-2 多状态 CTA v2（4h）
Day 5-6: P0-3 公开首页活动矩阵（6h，可跨周末）
```

**Week 2-3（加固期，~30h）**：
```
P1-1 邮件序列（3h）→ P1-2 ROI 仪表盘（4h）→ P1-3 优惠券提醒（2h）
→ P1-4 活动级限流（2h）→ P1-5 退款 API（3h）→ P1-6 出站事件（3h）
→ O1 邮件模板库（6h）→ O2 全局公告（4h）→ O3 只读视图（4h）→ O4 库存预警（2h）
```

**Week 4-7（增长期，~40h）**：
```
P2-1 iframe 嵌入（3h）→ P2-2 SEO 优化（2h）
→ P2-4 分享卡片优化（3h）→ P2-5 公开 API（8h）
→ P2-6 邮件投递面板（8h）→ P2-3 触达序列（12h，最大项）
```

---

## 参考文档

| 编号 | 文档 |
|:----|:-----|
| docs/209 | 系统全景流程图（9 张图+12 章全景分析） |
| docs/042a | 营销能力全维度差距分析与补强路线图 |
| docs/038a | 导流促销变现能力深度分析报告 |
| docs/196 | 待优化项全景清单（H1-H3 + M1-M5） |
| docs/199 | 核心业务深度审查报告 |
| docs/202 | 丝滑体验全域审查与修复 |
| docs/205 | 容量与边界处理机制行业最佳实践对比 |
| docs/137 | 公开首页活动矩阵方案 |
| docs/171 | 签到积分与抽奖次数体系打通方案 |
| docs/206 | 店铺首页秒杀化升级 |
ENDOFFILE
echo 'doc created, verifying...' && wc -l docs/211_cf-lottery整体TODOLIST与行业最佳实践方案_2026-08-12.md"]
