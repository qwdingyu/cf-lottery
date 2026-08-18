# request_logs + consumeOnce + 5/6 项核查（docs/243）

## 完成状态总览

| # | 项 | 状态 | 说明 |
|---|-----|------|------|
| 1 | staleAssetRecovery | ✅ 已完成（docs/242）| |
| 2 | CSP nonce | ✅ 已完成（docs/242）| |
| 3 | request_logs | ✅ **本次实施** | 表 + writeRequestLog + enforceRateLimit |
| 4 | consumeOnce | ✅ **本次实施** | 表 + consumeOnce 函数 + 测试 |
| 5 | 纯函数层 | ✅ 已存在，无需新增 | `ops-utils.ts` 已覆盖 cf-shop lottery-ops 全部能力 |
| 6 | shared/ 契约层 | ✅ 已满足，无需新增 | `DRAW_STATUS` 后端集中定义，前端 string 消费无重复 |

## 3. request_logs（docs/243）

- 迁移 `0064_request_logs.sql`：`request_logs` 表（id/ip_hash/method/path/action/status_code/created_at + 索引）
- schema `requestLogs` 表
- `src/lib/request-log.ts` 的 `writeRequestLog(c, action, statusCode, ipHash?)`：
  - ipHash 默认 `hashEventValue(getClientIp(c))`（与参与流程 IP 哈希一致）
  - 写失败 fire-and-forget 不影响主流程
- `src/lib/rate-limit.ts` 新增 `enforceRateLimit`：限流拒绝时自动写 request_logs（429）
- 测试：`request-log.test.ts`（3 用例：写日志/重放/空 token）
- `test-setup.ts` 的 `clearTestData` 新增清理 request_logs/consume_once_tokens

## 4. consumeOnce（docs/243）

- 迁移 `0065_consume_once_tokens.sql`：`consume_once_tokens` 表（复合主键 action+subject_hash + created_at 索引）
- schema `consumeOnceTokens` 表（drizzle 复合主键）
- `src/lib/request-log.ts` 的 `consumeOnce(c, action, token)`：
  - subjectHash = sha256(action:token)（不落明文 token）
  - `onConflictDoNothing` 原子防重放：首插成功 → ok；重放 → already_used
- 测试：`request-log.test.ts` 重放返回 already_used、空 token 返回 empty_token 不触库
- **当前无直接业务调用点**（cf-lottery 认证用 OAuth code 由 IdP 保证一次性，无需 consumeOnce），功能就绪可随时用于登录链接/验证码防重放

## cf-core 重合审查

| 能力 | cf-core 是否有 | 结论 |
|------|--------------|------|
| request_logs | ❌ 无 | 本地实现（调用模式绑定路由，不适合抽象）|
| consumeOnce | ❌ 无函数（有 rate_limit_windows 表但用于计数限流）| 本地实现（直接用 drizzle 复合主键，无需改 cf-core）|

## 验证

```
tsc 0；vue-tsc 0；build 成功；vitest 1363 passed（95 files，新增 3 用例）
```