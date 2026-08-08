# SQLite → PostgreSQL 迁移代价与风险分析

日期：2026-08-08
背景：评估"后期切换到 PG 数据库"的改动量、致命风险与建议

## 一、事实统计（方言依赖精确计数）

以下数据来自 `src/` 目录的 grep 统计，**不是估算**：

| 方言依赖 | 出现次数 | 说明 |
|---------|---------|------|
| `sqliteTable` | 35 张表 | schema.ts 全部表定义，必须全量重写为 `pgTable` |
| `datetime('now')` 裸 SQL | **81 处** | 约 30 处 schema 默认值 + 50 处业务代码 |
| `MAX(0, col)`（SQLite 标量） | 3 处 | PG 需改为 `GREATEST(0, col)` |
| `INSERT OR IGNORE` | 2 处 | PG 需改为 `ON CONFLICT DO NOTHING` |
| 条件 INSERT（`tx.run(sql\`INSERT INTO ... SELECT ... WHERE\`)`） | 1 处 | `participation.ts:350`，PG 下需改为 CTE 或 FOR UPDATE |
| 迁移文件（SQLite 方言） | 10 个 SQL 文件 | `migrations/0030~0039`，全部需重写为 PG 方言 |
| 时间字段类型 | 全部 `text`（ISO 字符串） | 切 PG 可保持 `text`（最小改动），也可改为 `timestamp` |
| 布尔字段 | 全部 `integer`（0/1） | 切 PG 可保持 `integer`，也可改为 `boolean` |
| 驱动 | `@libsql/client` | 换为 `pg` / `postgres.js` / `@neondatabase/serverless` |
| 事务重试 | `isSqliteBusyError`（SQLITE_BUSY） | 需改为 PG 的错误码（40P01/40001/55P03） |
| 测试库 | 内存 SQLite（`file::memory:`） | 全部测试需换 PG 测试库 |

## 二、模块改动量评估

### 2.1 必须改（不改不能运行）

| 模块 | 文件 | 改动内容 | 预估工作量 |
|------|------|---------|-----------|
| schema.ts | `src/db/schema.ts`（724 行） | `sqliteTable`→`pgTable`，索引/约束 API 重写，类型微调 | 0.5~1 天 |
| 驱动层 | `src/db/client.ts` | 换驱动包，`createDb` 重写，`isSqliteBusyError` 改为 PG 错误码 | 0.5 天 |
| 迁移系统 | `src/db/apply-migrations.ts` + `migrations/*.sql` | 迁移脚本改为 drizzle-kit push 或 drizzle-orm migrate，历史迁移重新生成基线 | 0.5 天 |
| 启动迁移 | `src/server.ts` | 移出 PRAGMA 相关代码（WAL / busy_timeout 在 PG 下不存在） | 0.1 天 |
| 测试基础设施 | `src/test-setup.ts` | 内存 SQLite → 真实 PG 或 pg-mem 测试库 | 1~2 天 |
| 部署脚本 | `scripts/` 下的 setup/update/backup | 安装 PG、配置连接、备份策略改为 pg_dump | 0.5 天 |

**小计**：3~4.5 天

### 2.2 批量替换（机械但量大）

| 替换项 | 数量 | 做法 | 工作量 |
|-------|------|------|-------|
| `datetime('now')` | 81 处 | 全部替换为应用层 `new Date().toISOString()` 或 `sql\`now()::text\`` | 0.5 天（需逐一审核每处上下文） |
| `MAX(0, col)` → `GREATEST(0, col)` | 3 处 | 直接替换 | 0.1 天 |
| `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` | 2 处 | 直接替换 | 0.1 天 |

**小计**：0.7 天

### 2.3 不需改（Drizzle ORM 屏蔽了方言差异）

- `drizzle-orm` 的查询 API（`select`/`insert`/`update`/`delete`/`eq`/`and`/`sql\`\``）——**跨平台，无需改**
- `withDbTransaction` 的事务包裹——**逻辑不变，只改重试错误识别**
- 业务服务层代码（`payment-service.ts`、`spin-execution.ts`、`draw-execution.ts` 等）——**SQL 片段替换后即可运行**

### 2.4 必须额外修（并发语义致命差异，见第三节）

| 问题 | 位置 | 当前 | PG 下会怎样 |
|------|------|------|-------------|
| instant spin 档位名额 | `spin-execution.ts:109-130` | COUNT(winners) 无 CAS | **超发** |
| 非秒杀容量判断 | `participation.ts:350` | 条件 INSERT 依赖 SQLite 串行化 | **超发** |

**上述两个问题在 SQLite 下安全（依赖单写者语义），在 PG 的 MVCC Read Committed 下会立即超发。这不是可优化事项，是必须和迁移一起修的资金事故。**

## 三、致命风险分析

### 3.1 红色风险（导致资金事故，必须迁移前修复）

