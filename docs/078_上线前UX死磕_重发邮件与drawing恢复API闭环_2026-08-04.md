# 078 上线前 UX 死磕：重发邮件与 drawing 恢复 API 闭环

> 日期：2026-08-04  
> 原则：死磕用户路径；低成本；有证据；不拆巨页  
> 承接：docs/076–077（邮件失败可感知、轮询收敛）— 但「重发」按钮此前打空路由

---

## 一、问题（代码证据）

| 路径断点 | 证据 | 用户感受 |
|----------|------|----------|
| 管理端「重发邮件」 | 前端 `retryAdminLotteryEmail` → `POST /api/admin/draws/:id/retry-email`；**全仓无后端路由** | 按钮存在，请求 404；076/077 toast 闭环空转 |
| 管理端 drawing「恢复」 | 前端 `recoverLotteryDraw` → `POST .../recover`；**无后端路由** | 卡死 drawing 无法人工恢复 |
| 单条 `winners/:id/resend` | 仅 `notificationStatus=pending`，**无发送、无 cron 扫 pending 通知** | 「重发」只改状态，邮件永不发出 |
| `sendWinnerNotifications` | 无返回值 | 运营台无法 toast `sent/failed` 计数 |

前端证据：

- `frontend/src/views/admin/lottery/api.ts`：`retry-email` / `recover`
- `AdminLotteryView`：`handleRetryEmail` / `handleRecover`
- Dashboard 待办文案「打开查看结果可重发」（docs/076）

---

## 二、本轮改动

### 1. `sendWinnerNotifications` 返回 `{ sent, failed }`

- 仍跳过已 `sent`
- 每人独立 try/catch，失败互不影响
- 开奖 fire-and-forget 调用方忽略返回值即可（兼容）

### 2. `POST /draws/:id/retry-email`

- 租户隔离 + 仅 `status===drawn`
- 同步调用 `sendWinnerNotifications`
- 响应 `{ sent, failed }` 对齐前端契约
- 审计 `draw.retry_email`

### 3. 单条 `POST /draws/:id/winners/:winnerId/resend`

- 重置 pending 后**同步发送**（不再空改状态）
- 仍复用整活动发送（跳过已 sent，顺带处理同活动 failed）

### 4. `POST /draws/:id/recover`

- 仅 `drawing`
- `healDrawingState(..., { force: true })`：有中奖 → `drawn`；无中奖 → `open`（不等 5 分钟超时）
- 审计 `draw.recover`

### 5. `healDrawingState` 增加 `force`

- cron 默认仍看 `staleMs`
- 运营手动恢复可 force 回滚 open

### 6. 测试

- `p0-flow.test.ts`：retry-email 成功/非 drawn 拒绝；recover 有/无中奖

---

## 三、刻意不做

- 不新增独立「pending 邮件」cron（重发为同步；开奖仍 fire-and-forget）
- 不 N+1 列表预拉 per-draw 失败数（076 已说明）
- 不拆 AdminLotteryView 巨页（P2）
- 不改前端 API 路径（补后端对齐既有契约）

---

## 四、验收

```bash
npx tsc --noEmit
npx vitest run
# 重点：src/routes/p0-flow.test.ts -t "retry-email|recover"
npm run type-check:frontend
npm run frontend:build
```

人工：

1. 已开奖活动，中奖通知 failed → 点「重发邮件」→ toast 成功数，名单状态变已发送  
2. 活动卡在 drawing 且已有 winners → 恢复 → drawn  
3. drawing 无 winners → 恢复 → open，可再开奖  

---

## 五、055a 增量（诚实）

| 项 | 变化 |
|----|------|
| 开奖邮件闭环 | **重发真正发信**（076/077 感知层 + 本轮执行层） |
| drawing 卡死 | **运营可恢复** |
| 整体 | 约 **94–96%**；P2 巨页拆分仍未做 |
