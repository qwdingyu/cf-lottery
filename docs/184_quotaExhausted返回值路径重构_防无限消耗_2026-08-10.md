# 抽奖次数耗尽异常改为返回值路径（P0 防无限消耗）

## 背景

`executeSpinCommand` 调用 `performInstantSpin` 时，若次数耗尽（`spin.quota.exhausted`），底层通过 `SpinBusinessError` 异常抛给调用方。调用方在 `catch` 中捕获后返回友好提示。

**风险**：异常路径与正常返回值混合，未来若有人在事务内、CAS 扣次之后新增 `SpinBusinessError` throw，会导致：

1. 扣次已发生但事务回滚——用户可重试（正确）
2. 扣次已发生但事务不回滚——用户无法重试但次数已扣（灾难）

## 修复

将 `spin.quota.exhausted` 从异常路径改为返回值路径，设计原则：

- `performInstantSpin` 对业务逻辑错误（quota exhausted）**不再抛异常**，而是返回一个 `SpinResult` 并携带 `businessError` / `businessErrorCode` 字段
- 调用方通过检查 `result.businessError` 来判断是否发生业务拒绝，而非依赖 `catch` 块
- `SpinBusinessError` 仅保留给**前置校验错误**（draw not found、entry required 等），这些错误发生在事务之前，不可能有扣次

### 改动文件

1. **`src/services/lottery/spin-execution.ts`**：
   - `SpinResult` 新增 `businessError?: string` 和 `businessErrorCode?: string` 可选字段
   - 事务内 `quotaExhausted` 分支改为返回 `{ kind: "quotaExhausted", spinsLeft }`，不再 `throw`
   - 事务后处理 `quotaExhausted` 分支，构造 `SpinResult` 返回（spinId=""，businessError 非空）

2. **`src/services/platform/commands.ts`**：
   - `executeSpinCommand` 新增 `result.businessError` 检查，在正常流程中返回引导文案
   - 抽取 `buildQuotaPurchaseGuide` 辅助函数，消除 `catch` 块中的购买引导逻辑
   - `catch` 块简化，移除 `spin.quota.exhausted` 分支处理

3. **`src/routes/public-lottery.ts`**：
   - 新增 `result.businessError` 检查，返回 `fail(c, ...)` 错误响应

4. **`src/services/lottery/spin-execution.test.ts`**：
   - 更新 `maxSpins=1 第二次 spin` 测试：从 `rejects.toMatchObject` 改为 `businessError` 断言
   - 更新并发双 spin 测试：从 `1 fulfilled + 1 rejected` 改为 `2 fulfilled`，通过 `businessErrorCode` 区分

## 安全验证

- 所有 66 个相关测试用例通过（commands 47 + spin-execution 19 → 后增至 22）
- TypeScript 类型检查零错误（修改文件）
- 覆盖了 quota exhausted 的回归路径、并发竞态、购买引导组合

## 二次审查（2026-08-10）

### 排查范围

对全部关键业务流进行系统性审计，检查"state mutation → throw business error"模式：

| 业务流 | 审计结论 |
|--------|---------|
| `performInstantSpin` (spin-execution.ts) | ✅ 已修复。事务内唯一业务错误 quotaExhausted 改为返回值路径 |
| `joinDraw` (participation.ts) | ✅ 事务体内全部使用 return 值，无 throw-after-mutation |
| `handlePaymentCallback` (payment-service.ts) | ✅ 所有 throw 在 `withDbTransaction` 内，事务回滚自动补偿 |
| `retryPaymentFulfillment` (payment-service.ts) | ✅ 同上 |
| `createPaymentOrder` (payment-service.ts) | ✅ throw 在 mutation 前，或事务内自动回滚 |
| `performDraw` (draw-execution.ts) | ✅ 事务体内无业务错误 throw；catch 块 heal 状态 |
| `cancelDraw` (draws.ts) | ✅ throw 在 CAS update 前，无 mutation 泄漏 |
| `executeCheckinCommand` (commands.ts) | ✅ CAS update 后全部 return 值，无 throw |
| `executeSpinCommand` (commands.ts) | ✅ 已适配 businessError 返回值路径 |
| `redeemRedemptionCode` (admin-lottery-integrations.ts) | ✅ 全部在 `withDbTransaction` 内，回滚安全 |
| `recordExternalConversion` (integration.ts) | ✅ throw 在 INSERT 前 |
| `enforceGroupMemberCap` (community-policy.ts) | ✅ 使用 return flag 而非 throw |
| `recordActivityEvent` (integration.ts) | ⚠️ 编程守卫 throw 在 mutation 后，但事件类型为编译时常量，不可达 |

### 剩余 SpinBusinessError 全部在事务前

`performInstantSpin` 中所有 `SpinBusinessError` 抛出点（not_found, not_lottery, not_instant, not_open, out_of_window, not_configured, entry.required, payment.required, idempotency.required）均在事务开始前（line 167 之前），不涉及任何状态变更，安全。

### 额外发现的并发剩余次数虚高问题（已修复）

**问题**：`quotaExhausted` 分支原使用事务外预读的 `entry.spinsLeft` 回填剩余次数。并发场景下（如两人同时 spin），预读值可能较高（如两人都读到 1），导致响应中返回虚高的剩余次数。

**修复**：事务内重新 `SELECT spinsLeft`，保证返回的 `spinsLeft` 与库内真实值一致（BEGIN IMMEDIATE 串行化写锁，能读到竞争者已提交的扣减结果）。

**验证**：concurrency test 新增断言 `expect(exhausted!.value.spinsLeft).toBe(0)`，强化回归覆盖。

## 结论

代码库中不存在其他"throw-after-mutation"导致的无限消耗/状态不一致问题。`SpinBusinessError` 全部仅用于事务前的前置校验，事务内业务错误已改为返回值路径。建议后续新增业务逻辑错误时遵循此模式：**返回值优先，异常仅用于前置校验或不可恢复的错误**。