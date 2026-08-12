# 211 cf-lottery 整体 TODO 清单与行业最佳实践方案（2026-08-12）

> 审核修正版。
> 范围：只基于当前代码可验证事实修正 TODO，不把历史文档或规划稿当成现状。
> 原则：保留能落地的事项，删除或降级已经实现、证据不足、表述夸大的事项。

---

## 一、执行摘要

### 一句话定位

`cf-lottery` 当前最适合对外表达为：

> 面向社群主、小商户、课程/会员/卡密卖家的轻量活动成交工具：用抽奖、秒杀、签到、裂变，把用户从群、链接、店铺页带到活动页，完成留资、支付、发码、发券和归因。

内部架构上，它是多租户活动引擎；对用户和市场，不建议主打“平台/生态/多租户”这些工程语言。

### 当前代码事实

| 维度 | 状态 | 代码证据 | 修正说明 |
|:----|:----|:---------|:---------|
| 公开首页活动矩阵 | ✅ 已实现基础版 | `src/routes/public-lottery.ts` 的 `/home-activities`；`frontend/src/views/LandingView.vue` 请求 `/api/public/home-activities?limit=12` | 不应再列为“缺后端 API” |
| 店铺页 | ✅ 已实现 | `src/routes/public-lottery.ts` 的 `/shops/:storeSlug`；`frontend/src/views/ShopView.vue` | 已支持秒杀横幅、倒计时、库存、进度 |
| 活动 Open Graph | ✅ 活动页分享链路已补齐基础动态 OG | `src/routes/public-lottery.ts` 的 `/draws/:slug/og`；`src/index.ts` 的 `/lottery/:slug` 社交爬虫回退 | 目前仍缺 `og:image`、店铺级 OG，以及生产环境各渠道抓取实测；普通浏览器仍返回 SPA |
| 多状态 CTA | ✅ 已有配置与展示 | `frontend/src/views/admin/AdminLotteryView.vue`；`frontend/src/views/lottery/types.ts`；`frontend/src/views/LotteryView.vue` | 不应再列为从零实现 |
| 未中奖发券/安慰邮件 | ✅ 有基础 | `src/services/lottery/draw-execution.ts` 的 `grantLoserRewards` / `sendLoserConsolationEmails` | 缺产品化、复访 URL、看板闭环 |
| ROI/转化看板 | ✅ 有雏形 | `src/routes/admin-lottery.ts` ROI 汇总；`useDrawAnalytics.ts` 活动漏斗 | 缺接入引导和空态，不是无仪表盘 |
| 模拟登录 | ✅ 已修正路径 | `frontend/src/router/index.ts` 写 `impersonated_token` 的 `{ token, expiry }`；`useAdminAuth.ts` 优先读取 | 不应再列为“永久失效” |
| verify-email 限流 | ✅ 已加 | `src/routes/auth.ts` 对 `/verify-email` 做内存 + DB 限流；`security-audit-verification.test.ts` 有对应断言 | 不应再列为未限流漏洞 |
| QQ/TG 群助手 | ✅ 核心闭环 | `src/services/platform/commands.ts`；`src/routes/platform-qq.ts`；`src/routes/platform-telegram.ts` | 真实缺口是开通门槛和诊断，不是命令能力空白 |

---

## 二、P0：立即做的高 ROI 修正

### P0-1. 活动和店铺分享卡片补 `og:image`

> ✅ **已实现（2026-08-12）**：`renderPublicOgHtml` 新增 `imageUrl` 参数，OG 端点从 `productLink.imageUrl` / `promotionConfig.destination.imageUrl` 提取活动商品图；无图时回退内置 SVG 默认图；Twitter Card 升级为 `summary_large_image`。已补 5 个单元测试（含 XSS 转义）。

**现状**

活动 OG 端点已存在，但 HTML 模板只输出 `og:title`、`og:description`、`og:url`，没有 `og:image`。基础 Open Graph 不是空白，但分享到微信、QQ、Telegram 时缺封面图，点击率和信任感会明显吃亏。

