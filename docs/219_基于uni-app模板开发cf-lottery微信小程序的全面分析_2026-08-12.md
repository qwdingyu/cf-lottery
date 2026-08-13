# 219 基于 uni-app 模板开发 cf-lottery 微信小程序的全面分析

> 日期：2026-08-12
> 定位：工程专家级可行性分析 + 架构方案
> 范围：基于 uni-app 公共模板开发 cf-lottery 微信小程序，覆盖签到、抽奖、秒杀、批发四块业务与用户端触达

---

## 文档约定：事实等级标注

为避免幻觉，全文所有论断按以下等级标注：

| 标记 | 含义 |
|------|------|
| 【代码事实】 | 已通过逐文件代码验证 |
| 【官方确认】 | 已通过微信/uni-app 官方文档核实 |
| 【行业常识】 | 行业公认做法，但平台规则可能调整，落地前需复核 |
| 【建议】 | 基于事实的分析推演 / 推荐方案 |

凡未标注的段落均为【建议】的分析推演。

---

## 1. 结论先行（执行摘要）

**整体判断：uni-app 模板是合适的起点，但需做 5 项关键适配，直接复制不可行。** 模板在「请求封装、CSS 变量主题、上传组件、底部弹窗、热更新（APP 侧）」方面可直接复用；在「后端响应格式、认证体系、支付渠道、平台身份、小程序原生能力」方面必须改造或新增。

### 1.1 核心发现

| # | 发现 | 影响 | 工作量预估 |
|---|------|------|-----------|
| 1 | 模板后端（song-rong）与 cf-lottery 后端**响应格式不同**：模板期望 `{code,msg,data}`，cf-lottery 返回 `{ok,message,...}` | 请求层必须适配 | 小 |
| 2 | 模板认证（账号/手机号+密码/验证码）与 cf-lottery（邮箱+OTP+JWT / cf-auth OAuth）**数据模型不同** | 登录页重写，cf-lottery 端需新增微信登录接口 | 中 |
| 3 | 模板 `request.ts` 要求 auth 默认 true，cf-lottery 公开 API 多无鉴权 | 请求层需区分公开/鉴权 | 小 |
| 4 | cf-lottery 支付渠道（Stripe/EasyPay/支付宝）**不包含微信原生支付**（wx.requestPayment） | 需新增 WeChat Pay provider 或走 web-view H5 支付 | 大 |
| 5 | cf-lottery 平台适配器仅支持 QQ 和 Telegram，**无微信小程序适配器** | 需新增 wechat 平台类型 + 微信登录/订阅消息/客服消息 | 大 |
| 6 | 模板 hot-update（update.ts）是 APP 专用，小程序走 OTA 更新（wx.getUpdateManager） | 条件编译替换 | 小 |
| 7 | 模板 auth guard 强制跳登录页，cf-lottery 公开活动页无需登录 | 改白名单逻辑 | 小 |

### 1.2 优势清单

- **后端能力完备**：【代码事实】cf-lottery 后端已有完整的抽奖引擎（spins / draw / flash-sale / payment / viral / checkin），小程序只需调 API，无需重写业务逻辑
- **模板基础设施扎实**：CSS 变量主题、BottomPopup、Empty 组件、请求封装骨架均可直接复用
- **跨平台编译**：uni-app 3.x 支持一键构建到微信小程序、H5、App，未来扩展平台成本低
- **已有微信小程序调研**：docs/189 已详细分析微信广告激励、uni-ad 聚合、开源组件复用路径

---

## 2. 后端能力事实盘点（代码级核实）

### 2.1 公开 API 清单（小程序需调用的全部端点）

【代码事实】以下所有端点已在 `src/index.ts` 和对应路由文件中确认。

#### 活动浏览

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/public/home-activities` | 首页活动列表（精选/秒杀/免费） | 无 |
| GET | `/api/public/shops/:storeSlug` | 店铺首页（含品牌配置、活动列表） | 无 |
| GET | `/api/public/draws/:slug` | 活动详情（含参与时间窗、奖品壳、秒杀运行时） | 无 |
| GET | `/api/public/draws/:slug/og` | 社交分享 OG 页面 | 无 |

#### 参与流程

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/public/draws/:slug/events` | 上报事件（page_view/cta_click/share_click 等） | 无 |
| POST | `/api/public/draws/:slug/access-code` | 发送邮箱验证码 | 无 |
| POST | `/api/public/draws/:slug/verify-join` | 验证参与条件（密码/邀请码等） | 无 |
| POST | `/api/public/draws/:slug/join` | 提交参与（含 accessPassword/inviteCode/refCode/submission） | 无/部分 |
| POST | `/api/public/draws/:slug/cancel` | 取消参与 | 有 |
| POST | `/api/public/draws/:slug/spin` | 即时抽奖（spin 一次，消耗次数） | 无 |

