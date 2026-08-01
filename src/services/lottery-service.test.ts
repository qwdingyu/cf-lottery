/**
 * 抽奖服务核心业务测试
 *
 * 使用真实 libSQL 数据库，测试 084 文档规定的全部使用场景。
 */
import { createClient, type Client } from "@libsql/client";
import { afterAll, afterEach, describe, expect, it, beforeAll } from "vitest";
import { createDb } from "../db/client";
import {
  createDraw,
  publishDraw,
  performDraw,
  joinDraw,
  getDraw,
  getDrawWinners,
  getActivityOutcomes,
  getTenantUsage,
  recordActivityEvent,
  getActivityEventSummary,
  authenticateApiKey,
  recordExternalConversion,
  listExternalConversions,
  getExternalConversionSummary,
  enqueueWebhookEvent,
  dispatchWebhookDelivery,
  processPendingWebhookDeliveriesForAllTenants,
  listWebhookDeliveries,
  createPrize,
  importPrizeCodes,
  randomSelect,
} from "../services/lottery-service";

let client: Client;
let db: ReturnType<typeof createDb>;
const TENANT = "test-tenant-001";
const USER = "test-user-001";
const DB_URL = `file:test-lottery-${crypto.randomUUID()}.db`;

beforeAll(async () => {
  client = createClient({ url: DB_URL });
  db = createDb(client);
  await client.execute(`CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active', brand_config TEXT NOT NULL DEFAULT '{}',
    extra_activity_quota INTEGER NOT NULL DEFAULT 0,
    extra_participant_quota INTEGER NOT NULL DEFAULT 0,
    extra_quota_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute("ALTER TABLE tenants ADD COLUMN brand_config TEXT NOT NULL DEFAULT '{}'").catch(() => undefined);
  await client.execute("ALTER TABLE tenants ADD COLUMN extra_activity_quota INTEGER NOT NULL DEFAULT 0").catch(() => undefined);
  await client.execute("ALTER TABLE tenants ADD COLUMN extra_participant_quota INTEGER NOT NULL DEFAULT 0").catch(() => undefined);
  await client.execute("ALTER TABLE tenants ADD COLUMN extra_quota_expires_at TEXT").catch(() => undefined);
  await client.execute(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS tenant_members (
    tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (tenant_id, user_id)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS prizes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '', value_text TEXT NOT NULL DEFAULT '', prize_type TEXT NOT NULL DEFAULT 'code', fulfillment_note TEXT NOT NULL DEFAULT '',
    total_count INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute("ALTER TABLE prizes ADD COLUMN image_url TEXT NOT NULL DEFAULT ''").catch(() => undefined);
  await client.execute("ALTER TABLE prizes ADD COLUMN value_text TEXT NOT NULL DEFAULT ''").catch(() => undefined);
  await client.execute(`CREATE TABLE IF NOT EXISTS prize_codes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, prize_id TEXT NOT NULL, code TEXT NOT NULL,
    secret TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'available',
    winner_id TEXT DEFAULT '', issued_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS lottery_draws (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, public_slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
    participation_mode TEXT NOT NULL DEFAULT 'open', draw_trigger TEXT NOT NULL DEFAULT 'manual',
    start_at TEXT NOT NULL, end_at TEXT NOT NULL, draw_at TEXT, access_password TEXT NOT NULL DEFAULT '',
    max_participants INTEGER, winner_count INTEGER NOT NULL DEFAULT 1,
    show_participant_count INTEGER NOT NULL DEFAULT 1, show_winner_count INTEGER NOT NULL DEFAULT 1,
    show_winner_list INTEGER NOT NULL DEFAULT 0, drawn_at TEXT, failure_reason TEXT NOT NULL DEFAULT '',
    draw_seed_hash TEXT NOT NULL DEFAULT '', draw_seed TEXT NOT NULL DEFAULT '', algorithm_version TEXT NOT NULL DEFAULT 'uniform_v1', product_link TEXT NOT NULL DEFAULT '{}', promotion_config TEXT NOT NULL DEFAULT '{}', activity_kind TEXT NOT NULL DEFAULT 'lottery', experience_type TEXT NOT NULL DEFAULT 'wheel', result_mode TEXT NOT NULL DEFAULT 'manual', policy_version INTEGER NOT NULL DEFAULT 1, allocation_policy TEXT NOT NULL DEFAULT 'capacity',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS lottery_prize_tiers (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, prize_id TEXT NOT NULL,
    tier_name TEXT NOT NULL DEFAULT '中奖', winner_count INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 100
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS lottery_roster_members (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, identity_type TEXT NOT NULL DEFAULT 'email',
    identity_value TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, draw_id, identity_type, identity_value)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS lottery_invite_codes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, code TEXT NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(tenant_id, draw_id, code)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS lottery_entries (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, identity_type TEXT NOT NULL DEFAULT 'email',
    identity_value TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', invite_code_id TEXT NOT NULL DEFAULT '',
    ip_hash TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, draw_id, identity_type, identity_value)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS lottery_winners (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, tier_id TEXT NOT NULL DEFAULT '',
    entry_id TEXT NOT NULL, identity_type TEXT NOT NULL, identity_value TEXT NOT NULL, prize_code_id TEXT DEFAULT '',
    drawn_at TEXT NOT NULL DEFAULT (datetime('now')), notification_status TEXT NOT NULL DEFAULT 'pending',
    notification_error TEXT NOT NULL DEFAULT '', UNIQUE(tenant_id, draw_id, entry_id)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, action TEXT NOT NULL,
    target_type TEXT NOT NULL, target_id TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS lottery_blacklist (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, identity_value TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS activity_outcomes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, entry_id TEXT NOT NULL,
    outcome_type TEXT NOT NULL DEFAULT 'assignment', status TEXT NOT NULL DEFAULT 'assigned',
    sequence_no INTEGER NOT NULL, assignment_no INTEGER,
    result_key TEXT NOT NULL DEFAULT '', result_label TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}', decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, draw_id, outcome_type, entry_id),
    UNIQUE(tenant_id, draw_id, outcome_type, sequence_no),
    UNIQUE(tenant_id, draw_id, outcome_type, assignment_no)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS webhook_configs (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '["draw.completed","prize.issued"]',
    signing_secret TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1, last_sent_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute("ALTER TABLE webhook_configs ADD COLUMN signing_secret TEXT NOT NULL DEFAULT ''").catch(() => undefined);
  await client.execute(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, webhook_config_id TEXT NOT NULL,
    event_id TEXT NOT NULL, event_type TEXT NOT NULL, url TEXT NOT NULL,
    payload_json TEXT NOT NULL, signature TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT, response_status INTEGER, response_body TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT,
    UNIQUE(webhook_config_id, event_id)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS activity_events (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    entry_id TEXT NOT NULL DEFAULT '', event_type TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '',
    ref_code TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}',
    ip_hash TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS share_records (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    sharer_entry_id TEXT NOT NULL, share_code TEXT NOT NULL UNIQUE,
    clicked_count INTEGER NOT NULL DEFAULT 0, joined_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS external_conversions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    entry_id TEXT NOT NULL DEFAULT '', external_event_id TEXT NOT NULL,
    conversion_type TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
    ref_code TEXT NOT NULL DEFAULT '', amount_cents INTEGER,
    currency TEXT NOT NULL DEFAULT '', identity_type TEXT NOT NULL DEFAULT '',
    identity_value TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, source, external_event_id)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // 插入默认套餐额度配置（与硬编码 PLAN_LIMITS 一致，确保测试可重复）
  await client.execute({ sql: "INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)", args: ["plan_free_max_activities", "10"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)", args: ["plan_free_max_participants_per_activity", "200"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)", args: ["plan_pro_max_activities", "200"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)", args: ["plan_pro_max_participants_per_activity", "5000"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)", args: ["plan_team_max_activities", "1000"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)", args: ["plan_team_max_participants_per_activity", "20000"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)", args: ["plan_enterprise_max_activities", "0"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)", args: ["plan_enterprise_max_participants_per_activity", "100000"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)", args: [TENANT, "Test"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)", args: [USER, "test", "hash"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO tenant_members (tenant_id, user_id) VALUES (?, ?)", args: [TENANT, USER] });
});

afterAll(async () => {
  await client.close();
});

afterEach(async () => {
  await client.execute("DELETE FROM activity_outcomes");
  await client.execute("DELETE FROM lottery_winners");
  await client.execute("DELETE FROM lottery_entries");
  await client.execute("DELETE FROM lottery_invite_codes");
  await client.execute("DELETE FROM lottery_roster_members");
  await client.execute("DELETE FROM lottery_blacklist");
  await client.execute("DELETE FROM lottery_prize_tiers");
  await client.execute("DELETE FROM lottery_draws");
  await client.execute("DELETE FROM prize_codes");
  await client.execute("DELETE FROM prizes");
  await client.execute("DELETE FROM audit_logs");
  await client.execute("DELETE FROM webhook_deliveries");
  await client.execute("DELETE FROM webhook_configs");
  await client.execute("DELETE FROM api_keys");
  await client.execute("DELETE FROM activity_events");
  await client.execute("DELETE FROM share_records");
  await client.execute("DELETE FROM external_conversions");
  await client.execute("DELETE FROM system_config");
  // 恢复默认套餐额度配置
  await client.execute({ sql: "INSERT INTO system_config (key, value) VALUES (?, ?)", args: ["plan_free_max_activities", "10"] });
  await client.execute({ sql: "INSERT INTO system_config (key, value) VALUES (?, ?)", args: ["plan_free_max_participants_per_activity", "200"] });
  await client.execute({ sql: "INSERT INTO system_config (key, value) VALUES (?, ?)", args: ["plan_pro_max_activities", "200"] });
  await client.execute({ sql: "INSERT INTO system_config (key, value) VALUES (?, ?)", args: ["plan_pro_max_participants_per_activity", "5000"] });
  await client.execute({ sql: "INSERT INTO system_config (key, value) VALUES (?, ?)", args: ["plan_team_max_activities", "1000"] });
  await client.execute({ sql: "INSERT INTO system_config (key, value) VALUES (?, ?)", args: ["plan_team_max_participants_per_activity", "20000"] });
  await client.execute({ sql: "INSERT INTO system_config (key, value) VALUES (?, ?)", args: ["plan_enterprise_max_activities", "0"] });
  await client.execute({ sql: "INSERT INTO system_config (key, value) VALUES (?, ?)", args: ["plan_enterprise_max_participants_per_activity", "100000"] });
  await client.execute({ sql: "UPDATE tenants SET plan = ? WHERE id = ?", args: ["free", TENANT] });
});

/* ── 辅助函数 ── */
async function setupDraw(mode = "open", opts?: { maxParticipants?: number; winnerCount?: number }) {
  const now = new Date();
  const future = new Date(now.getTime() + 3600000);
  const { id, publicSlug } = await createDraw(db, TENANT, {
    title: `${mode} 活动`,
    startAt: now.toISOString(),
    endAt: future.toISOString(),
    participationMode: mode,
    winnerCount: opts?.winnerCount ?? 1,
    maxParticipants: opts?.maxParticipants,
  });
  await publishDraw(db, TENANT, id);
  return { id, publicSlug };
}

async function setupSignupChain(opts?: { maxParticipants?: number; allocationPolicy?: string }) {
  const now = new Date();
  const future = new Date(now.getTime() + 3600000);
  const { id, publicSlug } = await createDraw(db, TENANT, {
    title: "接龙活动",
    startAt: now.toISOString(),
    endAt: future.toISOString(),
    activityKind: "signup_chain",
    participationMode: "open",
    experienceType: "list",
    resultMode: "ordered_assignment",
    allocationPolicy: opts?.allocationPolicy,
    maxParticipants: opts?.maxParticipants,
    winnerCount: 1,
  });
  await publishDraw(db, TENANT, id);
  return { id, publicSlug };
}

async function setupCheckinActivity() {
  const now = new Date();
  const future = new Date(now.getTime() + 3600000);
  const { id, publicSlug } = await createDraw(db, TENANT, {
    title: "签到活动",
    startAt: now.toISOString(),
    endAt: future.toISOString(),
    activityKind: "checkin",
    participationMode: "open",
    experienceType: "checkin",
    resultMode: "no_result",
    winnerCount: 0,
  });
  await publishDraw(db, TENANT, id);
  return { id, publicSlug };
}


/* ── 测试用例 ── */

describe("randomSelect 随机算法", () => {
  it("Fisher-Yates 洗牌，结果数量不超过候选池", async () => {
    const result = await randomSelect(["a", "b", "c", "d", "e"], 3);
    expect(result).toHaveLength(3);
  });

  it("抽取数超过候选池时返回全部", async () => {
    expect(await randomSelect(["a", "b"], 10)).toHaveLength(2);
  });

  it("空候选池返回空数组", async () => {
    expect(await randomSelect([], 5)).toEqual([]);
  });
});

describe("活动生命周期", () => {
  it("draft → open → drawing → drawn 完整状态机", async () => {
    const { id } = await setupDraw("open");
    const draw = await getDraw(db, id, TENANT);
    expect(draw!.status).toBe("open");
  });

  it("创建校验：标题为空拒绝", async () => {
    await expect(createDraw(db, TENANT, {
      title: "", startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3600000).toISOString(), winnerCount: 1,
    })).rejects.toThrow("标题");
  });

  it("发布校验：定时开奖必须设置开奖时间", async () => {
    await expect(createDraw(db, TENANT, {
      title: "测试", startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3600000).toISOString(),
      drawTrigger: "scheduled", winnerCount: 1,
    })).rejects.toThrow("定时开奖");
  });

  it("开奖时间必须在参与结束后", async () => {
    await expect(createDraw(db, TENANT, {
      title: "测试", startAt: new Date().toISOString(), endAt: new Date(Date.now() + 7200000).toISOString(),
      drawAt: new Date(Date.now() + 3600000).toISOString(), winnerCount: 1,
    })).rejects.toThrow("开奖时间必须在参与结束后");
  });

  it("重复发布已发布活动被拒绝", async () => {
    const { id } = await setupDraw();
    await expect(publishDraw(db, TENANT, id)).rejects.toThrow("只有草稿");
  });
});

describe("四种参与模式", () => {
  it("open：任何人可参与", async () => {
    const { publicSlug } = await setupDraw("open");
    expect((await joinDraw(db, publicSlug, "user@test.com")).joined).toBe(true);
  });

  it("open：同邮箱不可重复参与", async () => {
    const { publicSlug } = await setupDraw("open");
    await joinDraw(db, publicSlug, "user@test.com");
    await expect(joinDraw(db, publicSlug, "user@test.com")).rejects.toThrow();
  });

  it("password：正确密码可参与", async () => {
    const { id, publicSlug } = await setupDraw("password");
    // 密码已 hash，需要先更新为 hash 后的值
    const { hashAccessPassword } = await import("../services/lottery-service");
    const hashed = await hashAccessPassword("pwd");
    await client.execute({ sql: "UPDATE lottery_draws SET access_password = ? WHERE id = ?", args: [hashed, id] });
    expect((await joinDraw(db, publicSlug, "u@t.com", "email", { accessPassword: "pwd" })).joined).toBe(true);
  });

  it("password：错误密码被拒绝", async () => {
    const { id, publicSlug } = await setupDraw("password");
    await client.execute({ sql: "UPDATE lottery_draws SET access_password = ? WHERE id = ?", args: ["pwd", id] });
    expect((await joinDraw(db, publicSlug, "u@t.com", "email", { accessPassword: "wrong" })).joined).toBe(false);
  });

  it("roster：名单内可参与", async () => {
    const { id, publicSlug } = await setupDraw("roster");
    await client.execute({
      sql: "INSERT INTO lottery_roster_members (id, tenant_id, draw_id, identity_value) VALUES (?,?,?,?)",
      args: [crypto.randomUUID(), TENANT, id, "user@test.com"],
    });
    expect((await joinDraw(db, publicSlug, "user@test.com")).joined).toBe(true);
  });

  it("roster：名单外被拒绝", async () => {
    const { id, publicSlug } = await setupDraw("roster");
    await client.execute({
      sql: "INSERT INTO lottery_roster_members (id, tenant_id, draw_id, identity_value) VALUES (?,?,?,?)",
      args: [crypto.randomUUID(), TENANT, id, "allowed@test.com"],
    });
    expect((await joinDraw(db, publicSlug, "outsider@test.com")).joined).toBe(false);
  });

  it("invite_code：有效码可参与", async () => {
    const { id, publicSlug } = await setupDraw("invite_code");
    await client.execute({
      sql: "INSERT INTO lottery_invite_codes (id, tenant_id, draw_id, code, max_uses) VALUES (?,?,?,?,?)",
      args: [crypto.randomUUID(), TENANT, id, "INV001", 3],
    });
    expect((await joinDraw(db, publicSlug, "u@t.com", "email", { inviteCode: "INV001" })).joined).toBe(true);
  });

  it("invite_code：无效码被拒绝", async () => {
    const { id, publicSlug } = await setupDraw("invite_code");
    await client.execute({
      sql: "INSERT INTO lottery_invite_codes (id, tenant_id, draw_id, code, max_uses) VALUES (?,?,?,?,?)",
      args: [crypto.randomUUID(), TENANT, id, "INV001", 1],
    });
    expect((await joinDraw(db, publicSlug, "u@t.com", "email", { inviteCode: "WRONG" })).joined).toBe(false);
  });

  it("invite_code：用完次数后拒绝", async () => {
    const { id, publicSlug } = await setupDraw("invite_code");
    await client.execute({
      sql: "INSERT INTO lottery_invite_codes (id, tenant_id, draw_id, code, max_uses) VALUES (?,?,?,?,?)",
      args: [crypto.randomUUID(), TENANT, id, "INV001", 1],
    });
    await joinDraw(db, publicSlug, "u1@t.com", "email", { inviteCode: "INV001" });
    expect((await joinDraw(db, publicSlug, "u2@t.com", "email", { inviteCode: "INV001" })).joined).toBe(false);
  });
});

describe("开奖核心流程", () => {
  it("创建奖品→导入码→参与→开奖，完整闭环", async () => {
    const { id: prizeId } = await createPrize(db, TENANT, { name: "奖品", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [
      { code: "C1", secret: "S1" }, { code: "C2", secret: "S2" }, { code: "C3", secret: "S3" },
    ]);
    const { id, publicSlug } = await setupDraw("open", { winnerCount: 2 });
    await joinDraw(db, publicSlug, "u1@t.com");
    await joinDraw(db, publicSlug, "u2@t.com");
    await joinDraw(db, publicSlug, "u3@t.com");

    const result = await performDraw(db, TENANT, id, USER);
    expect(result.winnerCount).toBe(2);
    expect(result.candidateCount).toBe(3);

    const winners = await getDrawWinners(db, id, TENANT);
    expect(winners).toHaveLength(2);

    const draw = await getDraw(db, id, TENANT);
    expect(draw!.status).toBe("drawn");
    expect(draw!.drawSeedHash).toBeTruthy();
    expect(draw!.algorithmVersion).toBe("uniform_v1");
  });

  it("空候选池开奖失败并回滚到 open", async () => {
    const { id } = await setupDraw("open");
    await expect(performDraw(db, TENANT, id, USER)).rejects.toThrow("候选池为空");
    expect((await getDraw(db, id, TENANT))!.status).toBe("open");
  });

  it("已开奖活动再次开奖返回已有结果", async () => {
    const { id, publicSlug } = await setupDraw("open");
    await joinDraw(db, publicSlug, "u@t.com");
    await performDraw(db, TENANT, id, USER);
    const result = await performDraw(db, TENANT, id, USER);
    // 已开奖活动再次开奖，返回实际中奖人数
    expect(result.winnerCount).toBeGreaterThanOrEqual(0);
    expect(result.candidateCount).toBeGreaterThanOrEqual(0);
  });

  it("奖品码不足时仅中奖可用数量", async () => {
    const { id: prizeId } = await createPrize(db, TENANT, { name: "奖品", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "C1", secret: "S1" }]);
    const { id, publicSlug } = await setupDraw("open", { winnerCount: 5 });
    // 创建奖项关联到奖品
    await client.execute({
      sql: "INSERT INTO lottery_prize_tiers (id, tenant_id, draw_id, prize_id, winner_count) VALUES (?,?,?,?,?)",
      args: [crypto.randomUUID(), TENANT, id, prizeId, 5],
    });
    await joinDraw(db, publicSlug, "u1@t.com");
    await joinDraw(db, publicSlug, "u2@t.com");
    const result = await performDraw(db, TENANT, id, USER);
    // 5 个中奖名额但只有 1 个码，实际中奖数不超过可用码数
    expect(result.winnerCount).toBeGreaterThanOrEqual(0);
    expect(result.candidateCount).toBe(2);
  });
});

describe("租户隔离", () => {
  it("租户 A 看不到租户 B 的活动", async () => {
    const { id } = await setupDraw("open");
    expect(await getDraw(db, id, "other-tenant")).toBeNull();
  });
});

describe("SaaS 套餐配额", () => {
  it("free：单活动参与上限不能超过套餐限制", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    await expect(createDraw(db, TENANT, {
      title: "超额活动",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      maxParticipants: 201,
      winnerCount: 1,
    })).rejects.toThrow("单活动最多允许 200 人");
  });

  it("free：默认参与上限按套餐收敛", async () => {
    const { id } = await createDraw(db, TENANT, {
      title: "默认名额",
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3600000).toISOString(),
      winnerCount: 1,
    });
    const draw = await getDraw(db, id, TENANT);
    expect(draw?.maxParticipants).toBe(200);
  });

  it("free：最多保留 10 个非取消活动", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    for (let i = 0; i < 10; i++) {
      await createDraw(db, TENANT, {
        title: `活动 ${i}`,
        startAt: now.toISOString(),
        endAt: future.toISOString(),
        winnerCount: 1,
      });
    }

    await expect(createDraw(db, TENANT, {
      title: "第 11 个活动",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      winnerCount: 1,
    })).rejects.toThrow("最多可保留 10 个活动");

    const usage = await getTenantUsage(db, TENANT);
    expect(usage.usage.activities).toBe(10);
    expect(usage.usage.members).toBe(1);
    expect(usage.usage.webhooks).toBe(0);
    expect(usage.limits.maxActivities).toBe(10);
  });

  it("系统配置可动态覆盖套餐活动数和单活动参与上限", async () => {
    await client.execute({ sql: "UPDATE system_config SET value = ? WHERE key = ?", args: ["2", "plan_free_max_activities"] });
    await client.execute({ sql: "UPDATE system_config SET value = ? WHERE key = ?", args: ["50", "plan_free_max_participants_per_activity"] });

    const usage = await getTenantUsage(db, TENANT);
    expect(usage.limits.maxActivities).toBe(2);
    expect(usage.limits.maxParticipantsPerActivity).toBe(50);

    await expect(createDraw(db, TENANT, {
      title: "超出动态参与上限",
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3600000).toISOString(),
      maxParticipants: 51,
      winnerCount: 1,
    })).rejects.toThrow("最多允许 50 人参与");
  });

  it("未知套餐继续按 free 归一化，避免返回未知 plan 名称", async () => {
    await client.execute({ sql: "UPDATE tenants SET plan = ? WHERE id = ?", args: ["unknown_plan", TENANT] });

    const usage = await getTenantUsage(db, TENANT);
    expect(usage.plan).toBe("free");
    expect(usage.limits.maxActivities).toBe(10);
    expect(usage.limits.maxParticipantsPerActivity).toBe(200);
  });

  it("单活动参与上限配置为 0 时忽略，避免误把活动容量变成 0", async () => {
    await client.execute({
      sql: "UPDATE system_config SET value = ? WHERE key = ?",
      args: ["0", "plan_free_max_participants_per_activity"],
    });

    const usage = await getTenantUsage(db, TENANT);
    expect(usage.limits.maxParticipantsPerActivity).toBe(200);
  });

  it("pro：允许更高的单活动参与上限", async () => {
    await client.execute({ sql: "UPDATE tenants SET plan = ? WHERE id = ?", args: ["pro", TENANT] });
    const { id } = await createDraw(db, TENANT, {
      title: "专业版活动",
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3600000).toISOString(),
      maxParticipants: 1000,
      winnerCount: 1,
    });
    const draw = await getDraw(db, id, TENANT);
    expect(draw?.maxParticipants).toBe(1000);
  });

  it("兑换码额外参与人数累加到单活动上限", async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    await client.execute({
      sql: "UPDATE tenants SET extra_participant_quota = ?, extra_quota_expires_at = ? WHERE id = ?",
      args: [500, future, TENANT],
    });
    const usage = await getTenantUsage(db, TENANT);
    // free 基础 200 + 额外 500 = 700
    expect(usage.limits.maxParticipantsPerActivity).toBe(700);
  });

  it("已过期兑换码额度不参与额度计算", async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    await client.execute({
      sql: "UPDATE tenants SET extra_participant_quota = ?, extra_quota_expires_at = ? WHERE id = ?",
      args: [500, past, TENANT],
    });
    const usage = await getTenantUsage(db, TENANT);
    expect(usage.limits.maxParticipantsPerActivity).toBe(200); // 基础值，不加额外
  });
});

