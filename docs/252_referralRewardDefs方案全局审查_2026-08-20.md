# referralRewardDefs 方案全局审查报告

> 文档版本：1.0.0
> 最后更新：2026-08-20
> 审查对象：docs/250（实施方案）、docs/251（闭环分析）、已实现代码（referral-rewards-engine.ts / reward-exits.ts）
> 审查视角：上帝视角、全局思维、死磕技术细节

---

## 一、审查结论总览

| 严重度 | 数量 | 说明 |
|--------|------|------|
| 🔴 高（必须修复） | 3 | 幂等标记缺 CAS、bonus_spin 非 lottery 静默失效、recipientEmail 缺口 |
| 🟡 中（建议修复） | 3 | 优惠券无前端展示、码池耗尽无提示、配置切换遗留旧标记 |
| 🟢 低（可选优化） | 2 | 事务边界、审计完整性 |

---

## 二、🔴 高严重度问题（必须修复）

### 2.1 幂等标记 `markRewardIdsGranted` 缺少 CAS 条件

**位置**：`referral-rewards-engine.ts` 的 `markRewardIdsGranted`

**现状**：
```ts
const result = await tx.update(shareRecords)
  .set({ rewardMilestonesGranted: nextGrantedJson })
  .where(eq(shareRecords.id, recordId));  // ← 没有 CAS 条件！
```

**对比**：现有路径 [2] `processReferralMilestoneRewards` 的标记带 CAS 条件：
```ts
.where(and(
  eq(shareRecords.id, r.id),
  eq(shareRecords.rewardMilestonesGranted, String(r.rewardMilestonesGranted || "[]")),  // ← CAS
));
```

**问题**：如果两个并发请求同时处理同一个分享者的不同 shareRecord，会**互相覆盖** `rewardMilestonesGranted`，导致幂等标记丢失。例如：
- 请求 A 处理 shareRecord-1，标记 `["m1"]`
- 请求 B 处理 shareRecord-2，标记 `["m3"]`（基于旧快照 `[]`）
- 结果：shareRecord-1 变成 `["m3"]`，shareRecord-2 变成 `["m3"]`，`m1` 的标记丢失
- 下次归因时，`m1` 被重新发放（重复发放！）

**修复**：`markRewardIdsGranted` 的 UPDATE 必须带 CAS 条件（`eq(shareRecords.rewardMilestonesGranted, 旧值)`），且**检查返回值**，失败时回滚本次奖励发放。

### 2.2 `bonus_spin` 对非 lottery 类型静默失效

**位置**：`referral-rewards-engine.ts` 的 `processReferralRewardsEngine`

**现状**：对非 lottery 类型配置 `bonus_spin` 时，`grantBonusSpin` 会执行（spinsLeft +N），但分享者无法消费（`performInstantSpin` 严格限制 `activityKind === "lottery"`，`spin-execution.ts:70`）。

**问题**：奖励"发了但用不了"，用户困惑，且 spins 字段被污染。

**修复**：
1. **发布预检**：`rewardExit === "bonus_spin"` 且 `activityKind !== "lottery"` → error
2. **运行时防御**：`processReferralRewardsEngine` 中，非 lottery 时跳过 bonus_spin（或直接跳过整个 engine 路径）

### 2.3 `grantBonusCoupon` 未填充 recipientEmail

**位置**：`reward-exits.ts` 的 `grantBonusCoupon`

**现状**：发券时只写 `status: "issued"` 和 `drawId`，**没有填充 `recipientEmail`**。

**对比**：`grantLoserRewards` 会查 users 表关联邮箱并填充 recipientEmail（`draw-execution.ts:790-800`）。

**问题**：分享者获得优惠券后，**无法通过邮件收到优惠券码**。如果前端也没有展示入口（见 3.1），奖励闭环完全断裂。

**修复**：`grantBonusCoupon` 需要查询分享者 entry 的 identityValue，若是 registered 身份（user_id）还需关联 users.email，填充 recipientEmail。

---

## 三、🟡 中严重度问题（建议修复）

### 3.1 优惠券码无前端展示入口

**现状**：`myResultData.consolationCoupon`（"我的结果"弹窗）只显示 `grantLoserRewards` 发的**未中奖安慰券**（`public-lottery.ts:1338-1378`），不包含邀请奖励发的券。

**问题**：分享者邀请人后获得优惠券，但**看不到券码，无法使用**。

**修复**：
1. 后端：新增 `GET /api/public/coupons?entryId=` 查询已发放的优惠券码
2. 前端：在活动页"我的结果"弹窗中新增"邀请奖励"区域

### 3.2 码池耗尽无提示

**现状**：`grantBonusCoupon` 码池耗尽时静默返回 false，无任何提示。

**问题**：运营不知道奖励没发出去。

**修复**：发布预检 warning + 运行时记录日志。

### 3.3 配置切换遗留旧标记

**现状**：`parseGrantedRewardIds` 只保留字符串元素，过滤掉数值元素。

**问题**：如果运营先配置 `referralRewards`（写 `requireCount` 数值数组如 `[1,3]`），后来改成 `referralRewardDefs`（写 `rewardId` 字符串数组如 `["m1"]`），旧的 `rewardMilestonesGranted` 里存的是 `[1,3]`，新路径 [4] 的 `parseGrantedRewardIds` 会过滤掉数值，导致**旧里程碑被忽略，可能重复发放**。

**修复**：发布预检拦截"从 referralRewards 切换到 referralRewardDefs"时，提示运营清理旧的 `rewardMilestonesGranted` 标记（或提供迁移工具）。

---