#### 结果查询

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/public/draws/:slug/my-result` | 通过邮箱+验证码查询中奖结果 | 无 |
| POST | `/api/public/draws/:slug/result` | 查询指定参与结果 | 无 |
| GET | `/api/public/access/card-codes` | 一次性令牌查卡密 | 令牌 |

#### 支付

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/public/draws/:slug/payment-orders` | 创建支付订单 | 无 |
| POST | `/api/public/draws/:slug/payment-orders/recover` | OTP 找回订单 | 无 |
| GET | `/api/public/draws/:slug/payment-orders/:orderId` | Bearer 查询订单状态 | 令牌 |

#### 认证

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/auth/login` | 邮箱+密码登录 | 无 |
| POST | `/api/auth/register` | 注册（需邮箱验证） | 无 |
| POST | `/api/auth/verify-email` | 验证邮箱验证码 | 无 |
| POST | `/api/auth/logout` | 登出 | 无 |
| GET | `/api/auth/me` | 查询当前用户信息 | 有 |
| POST | `/api/auth/cf-auth/exchange` | cf-auth OAuth 令牌交换 | 无 |

### 2.2 响应格式

【代码事实】cf-lottery 使用 Hono 的 `ok()` / `fail()` 辅助函数，统一响应结构：

```typescript
// 成功
{ ok: true, ...data }
// 失败
{ ok: false, message: "错误信息" }
// 业务错误（含状态码）
{ ok: false, message: "已抢光", error: "...", soldOut: true, code: "flash_sale.sold_out" }
```

**与模板的冲突**：模板 `request.ts` 的 `ApiResult<T>` 期望 `{ code: number, msg: string, data: T }`，成功 code ∈ {0, 200}。**必须改造请求层**。

### 2.3 认证模型

【代码事实】cf-lottery 认证体系：

- **Session Token**：登录后签发 JWT，24 小时有效，存储在客户端 localStorage/mini-program storage
- **Email OTP**：参与/查询结果时的二次验证，6 位数字，有效期短
- **cf-auth OAuth**：可选 IdP（OAuth 2.0 + OpenID Connect），通过 `POST /api/auth/cf-auth/exchange` 完成 token exchange
- **注册流程**：提交邮箱 → 发送验证码 → 验证 → 设置密码 → 完成
- **身份绑定**：`auth_identities` 表存储 `provider + provider_user_id` 映射到本地用户，目前仅支持 `cf-auth` provider

**小程序关键约束**：微信小程序没有「邮箱」。微信登录流程：`wx.login()` → code → 后端 `code2Session` → openid。**cf-lottery 需要新增 `wechat` provider 平台**，即：
1. 新接口 `POST /api/auth/wechat/login`（接收 wx.login 的 code，调用微信 code2Session）
2. 新接口 `POST /api/auth/wechat/bind-email`（可选：将 openid 绑定到已有邮箱账号）
3. 在 `auth_identities` 中新增 `provider: "wechat"` 的支持

### 2.4 支付渠道

【代码事实】cf-lottery 的支付 providers（`src/services/payment/catalog.ts`）：

| Provider | 模式 | 小程序兼容性 |
|----------|------|------------|
| Stripe | 信用卡/AP/GP，Redirect H5 | ❌ 不可用（小程序无 WebView 支付） |
| 易支付/EasyPay | H5 跳转（支持 wxpay 作为收款方式） | ⚠️ 需 web-view 容器，体验差 |
| 支付宝 | H5 跳转/当面付 | ❌ 不可用（小程序内不支持支付宝 H5） |

**实际结论**：cf-lottery 的**现有支付渠道均不能直接用于微信小程序**。微信小程序原生支付只有 `wx.requestPayment`（微信支付）一条路。需要：

- **方案 A**（推荐）：在 cf-lottery 后端新增 `wechatpay` provider（对接微信支付 JSAPI），使用 `wx.requestPayment` 唤起支付
- **方案 B**（临时）：使用 web-view 加载 H5 支付页（易支付 wxpay），但无法回调通知小程序，用户体验差
- **方案 C**（短期）：闪购不走支付，只做导流（`paymentRequired: false`），引导用户到 H5 版完成支付

### 2.5 平台适配器（触达渠道）

【代码事实】当前平台适配器：

| 平台 | 适配器 | 状态 |
|------|--------|------|
| QQ | `qq-adapter.ts` | 完整（入站命令 + 消息模板 + 多媒体） |
| Telegram | `telegram-adapter.ts` | 完整（Bot API 长轮询） |
| **微信小程序** | ❌ **不存在** | **需新建** |

平台类型定义（`types.ts`）：`PlatformType = "qq" | "telegram"`，需扩展为 `"qq" | "telegram" | "wechat"`。

微信小程序需要新增的能力：
- 微信登录（wx.login + code2Session）
- 订阅消息（wx.requestSubscribeMessage + 模板消息推送）
- 客服消息（Customer Service Messages）
- 分享卡片（wx.shareAppMessage / wx.shareTimeline）

### 2.6 数据模型（小程序相关）

【代码事实】关键表：

| 表 | 关键字段 | 小程序用途 |
|----|---------|-----------|
| `tenants` | `storeSlug`, `brandConfig` | 店铺首页、品牌主题色 |
| `lotteryDraws` | `publicSlug`, `title`, `experienceType`, `activityKind`, `promotionConfig`, `flashSale` | 活动卡片渲染、秒杀配置 |
| `lotteryPrizeTiers` | `tierName`, `prizeId`, `weight`, `quantity` | 奖品壳展示、奖项配置 |
| `lotteryEntries` | `identityType`, `identityValue`, `drawId` | 参与记录、个人中心 |
| `lotteryWinners` | `entryId`, `tierId`, `prizeCodeId`, `drawnAt` | 中奖结果查询 |
| `prizeCodes` | `code`, `secret`, `status` | 卡密展示 |
| `paymentOrders` | `quantity`, `unitPriceCents`, `amountCents`, `pricingSnapshotJson` | 批发订单、阶梯价展示 |
| `tenantConfigs` | `providers` (JSON) | 支付渠道配置 |

---

## 3. 业务模块 × 小程序方案映射

### 3.1 签到（Check-in）

【代码事实】后端已支持：

- 活动模板 `checkin-daily`（`activity-templates.ts`）
- 奖励配置 `checkin-reward.ts`（支持 daily/linear/step/cycle 四种模式 + 随机 bonus）
- 连续天数计算 `nextStreakAfterCheckin()`（昨天签到则连续+1，否则重置）
- spins 次数奖励作为签到奖励（`grantSpinCount` / `rewardConfig`）
- 通过 `commands.ts` 提供 bot 命令签到（非小程序直接使用）

**小程序方案**：

| 功能 | 接口 | 前端实现 |
|------|------|---------|
| 签到首页 | `GET /api/public/draws?activityKind=checkin` | 日历/连续签到 UI |
| 执行签到 | `POST /api/public/draws/:slug/join` | 按钮 → 签到成功动画 |
| 签到历史 | 扩展 API（当前无专有签到记录查询） | 需要后端新增 `GET /api/public/draws/:slug/checkin-status` |
| 签到奖励展示 | 从活动详情 `draw` 的 `promotionConfig` 解析 | 展示次日可获 spins 数 |

**待扩展项**：
- 小程序签到需要 `checkin-status` 接口返回「今日是否已签」「连续天数」「明日奖励」等摘要信息
- 当前 `joinDraw` 可处理签到逻辑（`activityKind=checkin`），但需确认 `checkin` 的 `joinDraw` 是否已实现免 OTP 直达

### 3.2 抽奖（Lottery）

【代码事实】抽奖是 cf-lottery 的核心能力：

- **体验壳**：大转盘（wheel）、刮刮卡（scratch）、翻牌（card）、九宫格（grid）、老虎机（slot）、翻骰（reveal/dice）、表单提交（submit）、秒杀（flash sale）——**8 种体验类型**
- **参与模式**：open / password / roster / invite_code / registered
- **出奖模式**：instant（即时 spin，有 spins 次数体系）/ scheduled（定时开奖）/ manual（手动开奖）
- **裂变**：邀请码（refCode）、裂变排行榜、邀请增加 spins 次数（双封顶）
- **奖品**：实物（需人工发货）、卡密（自动发放）、优惠券

**小程序方案**：

| 体验类型 | 前端组件 | 备注 |
|---------|---------|------|
| wheel（大转盘） | 基于 ThorUI 开源组件改造 | 已有转盘动画，可复用 |
| scratch（刮刮卡） | 基于 Canvas 手写 | 小程序 Canvas 2D 支持 |
| card（翻牌） | 自定义 CSS 3D 翻转 | 轻量，无第三方依赖 |
| grid（九宫格） | 自定义 | 简单 grid 布局 + 动画 |
| slot（老虎机） | 基于 Canvas/CSS 动画 | 类似转盘 |
| reveal（翻骰） | CSS 3D 骰子 | 简单 |
| submit（表单） | 原生表单组件 | 复用模板表单 |
| flash_sale（秒杀） | 独立组件 | 见 3.3 |

**关键实现要点**：
- 小程序 Canvas 2D API 与 H5 Canvas 有差异，需要条件编译或封装
- 转盘动画在微信小程序中性能受限于 WebView 渲染，复杂动画建议用 `canvas` 2D 实现
- 即时抽奖的 `POST /api/public/draws/:slug/spin` 返回结果后立即展示动画结果

### 3.3 秒杀与批发（Flash Sale & Wholesale）

【代码事实】秒杀配置在 `flash-sale-config.ts`：

- `enabled`：是否启用秒杀壳
- `stockLimit`：名额上限
- `maxPerUser`：每人限购（两级防护：路由层 + 订单层）
- `paymentRequired`：是否直付发卡
- `priceCents`：价格（分）
- `pricingTiers`：阶梯价（批发用，`[{minQuantity: 1, unitPriceCents: 990}, {minQuantity: 10, unitPriceCents: 790}]`）
- `showCountdown` / `showProgress` / `showStock`：展示控制
- `ctaLabel`：按钮文案

后端已提供 `buildFlashSaleRuntime()` 计算「已抢/剩余/进度%」，通过 `GET /api/public/draws/:slug` 返回。

**小程序方案**：

| 功能 | 接口 | 前端实现 |
|------|------|---------|
| 秒杀卡片 | GET /api/public/shops/:storeSlug / home-activities | 倒计时 + 进度条 + 库存 + 闪电标 |
| 秒杀详情 | GET /api/public/draws/:slug | 商品图、价格、阶梯价选择器、数量选择、抢购按钮 |
| 创建订单 | POST /api/public/draws/:slug/payment-orders | 提交 quantity + 阶梯价确认 |
| 支付 | 见 2.4 支付方案 | 见支付章节 |
| 订单查询 | GET /api/public/draws/:slug/payment-orders/:orderId | 订单状态、卡密列表 |

**批发（Wholesale）**：后端通过 `paymentOrders.quantity` + `pricingSnapshotJson` 实现「一笔订单多件商品」，前端需提供：
- 数量选择器（Stepper 组件）
- 阶梯价实时计算（调用 `calculateFlashSalePrice()` 的客户端版本或请求后端）
- 订单详情展示多件卡密列表

### 3.4 用户端触达（Touchpoints）

【代码事实】后端现有触达能力：

| 触达方式 | 后端支持 | 小程序适用性 |
|---------|---------|------------|
| 邮件 | `email-service.ts`（通过 Resend 发送） | ❌ 小程序无法触发邮件发送，可改为后端自动发 |
| QQ Bot 私聊/群消息 | `qq-adapter.ts` | ❌ |
| Telegram Bot 消息 | `telegram-adapter.ts` | ❌ |
| Webhook | `delivery.ts` | ⚠️ 需服务端自己配置 |
| 一次性 Web 令牌 | `access-token.ts` | ✅ 卡密查看链接可分享到微信会话 |

**小程序方案（需新增）**：

| 触达方式 | 微信 API | 建议实现 |
|---------|---------|---------|
| 订阅消息 | `wx.requestSubscribeMessage` | 参与后弹窗订阅「开奖通知」/「秒杀开始提醒」 |
| 客服消息 | `wx.openCustomerServiceChat` | 我的页面提供客服入口 |
| 分享卡片 | `wx.shareAppMessage` | 活动详情页分享按钮，带 refCode 参数 |
| 生成海报 | `canvas` 2D 绘制分享图 | 推荐榜单、中奖炫耀海报 |
| 模板消息 | 服务端通过微信 API 推送 | 开奖通知、中奖通知、卡密发放通知 |

**关键架构决策**：微信订阅消息需要服务端 store 用户的 `formId` 或 `template_id` 订阅关系。建议：
1. 小程序端在用户「参与活动时」调用 `wx.requestSubscribeMessage` 勾选订阅项
2. 后端 `auth_identities` 扩展 `wechat` provider 后，存储用户的 `openid`
3. 后端新增 `wechat-adapter.ts`，通过微信 API 推送模板消息
## 4. 模板能力基线评估

### 4.1 可直接复用

| 模板模块 | 文件 | 复用说明 |
|---------|------|---------|
| CSS 变量主题 | `styles/theme.css` | 变量命名规范，仅需调整色值匹配 cf-lottery 品牌 |
| BottomPopup 组件 | `components/BottomPopup.vue` | 完整可用 |
| Empty 组件 | `components/Empty.vue` | 完整可用 |
| 文件上传 | `utils/upload.ts` | 通用，可直接复用 |
| 状态管理模式 | `store/` | reactive 模块化模式，可沿用 |
| 包结构 | 标准 uni-app 3.x Vue3 TS | 可直接作为脚手架 |

### 4.2 需改造

| 模板模块 | 改造内容 | 工作量 |
|---------|---------|--------|
| `utils/request.ts` | 响应结构适配 `{ok,message,...}` 而非 `{code,msg,data}`；cf-lottery 返回 401 在 body 中而非 HTTP 401；公开 API 无需 auth 请求头 | 中 |
| `utils/auth.ts` | 白名单逻辑改为「默认公开，仅个人中心需鉴权」；token key 从 `h5_token` 改为 `mp_token`；去掉 `VITE_ENABLE_AUTH_GUARD` 开关依赖 | 小 |
| `pages/login/index.vue` | 重写为微信小程序登录（wx.login）；去除「手机号+密码」表单 | 大 |
| `App.vue` | 热更新替换为 `wx.getUpdateManager`；onShow 认证检查改 cf-lottery JWT | 小 |
| `pages.json` | 路由表重写为 cf-lottery 的页面结构 | 中 |

### 4.3 需新增

| 模块 | 说明 | 优先级 |
|------|------|--------|
| 请求层适配器 | 封装 cf-lottery API 的 `ok/fail` 响应格式 | P0 |
| cf-lottery API 模块 | `src/api/` 下按业务模块拆分（draw, payment, auth, shop, checkin） | P0 |
| 游戏组件库 | 转盘/刮刮卡/翻牌/老虎机等 8 种体验组件 | P0 |
| 秒杀 UI 组件 | 倒计时、进度条、阶梯价选择器、数量 Stepper | P0 |
| 签到页面 | 日历视图、连续天数展示、签到按钮 | P1 |
| 个人中心 | 参与记录、中奖记录、卡密列表、订单列表 | P1 |
| 微信平台适配器 | 后端扩展 wechat 平台类型 + 微信登录接口 + 订阅消息接口 | P0 |
| 微信支付 provider | 后端新增 wechatpay provider（wx.requestPayment） | P1 |
| 分享/海报组件 | 分享卡片、Canvas 海报生成 | P1 |
| 微信订阅消息 | 前端订阅弹窗 + 后端推送逻辑 | P2 |
## 5. 架构设计建议

### 5.1 工程结构

```
cf-lottery/
├── mp/                          # 小程序项目（新目录）
│   ├── src/
│   │   ├── api/                 # cf-lottery API 封装
│   │   │   ├── index.ts         # 统一导出
│   │   │   ├── client.ts        # 请求层（适配 cf-lottery 响应格式）
│   │   │   ├── auth.ts          # 认证接口（login/register/me）
│   │   │   ├── draw.ts          # 活动接口（list/detail/join/spin）
│   │   │   ├── shop.ts          # 店铺接口
│   │   │   ├── payment.ts       # 支付接口
│   │   │   ├── checkin.ts       # 签到接口（含扩展 checkin-status）
│   │   │   └── types.ts         # 类型定义
│   │   ├── components/          # 通用组件
│   │   │   ├── games/           # 游戏组件（8 种体验壳）
│   │   │   │   ├── WheelGame.vue
│   │   │   │   ├── ScratchGame.vue
│   │   │   │   ├── CardGame.vue
│   │   │   │   ├── GridGame.vue
│   │   │   │   ├── SlotGame.vue
│   │   │   │   ├── RevealGame.vue
│   │   │   │   ├── SubmitGame.vue
│   │   │   │   ├── FlashSaleGame.vue
│   │   │   │   ├── GameRegistry.ts
│   │   │   │   └── GameResultModal.vue
│   │   │   ├── Countdown.vue    # 倒计时组件（通用）
│   │   │   ├── Stepper.vue      # 数量选择器（批发用）
│   │   │   ├── PriceTier.vue    # 阶梯价展示
│   │   │   ├── ViralLeaderboard.vue  # 裂变排行榜
│   │   │   └── ...              # BottomPopup, Empty 等复用模板
│   │   ├── pages/
│   │   │   ├── index/           # 首页（活动广场）
│   │   │   ├── shop/            # 店铺首页
│   │   │   ├── lottery/         # 活动详情（核心页）
│   │   │   ├── payment/         # 支付/订单
│   │   │   ├── checkin/         # 签到
│   │   │   ├── mine/            # 个人中心
│   │   │   ├── login/           # 微信登录
│   │   │   └── webview/         # H5 支付中转页（临时方案）
│   │   ├── store/               # 状态管理
│   │   ├── utils/               # 工具（复用模板）
│   │   ├── styles/              # CSS 变量（参考模板）
│   │   ├── App.vue
│   │   ├── main.ts
│   │   ├── pages.json
│   │   └── manifest.json
│   ├── package.json
│   └── tsconfig.json
```

### 5.2 请求层适配（关键）

【建议】不直接修改模板的 `request.ts`，而是新增 `api/client.ts` 作为 cf-lottery 专用请求层：

```typescript
// api/client.ts — cf-lottery API 客户端
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://api.example.com'

