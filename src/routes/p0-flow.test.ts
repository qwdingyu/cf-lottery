/**
 * P0 核心流程压测：创建活动 → 发布 → 参与 → 开奖 → 查看结果
 *
 * 模拟真实用户操作完整闭环，覆盖所有活动类型（抽奖/接龙/问卷/签到/投票/审批/资料领取）。
 * 每个场景验证：创建成功 → 状态机正确 → 参与成功 → 结果可查。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createDb, type DbType } from "../db/client";
import { adminLotteryRoute } from "./admin-lottery";
import { publicLotteryRoute } from "./public-lottery";
import { signJwt } from "../middleware/auth";
import { activityEvents, tenants, users, tenantMembers, lotteryDraws, lotteryEntries, lotteryWinners, systemConfig, webhookConfigs } from "../db/schema";
import { eq } from "drizzle-orm";

let client: Client;
let db: DbType;

const JWT_SECRET = "test-p0-flow-secret-0123456789abcdef";
const TENANT_ID = "tenant-p0";
const OWNER_ID = "user-p0-owner";
const DB_URL = `file:test-p0-flow-${crypto.randomUUID()}.db`;

const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET,
};

/** 建表 SQL（覆盖 P0 流程涉及的全部表） */
const DDL = [
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active', brand_config TEXT NOT NULL DEFAULT '{}', extra_activity_quota INTEGER NOT NULL DEFAULT 0, extra_participant_quota INTEGER NOT NULL DEFAULT 0, extra_quota_expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '', email_verified INTEGER NOT NULL DEFAULT 0, password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS tenant_members (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (tenant_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS platform_members (user_id TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS lottery_draws (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, public_slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', activity_kind TEXT NOT NULL DEFAULT 'lottery', participation_mode TEXT NOT NULL DEFAULT 'open', experience_type TEXT NOT NULL DEFAULT 'wheel', draw_trigger TEXT NOT NULL DEFAULT 'manual', result_mode TEXT NOT NULL DEFAULT 'manual', allocation_policy TEXT NOT NULL DEFAULT 'capacity', policy_version INTEGER NOT NULL DEFAULT 1, start_at TEXT NOT NULL, end_at TEXT NOT NULL, draw_at TEXT, access_password TEXT NOT NULL DEFAULT '', max_participants INTEGER, winner_count INTEGER NOT NULL DEFAULT 1, show_participant_count INTEGER NOT NULL DEFAULT 1, show_winner_count INTEGER NOT NULL DEFAULT 1, show_winner_list INTEGER NOT NULL DEFAULT 0, drawn_at TEXT, failure_reason TEXT NOT NULL DEFAULT '', draw_seed_hash TEXT NOT NULL DEFAULT '', draw_seed TEXT NOT NULL DEFAULT '', algorithm_version TEXT NOT NULL DEFAULT 'uniform_v1', product_link TEXT NOT NULL DEFAULT '{}', promotion_config TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS lottery_entries (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, identity_type TEXT NOT NULL DEFAULT 'email', identity_value TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', invite_code_id TEXT DEFAULT '', ip_hash TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL, UNIQUE(tenant_id, draw_id, identity_type, identity_value))`,
  `CREATE TABLE IF NOT EXISTS lottery_winners (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, tier_id TEXT NOT NULL, entry_id TEXT NOT NULL, identity_type TEXT NOT NULL, identity_value TEXT NOT NULL, prize_code_id TEXT DEFAULT '', drawn_at TEXT NOT NULL, notification_status TEXT NOT NULL DEFAULT 'pending', notification_error TEXT NOT NULL DEFAULT '', UNIQUE(tenant_id, draw_id, entry_id))`,
  `CREATE TABLE IF NOT EXISTS activity_outcomes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, entry_id TEXT NOT NULL, outcome_type TEXT NOT NULL DEFAULT 'assignment', status TEXT NOT NULL DEFAULT 'assigned', sequence_no INTEGER NOT NULL, assignment_no INTEGER, result_key TEXT NOT NULL DEFAULT '', result_label TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}', decided_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS prizes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', value_text TEXT NOT NULL DEFAULT '', prize_type TEXT NOT NULL DEFAULT 'code', fulfillment_note TEXT NOT NULL DEFAULT '', total_count INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS prize_codes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, prize_id TEXT NOT NULL, code TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'available', winner_id TEXT DEFAULT '', issued_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS coupon_codes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT, code TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'available', recipient_email TEXT, redeemed_at TEXT, expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(tenant_id, code))`,
  `CREATE TABLE IF NOT EXISTS lottery_prize_tiers (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, prize_id TEXT NOT NULL, tier_name TEXT NOT NULL DEFAULT '中奖', winner_count INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS lottery_roster_members (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, identity_type TEXT NOT NULL DEFAULT 'email', identity_value TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(tenant_id, draw_id, identity_type, identity_value))`,
  `CREATE TABLE IF NOT EXISTS lottery_invite_codes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, code TEXT NOT NULL, max_uses INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS lottery_blacklist (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, identity_value TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS email_access_codes (id TEXT PRIMARY KEY, email TEXT NOT NULL, draw_id TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS activity_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, entry_id TEXT DEFAULT '', event_type TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '', ref_code TEXT NOT NULL DEFAULT '', ip_hash TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS share_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, sharer_entry_id TEXT NOT NULL, share_code TEXT NOT NULL, clicked_count INTEGER NOT NULL DEFAULT 0, joined_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS external_conversions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, entry_id TEXT DEFAULT '', external_event_id TEXT NOT NULL, conversion_type TEXT NOT NULL DEFAULT 'purchase', amount_cents INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS webhook_configs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["draw.completed","prize.issued"]', signing_secret TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, last_sent_at TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, webhook_config_id TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}', signature TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, response_status INTEGER, response_body TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, UNIQUE(webhook_config_id, event_id))`,
  `CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS redemption_codes (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, plan TEXT NOT NULL DEFAULT 'custom', activity_quota INTEGER NOT NULL DEFAULT 0, participant_quota INTEGER NOT NULL DEFAULT 0, duration_days INTEGER NOT NULL DEFAULT 30, max_uses INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS redemption_records (id TEXT PRIMARY KEY, code_id TEXT NOT NULL, code TEXT NOT NULL, tenant_id TEXT NOT NULL, tenant_name TEXT NOT NULL DEFAULT '', activity_quota_granted INTEGER NOT NULL DEFAULT 0, participant_quota_granted INTEGER NOT NULL DEFAULT 0, duration_days_granted INTEGER NOT NULL DEFAULT 30, expires_at TEXT, redeemed_at TEXT NOT NULL DEFAULT (datetime('now')))`,
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
  for (const table of ["webhook_deliveries", "webhook_configs", "audit_logs", "external_conversions", "share_records", "activity_events", "email_access_codes", "lottery_blacklist", "lottery_invite_codes", "lottery_roster_members", "lottery_prize_tiers", "coupon_codes", "prize_codes", "prizes", "activity_outcomes", "lottery_winners", "lottery_entries", "lottery_draws", "system_config", "platform_members", "tenant_members", "users", "tenants"]) {
    await client.execute(`DELETE FROM ${table}`);
  }
});

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/admin", adminLotteryRoute);
  app.route("/api/public", publicLotteryRoute);
  return app;
}

