# referralRewardDefs 完整闭环分析（三级用户体系 × 活动类型矩阵）

> 文档版本：1.0.0
> 最后更新：2026-08-20
> 前置：docs/250（P0-1 实施方案）、docs/249（碰撞分析）
> 核心目标：**分析 referralRewardDefs 在 L1/L2/L3 三级用户体系下，每种活动类型如何配置、如何发放、如何使用，形成完整闭环，避免灾难**

---

## 一、三级用户体系视角（谁配置、谁发放、谁使用）

### 1.1 角色与职责

| 层级 | 角色 | 与 referralRewardDefs 的关系 | 入口 |
|------|------|---------------------------|------|
| **L1 普通用户** | 参与者/分享者 | **被奖励对象**：通过分享链接邀请他人，获得 bonus_spin / bonus_coupon | `/lottery/:slug`（公开页） |
| **L2 租户管理员** | owner/admin/viewer | **配置者**：在活动 promotionConfig 中配置 referralRewardDefs | `/admin/draws`（活动编辑） |
| **L3 平台运营者** | platform_owner/operator/support | **监督者**：查看跨租户奖励发放、审计、系统配置 | `/platform/*` |

### 1.2 闭环链路（谁→谁）

```
L2 配置 referralRewardDefs（活动 promotionConfig）
        │
        ▼
L1 分享者生成分享码 → 邀请 L1 新用户参与（joinDraw）
        │
        ▼
recordAttributedJoin 归因成功（joinedCount +1）
        │
        ▼
maybeTriggerReward → processReferralRewardsEngine（engine 计算）
        │
        ▼
奖励出口：bonus_spin（抽奖次数）/ bonus_coupon（优惠券）
        │
        ▼
L1 分享者使用奖励（抽奖 / 核销优惠券）
        │
        ▼
L3 通过审计日志/活动事件监督发放（跨租户）
```

---

## 二、活动类型矩阵（核心分析）

### 2.1 关键事实（已实测验证）

| 机制 | 活动类型限制 | 说明 |
|------|------------|------|
| 分享码创建 | **无限制** | 所有活动类型参与者都能生成分享码 |
| 归因（attribution） | **无限制** | joinDraw 两个分支都调用 recordAttributedJoin |
| spins 写入 | **无限制**（非 lottery 写 0） | 由 maxSpinsPerEntry 决定，非 activityKind |
| **spin 执行** | **仅 lottery** | `spin-execution.ts:70` 严格限制 activityKind==="lottery" |
| 优惠券发券 | **无限制** | grantLoserRewards 无 activityKind 限制 |
| 优惠券核销 | **无限制** | /coupons/redeem 无 activityKind 限制 |
| ViralLeaderboard | **无限制**（仅文案区分） | 所有类型都展示，lottery 显示"邀请加次"文案 |

### 2.2 11 个活动模板 × 奖励出口适配性

| # | 模板 | activityKind | resultMode | 分享码 | spins 可用 | coupon 可用 | **推荐奖励出口** |
|---|------|-------------|-----------|--------|-----------|------------|----------------|
| 1 | lottery-wheel | lottery | manual | ✅ | ❌（delayed 无 spins） | ✅ | **bonus_coupon** |
| 2 | lottery-scratch | lottery | manual | ✅ | ❌ | ✅ | **bonus_coupon** |
| 3 | lottery-wheel-instant | lottery | instant | ✅ | ✅ | ✅ | **bonus_spin**（首选）/ bonus_coupon |
| 4 | signup-chain | signup_chain | ordered_assignment | ✅ | ❌ | ✅ | **bonus_coupon** |
| 5 | claim-download | claim | instant | ✅ | ❌（非 lottery 不能 spin） | ✅ | **bonus_coupon** |
| 6 | survey-feedback | survey | no_result | ✅ | ❌ | ✅ | **bonus_coupon** |
| 7 | vote-pick | vote | vote_tally | ✅ | ❌ | ✅ | **bonus_coupon** |
| 8 | checkin-daily | checkin | no_result | ✅ | ❌ | ✅ | **bonus_coupon** |
| 9 | approval-apply | approval | review_decision | ✅ | ❌ | ✅ | **bonus_coupon** |
| 10 | flash-sale-rush | claim | instant | ✅ | ❌（非 lottery 不能 spin） | ✅ | **bonus_coupon**（送折扣码） |
| 11 | reservation-booking | reservation | capacity_assignment | ✅ | ❌ | ✅ | **bonus_coupon** |

### 2.3 核心结论

> **⚠️ 关键约束：`bonus_spin` 出口只对 `activityKind === "lottery"` 且 `resultMode === "instant"` 有效。**
> 因为 `performInstantSpin` 严格限制 `activityKind === "lottery"`，非 lottery 活动即使给分享者加了 spins，分享者也无法消费（spin 接口 400）。