export async function cfRequest<T = unknown>(
  url: string,
  options?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
    body?: unknown
    params?: Record<string, string>
    auth?: boolean
  },
): Promise<T> {
  const token = uni.getStorageSync('mp_token') as string
  const { data } = await uni.request({
    url: `${API_BASE}${url}`,
    method: options?.method || 'GET',
    data: options?.body,
    header: {
      'Content-Type': 'application/json',
      ...(options?.auth !== false && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    timeout: 15000,
  })
  const result = data as { ok: boolean; message?: string } & Record<string, unknown>
  if (!result.ok) {
    if (result.message?.includes('登录') || result.message?.includes('过期')) {
      uni.removeStorageSync('mp_token')
    }
    throw result
  }
  const { ok, message, ...rest } = result
  return rest as T
}
```

### 5.3 认证流程适配

【代码事实】cf-lottery 认证模型与微信小程序登录流程的映射：

```
微信小程序               cf-lottery 后端
─────────────────────────────────────────
wx.login() ──→ code ──→ POST /api/auth/wechat/login
                          ├─ 调用微信 code2Session → openid
                          ├─ 查 auth_identities(provider=wechat)
                          ├─ 未找到 → 自动注册
                          ├─ 返回 JWT + 用户信息
                          ←─ { ok: true, token, isNew, user }
```

**为什么这样做**：微信小程序没有「邮箱」概念，不能直接使用 cf-lottery 的邮箱注册流程。需要后端新增 `wechat` 作为登录 provider，遵循 `auth_identities` 已有的 `provider + providerUserId` 模式。

### 5.4 支付流程

【建议】秒杀/批发支付在微信小程序内三种方案对比：

| 方案 | 实现 | 优点 | 缺点 |
|------|------|------|------|
| A: 新增 WeChat Pay provider | 后端新增 `wechatpay` provider，对接微信支付 JSAPI；前端 `wx.requestPayment` | 原生体验，支持回调通知 | 需要微信商户号，开发量大 |
| B: web-view 内嵌 H5 支付 | 小程序内打开 web-view 到 H5 版支付页（易支付 wxpay） | 无需新增 provider | 体验差、无法回调小程序、微信审核可能拒 |
| C: 导流到 H5 | 小程序内提示「请到浏览器/H5 完成支付」 | 零开发 | 转化率极低 |

**推荐路径**：MVP 先用方案 C（仅导流，不闭环支付），P1 实现方案 A。
### 5.5 触达体系

【建议】微信小程序用户触达路径：

```
┌─────────────────────────────────────────────────┐
│                 小程序前端                         │
│  wx.shareAppMessage()    wx.requestSubscribeMessage│
│  分享卡片（带 refCode）    订阅消息（开奖/秒杀）     │
└──────────────┬──────────────────────┬──────────────┘
               │ 分享到微信会话          │ 订阅请求
               ▼                       ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│ 微信社交关系链             │  │ 微信订阅消息服务           │
│ 好友点击卡片 → 打开小程序   │  │ 通过模板消息推送到用户      │
│ 读取 query.refCode → 裂变 │  │ 开奖通知 / 秒杀开始 / 中奖 │
└──────────────────────────┘  └──────────────────────────┘
               │                       │
               ▼                       ▼
┌───────────────────────────────────────────────────────┐
│                  cf-lottery 后端                        │
│  wechat-adapter.ts（新增）                              │
│  ├─ wx.login → code2Session → openid                   │
│  ├─ 订阅消息推送（通过微信 API）                         │
│  ├─ 小程序码生成（wxacode.getUnlimited）                │
│  └─ 客服消息转发（可选的 webhook 到 Telegram/QQ）       │
└───────────────────────────────────────────────────────┘
```

## 6. 行业最佳实践

### 6.1 小程序包体积管理

【官方确认】微信小程序主包不超过 2MB，总包不超过 20MB（分包加载）：

- 游戏组件（转盘/刮刮卡/老虎机）的 Canvas 逻辑和图片资源占用较大
- **建议**：使用**分包**（subPackages），按页面模块分包：

```
┌─ 主包（~1.5MB）
│  ├─ 首页（活动广场）
│  ├─ 公共组件（BottomPopup, Empty, Countdown, Stepper）
│  └─ 通用工具
├─ 分包 A：活动模块（~300KB）
│  ├─ 活动详情页
│  ├─ 游戏组件（按需加载）
│  └─ 参与/结果
├─ 分包 B：个人中心（~200KB）
├─ 分包 C：秒杀/支付（~200KB）
└─ 分包 D：店铺/签到（~200KB）
```

### 6.2 安全规范

【官方确认】微信小程序安全合规要点：

1. **数据上报**：活动参与/抽奖等敏感操作必须走服务端验证，前端仅展示结果
2. **防刷机制**：cf-lottery 已有 `MemoryRateLimiter + DB rate limit`，小程序端无需额外加固
3. **用户隐私**：小程序不能强制收集用户手机号（除非业务必需），建议先用 `wx.login` 获取 openid，手机号仅用于找回/绑定
4. **内容安全**：活动标题/描述等用户生成内容需过微信内容安全检测（`msgSecCheck` / `imgSecCheck`）

### 6.3 性能优化

1. **骨架屏**：模板已有 skeleton 思路，建议每个业务页实现骨架屏提升首屏感知
2. **图片懒加载**：活动列表图片使用 `lazy-load` 属性
3. **预加载**：使用 `wx.preload` 预加载关键页面数据
4. **Canvas 降级**：复杂动画（转盘）在低端机型上降级为 CSS 动画

### 6.4 裂变设计

【行业常识】微信小程序裂变最佳实践：

1. **分享卡片**：`wx.shareAppMessage` 带上 `path?refCode=xxx`，好友打开后自动绑定邀请关系
2. **小程序码**：使用 `wxacode.getUnlimited` 生成带参数的小程序码，用于线下海报/群分享
3. **排行榜**：cf-lottery 已有 `viral-leaderboard-ui` 组件，直接移植为小程序版本
4. **双封顶**：限制每日分享奖励上限 + 总奖励上限，cf-lottery 后端 `viral-weight.ts` 已实现

### 6.5 微信生态合规

【官方确认】微信小程序运营合规要点：

1. **类目**：抽奖类小程序需选择「工具-信息查询」或「社交-社区/论坛」类目（以最新规则为准）
2. **虚拟支付**：小程序内购买虚拟商品（卡密）需使用微信支付，不能使用第三方支付
3. **诱导分享**：不得强制分享才能参与，cf-lottery 的「分享=额外 spins」模式合规（非强制）
4. **用户隐私**：小程序需配置隐私协议，用户授权后方可获取 openid/手机号
## 7. 里程碑计划

### Phase 0：基础设施（2 周）

| 任务 | 依赖 | 产出 |
|------|------|------|
| 新建 `mp/` 项目，基于 uni-app 模板初始化 | 无 | 可运行的小程序项目 |
| 实现 `api/client.ts` 请求层适配 | 无 | 所有 API 调用可正常收发 |
| 实现 `api/auth.ts` + `api/draw.ts` + `api/shop.ts` | client.ts | 基础 API 模块 |
| 后端新增 `wechat` provider + `POST /api/auth/wechat/login` | 无 | 微信登录接口 |
| 配置小程序域名白名单（`request` / `uploadFile` / `downloadFile`） | 无 | 网络连通 |
| 实现微信登录页 | auth API | 用户可登录 |

### Phase 1：核心活动流程（4 周）

| 任务 | 依赖 | 产出 |
|------|------|------|
| 首页活动广场（LandingView 移植） | 基础 API | 活动列表展示 |
| 活动详情页（GameRegistry + 8 种体验壳） | 基础 API | 用户可参与活动 |
| 参与流程（join / spin / verify-join） | 活动详情页 | 完整参与闭环 |
| 结果查询（my-result / result / card-codes） | 参与流程 | 用户可查看中奖 |
| 店铺首页（ShopView 移植） | 基础 API | 店铺品牌展示 |
| 支付流程（方案 C 导流或方案 A 微信支付） | 活动详情页 | 秒杀下单 |

### Phase 2：增值功能（3 周）

| 任务 | 依赖 | 产出 |
|------|------|------|
| 签到页面（checkin-status + join） | 核心活动流程 | 每日签到 |
| 个人中心（参与记录/中奖/卡密/订单） | 核心活动流程 | 用户资产管理 |
| 裂变分享（shareAppMessage + refCode） | 活动详情页 | 社交裂变 |
| 订阅消息（template 推送 + 前端订阅弹窗） | wechat adapter | 开奖/秒杀通知 |
| 后端 `wechat-adapter.ts` | 无 | 微信消息推送 |

### Phase 3：优化与扩展（2 周）

| 任务 | 依赖 | 产出 |
|------|------|------|
| 海报生成（Canvas） | 分享功能 | 中奖炫耀海报 |
| 小程序码生成（wxacode.getUnlimited） | 后端 | 线下推广二维码 |
| 骨架屏 + 图片懒加载 + 分包 | 所有页面 | 首屏性能优化 |
| 微信广告激励（docs/189 方案，P2） | 核心活动流程 | 看广告增加 spins |
| 客服消息接入 | wechat adapter | 用户反馈渠道 |

## 8. 风险与决策项

### 风险清单

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 微信小程序类目审核不通过（抽奖类） | 中 | 高 | 提前在微信公众平台确认类目要求，准备资质 |
| 微信支付商户号申请失败 | 中 | 高 | MVP 阶段先用方案 C 导流，同时准备材料 |
| 小程序 Canvas 2D 与 H5 差异导致游戏组件重写 | 中 | 中 | 优先使用 CSS 动画实现，Canvas 仅用于转盘等必要场景 |
| 微信订阅消息模板审核不通过 | 低 | 中 | 准备多个模板文案备用 |
| 二手后端 wechat adapter 开发工作量超预期 | 中 | 中 | 仅实现 MVP 必需接口（登录 + 订阅消息） |

### 决策请求清单

1. **小程序主体**：确认由平台方注册微信小程序、持有流量主资质？（涉及企业/个人主体、微信商户号）
2. **支付方案**：确认 MVP 是否走方案 C（导流）还是 P1 直接实现方案 A（微信支付）？
3. **登录方式**：确认是否支持「仅微信一键登录」还是需要「微信 + 邮箱绑定」双重模式？
4. **签到定位**：签到是独立功能还是抽奖系统的 spins 来源？
5. **品牌支持**：小程序是否支持多租户品牌（根据 `storeSlug` 切换主题色）？
6. **发布策略**：是否需要同时支持 H5 和微信小程序，还是先只做小程序？

## 9. 附录：参考文档索引

### 本项目文档（cf-lottery docs）

| 编号 | 文档 | 关联 |
|------|------|------|
| docs/189 | 微信小程序广告激励抽奖整合方案 | 广告变现、uni-ad 聚合、开源组件复用 |
| docs/167 | 嫁接层顶层设计（平台抽象与 Webhook 体系） | 微信平台适配器扩展基础 |
| docs/171 | 签到积分与抽奖次数体系打通方案 | 签到/spins 体系来源 |
| docs/172 | 连续签到递增奖励 | checkin-streak 复用 |
| docs/175 | spins 流水日志 | spinsLog 扩展基础 |
| docs/179 | 一次性 Web 访问令牌与跨平台身份绑定 | 卡密查看安全参考 |
| docs/128 | 全链路活动流程与转化闭环 | 活动配置/导流结构 |
| docs/130 | 秒杀活动展示壳 | flashSale 展示配置 |
| docs/131 | 秒杀卡密直付 | 支付流程、阶梯价 |
| docs/142 | 店铺首页设计 | 多租户店铺 |
| docs/158 | 支付订单 V2 批发实现 | 多件订单、阶梯价快照 |
| docs/203 | 丝滑体验审查补充 | maxPerUser 两级防护 |

### 外部参考

| 项目 | 说明 | 来源 |
|------|------|------|
| ThorUI-uniapp | 幸运转盘组件 `luckdraw.vue` | GitHub 2778 stars |
| wot-design-uni | `useRewardAd.ts` 激励视频封装 | GitHub |
| ChatGTP-uni | `task.vue` 任务中心范式 | GitHub |
| hello-uniapp | `pages/component/ad/ad.vue` 官方示例 | DCloud |
| unidocs-zh | uni-ad 官方文档全集 | DCloud |

### uni-app 模板参考

| 文件 | 复用策略 |
|------|---------|
| `src/utils/request.ts` | 参考接口设计模式，重写为 cf-lottery 适配器 |
| `src/utils/auth.ts` | 参考守卫模式，改造白名单逻辑 |
| `src/utils/upload.ts` | 直接复用 |
| `src/components/BottomPopup.vue` | 直接复用 |
| `src/components/Empty.vue` | 直接复用 |
| `src/styles/theme.css` | 参考变量命名，调整色值 |
| `src/store/` | 参考模块化模式 |
| `src/App.vue` | 参考生命周期，替换热更新 |
- **已有微信小程序调研**：docs/189 已详细分析微信广告激励、uni-ad 聚合、开源组件复用路径