已完成的低成本修复：真实用户分享的 `/lottery/:slug` 在统一 SPA 回退前识别已知社交爬虫，并按 `publicSlug + visible=1 + status in (open, drawn)` 查询活动后返回动态 OG HTML；普通浏览器仍走原 SPA。`/api/public/draws/:slug/og` 与该渲染逻辑复用，并保留 `ref` 查询参数。仍需在生产环境用实际分享渠道验证抓取结果，不能仅凭单元测试宣称所有平台均已生效。

**代码位置**

- `src/routes/public-lottery.ts`：`/draws/:slug/og`
- `frontend/index.html`：全站基础 OG
- `src/routes/public-lottery.ts`：`/shops/:storeSlug` 当前没有店铺级 OG

**建议方案**

1. 活动 OG 增加 `og:image`、`og:image:width`、`og:image:height`。
2. 图片优先级：活动商品图/奖品图 > 租户品牌图 > 平台默认分享图。
3. 明确分享 URL 策略：要么前端分享按钮复制 OG 跳转端点，要么后端对 `/lottery/:slug` 做爬虫 UA 动态 HTML 响应，避免 SPA 首页 meta 被误抓。
4. 新增店铺级 OG 端点：`/api/public/shops/:storeSlug/og`，标题用店铺名，描述用公开活动数量和秒杀数量。
5. 做微信、QQ、Telegram 的真实分享抓取验证，记录到 docs。

**验收标准**

- 用户实际复制/点击分享的活动链接和店铺链接分享到微信/QQ/TG 时，标题、描述、图片都能正确显示。
- 无活动图片时使用平台默认图，不出现空白卡片。

---

### P0-2. 未中奖承接补完整复访闭环

> ✅ **已实现（2026-08-12）**：`sendLoserConsolationEmails` 查询租户 `storeSlug`，构建指向 `{origin}/shop/{storeSlug}` 的复访链接；无店铺页时回退到首页 `{origin}/`。邮件模板中的"查看最新活动"按钮现在指向真实 URL（之前为空字符串，按钮被 Handlebars `#if` 隐藏）。

**现状**

未中奖发券不是空白能力。`grantLoserRewards` 会在开奖后给未中奖参与者发券，`sendLoserConsolationEmails` 也存在。但当前邮件里的 `nextActivityUrl` 是空字符串，用户收到优惠后缺少稳定复访路径。

**代码位置**

- `src/services/lottery/draw-execution.ts`：`grantLoserRewards`
- `src/services/lottery/draw-execution.ts`：`sendLoserConsolationEmails`
- `frontend/src/views/admin/AdminLotteryView.vue`：未中奖自动发券配置
- `src/services/email-service.ts`：`loser_consolation` 模板

**建议方案**

1. `sendLoserConsolationEmails` 查询租户 `storeSlug`，优先把 `nextActivityUrl` 指向 `/shop/:storeSlug`。
2. 没有店铺链接时回退到当前活动页或首页。
3. 未中奖发券配置页增加券池余量提示：预计未中奖人数、当前可用券数、是否可能不足。
4. 活动分析页增加“未中奖承接”区块：未中奖人数、发券数、邮件发送成功/失败、核销数。

**验收标准**

- 开奖后未中奖用户收到的邮件含可点击复访链接。
- 券池不足时后台提前提示，不等开奖后才发现。
- 管理员能看到这场活动到底发了多少安慰券、带来多少核销。

---

### P0-3. 秒杀模板产品化

> ✅ **已实现（2026-08-12）**：发布检查的 `payment` section 错误现在可跳转到高级配置区（`lottery-advanced`）；支付成功页面新增"看看其他活动"引导链接，引导用户回到首页浏览更多活动。

**现状**

秒杀是当前最成熟、最容易收费的闭环：店铺页有倒计时和库存，支付服务有名额预约和 CAS 控制，发布检查有支付/价格/库存/卡密校验。