**因此：**
- **lottery + instant**（模板 3）：`bonus_spin` 首选，`bonus_coupon` 备选
- **lottery + manual**（模板 1/2）：`bonus_coupon`（delayed 无 spins 体系）
- **所有非 lottery 类型**（模板 4-11）：**只能用 `bonus_coupon`**，不能用 `bonus_spin`

---

## 三、每种活动类型的完整闭环分析

### 3.1 lottery + instant（模板 3：lottery-wheel-instant）

**配置**（L2 在 promotionConfig 写入）：
```json
{
  "referralRewardDefs": [
    {
      "rewardId": "invite_1",
      "type": "FIXED",
      "target": "SOURCE",
      "fixedAmount": "2",
      "conditions": [{ "field": "totalJoinedCount", "operator": "GTE", "value": "1" }],
      "metadata": { "rewardExit": "bonus_spin", "exitLabel": "邀请1人获2次抽奖" }
    }
  ]
}
```

**发放**（L1 分享者）：
1. 分享者生成分享码 → 邀请新用户
2. 新用户通过 `?ref=分享码` 参与 → `recordAttributedJoin` 归因成功
3. `processReferralRewardsEngine` 计算 → `grantBonusSpin` 给分享者 `spinsLeft +2`
4. 分享者用 spins 抽奖（`performInstantSpin`）

**使用**（L1）：
- 分享者在活动页看到 spins 增加，可立即抽奖
- ViralLeaderboard 显示"邀请加次"文案

**闭环**：✅ 完整。配置→归因→计算→发放→消费→审计。

### 3.2 lottery + manual（模板 1/2：lottery-wheel / lottery-scratch）

**配置**：同 3.1，但 `rewardExit` 必须用 `bonus_coupon`（delayed 无 spins 体系）。

**发放**：
1. 归因成功 → `grantBonusCoupon` 从 couponCodes 池取一张 available 码 → issued
2. 分享者获得优惠券码

**使用**：
- 分享者在活动页/我的卡密页看到优惠券码
- 通过 `/coupons/redeem` 核销

**闭环**：✅ 完整（需确认优惠券码如何展示给分享者，见 §5 缺口）。

### 3.3 signup_chain（模板 4：报名接龙）

**配置**：`bonus_coupon`（送优先名额/优惠券）。

**发放**：归因成功 → 发券。

**使用**：分享者核销优惠券。

**闭环**：✅ 完整（接龙本身有 outcome 序列号，但奖励出口是 coupon）。

### 3.4 claim-download（模板 5：资料领取）

**配置**：`bonus_coupon`（送额外领取次数/优惠券）。

**发放**：归因成功 → 发券。

**使用**：分享者核销。

**闭环**：✅ 完整。

### 3.5 survey / vote / checkin / approval / reservation（模板 6-9, 11）

**配置**：`bonus_coupon`。

**发放**：归因成功 → 发券。

**使用**：分享者核销。

**闭环**：✅ 完整（这些类型本身无 spins，coupon 是唯一出口）。

### 3.6 flash-sale-rush（模板 10：限时抢购）

**配置**：`bonus_coupon`（送折扣码/优惠券）。

**发放**：归因成功 → 发券。

**使用**：分享者核销折扣码。

**闭环**：✅ 完整（flash_sale 是直付模式，coupon 可作为折扣码）。

---

## 四、配置校验（发布预检）

### 4.1 现有检查（publish-check-service.ts）

已实现：
- `referralRewards` + `referralRewardDefs` 冲突检查（docs/250 新增）
- `referralRewardDefs` 全无效项 warning

### 4.2 需要补充的检查（闭环缺口）

**缺口 A：`bonus_spin` 出口对非 lottery 类型的拦截**
```ts
// 如果 rewardExit === "bonus_spin" 但 activityKind !== "lottery" → error
// 因为 performInstantSpin 严格限制 lottery，非 lottery 加了 spins 也无法消费
```

**缺口 B：`bonus_spin` 出口对 delayed 模式的拦截**
```ts
// 如果 rewardExit === "bonus_spin" 但 resultMode !== "instant" → error
// 因为 delayed 无 spins 体系（maxSpinsPerEntry=0）
```

**缺口 C：`bonus_coupon` 出口需要码池**
```ts
// 如果 rewardExit === "bonus_coupon" 但租户无可用 couponCodes → warning
// 提示运营先导入优惠券码池，否则奖励静默不发
```

---

## 五、闭环缺口（需修复）

### 5.1 缺口 1：`grantBonusCoupon` 未填充 recipientEmail

**现状**：`grantBonusCoupon` 发券时只写 `status: "issued"` 和 `drawId`，**没有填充 `recipientEmail`**。

**影响**：分享者获得优惠券后，**无法通过邮件收到优惠券码**（`grantLoserRewards` 会查 users 表关联邮箱并填充 recipientEmail，但 `grantBonusCoupon` 没有）。

**修复**：`grantBonusCoupon` 需要查询分享者 entry 的 identityValue，若是 registered 身份（user_id）还需关联 users.email，填充 recipientEmail。