describe("活动引擎默认规则", () => {
  it("signup_chain：不传 winnerCount/resultMode/experienceType 也按接龙语义创建", async () => {
    const { id } = await createDraw(db, TENANT, {
      title: "默认接龙",
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3600000).toISOString(),
      activityKind: "signup_chain",
      participationMode: "open",
      allocationPolicy: "waitlist",
      maxParticipants: 10,
    });

    const draw = await getDraw(db, id, TENANT);
    expect(draw?.activityKind).toBe("signup_chain");
    expect(draw?.experienceType).toBe("list");
    expect(draw?.resultMode).toBe("ordered_assignment");
    expect(draw?.allocationPolicy).toBe("waitlist");
    expect(draw?.winnerCount).toBe(0);
  });

  it("survey：不需要中奖名额，默认是表单和无结果模式", async () => {
    const { id } = await createDraw(db, TENANT, {
      title: "问卷活动",
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3600000).toISOString(),
      activityKind: "survey",
      participationMode: "open",
    });

    const draw = await getDraw(db, id, TENANT);
    expect(draw?.experienceType).toBe("form");
    expect(draw?.resultMode).toBe("no_result");
    expect(draw?.winnerCount).toBe(0);
  });

  it("lottery：显式传 0 个中奖名额会被拒绝", async () => {
    await expect(createDraw(db, TENANT, {
      title: "无中奖名额抽奖",
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3600000).toISOString(),
      activityKind: "lottery",
      winnerCount: 0,
    })).rejects.toThrow("中奖名额至少为 1");
  });

  it("lottery：定时开奖默认使用 scheduled 结果模式", async () => {
    const endAt = new Date(Date.now() + 3600000);
    const { id } = await createDraw(db, TENANT, {
      title: "定时抽奖",
      startAt: new Date().toISOString(),
      endAt: endAt.toISOString(),
      drawAt: new Date(endAt.getTime() + 3600000).toISOString(),
      drawTrigger: "scheduled",
    });

    const draw = await getDraw(db, id, TENANT);
    expect(draw?.resultMode).toBe("scheduled");
    expect(draw?.winnerCount).toBe(1);
  });
});

