/**
 * libsql 连接创建成本对照基准（本地 SQLite）
 *
 * 背景（docs/191）：cf-lottery 的 DB 中间件在【每个请求】都执行 createClient + PRAGMA journal_mode=WAL。
 * 本地 SQLite 部署下，这是否是主要性能瓶颈？本脚本在 Node 进程内做受控对照，排除 HTTP/框架/机器负载干扰。
 *
 * 场景：
 *   A. 复用单个连接执行 SELECT
 *   B. 每请求新建连接 + SELECT + close（当前生产行为）
 *   C. 复用连接 + 每 SELECT 前执行 PRAGMA journal_mode=WAL（模拟中间件每请求 PRAGMA）
 *
 * 用法：node scripts/benchmark-db-connection.mjs [数据库文件路径]
 */
import { createClient } from "@libsql/client";

const DB = process.argv[2] || "/tmp/cf-lottery-bench.db";
const N = 2000; // 每场景执行次数（B 场景新建连接较慢，用 N 次）

const SQL = "select count(*) as n from lottery_draws";

async function time(name, fn, iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    await fn(i);
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`${name.padEnd(46)} ${(ms / iterations).toFixed(3)} ms/次  (${iterations} 次共 ${ms.toFixed(0)}ms)`);
  return ms / iterations;
}

// 预热（复用连接场景需要连接已建立）
const warm = createClient({ url: `file:${DB}` });
await warm.execute(SQL);
await warm.close();

console.log(`数据库: ${DB}`);
console.log("");

// A. 复用单个连接
const shared = createClient({ url: `file:${DB}` });
await time("A. 复用连接 SELECT", () => shared.execute(SQL), N);
await shared.close();

// B. 每请求新建连接 + SELECT + close
await time("B. 每请求 createClient+SELECT+close", async () => {
  const c = createClient({ url: `file:${DB}` });
  try {
    await c.execute(SQL);
  } finally {
    await c.close();
  }
}, N);

// C. 复用连接 + 每请求执行 PRAGMA WAL（模拟中间件行为）
const shared2 = createClient({ url: `file:${DB}` });
await time("C. 复用连接+每请求 PRAGMA WAL+SELECT", async () => {
  await shared2.execute("PRAGMA journal_mode = WAL");
  await shared2.execute(SQL);
}, N);
await shared2.close();

// D. 本地 createClient（不查询）—— 回答「health 无查询时每请求建连成本」
await time("D. 本地 createClient+close（不查询）", async () => {
  const c = createClient({ url: `file:${DB}` });
  await c.close();
}, Math.min(N, 500));

// E. 远程 createClient（不查询，懒连接验证）—— 回答「为何远程 health 反而快」
// 需通过环境变量提供：TURSO_URL=libsql://... TURSO_TOKEN=...
const REMOTE = process.env.TURSO_URL;
if (REMOTE) {
  await time("E. 远程 createClient+close（不查询）", async () => {
    const c = createClient({ url: REMOTE, authToken: process.env.TURSO_TOKEN });
    await c.close();
  }, 100);
} else {
  console.log("E. 远程 createClient+close（不查询）   跳过（未设置 TURSO_URL）");
}

console.log("");
console.log("解读：B/A 的倍数 ≈ 每请求建连的额外开销；C/A 的倍数 ≈ PRAGMA 每请求执行的额外开销");
console.log("D vs E：D 是本地 file: 打开文件的实际 I/O；E 若接近 0 说明远程客户端是懒连接（不查询不建连）");