### 5.2 缺口 2：优惠券码如何展示给分享者（已确认）

**现状**：`grantBonusCoupon` 发券后，分享者**没有前端展示入口看到优惠券码**。

**证据**：
- `myResultData.consolationCoupon`（"我的结果"弹窗）只显示 `grantLoserRewards` 发的**未中奖安慰券**（`public-lottery.ts:1338-1378`），不包含邀请奖励发的券
- `AccessCardCodesView` 是卡密访问页，不是 coupon 展示页
- `grantBonusCoupon` 只写 `couponCodes.status="issued"`，没有配套的"我的优惠券"前端查询 API

**影响**：运营配置了 `bonus_coupon` 奖励，分享者邀请人后获得了优惠券，**但看不到券码，无法使用**。奖励闭环在此断裂。

**修复**（需新增）：
1. 后端：新增 `GET /api/public/coupons?entryId=` 查询已发放的优惠券码
2. 前端：在活动页"我的结果"弹窗中新增"邀请奖励"区域，展示已发放的优惠券

### 5.3 缺口 3：`bonus_spin` 对非 lottery 的静默失效

**现状**：`processReferralRewardsEngine` 对非 lottery 类型配置 `bonus_spin` 时，`grantBonusSpin` 会执行（spinsLeft +N），但分享者无法消费（spin 接口 400）。

**影响**：奖励"发了但用不了"，用户困惑。

**修复**：发布预检拦截（缺口 A），运行时也防御（非 lottery 时跳过 bonus_spin）。

### 5.4 缺口 4：`bonus_coupon` 码池耗尽无提示

**现状**：`grantBonusCoupon` 码池耗尽时静默返回 false，无任何提示。

**影响**：运营不知道奖励没发出去。

**修复**：发布预检 warning（缺口 C）+ 运行时记录日志。

---

## 六、L1/L2/L3 各自的操作闭环

### 6.1 L1 普通用户（分享者）

```
1. 参与活动 → 生成分享码（POST /draws/:slug/share）
2. 分享链接给朋友（?ref=分享码）
3. 朋友参与 → 归因成功
4. 获得奖励（bonus_spin 加次 / bonus_coupon 优惠券）
5. 使用奖励（抽奖 / 核销优惠券）
```

### 6.2 L2 租户管理员（配置者）

```
1. 创建/编辑活动 → 配置 promotionConfig.referralRewardDefs
2. 发布预检（publish-check）校验配置合法性
3. 导入优惠券码池（如果用 bonus_coupon）
4. 查看活动分析（useDrawAnalytics）监控奖励发放
```

### 6.3 L3 平台运营者（监督者）

```
1. 查看跨租户审计日志（/platform/audit-logs）
2. 查看活动事件漏斗（activityEvents）
3. 系统配置（/platform/config）
4. 数据清理（/platform/data-cleanup）
```

---

## 七、审查清单（实施前逐项确认）

### 7.1 配置层
- [ ] `referralRewardDefs` 配置格式是否与 incentive-engine rewardDefs 一致
- [ ] `metadata.rewardExit` 白名单（bonus_spin/bonus_coupon）是否校验
- [ ] `bonus_spin` 是否限制 lottery + instant
- [ ] `bonus_coupon` 是否需要码池

### 7.2 发放层
- [ ] `grantBonusSpin` 是否受 maxSpinsPerEntry 总顶约束
- [ ] `grantBonusCoupon` 是否填充 recipientEmail
- [ ] 幂等标记（rewardMilestonesGranted）是否防重复发放
- [ ] 并发安全（CAS 乐观锁）

### 7.3 使用层
- [ ] 分享者如何看到优惠券码（前端入口）
- [ ] 分享者如何消费 spins（lottery 抽奖）
- [ ] 优惠券如何核销（/coupons/redeem）

### 7.4 监督层
- [ ] 奖励发放是否有审计日志（spins_log / activityEvents）
- [ ] L3 是否能跨租户查看奖励发放

---

## 八、结论

**referralRewardDefs 的完整闭环需要满足：**

1. **配置**：L2 在活动 promotionConfig 配置，发布预检校验合法性
2. **发放**：L1 分享者归因成功后，engine 计算奖励，按 rewardExit 分发
3. **使用**：L1 分享者能消费奖励（spins 抽奖 / coupon 核销）
4. **监督**：L3 能通过审计日志/事件查看发放

**当前已实现**：配置解析、engine 计算、bonus_spin 发放、bonus_coupon 发放、幂等、审计（spins_log）。

**需修复的闭环缺口**：
1. `grantBonusCoupon` 未填充 recipientEmail（分享者收不到优惠券邮件）
2. `bonus_spin` 对非 lottery 类型静默失效（需发布预检拦截）
3. 优惠券码展示入口需确认
4. 码池耗尽无提示

**建议**：先修复缺口 1（recipientEmail）和缺口 2（bonus_spin 类型拦截），再确认缺口 3（前端展示），最后补缺口 4（码池提示）。