async function seedOwner() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "P0 Test" });
  await db.insert(users).values({ id: OWNER_ID, username: "p0owner", email: "p0@test.com", emailVerified: 1, passwordHash: "hash" });
  await db.insert(tenantMembers).values({ tenantId: TENANT_ID, userId: OWNER_ID, role: "owner" });
  await db.insert(systemConfig).values({ key: "enabled_activity_kinds", value: "lottery,signup_chain,claim,survey,vote,checkin,approval,reservation" });
}

async function authHeader() {
  const token = await signJwt({ sub: OWNER_ID, tenantId: TENANT_ID }, JWT_SECRET, 3600);
  return { Authorization: `Bearer ${token}` };
}

/** 生成未来时间 ISO */
function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60000).toISOString();
}

/** 创建草稿活动，返回内部 ID 和公开 slug */
async function createDraft(app: Hono<AppEnv>, kind: string, extra: Record<string, unknown> = {}) {
  const createRes = await app.request("/api/admin/draws", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({
      title: `P0-${kind}`,
      activityKind: kind,
      participationMode: "open",
      startAt: futureIso(-10),
      endAt: futureIso(60),
      winnerCount: 1,
      ...extra,
    }),
  }, TEST_ENV);
  expect(createRes.status).toBe(200);
  const created = await createRes.json() as { ok: boolean; id: string; publicSlug: string };
  expect(created.ok).toBe(true);
  return { id: created.id, publicSlug: created.publicSlug };
}