**代码位置**

- `src/services/payment/payment-service.ts`
- `src/lib/flash-sale-config.ts`
- `src/services/publish-check-service.ts`
- `frontend/src/views/ShopView.vue`
- `frontend/src/views/admin/AdminLotteryView.vue`

**建议方案**

1. 把“卡密秒杀 / 课程名额抢购 / 会员福利限量发售”做成第一主推模板。
2. 发布预检不只显示错误，还提供明确跳转：
   - 去配置支付
   - 去导入卡密
   - 去补商品图
   - 去设置库存/名额
3. 支付成功页增加“返回店铺 / 看更多活动”的转化入口。

**验收标准**

- 新商户按模板创建一场直付卡密秒杀，不读文档也能完成支付配置、卡密导入、发布。
- 支付成功后用户能继续进入店铺页或下一场活动。

---

### P0-4. ROI/转化接入引导

> ✅ **已实现（2026-08-12）**：管理端数据分析弹窗的转化空态新增 curl 示例，展示如何通过 `POST /api/integration/conversions` 回传外部转化事件（含 publicSlug、conversionType、amountCents、identityType 等字段说明）。

**现状**

ROI 不是没有。后台已有租户级 ROI 汇总，活动分析页也有漏斗、CTA、外部转化列表和金额汇总。但真实成交归因依赖外部系统调用 `/api/integration/conversions` 回传。

**代码位置**

- `src/routes/integration.ts`
- `src/services/lottery/integration.ts`
- `src/routes/admin-lottery.ts`
- `src/routes/admin-lottery-draw-ops.ts`
- `frontend/src/views/admin/lottery/useDrawAnalytics.ts`
- `frontend/src/views/AdminDashboardView.vue`

**建议方案**

1. 在活动分析空态里明确区分：
   - 平台内事实：浏览、参与、分享、点击
   - 外部事实：购买、核销、注册，需要 API 回传
2. 后台增加“复制回传示例”：
   - curl 示例
   - 字段解释
   - 幂等 ID 说明
   - 常见系统接入示例
3. 外链自动附加 `draw`、`entry`、`ref` 参数，给不会写回传 API 的商户一个轻量归因兜底。

**验收标准**

- 没有外部回传时，后台不再显示冷冰冰空表，而是显示下一步接入说明。
- 商户复制示例即可完成一次测试回传，后台能看到购买金额。

---

## 三、P1：加固体验和运营能力

### P1-1. 公开首页从“列表”升级为“精选货架”
> ✅ **已实现（2026-08-12）**：首页活动列表 `ORDER BY` 新增 `json_extract(promotionConfig, '$.enableFlashSale')` 优先排序，秒杀活动排在最前，再按结束时间升序、创建时间降序排列。

**现状**

公开首页基础 API 已有，但排序和运营规则偏简单。当前更像活动列表，不是平台可运营的货架。

**建议方案**

1. 增加精选/排序能力：运行中的直付秒杀优先，其次即将结束活动，再展示免费活动。
2. 增加平台侧精选开关或排序权重。
3. 隐藏明显测试活动、低质量活动、无图无描述活动。
4. 活动卡片显示商户来源，提高信任感。

**验收标准**

- 首页首屏优先出现最可能转化的活动。
- 平台运营者可以控制公开首页展示质量。

---

### P1-2. 群助手连通性诊断

**现状**

QQ/TG 命令闭环完整，但 QQ 依赖 NapCat/OneBot，自托管对普通商户有门槛。现阶段图片卡片不是最优先，开通成功率更重要。

**代码位置**

- `src/routes/admin-lottery-platform.ts`
- `src/routes/platform-qq.ts`
- `src/routes/platform-telegram.ts`
- `src/services/platform/commands.ts`

**建议方案**

1. 平台助手页显示最近一次入站时间、最近一次出站时间、最近错误。
2. 增加“一键测试发送”和“Webhook 是否可达”的明确结果。
3. `/帮助` 根据绑定活动类型动态显示推荐命令，减少用户误用。

