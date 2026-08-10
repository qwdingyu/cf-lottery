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

- 所有 66 个相关测试用例通过（commands 47 + spin-execution 19）
- TypeScript 类型检查零错误（修改文件）
- 覆盖了 quota exhausted 的回归路径、并发竞态、购买引导组合

## 建议

后续若新增业务逻辑错误，应遵循此模式：**返回值优先，异常仅用于前置校验或不可恢复的错误**。