# referralRewardDefs 闭环审查报告（第二版）

> 文档版本：2.0.0
> 最后更新：2026-08-20
> 前置：docs/250（实施方案）、docs/251（闭环分析）、docs/252（全局审查第一版）
> 重点：**三级用户体系 × 各环节的闭环完整性**

---

## 一、闭环全景（L1/L2/L3 各环节状态）

```
┌─ L2 配置 referralRewardDefs ──→ ✅ 已实现（promotionConfig）
│      │
│      ▼
├─ L1 分享者生成分享码 ────────→ ✅ 已实现（POST /draws/:slug/share，无 activityKind 限制）
│      │
│      ▼
├─ L1 新用户通过 ?ref= 参与 ───→ ✅ 已实现（joinDraw，open 模式）
│      │
│      ▼
├─ recordAttributedJoin 归因 ──→ ✅ 已实现（joinedCount +1，自邀请拦截）
│      │
│      ▼
├─ processReferralRewardsEngine ─ ✅ 已实现（engine 计算 + 幂等过滤）
│      │
│      ▼
├─ 奖励出口：bonus_spin ───────→ ✅ 闭环（发放→spins→lottery 抽奖消费→spins_log 审计）
│      │                          └ bonus_coupon：⚠️ 部分闭环（发放→审计，但 L1 展示有缺口）
│      │
│      ▼
├─ L1 使用奖励 ────────────────→ 🟡 bonus_spin 可用；bonus_coupon 非 lottery 展示有缺口
│      │
│      ▼
└─ L3 监督（跨租户） ──────────→ ✅ 闭环（activityEvents reward_earned / audit）
```

---

## 二、各环节闭环状态详表

| # | 环节 | 状态 | 说明 |
|---|------|------|------|
| 1 | L2 配置 referralRewardDefs | ✅ | 发布预检校验合法性 |
| 2 | L1 分享者生成分享码 | ✅ | 所有活动类型通用 |
| 3 | L1 新用户参与归因 | ✅ | 所有活动类型通用 |
| 4 | engine 计算奖励 | ✅ | conditions 过滤 + rewardExit 分发 |
| 5 | bonus_spin 发放 | ✅ | CAS 防护 + spins_log 审计 |
| 6 | bonus_coupon 发放 | ✅ | CAS 防护 + recipientEmail（已修复）+ reward_earned 审计（已修复） |
| 7 | **L1 看到 bonus_spin 奖励** | ✅ | 活动页 spinesLeft 可见 |
| 8 | **L1 看到 bonus_coupon 奖励** | 🟡 | lottery 活动：consolationCoupon 可查；非 lottery：**看不到** |
| 9 | L1 消费 bonus_spin | ✅ | performInstantSpin 抽奖 |
| 10 | L1 核销 bonus_coupon | 🟡 | 仅 L2 管理端 API，L1 无自助核销（现有设计边界） |
| 11 | L2 查看奖励发放 | 🟡 | getActivityEventSummary 有数据，前端漏斗未展示 reward_earned |
| 12 | L3 跨租户监督 | ✅ | activityEvents 可查 |

---

## 三、关键发现

### 3.1 已确认正确的环节

**a) `maybeTriggerReward` 的 draw 类型标注不影响运行**（docs/252 §4.1 补充确认）
- `joinDraw` 使用 `.select()`（全字段）查 draw，`draw.activityKind` 在运行时可用
- `processReferralRewardsEngine` 的 `activityKind` 类型标注为可选，TypeScript 结构类型允许
- **代码正确**，仅类型标注不完整（`maybeTriggerReward` 的 draw 类型缺 `activityKind`）
- **可选优化**：在 `maybeTriggerReward` 的 draw 类型中补充 `activityKind?: string | null`，使类型标注与运行时一致

**b) `bonus_coupon` 审计闭环**（本轮已修复）
- `grantBonusCoupon` 写 `activityEvents`（`reward_earned`），metadata 含 rewardExit/rewardId/couponLabel/couponCode/recipientEmail
- L3 平台运营者可跨租户追踪优惠券奖励发放
- 与 bonus_spin 写 spins_log 对齐