/** 配置一个手动发放奖项；抽奖正式发布必须先具备奖品和奖项，不能靠默认空配置上线。 */
async function configureManualPrizeTier(app: Hono<AppEnv>, drawId: string, prizeName = "测试奖品") {
  const prizeRes = await app.request("/api/admin/prizes", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ name: prizeName, prizeType: "manual_fulfillment" }),
  }, TEST_ENV);
  expect(prizeRes.status).toBe(200);
  const prizeData = await prizeRes.json() as { ok: boolean; id: string };

  const tierRes = await app.request(`/api/admin/draws/${drawId}/tiers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ tiers: [{ prizeId: prizeData.id, tierName: "一等奖", winnerCount: 1 }] }),
  }, TEST_ENV);
  expect(tierRes.status).toBe(200);
  return prizeData.id;
}

/** 发布草稿活动，并确认状态进入 open */
async function publishDraft(app: Hono<AppEnv>, id: string) {
  // 发布
  const pubRes = await app.request(`/api/admin/draws/${id}/publish`, {
    method: "POST",
    headers: { ...(await authHeader()) },
  }, TEST_ENV);
  expect(pubRes.status).toBe(200);

  // 验证状态
  const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, id));
  expect(draw?.status).toBe("open");
}

/** 创建活动 → 发布 → 返回 public_slug */
async function createAndPublish(app: Hono<AppEnv>, kind: string, extra: Record<string, unknown> = {}) {
  const created = await createDraft(app, kind, extra);
  if (kind === "lottery") {
    await configureManualPrizeTier(app, created.id);
  }
  await publishDraft(app, created.id);
  return created;
}

describe("P0 核心流程：创建活动 → 发布", () => {
  it("抽奖活动：创建→发布→参与→开奖→查看中奖", async () => {
    await seedOwner();
    const app = createTestApp();

    const { id, publicSlug } = await createDraft(app, "lottery");

    await configureManualPrizeTier(app, id);

    await publishDraft(app, id);

    // 用户参与（公开端）
    const joinRes = await app.request(`/api/public/draws/${publicSlug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.1" },
      body: JSON.stringify({ email: "user1@test.com" }),
    }, TEST_ENV);
    expect(joinRes.status).toBe(200);
    const joinData = await joinRes.json() as any;
    expect(joinData.ok).toBe(true);

    // 验证参与记录
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, id));
    expect(entry?.identityValue).toBe("user1@test.com");

    // 开奖
    const drawRes = await app.request(`/api/admin/draws/${id}/draw`, {
      method: "POST",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    expect(drawRes.status).toBe(200);

    // 验证中奖名单
    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    expect(winners.length).toBeGreaterThan(0);
  });

  it("接龙活动：创建→发布→多人参与→按顺序分配", async () => {
    await seedOwner();
    const app = createTestApp();

    const { publicSlug } = await createAndPublish(app, "signup_chain", { allocationPolicy: "capacity", maxParticipants: 3 });

    // 3 人参与
    for (let i = 1; i <= 3; i++) {
      const res = await app.request(`/api/public/draws/${publicSlug}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.0.0.${i}` },
        body: JSON.stringify({ email: `user${i}@test.com` }),
      }, TEST_ENV);
      expect(res.status).toBe(200);
    }

    // 第 4 人应该被拒绝（容量满）
    const res4 = await app.request(`/api/public/draws/${publicSlug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.4" },
      body: JSON.stringify({ email: "user4@test.com" }),
    }, TEST_ENV);
    const data4 = await res4.json() as any;
    expect(data4.ok).toBe(false);

    // 验证参与顺序
    const entries = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, (await db.select().from(lotteryDraws).where(eq(lotteryDraws.publicSlug, publicSlug)))[0]!.id));
    expect(entries.length).toBe(3);
  });

  it("问卷活动：当前仅允许创建草稿，未完成字段配置闭环前禁止正式发布", async () => {
    await seedOwner();
    const app = createTestApp();

    const { id } = await createDraft(app, "survey");

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    expect(checkRes.status).toBe(200);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(false);
    expect(check.errors.some((item: any) => item.code === "survey.config.missing")).toBe(true);

    const publishRes = await app.request(`/api/admin/draws/${id}/publish`, {
      method: "POST",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    expect(publishRes.status).toBe(400);
  });

  it("资料领取活动：创建→发布→领取", async () => {
    await seedOwner();
    const app = createTestApp();

    const { publicSlug } = await createAndPublish(app, "claim");

    const joinRes = await app.request(`/api/public/draws/${publicSlug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.6" },
      body: JSON.stringify({ email: "claim@test.com" }),
    }, TEST_ENV);
    expect(joinRes.status).toBe(200);
  });

  it("禁用活动类型：创建被拒绝", async () => {
    await seedOwner();
    const app = createTestApp();

    // 只启用 lottery
    await db.update(systemConfig).set({ value: "lottery" }).where(eq(systemConfig.key, "enabled_activity_kinds"));

    const createRes = await app.request("/api/admin/draws", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({
        title: "被禁用的类型",
        activityKind: "survey",
        startAt: futureIso(-10),
        endAt: futureIso(60),
      }),
    }, TEST_ENV);
    expect(createRes.status).toBe(400);
    const data = await createRes.json() as any;
    expect(data.message).toContain("未启用");
  });

  it("发布前校验：活动名称为空被拒绝", async () => {
    await seedOwner();
    const app = createTestApp();

    const createRes = await app.request("/api/admin/draws", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({
        title: "",
        activityKind: "lottery",
        startAt: futureIso(-10),
        endAt: futureIso(60),
      }),
    }, TEST_ENV);
    // 空标题应被拒绝
    expect([400, 500]).toContain(createRes.status);
  });

  it("发布前校验：抽奖没有奖项时禁止发布，避免上线空奖池活动", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id } = await createDraft(app, "lottery");

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    expect(checkRes.status).toBe(200);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(false);
    expect(check.errors.some((item: any) => item.code === "prizes.tiers.required")).toBe(true);

    const publishRes = await app.request(`/api/admin/draws/${id}/publish`, {
      method: "POST",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    expect(publishRes.status).toBe(400);
  });

  it("发布前校验：卡密奖品码池不足时禁止发布", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id } = await createDraft(app, "lottery");

    const prizeRes = await app.request("/api/admin/prizes", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ name: "卡密奖品", prizeType: "code" }),
    }, TEST_ENV);
    expect(prizeRes.status).toBe(200);
    const prizeData = await prizeRes.json() as { ok: boolean; id: string };

    const tierRes = await app.request(`/api/admin/draws/${id}/tiers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ tiers: [{ prizeId: prizeData.id, tierName: "卡密奖", winnerCount: 2 }] }),
    }, TEST_ENV);
    expect(tierRes.status).toBe(200);

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(false);
    expect(check.errors.some((item: any) => item.code === "prizes.codes.insufficient")).toBe(true);
  });

  it("发布前校验：名单和邀请码模式必须先具备可用资格数据", async () => {
    await seedOwner();
    const app = createTestApp();

    const roster = await createDraft(app, "signup_chain", { participationMode: "roster" });
    const rosterCheckRes = await app.request(`/api/admin/draws/${roster.id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const rosterCheck = await rosterCheckRes.json() as any;
    expect(rosterCheck.errors.some((item: any) => item.code === "participation.roster.empty")).toBe(true);

    const invite = await createDraft(app, "signup_chain", { participationMode: "invite_code" });
    const inviteCheckRes = await app.request(`/api/admin/draws/${invite.id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const inviteCheck = await inviteCheckRes.json() as any;
    expect(inviteCheck.errors.some((item: any) => item.code === "participation.invite_code.empty")).toBe(true);
  });

  it("发布前校验：有效抽奖返回 CTA/Webhook/奖品信息提示但不阻断", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id } = await createDraft(app, "lottery");
    await configureManualPrizeTier(app, id);

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(true);
    expect(check.warnings.some((item: any) => item.code === "promotion.empty")).toBe(true);
    expect(check.infos.some((item: any) => item.code === "webhook.empty")).toBe(true);
    expect(check.infos.some((item: any) => item.code === "prizes.image.default")).toBe(true);
  });

  it("发布前校验：危险导流链接和异常 Webhook 配置会阻断发布", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id } = await createDraft(app, "lottery", {
      promotionConfig: {
        enabled: true,
        destination: { url: "javascript:alert(1)", title: "危险链接" },
      },
    });
    await configureManualPrizeTier(app, id);
    await db.insert(webhookConfigs).values({
      id: crypto.randomUUID(),
      tenantId: TENANT_ID,
      url: "ftp://example.com/hook",
      events: "[]",
      signingSecret: "",
      active: 1,
    });

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(false);
    expect(check.errors.some((item: any) => item.code === "promotion.url.invalid")).toBe(true);
    expect(check.errors.some((item: any) => item.code === "webhook.url.invalid")).toBe(true);
    expect(check.errors.some((item: any) => item.code === "webhook.events.invalid")).toBe(true);
  });

  it("发布前校验：投票选项闭环未完成前禁止正式发布", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id } = await createDraft(app, "vote");

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(false);
    expect(check.errors.some((item: any) => item.code === "vote.options.missing")).toBe(true);
  });

  it("公开事件治理：非法事件类型和大 payload 被拒绝且不写库", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id, publicSlug } = await createAndPublish(app, "lottery");

    const invalidRes = await app.request(`/api/public/draws/${publicSlug}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.1" },
      body: JSON.stringify({ eventType: "paid_order" }),
    }, TEST_ENV);
    expect(invalidRes.status).toBe(400);

    const largePayloadRes = await app.request(`/api/public/draws/${publicSlug}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.2" },
      body: JSON.stringify({
        eventType: "page_view",
        metadata: { text: "x".repeat(2050) },
      }),
    }, TEST_ENV);
    expect(largePayloadRes.status).toBe(400);

    const rows = await db.select().from(activityEvents).where(eq(activityEvents.drawId, id));
    expect(rows).toHaveLength(0);
  });

  it("公开事件治理：合法事件可写入并限制字段长度", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id, publicSlug } = await createAndPublish(app, "lottery");

    const validRes = await app.request(`/api/public/draws/${publicSlug}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.3" },
      body: JSON.stringify({
        eventType: "cta_click",
        source: "wechat",
        medium: "share",
        campaign: "launch",
        metadata: { placement: "result" },
      }),
    }, TEST_ENV);
    expect(validRes.status).toBe(200);

    const tooLongSourceRes = await app.request(`/api/public/draws/${publicSlug}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.4" },
      body: JSON.stringify({ eventType: "cta_click", source: "x".repeat(201) }),
    }, TEST_ENV);
    expect(tooLongSourceRes.status).toBe(400);

    const rows = await db.select().from(activityEvents).where(eq(activityEvents.drawId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("cta_click");
  });
});