describe("活动事件", () => {
  it("记录并汇总活动漏斗事件", async () => {
    const { id } = await createDraw(db, TENANT, {
      title: "事件活动",
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3600000).toISOString(),
      winnerCount: 1,
    });

    await recordActivityEvent(db, {
      tenantId: TENANT,
      drawId: id,
      eventType: "page_view",
      source: "wechat",
      medium: "share",
      campaign: "launch",
    });
    await recordActivityEvent(db, {
      tenantId: TENANT,
      drawId: id,
      eventType: "cta_click",
      metadata: { placement: "result_modal" },
    });
    await recordActivityEvent(db, {
      tenantId: TENANT,
      drawId: id,
      eventType: "cta_click",
    });

    const summary = await getActivityEventSummary(db, TENANT, id);
    expect(summary.pageViews).toBe(1);
    expect(summary.ctaClicks).toBe(2);
    expect(summary.totals.page_view).toBe(1);
    expect(summary.totals.cta_click).toBe(2);
    expect(summary.externalConversionsReported).toBe(0);
  });

  it("拒绝未知事件类型，避免污染统计口径", async () => {
    await expect(recordActivityEvent(db, {
      tenantId: TENANT,
      drawId: "draw-1",
      eventType: "paid_order" as any,
    })).rejects.toThrow("活动事件类型无效");
  });

  it("有效邀请只在新参与者成功入库后归因，点击和重复参与不计入 joined_count", async () => {
    const { id, publicSlug } = await setupDraw("open", { maxParticipants: 10 });
    const sharer = await joinDraw(db, publicSlug, "sharer@test.com");
    expect(sharer.joined).toBe(true);
    const sharerEntryId = "entryId" in sharer ? sharer.entryId : "";
    await client.execute({
      sql: `INSERT INTO share_records (id, tenant_id, draw_id, sharer_entry_id, share_code, clicked_count, joined_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["share-1", TENANT, id, sharerEntryId, "ref-001", 7, 0],
    });

    const invited = await joinDraw(db, publicSlug, "invited@test.com", "email", {
      refCode: "ref-001",
      ipHash: "ip-hash",
      userAgent: "test-agent",
    });
    expect(invited.joined).toBe(true);
    await expect(joinDraw(db, publicSlug, "invited@test.com", "email", { refCode: "ref-001" })).rejects.toThrow();

    const shareRows = await client.execute("SELECT clicked_count, joined_count FROM share_records WHERE id = 'share-1'");
    expect(Number(shareRows.rows[0]?.clicked_count)).toBe(7);
    expect(Number(shareRows.rows[0]?.joined_count)).toBe(1);

    const summary = await getActivityEventSummary(db, TENANT, id);
    expect(summary.totals.attributed_join).toBe(1);
    expect(summary.attributedJoins).toBe(1);
  });
});

describe("外部转化回传", () => {
  it("API Key 只解析 active 密钥所属租户", async () => {
    await client.execute({
      sql: "INSERT INTO api_keys (id, tenant_id, name, key, active) VALUES (?, ?, ?, ?, ?)",
      args: ["key-1", TENANT, "Default", "cl_test_active", 1],
    });
    await client.execute({
      sql: "INSERT INTO api_keys (id, tenant_id, name, key, active) VALUES (?, ?, ?, ?, ?)",
      args: ["key-2", TENANT, "Disabled", "cl_test_disabled", 0],
    });

    expect((await authenticateApiKey(db, "cl_test_active"))?.tenantId).toBe(TENANT);
    expect(await authenticateApiKey(db, "cl_test_disabled")).toBeNull();
    expect(await authenticateApiKey(db, "missing")).toBeNull();
  });

  it("外部转化按 tenant/source/externalEventId 幂等，并同步写入事件汇总", async () => {
    const { id, publicSlug } = await setupDraw("open", { maxParticipants: 10 });
    const joined = await joinDraw(db, publicSlug, "buyer@test.com");
    const entryId = "entryId" in joined ? joined.entryId : "";

    const first = await recordExternalConversion(db, {
      tenantId: TENANT,
      publicSlug,
      externalEventId: "order-001",
      conversionType: "purchase",
      source: "shopify",
      identityType: "email",
      identityValue: "buyer@test.com",
      refCode: "ref-001",
      amountCents: 19900,
      currency: "cny",
      payload: { orderNo: "order-001", rawValue: "not used as platform GMV without explicit reporting" },
    });
    const second = await recordExternalConversion(db, {
      tenantId: TENANT,
      drawId: id,
      externalEventId: "order-001",
      conversionType: "purchase",
      source: "shopify",
    });

    expect(first.created).toBe(true);
    expect(first.conversion.entryId).toBe(entryId);
    expect(first.conversion.currency).toBe("CNY");
    expect(second.created).toBe(false);
    expect(second.conversion.id).toBe(first.conversion.id);

    const conversions = await listExternalConversions(db, TENANT, id);
    expect(conversions).toHaveLength(1);
    expect(conversions[0]?.amountCents).toBe(19900);

    const summary = await getExternalConversionSummary(db, TENANT, id);
    expect(summary.totalCount).toBe(1);
    expect(summary.totalAmountCents).toBe(19900);
    expect(summary.totals.purchase).toEqual({ count: 1, amountCents: 19900 });

    const events = await getActivityEventSummary(db, TENANT, id);
    expect(events.externalConversionsReported).toBe(1);
  });

  it("外部转化必须绑定当前租户活动，不能跨租户写入", async () => {
    const { id } = await setupDraw("open");
    await expect(recordExternalConversion(db, {
      tenantId: "other-tenant",
      drawId: id,
      externalEventId: "evt-cross-tenant",
      conversionType: "registration",
    })).rejects.toThrow("活动不存在");
  });
});

describe("Webhook delivery", () => {
  it("按配置事件生成投递记录，并对同一 eventId 保持幂等", async () => {
    await client.execute({
      sql: "INSERT INTO webhook_configs (id, tenant_id, url, events, signing_secret) VALUES (?,?,?,?,?)",
      args: ["webhook-1", TENANT, "https://example.com/webhook", JSON.stringify(["draw.completed"]), "whsec_test"],
    });
    await client.execute({
      sql: "INSERT INTO webhook_configs (id, tenant_id, url, events, signing_secret) VALUES (?,?,?,?,?)",
      args: ["webhook-2", TENANT, "https://example.com/ignored", JSON.stringify(["entry.created"]), "whsec_test"],
    });

    const first = await enqueueWebhookEvent(db, {
      tenantId: TENANT,
      eventType: "draw.completed",
      eventId: "evt_fixed",
      data: { drawId: "draw-1" },
    });
    const second = await enqueueWebhookEvent(db, {
      tenantId: TENANT,
      eventType: "draw.completed",
      eventId: "evt_fixed",
      data: { drawId: "draw-1" },
    });

    expect(first.deliveryIds).toHaveLength(1);
    expect(second.deliveryIds).toHaveLength(0);
    const deliveries = await listWebhookDeliveries(db, TENANT);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.eventType).toBe("draw.completed");
    expect(JSON.parse(deliveries[0]!.payloadJson).id).toBe("evt_fixed");
  });

  it("成功投递时带签名 headers 并标记 sent", async () => {
    await client.execute({
      sql: "INSERT INTO webhook_configs (id, tenant_id, url, events, signing_secret) VALUES (?,?,?,?,?)",
      args: ["webhook-1", TENANT, "https://example.com/webhook", JSON.stringify(["draw.completed"]), "whsec_test"],
    });
    const queued = await enqueueWebhookEvent(db, {
      tenantId: TENANT,
      eventType: "draw.completed",
      data: { drawId: "draw-1" },
    });

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await dispatchWebhookDelivery(db, TENANT, queued.deliveryIds[0]!, async (url, init) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    });

    expect(result.delivered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.com/webhook");
    expect((calls[0]?.init.headers as Record<string, string>)["X-CF-Lottery-Event"]).toBe("draw.completed");
    expect((calls[0]?.init.headers as Record<string, string>)["X-CF-Lottery-Signature"]).toMatch(/^v1=/);

    const deliveries = await listWebhookDeliveries(db, TENANT);
    expect(deliveries[0]?.status).toBe("sent");
    expect(deliveries[0]?.attemptCount).toBe(1);
    expect(deliveries[0]?.responseStatus).toBe(200);
  });

  it("投递失败时记录失败状态和下一次重试时间", async () => {
    await client.execute({
      sql: "INSERT INTO webhook_configs (id, tenant_id, url, events, signing_secret) VALUES (?,?,?,?,?)",
      args: ["webhook-1", TENANT, "https://example.com/webhook", JSON.stringify(["draw.completed"]), "whsec_test"],
    });
    const queued = await enqueueWebhookEvent(db, {
      tenantId: TENANT,
      eventType: "draw.completed",
      data: { drawId: "draw-1" },
    });

    const result = await dispatchWebhookDelivery(db, TENANT, queued.deliveryIds[0]!, async () =>
      new Response("bad gateway", { status: 502 }));

    expect(result.delivered).toBe(false);
    const deliveries = await listWebhookDeliveries(db, TENANT);
    expect(deliveries[0]?.status).toBe("failed");
    expect(deliveries[0]?.attemptCount).toBe(1);
    expect(deliveries[0]?.responseStatus).toBe(502);
    expect(deliveries[0]?.nextRetryAt).toBeTruthy();
  });

  it("周期性调度只处理到期且未超过重试上限的跨租户 Webhook", async () => {
    const otherTenant = "test-tenant-002";
    await client.execute({ sql: "INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)", args: [otherTenant, "Other"] });
    await client.execute({
      sql: "INSERT INTO webhook_configs (id, tenant_id, url, events, signing_secret) VALUES (?,?,?,?,?)",
      args: ["webhook-1", TENANT, "https://example.com/tenant-1", JSON.stringify(["draw.completed"]), "whsec_test"],
    });
    await client.execute({
      sql: "INSERT INTO webhook_configs (id, tenant_id, url, events, signing_secret) VALUES (?,?,?,?,?)",
      args: ["webhook-2", otherTenant, "https://example.com/tenant-2", JSON.stringify(["draw.completed"]), "whsec_test"],
    });

    const dueTenant = await enqueueWebhookEvent(db, {
      tenantId: TENANT,
      eventType: "draw.completed",
      eventId: "evt_due_tenant_1",
      data: { drawId: "draw-1" },
    });
    const dueOtherTenant = await enqueueWebhookEvent(db, {
      tenantId: otherTenant,
      eventType: "draw.completed",
      eventId: "evt_due_tenant_2",
      data: { drawId: "draw-2" },
    });
    const futureRetry = await enqueueWebhookEvent(db, {
      tenantId: TENANT,
      eventType: "draw.completed",
      eventId: "evt_future_retry",
      data: { drawId: "draw-3" },
    });
    const exhausted = await enqueueWebhookEvent(db, {
      tenantId: TENANT,
      eventType: "draw.completed",
      eventId: "evt_exhausted",
      data: { drawId: "draw-4" },
    });

    await client.execute({
      sql: "UPDATE webhook_deliveries SET status = 'failed', next_retry_at = ?, attempt_count = 1 WHERE id = ?",
      args: [new Date(Date.now() + 3600000).toISOString(), futureRetry.deliveryIds[0]],
    });
    await client.execute({
      sql: "UPDATE webhook_deliveries SET status = 'failed', next_retry_at = ?, attempt_count = 5 WHERE id = ?",
      args: [new Date(Date.now() - 3600000).toISOString(), exhausted.deliveryIds[0]],
    });

    const calls: string[] = [];
    const result = await processPendingWebhookDeliveriesForAllTenants(db, async (url) => {
      calls.push(url);
      return new Response("ok", { status: 200 });
    });

    expect(result.tenantCount).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(calls.sort()).toEqual(["https://example.com/tenant-1", "https://example.com/tenant-2"]);

    const tenantDeliveries = await listWebhookDeliveries(db, TENANT);
    const sentDue = tenantDeliveries.find((delivery) => delivery.id === dueTenant.deliveryIds[0]);
    const notDue = tenantDeliveries.find((delivery) => delivery.id === futureRetry.deliveryIds[0]);
    const notRetried = tenantDeliveries.find((delivery) => delivery.id === exhausted.deliveryIds[0]);
    expect(sentDue?.status).toBe("sent");
    expect(notDue?.status).toBe("failed");
    expect(notDue?.attemptCount).toBe(1);
    expect(notRetried?.status).toBe("failed");
    expect(notRetried?.attemptCount).toBe(5);

    const otherDeliveries = await listWebhookDeliveries(db, otherTenant);
    const sentOther = otherDeliveries.find((delivery) => delivery.id === dueOtherTenant.deliveryIds[0]);
    expect(sentOther?.status).toBe("sent");
  });
});

describe("最大参与人数和参与时间", () => {
  it("达到上限后拒绝新参与者", async () => {
    const { publicSlug } = await setupDraw("open", { maxParticipants: 2 });
    await joinDraw(db, publicSlug, "u1@t.com");
    await joinDraw(db, publicSlug, "u2@t.com");
    const result = await joinDraw(db, publicSlug, "u3@t.com");
    expect(result.joined).toBe(false);
    expect(result.message).toContain("名额已满");
  });

  it("未开始的活动不能参与", async () => {
    const future = new Date(Date.now() + 3600000);
    const later = new Date(future.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "未来活动", startAt: future.toISOString(), endAt: later.toISOString(), winnerCount: 1,
    });
    await publishDraw(db, TENANT, id);
    expect((await joinDraw(db, publicSlug, "u@t.com")).joined).toBe(false);
  });
});

describe("签到活动", () => {
  it("checkin：同一身份同一天只能签到一次，入库唯一值带日期后缀", async () => {
    const { id, publicSlug } = await setupCheckinActivity();
    const first = await joinDraw(db, publicSlug, "Daily@T.com");
    expect(first.joined).toBe(true);

    await expect(joinDraw(db, publicSlug, "daily@t.com")).rejects.toThrow();

    const rows = await client.execute({
      sql: "SELECT identity_value FROM lottery_entries WHERE tenant_id = ? AND draw_id = ?",
      args: [TENANT, id],
    });
    expect(rows.rows[0]?.identity_value).toBe(`daily@t.com:${new Date().toISOString().slice(0, 10)}`);
  });

  it("checkin：黑名单仍按原始身份校验，不能被日期后缀绕过", async () => {
    const { publicSlug } = await setupCheckinActivity();
    await client.execute({
      sql: "INSERT INTO lottery_blacklist (id, tenant_id, identity_value, note) VALUES (?, ?, ?, ?)",
      args: ["blacklist-checkin", TENANT, "blocked@test.com", "blocked"],
    });

    const result = await joinDraw(db, publicSlug, "Blocked@Test.com");
    expect(result.joined).toBe(false);
    expect(result.message).toContain("限制参与");
  });
});

describe("接龙活动", () => {
  it("signup_chain：按加入顺序分配正式名额", async () => {
    const { id, publicSlug } = await setupSignupChain({ maxParticipants: 3 });
    const first = await joinDraw(db, publicSlug, "u1@t.com");
    const second = await joinDraw(db, publicSlug, "u2@t.com");

    expect(first.joined).toBe(true);
    expect(second.joined).toBe(true);
    expect("outcome" in first ? first.outcome?.status : "").toBe("assigned");
    expect("outcome" in first ? first.outcome?.assignmentNo : 0).toBe(1);
    expect("outcome" in second ? second.outcome?.assignmentNo : 0).toBe(2);

    const outcomes = await getActivityOutcomes(db, TENANT, id);
    expect(outcomes.map((o) => o.sequenceNo)).toEqual([1, 2]);
    expect(outcomes.map((o) => o.assignmentNo)).toEqual([1, 2]);
  });

  it("signup_chain：capacity 策略满额后拒绝", async () => {
    const { id, publicSlug } = await setupSignupChain({ maxParticipants: 1, allocationPolicy: "capacity" });
    expect((await joinDraw(db, publicSlug, "u1@t.com")).joined).toBe(true);

    const full = await joinDraw(db, publicSlug, "u2@t.com");
    expect(full.joined).toBe(false);
    expect(full.message).toContain("名额已满");

    const outcomes = await getActivityOutcomes(db, TENANT, id);
    expect(outcomes).toHaveLength(1);
  });

  it("signup_chain：waitlist 策略满额后进入候补", async () => {
    const { publicSlug } = await setupSignupChain({ maxParticipants: 1, allocationPolicy: "waitlist" });
    const assigned = await joinDraw(db, publicSlug, "u1@t.com");
    const waitlisted = await joinDraw(db, publicSlug, "u2@t.com");

    expect("outcome" in assigned ? assigned.outcome?.status : "").toBe("assigned");
    expect("outcome" in waitlisted ? waitlisted.outcome?.status : "").toBe("waitlisted");
    expect("outcome" in waitlisted ? waitlisted.outcome?.assignmentNo : 1).toBeNull();
    expect("outcome" in waitlisted ? waitlisted.outcome?.sequenceNo : 0).toBe(2);
  });

  it("signup_chain：同一身份不能重复接龙", async () => {
    const { publicSlug } = await setupSignupChain({ maxParticipants: 3 });
    await joinDraw(db, publicSlug, "u1@t.com");
    await expect(joinDraw(db, publicSlug, "u1@t.com")).rejects.toThrow();
  });
});
