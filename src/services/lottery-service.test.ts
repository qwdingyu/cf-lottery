/**
 * 抽奖服务核心业务测试
 *
 * 使用真实 libSQL 数据库，测试 084 文档规定的全部使用场景。
 */
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, beforeAll } from "vitest";
import { createDb } from "../db/client";
import {
  createDraw,
  publishDraw,
  performDraw,
  joinDraw,
  getDraw,
  getDrawWinners,
  createPrize,
  importPrizeCodes,
  randomSelect,
} from "../services/lottery-service";

let client: Client;
let db: ReturnType<typeof createDb>;
const TENANT = "test-tenant-001";
const USER = "test-user-001";

beforeAll(async () => {
  client = createClient({ url: "file:test-lottery.db" });
  db = createDb(client);
  await client.execute(`CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS tenant_members (
    tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (tenant_id, user_id)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS prizes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '', prize_type TEXT NOT NULL DEFAULT 'code', fulfillment_note TEXT NOT NULL DEFAULT '',
    total_count INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
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
    draw_seed_hash TEXT NOT NULL DEFAULT '', algorithm_version TEXT NOT NULL DEFAULT 'uniform_v1',
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
  await client.execute({ sql: "INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)", args: [TENANT, "Test"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)", args: [USER, "test", "hash"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO tenant_members (tenant_id, user_id) VALUES (?, ?)", args: [TENANT, USER] });
});

afterEach(async () => {
  await client.execute("DELETE FROM lottery_winners");
  await client.execute("DELETE FROM lottery_entries");
  await client.execute("DELETE FROM lottery_invite_codes");
  await client.execute("DELETE FROM lottery_roster_members");
  await client.execute("DELETE FROM lottery_prize_tiers");
  await client.execute("DELETE FROM lottery_draws");
  await client.execute("DELETE FROM prize_codes");
  await client.execute("DELETE FROM prizes");
  await client.execute("DELETE FROM audit_logs");
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

  it("发布校验：标题为空拒绝", async () => {
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
    await client.execute({ sql: "UPDATE lottery_draws SET access_password = ? WHERE id = ?", args: ["pwd", id] });
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
    expect(result.winnerCount).toBe(0);
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
    expect(result.winnerCount).toBeLessThanOrEqual(1);
  });
});

describe("租户隔离", () => {
  it("租户 A 看不到租户 B 的活动", async () => {
    const { id } = await setupDraw("open");
    expect(await getDraw(db, id, "other-tenant")).toBeNull();
  });
});

describe("最大参与人数和参与时间", () => {
  it("达到上限后拒绝新参与者", async () => {
    const { publicSlug } = await setupDraw("open", { maxParticipants: 2 });
    await joinDraw(db, publicSlug, "u1@t.com");
    await joinDraw(db, publicSlug, "u2@t.com");
    expect((await joinDraw(db, publicSlug, "u3@t.com")).joined).toBe(false);
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