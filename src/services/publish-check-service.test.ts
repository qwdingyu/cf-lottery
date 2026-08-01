/**
 * 发布前预检服务测试。
 *
 * 覆盖 033 文档要求的 P0 发布闸门：
 * - 基础信息（标题/时间/容量）
 * - 参与模式（名单/密码/邀请码）
 * - 奖项（奖项配置/码池充足性）
 * - Webhook（URL 格式）
 * - 导流配置
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { buildPublishCheckForDraw } from "./publish-check-service";
import type { DbType } from "../db/client";
import { eq, and } from "drizzle-orm";

const TENANT = "test-tenant-check";

let sqlite: Database.Database;
let db: DbType;

beforeAll(async () => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as DbType;

  // 创建核心表
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS lottery_draws (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, public_slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', activity_kind TEXT NOT NULL DEFAULT 'lottery',
      participation_mode TEXT NOT NULL DEFAULT 'open', experience_type TEXT NOT NULL DEFAULT 'wheel',
      draw_trigger TEXT NOT NULL DEFAULT 'manual', result_mode TEXT NOT NULL DEFAULT 'manual',
      allocation_policy TEXT NOT NULL DEFAULT 'capacity', policy_version INTEGER NOT NULL DEFAULT 1,
      start_at TEXT NOT NULL, end_at TEXT NOT NULL, draw_at TEXT,
      access_password TEXT NOT NULL DEFAULT '', max_participants INTEGER,
      winner_count INTEGER NOT NULL DEFAULT 1, show_participant_count INTEGER NOT NULL DEFAULT 1,
      show_winner_count INTEGER NOT NULL DEFAULT 1, show_winner_list INTEGER NOT NULL DEFAULT 0,
      drawn_at TEXT, failure_reason TEXT NOT NULL DEFAULT '',
      draw_seed_hash TEXT NOT NULL DEFAULT '', draw_seed TEXT NOT NULL DEFAULT '',
      algorithm_version TEXT NOT NULL DEFAULT 'uniform_v1',
      product_link TEXT NOT NULL DEFAULT '{}', promotion_config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS prizes (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '',
      value_text TEXT NOT NULL DEFAULT '', prize_type TEXT NOT NULL DEFAULT 'code',
      fulfillment_note TEXT NOT NULL DEFAULT '', total_count INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS prize_codes (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, prize_id TEXT NOT NULL,
      code TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'available',
      winner_id TEXT, issued_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS lottery_prize_tiers (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
      tier_name TEXT, prize_id TEXT NOT NULL, winner_count INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS lottery_roster_members (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
      identity_value TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS lottery_invite_codes (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
      code TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS webhook_configs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, url TEXT NOT NULL,
      events_json TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1,
      signing_secret TEXT NOT NULL DEFAULT ''
    );
  `);
});

afterAll(() => {
  sqlite?.close();
});

function makeDraw(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const future = new Date(now.getTime() + 86400000);
  return {
    id: crypto.randomUUID(),
    tenantId: TENANT,
    publicSlug: crypto.randomUUID().slice(0, 8),
    title: "测试活动",
    description: "",
    status: "draft",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    drawTrigger: "manual",
    resultMode: "manual",
    allocationPolicy: "capacity",
    policyVersion: 1,
    startAt: now.toISOString(),
    endAt: future.toISOString(),
    drawAt: null,
    accessPassword: "",
    maxParticipants: 100,
    winnerCount: 1,
    showParticipantCount: 1,
    showWinnerCount: 1,
    showWinnerList: 0,
    drawnAt: null,
    failureReason: "",
    drawSeedHash: "",
    drawSeed: "",
    algorithmVersion: "uniform_v1",
    productLink: "{}",
    promotionConfig: "{}",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

describe("发布预检 — 基础信息", () => {
  it("标题为空时返回错误", async () => {
    const draw = makeDraw({ title: "" });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some(e => e.code === "basic.title.required")).toBe(true);
  });

  it("结束时间已过时返回错误", async () => {
    const draw = makeDraw({
      startAt: "2020-01-01T00:00:00Z",
      endAt: "2020-01-02T00:00:00Z",
    });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "basic.time.ended")).toBe(true);
  });

  it("开始时间晚于结束时间时返回错误", async () => {
    const draw = makeDraw({
      startAt: new Date(Date.now() + 86400000 * 2).toISOString(),
      endAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "basic.time.order")).toBe(true);
  });

  it("定时开奖未设置开奖时间时返回错误", async () => {
    const draw = makeDraw({ drawTrigger: "scheduled", drawAt: null });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "basic.draw_at.required")).toBe(true);
  });

  it("正常活动预检通过", async () => {
    const draw = makeDraw();
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("参与人数上限为 0 时返回错误", async () => {
    const draw = makeDraw({ maxParticipants: 0 });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "basic.capacity.invalid")).toBe(true);
  });
});

describe("发布预检 — 参与模式", () => {
  it("密码模式未设置密码时返回错误", async () => {
    const draw = makeDraw({ participationMode: "password", accessPassword: "" });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "participation.password.required")).toBe(true);
  });

  it("名单模式无名单成员时返回错误", async () => {
    const draw = makeDraw({ participationMode: "roster" });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "participation.roster.empty")).toBe(true);
  });

  it("名单模式有成员时预检通过", async () => {
    const draw = makeDraw({ participationMode: "roster" });
    // 插入名单
    await db.insert(schema.lotteryRosterMembers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: draw.id,
      identityValue: "test@example.com", displayName: "测试",
    } as any);
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "participation.roster.empty")).toBe(false);
  });

  it("邀请码模式无可用邀请码时返回错误", async () => {
    const draw = makeDraw({ participationMode: "invite_code" });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "participation.invite_code.empty")).toBe(true);
  });
});

describe("发布预检 — 奖项", () => {
  it("抽奖活动无奖项时返回错误", async () => {
    const draw = makeDraw({ activityKind: "lottery" });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "prizes.tiers.empty")).toBe(true);
  });

  it("码池不足时返回错误", async () => {
    const draw = makeDraw({ activityKind: "lottery" });
    // 创建奖项（winnerCount=5，但码池只有 2 个可用码）
    const prizeId = crypto.randomUUID();
    await db.insert(schema.prizes).values({
      id: prizeId, tenantId: TENANT, name: "测试奖品", prizeType: "code",
    } as any);
    await db.insert(schema.lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: draw.id,
      prizeId, winnerCount: 5, tierName: "一等奖",
    } as any);
    // 只插入 2 个码
    for (let i = 0; i < 2; i++) {
      await db.insert(schema.prizeCodes).values({
        id: crypto.randomUUID(), tenantId: TENANT, prizeId,
        code: `CODE-${i}`, status: "available",
      } as any);
    }
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "prizes.code_pool.insufficient")).toBe(true);
  });

  it("码池充足时预检通过", async () => {
    const draw = makeDraw({ activityKind: "lottery" });
    const prizeId = crypto.randomUUID();
    await db.insert(schema.prizes).values({
      id: prizeId, tenantId: TENANT, name: "测试奖品", prizeType: "code",
    } as any);
    await db.insert(schema.lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: draw.id,
      prizeId, winnerCount: 3, tierName: "一等奖",
    } as any);
    for (let i = 0; i < 5; i++) {
      await db.insert(schema.prizeCodes).values({
        id: crypto.randomUUID(), tenantId: TENANT, prizeId,
        code: `CODE-${i}`, status: "available",
      } as any);
    }
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "prizes.code_pool.insufficient")).toBe(false);
  });
});

describe("发布预检 — Webhook", () => {
  it("无效 Webhook URL 时返回警告", async () => {
    const draw = makeDraw();
    // 插入无效 URL 的 Webhook
    await db.insert(schema.webhookConfigs).values({
      id: crypto.randomUUID(), tenantId: TENANT, url: "not-a-valid-url",
      eventsJson: "[]", active: 1, signingSecret: "",
    } as any);
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.warnings.some(w => w.code === "webhook.url.inactive")).toBe(true);
  });

  it("无 Webhook 时不影响发布", async () => {
    const draw = makeDraw();
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    // Webhook 缺失是 warning 不是 error，不影响 canPublish
    expect(result.errors.length).toBe(0);
  });
});

describe("发布预检 — 导流配置", () => {
  it("导流配置中无效 URL 时返回错误", async () => {
    const draw = makeDraw({
      promotionConfig: JSON.stringify({
        outcomes: { success: { cta: { url: "ftp://invalid-protocol.com" } } },
      }),
      activityKind: "lottery",
    });
    // 先创建必要奖项
    const prizeId = crypto.randomUUID();
    await db.insert(schema.prizes).values({
      id: prizeId, tenantId: TENANT, name: "测试奖品",
    } as any);
    await db.insert(schema.lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: draw.id,
      prizeId, winnerCount: 1, tierName: "一等奖",
    } as any);
    for (let i = 0; i < 3; i++) {
      await db.insert(schema.prizeCodes).values({
        id: crypto.randomUUID(), tenantId: TENANT, prizeId,
        code: `CODE-${i}`, status: "available",
      } as any);
    }
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some(e => e.code === "promotion.invalid_url")).toBe(true);
  });
});
