/**
 * Hono 框架性能基准测试（cf-lottery）
 *
 * 用途：量化 Hono 在 VPS（Node + SQLite）部署形态下的真实吞吐与延迟，
 * 回答「沿用 Hono 是否构成性能瓶颈」的框架选型问题。
 *
 * 用法：
 *   1. 启动被测服务（本地 SQLite）：
 *      DATABASE_URL=file:/tmp/cf-lottery-bench.db PORT=8799 npm run dev:local
 *   2. 运行本脚本（自动准备测试数据并调用 wrk 压测）：
 *      npx tsx scripts/benchmark-hono.ts
 *
 * 环境变量：
 *   DATABASE_URL — 被测库（默认 file:/tmp/cf-lottery-bench.db）
 *   BASE_URL     — 被测服务地址（默认 http://localhost:8799）
 *   WRK_DURATION — 单端点压测时长秒（默认 10）
 *
 * 压测端点：
 *   GET  /api/health                纯框架 + 中间件栈（无 DB 查询，但含每请求 createClient）
 *   GET  /                          静态 index.html（serveStatic）
 *   GET  /api/public/home-activities   DB 读（公开活动列表）
 *   GET  /api/public/draws/:slug     DB 读（活动详情 + 关联查询）
 */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  tenants,
  lotteryDraws,
  lotteryPrizeTiers,
  prizes,
  prizeCodes,
  lotteryEntries,
} from "../src/db/schema";

const DB_URL = process.env.DATABASE_URL || "file:/tmp/cf-lottery-bench.db";
const BASE_URL = process.env.BASE_URL || "http://localhost:8799";
const DURATION = process.env.WRK_DURATION || "10";
const TENANT = "bench-tenant";
const SLUG = "bench-demo";

async function seed() {
  const client = createClient({ url: DB_URL });
  const db = drizzle(client);

  // 幂等：重复运行不重复插入
  const existing = await db.select({ id: lotteryDraws.id }).from(lotteryDraws).where(eq(lotteryDraws.publicSlug, SLUG)).limit(1);
  if (existing.length > 0) {
    console.log(`[seed] 活动 ${SLUG} 已存在，跳过`);
    return;
  }

  const now = new Date();
  await db.insert(tenants).values({ id: TENANT, name: "Benchmark" }).onConflictDoNothing();
  const drawId = randomUUID();
  await db.insert(lotteryDraws).values({
    id: drawId,
    tenantId: TENANT,
    publicSlug: SLUG,
    title: "Benchmark 公开活动",
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    resultMode: "instant",
    allocationPolicy: "capacity",
    startAt: new Date(now.getTime() - 86400000).toISOString(),
    endAt: new Date(now.getTime() + 86400000).toISOString(),
    maxSpinsPerEntry: 100,
    winnerCount: 1,
    showParticipantCount: 1,
    showWinnerCount: 1,
  });
  const prizeId = randomUUID();
  await db.insert(prizes).values({
    id: prizeId,
    tenantId: TENANT,
    name: "基准奖品",
    prizeType: "code",
    totalCount: 1000,
  });
  await db.insert(lotteryPrizeTiers).values({
    id: randomUUID(),
    tenantId: TENANT,
    drawId,
    prizeId,
    tierName: "一等奖",
    winnerCount: 1000,
    sortOrder: 100,
    weight: 10,
  });
  // 卡密池：1000 张可用码，保证 spin 中奖可取
  const codes = Array.from({ length: 1000 }, (_, i) => ({
    id: randomUUID(),
    tenantId: TENANT,
    prizeId,
    code: `BENCH-${String(i).padStart(5, "0")}`,
    status: "available",
  }));
  await db.insert(prizeCodes).values(codes);
  // 一个参与 entry（spinsLeft=100），便于热路径写压测
  await db.insert(lotteryEntries).values({
    id: randomUUID(),
    tenantId: TENANT,
    drawId,
    identityType: "email",
    identityValue: "bench@example.com",
    displayName: "bench",
    spinsLeft: 100,
    spinsTotalGranted: 100,
    ipHash: "bench",
  });
  await client.close();
  console.log(`[seed] 数据就绪：租户=${TENANT} slug=${SLUG} 奖档=1 卡密=1000 entry=1`);
}

function wrk(name: string, path: string) {
  console.log(`\n=== ${name} ===`);
  const out = execSync(`wrk -t4 -c50 -d${DURATION}s ${BASE_URL}${path}`, { encoding: "utf8" });
  // 提取关键指标
  const rps = out.match(/Requests\/sec:\s+([\d.]+)/)?.[1] || "?";
  const transfer = out.match(/Transfer\/sec:\s+([\d.]+\w+)/)?.[1] || "?";
  const lat50 = out.match(/50%\s+([\d.]+(?:ms|s))/)?.[1] || "?";
  const lat75 = out.match(/75%\s+([\d.]+(?:ms|s))/)?.[1] || "?";
  const lat90 = out.match(/90%\s+([\d.]+(?:ms|s))/)?.[1] || "?";
  const lat99 = out.match(/99%\s+([\d.]+(?:ms|s))/)?.[1] || "?";
  console.log(`  Requests/sec: ${rps}  Transfer: ${transfer}`);
  console.log(`  Latency: p50=${lat50} p75=${lat75} p90=${lat90} p99=${lat99}`);
  return { rps, lat50, lat75, lat90, lat99 };
}

async function main() {
  console.log(`[bench] 目标库: ${DB_URL}`);
  console.log(`[bench] 被测服务: ${BASE_URL}`);
  await seed();

  const results: Record<string, ReturnType<typeof wrk>> = {};
  results["health(纯框架)"] = wrk("GET /api/health（纯框架+中间件栈）", "/api/health");
  results["静态页"] = wrk("GET /（静态 index.html）", "/");
  results["DB读-活动列表"] = wrk("GET /api/public/home-activities（DB 读）", "/api/public/home-activities");
  results["DB读-活动详情"] = wrk("GET /api/public/draws/:slug（DB 读+关联）", `/api/public/draws/${SLUG}`);

  console.log(`\n===== 汇总 =====`);
  for (const [name, r] of Object.entries(results)) {
    console.log(`  ${name.padEnd(18)} ${r.rps.padStart(8)} req/s  p50=${r.lat50}  p99=${r.lat99}`);
  }
}

main().catch((err) => {
  console.error("[bench] 失败:", err.message);
  process.exit(1);
});