## 四、🟢 低严重度问题（可选优化）

### 4.1 事务边界

**现状**：`processReferralRewardsEngine` 在 `joinDraw` 事务内执行，奖励发放与参与记录同事务。如果奖励发放失败（如码池耗尽），会回滚整个参与记录。

**问题**：奖励是附加行为，不应影响参与主流程。虽然 `maybeTriggerReward` 用 try/catch 包裹了，但**如果 `grantBonusCoupon` 抛异常（而非返回 false）**，会回滚参与记录。

**修复**：确保 `grantBonusCoupon`/`grantBonusSpin` 内部不抛异常（用 try/catch 包裹 DB 操作），只返回 boolean。

### 4.2 审计完整性

**现状**：`bonus_coupon` 发放没有写审计日志（只有 `bonus_spin` 写了 `spins_log`）。

**问题**：L3 无法追踪优惠券奖励的发放。

**修复**：`grantBonusCoupon` 发放后写一条 `activityEvents`（eventType: `reward_earned`）或审计日志。

---

## 五、全局视角的架构审视

### 5.1 与现有路径 [1][2][3] 的交互

| 路径 | 触发 | 幂等标记 | 奖励出口 | 与新路径 [4] 的关系 |
|------|------|---------|---------|-------------------|
| [1] grantViralSpinsToSharer | instant | spinsTotalGranted CAS | spins | 独立，无冲突 |
| [2] processReferralMilestoneRewards | instant + shareRecordId | rewardMilestonesGranted（requireCount 数组） | spins | **共用标记字段，格式不同** |
| [3] triggerRewardEarned | 归因成功 | checkDbRateLimit | 事件+webhook | 独立，无冲突 |
| [4] processReferralRewardsEngine | shareRecordId | rewardMilestonesGranted（rewardId 数组） | spins/coupon | **与 [2] 共用标记字段** |

**核心风险**：路径 [2] 和 [4] 共用 `rewardMilestonesGranted` 字段，但存储格式不同（数值数组 vs 字符串数组）。发布预检拦截了同时配置，但**配置切换（从 [2] 到 [4]）会遗留旧标记**（见 3.3）。

### 5.2 事务边界审视

`processReferralRewardsEngine` 在 `joinDraw` 事务内执行。这意味着：
- **优点**：奖励发放与参与记录原子，不会出现"参与了但奖励没发"
- **缺点**：奖励发放失败会回滚参与记录（如果抛异常）

**建议**：保持事务内执行（保证原子性），但确保奖励函数内部不抛异常（只返回 boolean），这样即使奖励失败，参与记录也能提交。

### 5.3 幂等设计审视

当前幂等设计依赖 `rewardMilestonesGranted` 字段。但存在一个**根本性问题**：

**`rewardMilestonesGranted` 是"已发放的 rewardId 列表"，但奖励发放和标记不是原子的**：
1. `grantBonusSpin` 先执行（spinsLeft +N）
2. `markRewardIdsGranted` 后执行（标记 rewardId）

如果步骤 2 失败（如 CAS 冲突），步骤 1 的 spins 已经加了，但标记没写。下次归因时，`m1` 不在标记里，会**再次发放**（重复发放）。

**修复**：奖励发放和标记必须在**同一事务**内，且标记失败时回滚发放。当前 `processReferralRewardsEngine` 在 `joinDraw` 事务内，理论上满足，但 `markRewardIdsGranted` 的 CAS 缺失（见 2.1）破坏了这一点。

---

## 六、优化后的方案（修复清单）

### 6.1 必须修复（🔴）

1. **`markRewardIdsGranted` 加 CAS 条件 + 检查返回值**
   - UPDATE 带 `eq(shareRecords.rewardMilestonesGranted, 旧值)` 条件
   - 检查 `rowsAffected`，失败时回滚本次奖励发放（抛异常让事务回滚，或返回 false 跳过）

2. **`bonus_spin` 非 lottery 拦截**
   - 发布预检：`rewardExit === "bonus_spin"` 且 `activityKind !== "lottery"` → error
   - 运行时：非 lottery 时跳过 bonus_spin

3. **`grantBonusCoupon` 填充 recipientEmail**
   - 查询分享者 entry 的 identityValue
   - registered 身份（user_id）关联 users.email

### 6.2 建议修复（🟡）

4. **优惠券前端展示入口**
   - 后端：`GET /api/public/coupons?entryId=`
   - 前端：活动页"我的结果"弹窗新增"邀请奖励"区域

5. **码池耗尽提示**
   - 发布预检 warning + 运行时日志

6. **配置切换遗留旧标记**
   - 发布预检拦截"从 referralRewards 切换到 referralRewardDefs"

### 6.3 可选优化（🟢）

7. **奖励函数内部不抛异常**（只返回 boolean）
8. **bonus_coupon 发放写审计日志**

---

## 七、结论

**当前方案的核心架构（共存式、engine 计算、幂等标记）是合理的，但存在 3 个必须修复的高严重度问题：**

1. **幂等标记缺 CAS**（并发下可能重复发放）——这是最严重的，直接威胁资金安全
2. **bonus_spin 非 lottery 静默失效**（发了但用不了）
3. **recipientEmail 缺口**（优惠券收不到）

**建议**：先修复这 3 个高严重度问题，再补中严重度的前端展示和提示，最后做可选优化。修复后重新跑全量测试确认无回归。

**特别提醒**：问题 2.1（幂等标记缺 CAS）是**并发安全缺陷**，必须用真实数据库并发测试验证修复效果（遵循"安全/漏洞分析必须用测试验证"原则）。