/**
 * 发布前预检服务测试。
 *
 * 该测试直接锁住 publish-check-service 的结构化规则：
 * - 不依赖未安装的 better-sqlite3，统一使用项目现有 libSQL 测试方式。
 * - 只构造当前活动需要的少量关联行，避免测试本身鼓励全表扫描式实现。
 */
import { createClient, type Client } from "@libsql/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbType } from "../db/client";
import { buildPublishCheckForDraw } from "./publish-check-service";

const TENANT = "test-tenant-check";
const DB_URL = `file:publish-check-test-${crypto.randomUUID()}.db`;

let client: Client;
let db: DbType;

const DDL = [
  `CREATE TABLE IF NOT EXISTS lottery_draws (
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
  )`,
  `CREATE TABLE IF NOT EXISTS prizes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '',
    value_text TEXT NOT NULL DEFAULT '', prize_type TEXT NOT NULL DEFAULT 'code',
    fulfillment_note TEXT NOT NULL DEFAULT '', total_count INTEGER NOT NULL DEFAULT 0,
    used_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS prize_codes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, prize_id TEXT NOT NULL,
    code TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'available',
    winner_id TEXT DEFAULT '', issued_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS lottery_prize_tiers (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    tier_name TEXT NOT NULL DEFAULT '中奖', prize_id TEXT NOT NULL, winner_count INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 100
  )`,
  `CREATE TABLE IF NOT EXISTS lottery_roster_members (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    identity_type TEXT NOT NULL DEFAULT 'email', identity_value TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS lottery_invite_codes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    code TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_configs (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '["draw.completed","prize.issued"]',
    signing_secret TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1, last_sent_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

beforeAll(async () => {
  client = createClient({ url: DB_URL });
  db = createDb(client);
  for (const stmt of DDL) await client.execute(stmt);
});

afterAll(async () => {
  await client.close();
});

afterEach(async () => {
  for (const table of ["webhook_configs", "lottery_invite_codes", "lottery_roster_members", "lottery_prize_tiers", "prize_codes", "prizes"]) {
    await client.execute(`DELETE FROM ${table}`);
  }
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

async function addManualTier(drawId: string, winnerCount = 1) {
  const prizeId = crypto.randomUUID();
  await client.execute({
    sql: "INSERT INTO prizes (id, tenant_id, name, prize_type) VALUES (?, ?, ?, ?)",
    args: [prizeId, TENANT, "手动奖品", "manual_fulfillment"],
  });
  await client.execute({
    sql: "INSERT INTO lottery_prize_tiers (id, tenant_id, draw_id, prize_id, winner_count, tier_name) VALUES (?, ?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), TENANT, drawId, prizeId, winnerCount, "一等奖"],
  });
}

async function addCodeTier(drawId: string, winnerCount: number, availableCodes: number) {
  const prizeId = crypto.randomUUID();
  await client.execute({
    sql: "INSERT INTO prizes (id, tenant_id, name, prize_type) VALUES (?, ?, ?, ?)",
    args: [prizeId, TENANT, "卡密奖品", "code"],
  });
  await client.execute({
    sql: "INSERT INTO lottery_prize_tiers (id, tenant_id, draw_id, prize_id, winner_count, tier_name) VALUES (?, ?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), TENANT, drawId, prizeId, winnerCount, "卡密奖"],
  });
  for (let i = 0; i < availableCodes; i++) {
    await client.execute({
      sql: "INSERT INTO prize_codes (id, tenant_id, prize_id, code, status) VALUES (?, ?, ?, ?, ?)",
      args: [crypto.randomUUID(), TENANT, prizeId, `CODE-${i}`, "available"],
    });
  }
}

describe("发布预检 — 基础信息", () => {
  it("标题为空时返回结构化错误", async () => {
    const draw = makeDraw({ title: "" });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "basic.title.required" && item.section === "basic")).toBe(true);
  });

  it("结束时间已过时阻断发布", async () => {
    const draw = makeDraw({
      startAt: "2020-01-01T00:00:00Z",
      endAt: "2020-01-02T00:00:00Z",
    });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some((item) => item.code === "basic.time.ended")).toBe(true);
  });

  it("正常抽奖配置可发布，但缺 CTA 和 Webhook 只提示", async () => {
    const draw = makeDraw();
    await addManualTier(draw.id);
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(true);
    expect(result.warnings.some((item) => item.code === "promotion.empty")).toBe(true);
    expect(result.infos.some((item) => item.code === "webhook.empty")).toBe(true);
  });
});

describe("发布预检 — 参与模式", () => {
  it("密码模式未设置密码时返回错误", async () => {
    const draw = makeDraw({ participationMode: "password", accessPassword: "" });
    await addManualTier(draw.id);
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some((item) => item.code === "participation.password.required")).toBe(true);
  });

  it("名单和邀请码模式必须有可用资格数据", async () => {
    const rosterDraw = makeDraw({ participationMode: "roster" });
    await addManualTier(rosterDraw.id);
    const rosterResult = await buildPublishCheckForDraw(db, TENANT, rosterDraw as any);
    expect(rosterResult.errors.some((item) => item.code === "participation.roster.empty")).toBe(true);

    const inviteDraw = makeDraw({ participationMode: "invite_code" });
    await addManualTier(inviteDraw.id);
    const inviteResult = await buildPublishCheckForDraw(db, TENANT, inviteDraw as any);
    expect(inviteResult.errors.some((item) => item.code === "participation.invite_code.empty")).toBe(true);
  });
});

describe("发布预检 — 奖项与码池", () => {
  it("抽奖活动无奖项时返回错误", async () => {
    const draw = makeDraw({ activityKind: "lottery" });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some((item) => item.code === "prizes.tiers.required")).toBe(true);
  });

  it("卡密码池不足时返回错误，码池充足时不返回该错误", async () => {
    const insufficientDraw = makeDraw();
    await addCodeTier(insufficientDraw.id, 3, 1);
    const insufficient = await buildPublishCheckForDraw(db, TENANT, insufficientDraw as any);
    expect(insufficient.errors.some((item) => item.code === "prizes.codes.insufficient")).toBe(true);

    const enoughDraw = makeDraw();
    await addCodeTier(enoughDraw.id, 3, 3);
    const enough = await buildPublishCheckForDraw(db, TENANT, enoughDraw as any);
    expect(enough.errors.some((item) => item.code === "prizes.codes.insufficient")).toBe(false);
  });
});

describe("发布预检 — 导流、Webhook、未闭环玩法", () => {
  it("危险导流链接和异常 Webhook 会阻断发布", async () => {
    const draw = makeDraw({
      promotionConfig: JSON.stringify({ enabled: true, destination: { url: "javascript:alert(1)", title: "危险链接" } }),
    });
    await addManualTier(draw.id);
    await client.execute({
      sql: "INSERT INTO webhook_configs (id, tenant_id, url, events, active, signing_secret) VALUES (?, ?, ?, ?, ?, ?)",
      args: [crypto.randomUUID(), TENANT, "ftp://example.com/hook", "[]", 1, ""],
    });

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "promotion.url.invalid")).toBe(true);
    expect(result.errors.some((item) => item.code === "webhook.url.invalid")).toBe(true);
    expect(result.errors.some((item) => item.code === "webhook.events.invalid")).toBe(true);
  });

  it("问卷和投票配置器未完成前禁止正式发布", async () => {
    const survey = await buildPublishCheckForDraw(db, TENANT, makeDraw({ activityKind: "survey", winnerCount: 0 }) as any);
    const vote = await buildPublishCheckForDraw(db, TENANT, makeDraw({ activityKind: "vote", winnerCount: 0 }) as any);
    expect(survey.errors.some((item) => item.code === "survey.config.missing")).toBe(true);
    expect(vote.errors.some((item) => item.code === "vote.options.missing")).toBe(true);
  });
});