**验收标准**

- 商户能在后台判断群助手到底是未绑定、未连通、未选活动，还是适配器发不出去。

---

> ✅ **已实现（2026-08-12）**：管理端数据分析弹窗新增「未中奖承接（安慰券）」区域，展示安慰券发放数、核销数及核销率。后端 `/draws/:id/stats` 新增 `consolation` 字段，前端新增 `consolationCards` / `consolationRedeemRate` computed，中英文 i18n 已补齐。
### P1-3. 未中奖/发券/邮件的统一运营看板

**现状**

发券、邮件投递、核销分别已有基础表和页面痕迹，但活动运营者缺少一屏闭环视角。

**建议方案**

1. 活动详情页增加“承接效果”区块。
2. 指标包括：未中奖人数、已发券、邮件成功、邮件失败、已核销、核销金额。
3. 支持导出发券和核销明细。

**验收标准**

- 商户能回答：“这场活动没中奖的人，有多少被我重新拉回来了？”

---

### P1-4. 邮件模板轻量自定义

**现状**

邮件模板已有代码模板，但商户不能轻量改标题、引导文案、承接链接。

**建议方案**

1. 不做复杂营销自动化，先做每类模板的标题/正文/按钮文案/按钮链接配置。
2. 保留平台级审核或开关，避免垃圾邮件风险。
3. 增加退订或“不再接收营销邮件”预留字段和流程。

**验收标准**

- 商户能在不改代码的情况下调整安慰邮件的按钮文案和链接。

---

## 四、P2：增长增强

| 项目 | 建议 | 前置条件 |
|:----|:-----|:---------|
| 活动嵌入 iframe | 提供 `/embed/:slug` 和复制嵌入代码 | 公开页状态稳定、跨域策略明确 |
| SEO 与 sitemap | 为公开活动和店铺页生成 sitemap、canonical、JSON-LD | 公开首页精选规则先完成 |
| 大图分享卡片 | 支持 `summary_large_image` 和 1200x630 默认图 | P0 的 `og:image` 先完成 |
| 外部系统模板化集成 | 为常见外部系统提供回传示例 | ROI 接入说明先完成 |
| 生命周期触达序列 | 开奖提醒、安慰券、到期提醒、下期推荐 | 邮件退订与频控先完成 |

---

## 五、已核销的过时结论

以下事项曾在旧审查或原文中被列为缺口/P0。二次核查当前代码后，确认这些结论已经过时，不能再作为待办执行。

| 过时结论 | 当前处理 | 代码事实 |
|:--------|:-----|:-----|
| `/verify-email` 没有限流 | 已核销，不再列 TODO | `src/routes/auth.ts` 的 `/verify-email` 已有内存限流 + `checkDbRateLimit` DB 限流（10 次/15 分钟/IP）；`src/security-audit-verification.test.ts` 有对应断言 |
| 平台模拟登录 localStorage 格式不匹配 | 已核销，不再列 TODO | `frontend/src/router/index.ts` 写入 `impersonated_token`，结构为 `{ token, expiry }`；`frontend/src/composables/useAdminAuth.ts` 的 `parseStoredToken` 正是读取该结构 |
| 开奖 winners 与 `status=drawn` 不在同一事务导致永久自锁 | 已核销，不再列 TODO | `src/services/lottery/draw-execution.ts` 已在同一事务内写 winners 并更新 `DRAW_STATUS.DRAWN`；catch 分支检查当前状态，已 drawn 时不会回滚 open |
| 公开首页活动矩阵缺后端 API | 已核销，不再列 TODO | `src/routes/public-lottery.ts` 已有 `/home-activities`；`frontend/src/views/LandingView.vue` 已请求 `/api/public/home-activities?limit=12`；`src/routes/public-home-activities.test.ts` 有测试 |
| 多状态 CTA v2 从零实现 | 降级为验收/优化 | `after_win` / `after_loss` 已有后台配置、payload 构造和结果页展示；后续重点是端到端测试、文案和运营默认值 |
| ROI 仪表盘从零新建 | 降级为接入引导 | dashboard 和活动分析已有聚合，缺的是外部回传接入说明、示例和空态解释 |
| 未中奖承接完全缺失 | 修正为产品化缺口 | 已有 `grantLoserRewards`、`sendLoserConsolationEmails` 和后台开关；缺复访 URL、券池预检和承接看板 |
| 卡密库存预警完全缺失 | 降级为主动通知/阈值配置 | dashboard 已有直付秒杀库存预警聚合；后续可补主动通知和租户可调阈值 |
| Telegram webhook 测试已知失败 | 删除，需重新验证再建 TODO | 当前文档不保留未复核失败结论；若复现失败，应以测试输出和当前行号另建问题 |

