# 263_东八区时间解析偏移与reward_failures身份显示修复_2026-08-23

## 背景

对最近 8 个提交（6d9b66d1~c0a65396）做深度审查时发现两个中优先级问题：

1. **时区解析偏移**：commit 2e718631 引入 `formatDateCST` 声称"统一前端时间格式化为东八区"，但对**无时区字符串**（SQLite `datetime('now')` 的 `YYYY-MM-DD HH:MM:SS`、管理端 datetime-local 输入的 `YYYY-MM-DDTHH:mm`）直接 `new Date(iso)`，浏览器会按**本地时区**解释——东八浏览器把后端 UTC 时间当作本地时间，展示偏 8 小时，"统一东八"目标未达成。
2. **reward_failures 身份缺失**：commit c0a65396 给失败列表加 `decorateIdentityDisplay`，但该函数只处理 `user_id` 身份；open 模式（email 身份）的记录没有 `identityDisplay`，而接口返回前又删除 `identityType/identityValue` 内部字段，运营者只能看到 entryId 前 8 位，看不到对应邮箱。

## 根因

### 问题 1：三种时间格式语义不同，前端无法一刀切

API 返回的时间字符串存在三种格式（历史原因）：

| 格式 | 示例 | 来源 | 语义 |
|---|---|---|---|
| SQLite UTC | `2026-08-23 01:00:00` | `datetime('now')` 生成 | UTC |
| datetime-local | `2026-08-23T09:00` | 管理端输入 | 运营者东八时间 |
| ISO 带时区 | `2026-08-23T01:00:00.000Z` | `toISOString()` / 测试 seed | 标准 |

实证（Node `TZ=Asia/Shanghai`）：`new Date('2026-08-23 01:00:00')` → `2026-08-22T17:00:00Z`（被当本地时间），`toLocaleString` 上海展示 `01:00`；而正确应为 UTC 01:00 → 上海 09:00。**东八浏览器上后端 UTC 时间偏 8 小时**。

### 问题 2：decorateIdentityDisplay 提前 return 短路了 email 分支

`userIds.length === 0`（全部为 email 身份）时直接 `return`，且循环内只处理 `user_id`——email 分支从未执行。

## 解决方案

### 修复 1：`frontend/src/composables/useFormat.ts` — `toCSTDate` 按来源格式补时区

新增导出 `toCSTDate(iso)`（独立导出便于单测）：

1. 结尾带 `Z` 或 `±HH:mm` → 标准解析，不补时区；
2. `YYYY-MM-DD HH:MM:SS`（空格分隔、无 T）→ SQLite UTC，补 `Z`；
3. `YYYY-MM-DDTHH:mm(:ss)?`（无时区 ISO）→ 管理端东八录入，补 `+08:00`；
4. 其余回退 `new Date(iso)` 原行为（不抛错）。

`formatDateCST` 改走 `toCSTDate`。修复后任何浏览器下：UTC 01:00 → 上海 09:00；东八录入 09:00 → 上海 09:00，展示一致。

**未改动**：`formatDate`（已无调用点）、`toDateTimeLocalValue`/`dateTimeLocalToIso`（输入转换，语义为本地时间，不涉及展示统一）。

### 修复 2：`src/routes/admin-lottery-helpers.ts` — `decorateIdentityDisplay` 支持 email

- 去掉"userIds 为空即 return"的短路（否则全 email 场景 email 分支永不执行）；
- 循环内新增：`identityType === 'email'` → `identityDisplay = identityValue`（邮箱本身即可读）。

影响面：6 个调用点（中奖名单、候选池、审核、失败列表），email 身份统一获得可读身份；reward_failures 删除内部字段后前端可正常展示。

### 测试

- 新建 `frontend/src/composables/useFormat.test.ts`（9 例）：`toCSTDate` 断言用 `toISOString()`（恒为 UTC 格式，与运行环境 TZ/ICU 无关）；`formatDateCST` 用宽松断言（包含 `09:00`）。已在 `vitest.config.ts` include 显式登记。
- `src/routes/admin-lottery.test.ts` 新增 FAILURES describe（3 例）：email 身份返回邮箱且内部字段被清理；user_id 身份解析为 `用户名（邮箱）`；活动不存在 404。

## 验证

- `npx vitest run src/routes/admin-lottery.test.ts`：90 tests 全过（含新增 3 例）
- `npx vitest run frontend/src/composables/useFormat.test.ts`：9 tests 全过
- `npx tsc --noEmit`：0 errors
- `cd frontend && npx vue-tsc -b --pretty false`：0 errors

## 建议

- 根治时区问题仍需后端统一输出带时区 ISO（当前方案是前端启发式兜底，依赖格式约定）；
- 若未来引入新的时间字段，应统一使用 `datetime('now')`（UTC）或 `toISOString()`（带 Z），避免再产生第三种"无时区本地时间"字符串。
