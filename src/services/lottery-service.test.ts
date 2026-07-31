/**
 * 抽奖服务层核心测试
 *
 * 测试策略：
 * - randomSelect 是纯函数，直接测试
 * - createDraw / publishDraw / performDraw 等需要数据库的操作，
 *   使用 @libsql/client 创建临时文件数据库，运行 DDL 后测试
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { DbType } from "../db/client";
import { randomSelect, createDraw, publishDraw, performDraw, processDueDraws } from "./lottery-service";

/* ── 数据库设置 ───────────────────────────────────────────── */

let db: DbType;
let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  client = createClient({ url: "file:test-lottery.db" });
  db = drizzle(client);

  // 逐条执行 DDL 创建表
  const statements = [
    `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS tenant_members (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS prizes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', prize_type TEXT NOT NULL DEFAULT 'code', fulfillment_note TEXT NOT NULL DEFAULT '', total_count INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS prize_codes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, prize_id TEXT NOT NULL, code TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'available', winner_id TEXT DEFAULT '', issued_at TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS lottery_draws (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, public_slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', participation_mode TEXT NOT NULL DEFAULT 'open', draw_trigger TEXT NOT NULL DEFAULT 'manual', start_at TEXT NOT NULL, end_at TEXT NOT NULL, draw_at TEXT, access_password TEXT NOT NULL DEFAULT '', max_participants INTEGER, winner_count INTEGER NOT NULL DEFAULT 1, show_participant_count INTEGER NOT NULL DEFAULT 1, show_winner_count INTEGER NOT NULL DEFAULT 1, show_winner_list INTEGER NOT NULL DEFAULT 0, drawn_at TEXT, failure_reason TEXT NOT NULL DEFAULT '', draw_seed_hash TEXT NOT NULL DEFAULT '', algorithm_version TEXT NOT NULL DEFAULT 'uniform_v1', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS lottery_prize_tiers (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, prize_id TEXT NOT NULL, tier_name TEXT NOT NULL DEFAULT '中奖', winner_count INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 100)`,
    `CREATE TABLE IF NOT EXISTS lottery_entries (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, identity_type TEXT NOT NULL DEFAULT 'email', identity_value TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', invite_code_id TEXT DEFAULT '', ip_hash TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL, UNIQUE(tenant_id, draw_id, identity_type, identity_value))`,
    `CREATE TABLE IF NOT EXISTS lottery_winners (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, tier_id TEXT NOT NULL, entry_id TEXT NOT NULL, identity_type TEXT NOT NULL, identity_value TEXT NOT NULL, prize_code_id TEXT DEFAULT '', drawn_at TEXT NOT NULL, notification_status TEXT NOT NULL DEFAULT 'pending', notification_error TEXT NOT NULL DEFAULT '', UNIQUE(tenant_id, draw_id, entry_id))`,
    `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`,
  ];
  for (const stmt of statements) {
    await client.execute(stmt);
  }
});

afterAll(async () => {
  await client.close();
  try { require("fs").unlinkSync("test-lottery.db"); } catch {}
  try { require("fs").unlinkSync("test-lottery.db-wal"); } catch {}
  try { require("fs").unlinkSync("test-lottery.db-shm"); } catch {}
});

const TABLES = ["audit_logs","lottery_winners","lottery_entries","lottery_prize_tiers","lottery_draws","prize_codes","prizes","tenant_members","users","tenants"];
async function clearTables() {
  for (const t of TABLES) await client.execute(`DELETE FROM ${t}`);
}
beforeEach(clearTables);

/* ── 辅助 ─────────────────────────────────────────────────── */

const TENANT_ID = "test-tenant-001";
const USER_ID = "test-user-001";

function futureTime(m: number) { return new Date(Date.now() + m * 60000).toISOString(); }
function pastTime(m: number) { return new Date(Date.now() - m * 60000).toISOString(); }

import {
  lotteryDraws, lotteryEntries, lotteryWinners, prizes, prizeCodes, lotteryPrizeTiers, auditLogs,
} from "../db/schema";
import { eq } from "drizzle-orm";