---

## 六、技术债务清单

这部分需要在执行前逐项重新跑代码定位，不建议照搬旧行号。

| 项目 | 优先级 | 建议 |
|:-----|:------:|:-----|
| `audit_logs` 查询索引 | P1 | 若后台日志量增长明显，再加 `tenant_id + created_at` 复合索引 |
| usage snapshots 聚合性能 | P1 | 先压测平台租户数量，确认是否真的出现 N+1 瓶颈 |
| `NOT IN` 清理 lotterySpins | P2 | 数据量上来后再替换为 `NOT EXISTS` 并补索引 |
| 支付订单 i18n | P1 | 当前 i18n 已有支付订单命名空间，执行前先审查剩余硬编码 |
| 邮件服务抽象 | P2 | 等模板自定义和生命周期触达要做时一起整理 |

---

## 七、不做清单

| 不做 | 原因 | 替代方案 |
|:----|:-----|:---------|
| 自建电商/商城/SKU | 当前优势是单活动成交，不是完整交易系统 | 商品页/商城继续作为外部承接 |
| 奖品供应链 | 重资产、库存和履约风险高 | 先聚焦虚拟卡密、课程权益、会员福利 |
| 复杂 SCRM | 会拖大系统边界 | 做轻量邮件、CTA、Webhook |
| 独立支付网关 | 合规和结算成本高 | 继续集成 EasyPay/ZPay 等渠道 |
| 内容社区/UGC | 审核和风控过重 | 公开首页只做精选活动货架 |
| 独立积分/余额体系 | 会和 spins 次数体系混淆 | 只保留活动内 spins |
| 原生微信小程序优先 | 开发和审核成本高 | 先保证 H5 在微信内分享和访问体验 |

---

## 八、建议启动顺序

### Week 1：把现有能力变成可成交体验

1. 活动/店铺 `og:image` 和真实分享验证。
2. 未中奖安慰邮件补复访链接。
3. 未中奖发券配置增加券池余量预检。
4. 秒杀模板发布检查增加直接跳转。

### Week 2：让商户看懂效果

1. 活动分析页增加外部转化接入空态和复制示例。
2. 活动详情增加承接效果区块。
3. 首页活动矩阵增加精选/排序规则。

### Week 3：降低高级能力开通门槛

1. 群助手连通性诊断。
2. 邮件模板轻量自定义。
3. 店铺页品牌化和店铺级 OG。

---

## 九、最终判断

当前最值得推进的不是继续横向加玩法，而是把已经存在的能力做成商户能理解、能配置、能复盘的闭环：

1. **卡密秒杀**：最接近收入。
2. **福利抽奖 + 未中奖发券**：最接近留资和复购。
3. **社群签到/抽奖助手**：最有差异化，但需要降低开通门槛。
4. **外部转化归因**：已有技术底座，但必须补接入引导。

`docs/209` 的大方向可以保留，但 `docs/211` 的 TODO 必须以当前代码事实为准：公开首页、OG 基础、多状态 CTA、未中奖发券、ROI 雏形都已经不是“从零待做”，后续重点是产品化和验证。