| 风险 | 触发条件 | 后果 | 修复成本 |
|------|---------|------|---------|
| instant spin 多档位超发 | 两个并发 spin 同时通过 COUNT(winners) 判断 | 一个档位发出超过 winnerCount 份奖品 | 1~2 天（加计数器 CAS） |
| 非秒杀参与超发 | 两个并发 join 的条件 INSERT 都通过 COUNT 子查询 | 活动参与人数超过 maxParticipants | 0.5 天（改用计数器） |

### 3.2 黄色风险（导致业务异常，需修复）

| 风险 | 说明 | 修复成本 |
|------|------|---------|
| 测试适配 | 全部测试基于内存 SQLite，切 PG 后测试基础设施要重建 | 1~2 天 |
| 数据迁移失败 | SQLite → PG 的数据类型不匹配（text 时间戳、integer 布尔） | 0.5 天（ETL 脚本） |
| 切换回滚困难 | 切 PG 后无法回退到 SQLite（数据格式不同） | 需要双写期 |

### 3.3 绿色风险（可接受，上线后优化）

| 风险 | 说明 |
|------|------|
| 部分查询性能变化 | PG 的查询计划器与 SQLite 不同，少数查询可能变慢，需要 explain analyze 调优 |
| 部署复杂度增加 | 多维护一个 PG 服务，备份策略从 file copy 改为 pg_dump |

## 四、总工作量与时间线

```
总工作量：5~9 人日（约 1~2 周）

其中：
  - 修并发漏洞（必做前置）：1~2 天
  - schema + 驱动 + 迁移系统：2~3 天
  - 81 处 datetime 替换 + 其余 SQL 替换：0.5~1 天
  - 测试适配：1~2 天
  - 数据迁移 + 回归验证：1~2 天
```

## 五、建议方案

### 阶段一：现在做（双赢，不依赖迁移决策）

**修并发漏洞 + 计数器化**——同时是 SQLite 下的性能优化，也是 PG 迁移的前置条件：

1. `lottery_prize_tiers` 加 `awarded` 计数器，替代 `COUNT(winners)` 判断（消除 instant spin 超发风险 + 热路径 COUNT 性能问题）
2. 普通活动也使用 `activeParticipantCount` 计数器，替代条件 INSERT 的 COUNT 子查询（消除超发风险 + 热路径性能问题）
3. 在 `index.ts` 补 `PRAGMA busy_timeout = 5000`（低风险，秒级优化）

**工作量**：2~3 天，**无论是否切 PG 都该做**。

### 阶段二：方言收拢（可选，为迁移做准备）

把裸 SQL 片段收拢到统一的工具函数，降低未来迁移的替换成本：

1. 建 `src/lib/db-time.ts`：`export const now = () => sql\`(datetime('now'))\``，替换 81 处引用。切 PG 时只改这一个函数。
2. 建 `src/lib/db-math.ts`：`export const clampZero = (col: SQL) => sql\`MAX(0, ${col})\``
3. `MAX(0,` 和 `INSERT OR IGNORE` 同理收拢

**工作量**：1 天，**可做可不做**，不做的话切 PG 时 81 处批量替换也 OK。

### 阶段三：切 PG（当日决策，1~2 周窗口）

**触发条件**：以下任一达成：
- 单场秒杀想 >5 万名额
- 活动参与者 >10 万人
- 活动事件超过 500 万行
- 需多租户实时用量看板

**做法**：
1. 重写 schema.ts 为 pg-core
2. 换驱动 + 改事务重试
3. 批量替换 SQL 方言
4. 重写迁移系统
5. 数据迁移（SQLite → PG）
6. 测试适配 + 回归验证
7. 部署切换（nginx 改连 PG）

**切换策略**：推荐**停机迁移**（非双写）。SQLite 数据量 <5GB 时，停机时间约 1~2 小时（导出 + 导入 + 验证）。双写方案复杂度过高，不值得。

## 六、结论

| 问题 | 答案 |
|------|------|
| 改动大吗？ | **中等**（5~9 人日，约 1~2 周） |
| 致命吗？ | **不致命**（架构分层清晰，不需要推倒重来），但有两个 **必修项**（否则上线就出资金事故） |
| 建议什么时候做？ | **12~18 个月内不需要做**，SQLite 够用 |
| 现在必须做什么？ | **修并发漏洞**（不论切不切 PG 都要修，且修了 SQLite 也受益） |

**最终建议**：阶段一（修并发漏洞 + 补 busy_timeout）现在做，大概 2~3 天。阶段三（切 PG）等到接近预警线时再评估，不需要提前规划。不需要为"可能有一天要切 PG"而提前做数据库无关化抽象——那是过度设计，等真需要切时再花 1~2 周做，成本可控。

**修正**：上述工作量估算基于**后端代码**。前端代码（`frontend/src/`）不涉及数据库，0 改动。测试代码（`src/*.test.ts`）需要适配，但测试模型逻辑不变，只改数据库连接方式。