async function insertDraw(ov: Record<string,any> = {}): Promise<string> {
  const id = ov.id || crypto.randomUUID();
  await db.insert(lotteryDraws).values({
    id, tenantId: TENANT_ID, publicSlug: ov.publicSlug || crypto.randomUUID().slice(0,8),
    title: ov.title || "测试", description: "", status: ov.status || "draft",
    participationMode: ov.participationMode || "open", drawTrigger: ov.drawTrigger || "manual",
    startAt: ov.startAt || futureTime(1), endAt: ov.endAt || futureTime(60),
    drawAt: ov.drawAt || null, winnerCount: ov.winnerCount || 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return id;
}
async function insertEntry(drawId: string, email: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(lotteryEntries).values({id, tenantId: TENANT_ID, drawId, identityType: "email", identityValue: email, joinedAt: new Date().toISOString()});
  return id;
}
async function insertPrize(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(prizes).values({id, tenantId: TENANT_ID, name, prizeType: "code", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()});
  return id;
}
async function insertPrizeCode(prizeId: string, code: string, secret = ""): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(prizeCodes).values({id, tenantId: TENANT_ID, prizeId, code, secret, status: "available", createdAt: new Date().toISOString()});
  return id;
}

/* ── randomSelect ────────────────────────────────────────── */

describe("randomSelect", () => {
  it("应从候选池中随机抽取指定数量", async () => {
    const s = await randomSelect([1,2,3,4,5,6,7,8,9,10], 3);
    expect(s).toHaveLength(3);
    for (const v of s) expect([1,2,3,4,5,6,7,8,9,10]).toContain(v);
  });
  it("抽取超过候选池时应返回全部", async () => {
    expect(await randomSelect([1,2,3], 10)).toHaveLength(3);
  });
  it("候选池为空应返回空", async () => {
    expect(await randomSelect([], 3)).toHaveLength(0);
  });
  it("抽取0个应返回空", async () => {
    expect(await randomSelect([1,2,3], 0)).toHaveLength(0);
  });
  it("多次抽取结果应不同（概率性）", async () => {
    const r = new Set<string>();
    for (let i=0; i<10; i++) r.add((await randomSelect([1,2,3,4,5], 3)).sort().join());
    expect(r.size).toBeGreaterThanOrEqual(2);
  });
});

/* ── createDraw ──────────────────────────────────────────── */

describe("createDraw", () => {
  it("应成功创建草稿活动", async () => {
    const {id, publicSlug} = await createDraw(db, TENANT_ID, {title: "年会", startAt: futureTime(1), endAt: futureTime(60), winnerCount: 5});
    expect(id).toBeTruthy(); expect(publicSlug).toBeTruthy();
    const [d] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id,id)).limit(1);
    expect(d!.title).toBe("年会"); expect(d!.status).toBe("draft"); expect(d!.winnerCount).toBe(5);
  });
  it("开始≥结束应报错", async () => {
    await expect(createDraw(db,TENANT_ID,{title:"x",startAt:futureTime(60),endAt:futureTime(1),winnerCount:1})).rejects.toThrow("参与开始时间必须早于结束时间");
  });
  it("定时开奖必须设置 drawAt", async () => {
    await expect(createDraw(db,TENANT_ID,{title:"x",startAt:futureTime(1),endAt:futureTime(60),drawTrigger:"scheduled",winnerCount:1})).rejects.toThrow("定时开奖必须设置开奖时间");
  });
  it("中奖名额不能为0", async () => {
    await expect(createDraw(db,TENANT_ID,{title:"x",startAt:futureTime(1),endAt:futureTime(60),winnerCount:0})).rejects.toThrow("中奖名额至少为 1");
  });
});

/* ── publishDraw ─────────────────────────────────────────── */

describe("publishDraw", () => {
  it("应成功发布草稿为 open", async () => {
    const id = await insertDraw({status:"draft"});
    expect(await publishDraw(db,TENANT_ID,id)).toBe(true);
    const [d] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id,id)).limit(1);
    expect(d!.status).toBe("open");
  });
  it("已发布的活动不能再次发布", async () => {
    const id = await insertDraw({status:"open"});
    await expect(publishDraw(db,TENANT_ID,id)).rejects.toThrow("只有草稿状态的活动才能发布");
  });
  it("不存在应报错", async () => {
    await expect(publishDraw(db,TENANT_ID,"nonexist")).rejects.toThrow("活动不存在");
  });
});

/* ── performDraw ─────────────────────────────────────────── */

describe("performDraw", () => {
  it("应抽取中奖者并写记录", async () => {
    const drawId = await insertDraw({status:"open",winnerCount:2});
    const prizeId = await insertPrize("奖品");
    await insertPrizeCode(prizeId,"C1","s1"); await insertPrizeCode(prizeId,"C2","s2");
    await insertEntry(drawId,"a@t.com"); await insertEntry(drawId,"b@t.com"); await insertEntry(drawId,"c@t.com");
    await db.insert(lotteryPrizeTiers).values({id:crypto.randomUUID(),tenantId:TENANT_ID,drawId,prizeId,tierName:"一等奖",winnerCount:2,sortOrder:100});
    const r = await performDraw(db,TENANT_ID,drawId,USER_ID);
    expect(r.drawId).toBe(drawId); expect(r.winnerCount).toBeGreaterThan(0);
    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId,drawId));
    expect(winners.length).toBeGreaterThan(0);
    const [d] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id,drawId)).limit(1);
    expect(d!.status).toBe("drawn"); expect(d!.drawnAt).toBeTruthy();
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.targetId,drawId));
    expect(logs.length).toBeGreaterThan(0); expect(logs[0]!.action).toBe("draw.perform");
  });
  it("候选池为空应报错", async () => {
    const id = await insertDraw({status:"open"});
    await expect(performDraw(db,TENANT_ID,id,USER_ID)).rejects.toThrow("候选池为空");
  });
  it("draft 不能开奖", async () => {
    const id = await insertDraw({status:"draft"});
    await expect(performDraw(db,TENANT_ID,id,USER_ID)).rejects.toThrow();
  });
  it("drawn 不能再次开奖", async () => {
    const id = await insertDraw({status:"drawn"});
    await expect(performDraw(db,TENANT_ID,id,USER_ID)).rejects.toThrow();
  });
});

/* ── processDueDraws ─────────────────────────────────────── */

describe("processDueDraws", () => {
  it("应处理到期定时开奖活动", async () => {
    const id = await insertDraw({status:"open",drawTrigger:"scheduled",drawAt:pastTime(5),startAt:pastTime(120),endAt:pastTime(1)});
    await insertEntry(id,"due@t.com");
    const r = await processDueDraws(db,{limit:10});
    expect(r.processed).toBeGreaterThanOrEqual(1);
    expect(r.failed).toBe(0);
  });
  it("未到期应跳过", async () => {
    const id = await insertDraw({status:"open",drawTrigger:"scheduled",drawAt:futureTime(60),startAt:futureTime(1),endAt:futureTime(55)});
    await processDueDraws(db,{limit:10});
    const [d] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id,id)).limit(1);
    expect(d!.status).toBe("open");
  });
});