### 3.2 闭环缺口（需确认/排期）

**缺口 A：非 lottery 活动的 bonus_coupon 券码，L1 用户看不到**
- `my-result` API 的 `consolationCoupon` 查询条件：`resultFamily === "lottery" && !won` + `recipientEmail = identityValue`
- `grantBonusCoupon` 已填充 recipientEmail → lottery 活动的邀请券可被查到
- 但**非 lottery 活动**（claim/survey/vote 等）的 `resultFamily` 不是 lottery，邀请券查不到
- **影响**：非 lottery 活动的 `bonus_coupon` 奖励，分享者拿不到券码（发券成功但用户不知情）

**缺口 B：`consolationCoupon` 只取第一条**
- 如果用户同时有安慰券和邀请券（都满足 `recipientEmail = identityValue`），`limit(1)` 只返回一条
- 可能显示安慰券而隐藏邀请券

**缺口 C：L2 管理端前端未展示 reward_earned**（数据已有，UI 未接）
- `getActivityEventSummary` 返回 `totals`（含 `reward_earned`）
- `useDrawAnalytics` 的漏斗卡片未展示 `reward_earned`
- **影响**：L2 运营者看不到邀请奖励发放统计

**缺口 D：L1 无自助核销优惠券**
- `POST /api/admin/coupons/redeem` 仅 L2 管理员可用
- **这是现有优惠券系统的设计边界**（grantLoserRewards 的安慰券也有同样限制），非 referralRewardDefs 引入的新问题
- 核销场景：用户拿着券码，联系运营/客服核销

---

## 四、修复建议（按优先级）

### P0（本轮已完成）
| # | 修复 | 状态 |
|---|------|------|
| 1 | markRewardIdsGranted 加 CAS | ✅ |
| 2 | bonus_spin 非 lottery 拦截 | ✅ |
| 3 | grantBonusCoupon 填充 recipientEmail | ✅ |
| 4 | bonus_coupon 审计（reward_earned） | ✅ |
| 5 | 发布预检检查 | ✅ |

### P1（需前端/接口配合，单独排期）
| # | 缺口 | 建议 |
|---|------|------|
| A | 非 lottery 邀请券看不到 | 后端新增 `GET /api/public/my-rewards?entryId=` 返回该用户全部已发奖励（含 spins/coupon），前端展示 |
| B | consolationCoupon 只取一条 | `my-result` 返回 `coupons: string[]`（数组）而非单条 |
| C | L2 前端未展示 reward_earned | `useDrawAnalytics` 漏斗卡片新增"奖励发放"卡片（读 `events.totals.reward_earned`） |

### P2（可选）
| # | 缺口 | 建议 |
|---|------|------|
| D | L1 无自助核销 | 新增公开核销 API `POST /api/public/coupons/redeem`（需安全设计：验证码/OAuth） |

---

## 五、结论

**referralRewardDefs 的核心闭环（配置→参与→归因→计算→发放→审计）已形成：**

- ✅ **bonus_spin 出口**：完整闭环（发放→spins→lottery 抽奖消费→spins_log 审计→L3 可查）
- ✅ **bonus_coupon 出口**：发放/审计闭环完成（recipientEmail + reward_earned），**但 L1 展示有缺口**（非 lottery 活动券码看不到）
- ✅ **L3 监督**：闭环（activityEvents reward_earned）
- 🟡 **L2 可视化**：数据已就绪（getActivityEventSummary），前端漏斗未接 reward_earned
- 🟡 **L1 自助核销**：现有设计边界，非新问题

**建议**：P1 的缺口 A（非 lottery 邀请券展示）是 `bonus_coupon` 出口形成完整 L1 闭环的关键，建议优先排期。缺口 C（L2 前端展示 reward_earned）成本极低（一个卡片），可一并做。缺口 D（L1 自助核销）涉及安全设计，建议评估后再定。