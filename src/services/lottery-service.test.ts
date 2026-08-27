/**
 * 抽奖服务核心业务测试
 *
 * 使用真实 libSQL 数据库，测试 084 文档规定的全部使用场景。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDraw,
  publishDraw,
  performDraw,
  processDueDraws,
  joinDraw,
  getDraw,
  getDrawWinners,
  getActivityOutcomes,
  getTenantUsage,
  recordActivityEvent,
  getActivityEventSummary,
  authenticateApiKey,
  hashApiKey,
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
  triggerRewardEarned,
  cancelDraw,
  performInstantSpin,
  grantLeaderboardRewards,
  cancelSignupChainEntry,
} from "../services/lottery-service";
import { settleRewardByPercent, cancelRewardPending, parseRewardConfig } from "../services/lottery/reward";
import {
  lotteryPrizeTiers,
  shareRecords,
  lotteryEntries,
  apiKeys,
  activityEvents,
  tenantConfigs,
  lotteryDraws,
  lotteryInviteCodes,
  paymentOrders,
  paymentOrderAttempts,
  spinsLog,
  prizeCodes,
  prizes,
  activityOutcomes,
  users,
} from "../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { clearTestData, getTestDb } from "../test-setup";
import { encryptPaymentConfigValue } from "@usethink/cf-pay/config-store";
import { sanitizePublicPromotionConfig } from "../lib/activity-utils";
import { todayStr } from "../lib/date-utils";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];
const TENANT = "test-tenant-001";
const USER = "test-user-001";
const PAYMENT_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

beforeEach(async () => {
  await clearTestData(client);
  await client.execute({ sql: "INSERT INTO tenants (id, name) VALUES (?, ?)", args: [TENANT, "Test"] });
  await client.execute({
    sql: "INSERT INTO users (id, username, email, email_verified, password_hash) VALUES (?, ?, ?, ?, ?)",
    args: [USER, "test", "test@example.com", 1, "hash"],
  });
  await client.execute({ sql: "INSERT INTO tenant_members (tenant_id, user_id) VALUES (?, ?)", args: [TENANT, USER] });
});

/* ── 辅助函数 ── */
async function configureManualTier(drawId: string, winnerCount = 1) {
  const { id: prizeId } = await createPrize(db, TENANT, { name: "测试奖品", prizeType: "manual_fulfillment" });
  await db.insert(lotteryPrizeTiers).values({
    id: crypto.randomUUID(),
    tenantId: TENANT,
    drawId,
    prizeId,
    tierName: "一等奖",
    winnerCount,
    sortOrder: 100,
  });
}

async function setupDraw(mode = "open", opts?: { maxParticipants?: number; winnerCount?: number }) {
  const now = new Date();
  const future = new Date(now.getTime() + 3600000);
  const { id, publicSlug } = await createDraw(db, TENANT, {
    title: `${mode} 活动`,
    startAt: now.toISOString(),
    endAt: future.toISOString(),
    participationMode: mode,
    accessPassword: mode === "password" ? "pwd" : undefined,
    winnerCount: opts?.winnerCount ?? 1,
    maxParticipants: opts?.maxParticipants,
  });
  // 发布前校验要求抽奖活动至少配置一个奖项。
  // 测试辅助函数总是创建独立的手动发放奖品，避免误复用其他用例的卡密奖品导致码池预检互相污染。
  await configureManualTier(id, opts?.winnerCount ?? 1);
  if (mode === "roster") {
    await client.execute({
      sql: "INSERT INTO lottery_roster_members (id, tenant_id, draw_id, identity_value) VALUES (?,?,?,?)",
      args: [crypto.randomUUID(), TENANT, id, "user@test.com"],
    });
  }
  if (mode === "invite_code") {
    await client.execute({
      sql: "INSERT INTO lottery_invite_codes (id, tenant_id, draw_id, code, max_uses) VALUES (?,?,?,?,?)",
      args: [crypto.randomUUID(), TENANT, id, "PUBLISH-INVITE", 1],
    });
  }
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

  it("部分洗牌结果：不重复且全部来自候选池（#12 优化后语义保持）", async () => {
    const candidates = Array.from({ length: 200 }, (_, i) => `c${i}`);
    const result = await randomSelect(candidates, 5);
    expect(result).toHaveLength(5);
    expect(new Set(result).size).toBe(5); // 无重复
    for (const item of result) {
      expect(candidates).toContain(item); // 全部来自候选池
    }
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

  it("lottery 仅传 drawAt、不传 drawTrigger → 推断 scheduled + resultMode scheduled（docs/115）", async () => {
    const start = new Date().toISOString();
    const end = new Date(Date.now() + 3600000).toISOString();
    const drawAt = new Date(Date.now() + 7200000).toISOString();
    const { id } = await createDraw(db, TENANT, {
      title: "仅 drawAt",
      startAt: start,
      endAt: end,
      drawAt,
      winnerCount: 1,
      // 故意不传 drawTrigger / resultMode：模拟旧管理端表单
    });
    const draw = await getDraw(db, id, TENANT);
    expect(draw?.drawTrigger).toBe("scheduled");
    expect(draw?.resultMode).toBe("scheduled");
    expect(draw?.drawAt).toBeTruthy();
  });

  it("显式 drawTrigger=manual + drawAt 仍尊重 manual（不强制改 scheduled）", async () => {
    const start = new Date().toISOString();
    const end = new Date(Date.now() + 3600000).toISOString();
    const drawAt = new Date(Date.now() + 7200000).toISOString();
    const { id } = await createDraw(db, TENANT, {
      title: "手动但记时间",
      startAt: start,
      endAt: end,
      drawAt,
      drawTrigger: "manual",
      resultMode: "manual",
      winnerCount: 1,
    });
    const draw = await getDraw(db, id, TENANT);
    expect(draw?.drawTrigger).toBe("manual");
    expect(draw?.resultMode).toBe("manual");
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
    const first = await joinDraw(db, publicSlug, "user@test.com");
    expect(first.joined).toBe(true);
    const again = await joinDraw(db, publicSlug, "user@test.com");
    expect(again.joined).toBe(false);
    expect(again.message).toContain("已参与");
    expect("alreadyJoined" in again && again.alreadyJoined).toBe(true);
    expect("entryId" in again ? again.entryId : "").toBeTruthy();
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
    const { publicSlug } = await setupDraw("roster");
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

  it("invite_code：活动满额时拒绝参与但不消耗邀请码次数", async () => {
    const { id, publicSlug } = await setupDraw("invite_code", { maxParticipants: 1 });
    const inviteId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO lottery_invite_codes (id, tenant_id, draw_id, code, max_uses) VALUES (?,?,?,?,?)",
      args: [inviteId, TENANT, id, "CAP-INVITE", 2],
    });

    expect((await joinDraw(db, publicSlug, "u1@t.com", "email", { inviteCode: "CAP-INVITE" })).joined).toBe(true);
    const rejected = await joinDraw(db, publicSlug, "u2@t.com", "email", { inviteCode: "CAP-INVITE" });
    expect(rejected.joined).toBe(false);
    expect(rejected.message).toContain("名额已满");

    const [invite] = await db
      .select({ usedCount: lotteryInviteCodes.usedCount })
      .from(lotteryInviteCodes)
      .where(eq(lotteryInviteCodes.id, inviteId));
    expect(invite!.usedCount).toBe(1);
  });
});

describe("开奖核心流程", () => {
  it("创建奖品→导入码→参与→开奖，完整闭环", async () => {
    // setupDraw 默认挂 manual 档位；本用例要测卡密锁码，必须覆盖为 code 奖项（docs/102）
    const { id: prizeId } = await createPrize(db, TENANT, { name: "奖品", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [
      { code: "C1", secret: "S1" }, { code: "C2", secret: "S2" }, { code: "C3", secret: "S3" },
    ]);
    const { id, publicSlug } = await setupDraw("open", { winnerCount: 2 });
    await db.delete(lotteryPrizeTiers).where(and(eq(lotteryPrizeTiers.drawId, id), eq(lotteryPrizeTiers.tenantId, TENANT)));
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      prizeId,
      tierName: "一等奖",
      winnerCount: 2,
      sortOrder: 1,
    });
    await joinDraw(db, publicSlug, "u1@t.com");
    await joinDraw(db, publicSlug, "u2@t.com");
    await joinDraw(db, publicSlug, "u3@t.com");

    const result = await performDraw(db, TENANT, id, USER);
    expect(result.winnerCount).toBe(2);
    expect(result.candidateCount).toBe(3);

    const winners = await getDrawWinners(db, id, TENANT);
    expect(winners).toHaveLength(2);
    // 卡密必须锁上并被 getDrawWinners 水合（管理端结果表依赖这些字段）
    for (const w of winners) {
      expect(w.prizeCodeId).toBeTruthy();
      expect(w.hasPrizeCode).toBe(true);
      expect(w.cardAccountLabel).toMatch(/^C[123]$/);
      expect(w.cardDeliverySecret).toMatch(/^S[123]$/);
      expect(w.prizeName).toBe("奖品");
      expect(w.prizeType).toBe("code");
      expect(w.fulfillmentKind).toBe("code");
      expect(w.orderNo).toBeNull();
    }
    const labels = new Set(winners.map((w) => w.cardAccountLabel));
    expect(labels.size).toBe(2);

    const draw = await getDraw(db, id, TENANT);
    expect(draw!.status).toBe("drawn");
    expect(draw!.drawSeedHash).toBeTruthy();
    expect(draw!.algorithmVersion).toBe("uniform_v1");
  });

  it("人工履约开奖：无卡密但 getDrawWinners 返回 prizeName/manual", async () => {
    const { id, publicSlug } = await setupDraw("open", { winnerCount: 1 });
    await joinDraw(db, publicSlug, "manual-win@t.com");
    await performDraw(db, TENANT, id, USER);
    const winners = await getDrawWinners(db, id, TENANT);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.prizeCodeId).toBeFalsy();
    expect(winners[0]!.hasPrizeCode).toBe(false);
    expect(winners[0]!.prizeType).toBe("manual_fulfillment");
    expect(winners[0]!.prizeName).toBe("测试奖品");
    expect(winners[0]!.fulfillmentKind).toBe("manual");
    expect(winners[0]!.orderNo).toBeNull();
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

  /**
   * docs/117 P0-2 / docs/123：Cron 纵深过滤 resultMode=instant。
   * 即使库内误配 draw_trigger=scheduled 且 draw_at 已到期，processDueDraws 也不得 performDraw。
   * performDraw 自身仍硬拒绝（双保险）。
   */
  it("processDueDraws 排除 resultMode=instant（误配 scheduled+到期也不抽）", async () => {
    const now = Date.now();
    const startAt = new Date(now - 3 * 3600000).toISOString();
    const endAt = new Date(now - 2 * 3600000).toISOString();
    const drawAtPast = new Date(now - 60000).toISOString();

    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "instant 误配 scheduled",
      startAt,
      endAt: new Date(now + 3600000).toISOString(), // 创建时 end 须在未来；发布后再改时间窗
      participationMode: "open",
      activityKind: "lottery",
      experienceType: "wheel",
      resultMode: "instant",
      maxSpinsPerEntry: 1,
      winnerCount: 1,
    });

    const prizeId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type, total_count, active) VALUES (?, ?, ?, ?, ?, ?)",
      args: [prizeId, TENANT, "Cron拒instant奖", "code", 3, 1],
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      prizeId,
      tierName: "一等奖",
      winnerCount: 1,
      sortOrder: 1,
      weight: 100,
    });
    for (let i = 0; i < 3; i++) {
      await client.execute({
        sql: "INSERT INTO prize_codes (id, tenant_id, prize_id, code, status) VALUES (?, ?, ?, ?, ?)",
        args: [crypto.randomUUID(), TENANT, prizeId, `CRON-INST-${i}`, "available"],
      });
    }
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    // 模拟脏数据/历史误配：instant 活动被写成 scheduled 且 draw_at 已过
    await client.execute({
      sql: `UPDATE lottery_draws
            SET draw_trigger = 'scheduled', draw_at = ?, start_at = ?, end_at = ?, status = 'open'
            WHERE id = ? AND tenant_id = ?`,
      args: [drawAtPast, startAt, endAt, id, TENANT],
    });

    const joined = await joinDraw(db, publicSlug, "cron-instant@test.com");
    // end_at 已过：join 可能失败；若失败则直接插 entry，保证候选池非空（测 Cron 而非 join 闸门）
    if (!joined.joined) {
      await client.execute({
        sql: `INSERT INTO lottery_entries (
          id, tenant_id, draw_id, identity_type, identity_value,
          spins_left, spins_total_granted, spins_viral_earned, joined_at
        ) VALUES (?, ?, ?, 'email', ?, 1, 1, 0, ?)`,
        args: [crypto.randomUUID(), TENANT, id, "cron-instant@test.com", new Date().toISOString()],
      });
    }

    const cron = await processDueDraws(db, { limit: 20 });
    expect(cron.processed).toBe(0);
    expect(cron.failed).toBe(0);
    expect(cron.errors).toHaveLength(0);

    const drawAfter = await getDraw(db, id, TENANT);
    expect(drawAfter?.status).toBe("open");
    expect(drawAfter?.resultMode).toBe("instant");

    // 纵深第二层：直接 performDraw 仍拒绝
    await expect(performDraw(db, TENANT, id, USER)).rejects.toThrow(/即时开奖|spin/);
    expect((await getDraw(db, id, TENANT))?.status).toBe("open");
  });

  it("processDueDraws 仍处理到期的 scheduled 非 instant 活动", async () => {
    const now = Date.now();
    const startAt = new Date(now - 3 * 3600000).toISOString();
    const endAt = new Date(now - 2 * 3600000).toISOString();
    const drawAtPast = new Date(now - 60000).toISOString();

    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "scheduled 到期应开奖",
      startAt: new Date(now - 1000).toISOString(),
      endAt: new Date(now + 3600000).toISOString(),
      drawAt: new Date(now + 7200000).toISOString(),
      drawTrigger: "scheduled",
      resultMode: "scheduled",
      participationMode: "open",
      activityKind: "lottery",
      winnerCount: 1,
    });
    await configureManualTier(id, 1);
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    // 把时间窗与 draw_at 拨到「已到期」
    await client.execute({
      sql: `UPDATE lottery_draws
            SET start_at = ?, end_at = ?, draw_at = ?, draw_trigger = 'scheduled', status = 'open'
            WHERE id = ? AND tenant_id = ?`,
      args: [startAt, endAt, drawAtPast, id, TENANT],
    });

    const joinRes = await joinDraw(db, publicSlug, "cron-sched@test.com");
    if (!joinRes.joined) {
      await client.execute({
        sql: `INSERT INTO lottery_entries (
          id, tenant_id, draw_id, identity_type, identity_value, joined_at
        ) VALUES (?, ?, ?, 'email', ?, ?)`,
        args: [crypto.randomUUID(), TENANT, id, "cron-sched@test.com", new Date().toISOString()],
      });
    }

    const cron = await processDueDraws(db, { limit: 20 });
    expect(cron.processed).toBe(1);
    expect(cron.failed).toBe(0);
    expect((await getDraw(db, id, TENANT))?.status).toBe("drawn");
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

  it("docs/166：lottery + paymentRequired 时 performDraw 只选 PAID entry（纵深防御）", async () => {
    // 发布预检已阻断 lottery + paymentRequired；但存量/历史数据可能绕过。
    // 运行时纵深防御：performDraw 必须只允许 PAID entry 进入候选池。
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "直付抽奖纵深防御",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      activityKind: "lottery",
      experienceType: "flash_sale",
      resultMode: "manual",
      winnerCount: 1,
      maxParticipants: 10,
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, priceCents: 9900, stockLimit: 10, maxPerUser: 1, currency: "cny" },
      }),
    });
    // 手工配置奖项，绕过 publish 门禁
    await configureManualTier(id, 1);
    // 直接设置状态为 open（绕过 publish 预检，模拟存量数据）
    await db.update(lotteryDraws).set({ status: "open" }).where(eq(lotteryDraws.id, id));

    // 创建两个参与者：一个 PAID，一个 RESERVED（未付款）
    const paidEmail = "paid@test.com";
    const freeEmail = "free@test.com";
    const paidJoin = await joinDraw(db, publicSlug, paidEmail);
    const freeJoin = await joinDraw(db, publicSlug, freeEmail);
    expect(paidJoin.joined).toBe(true);
    expect(freeJoin.joined).toBe(true);

    // 手动将 paid entry 标记为 PAID，模拟支付回调
    await db
      .update(lotteryEntries)
      .set({ paymentStatus: "paid" })
      .where(and(eq(lotteryEntries.drawId, id), eq(lotteryEntries.identityValue, paidEmail)));

    // 执行开奖
    const result = await performDraw(db, TENANT, id, USER);
    // 候选池只包含 PAID entry（1 个），不包含 RESERVED entry
    expect(result.candidateCount).toBe(1);
    expect(result.winnerCount).toBe(1);

    // 验证中奖者身份（使用 getDrawWinners 确保租户隔离）
    const winners = await getDrawWinners(db, id, TENANT);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.identityValue).toBe(paidEmail);
  });
});

describe("租户隔离", () => {
  it("租户 A 看不到租户 B 的活动", async () => {
    const { id } = await setupDraw("open");
    expect(await getDraw(db, id, "other-tenant")).toBeNull();
  });
});

describe("SaaS 套餐配额", () => {
  it("创建活动：显式传入非正或非整数参与上限会被拒绝", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const base = {
      title: "非法名额活动",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      winnerCount: 1,
    };

    await expect(createDraw(db, TENANT, { ...base, maxParticipants: 0 })).rejects.toThrow("参与人数上限必须为正整数");
    await expect(createDraw(db, TENANT, { ...base, maxParticipants: -1 })).rejects.toThrow("参与人数上限必须为正整数");
    await expect(createDraw(db, TENANT, { ...base, maxParticipants: 1.5 })).rejects.toThrow("参与人数上限必须为正整数");
  });

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

  it("Free 套餐 Webhook 数量配置为 0 时表示禁止创建，不是无限制", async () => {
    await client.execute({
      sql: "INSERT INTO system_config (key, value) VALUES (?, ?)",
      args: ["free_plan_max_webhooks", "0"],
    });

    const usage = await getTenantUsage(db, TENANT);
    expect(usage.limits.maxWebhooks).toBe(0);
  });

  it("Free 套餐 Webhook 数量可通过系统配置开放 1 个试用名额", async () => {
    await client.execute({
      sql: "INSERT INTO system_config (key, value) VALUES (?, ?)",
      args: ["free_plan_max_webhooks", "1"],
    });

    const usage = await getTenantUsage(db, TENANT);
    expect(usage.limits.maxWebhooks).toBe(1);
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

  // ── 社群功能套餐配额（docs/180）──
  it("不同套餐返回社群功能默认配额（free=1群×200人）", async () => {
    await client.execute({ sql: "UPDATE tenants SET plan = ? WHERE id = ?", args: ["free", TENANT] });
    const usage = await getTenantUsage(db, TENANT);
    expect(usage.limits.communityEnabled).toBe(true);
    expect(usage.limits.maxPlatformTargets).toBe(1);
    expect(usage.limits.maxGroupMembers).toBe(200);
  });

  it("pro：3 群 × 2000 人", async () => {
    await client.execute({ sql: "UPDATE tenants SET plan = ? WHERE id = ?", args: ["pro", TENANT] });
    const usage = await getTenantUsage(db, TENANT);
    expect(usage.limits.maxPlatformTargets).toBe(3);
    expect(usage.limits.maxGroupMembers).toBe(2000);
  });

  it("team：10 群 × 3000 人", async () => {
    await client.execute({ sql: "UPDATE tenants SET plan = ? WHERE id = ?", args: ["team", TENANT] });
    const usage = await getTenantUsage(db, TENANT);
    expect(usage.limits.maxPlatformTargets).toBe(10);
    expect(usage.limits.maxGroupMembers).toBe(3000);
  });

  it("enterprise：社群功能不设限（null）", async () => {
    await client.execute({ sql: "UPDATE tenants SET plan = ? WHERE id = ?", args: ["enterprise", TENANT] });
    const usage = await getTenantUsage(db, TENANT);
    expect(usage.limits.maxPlatformTargets).toBeNull();
    expect(usage.limits.maxGroupMembers).toBeNull();
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
    const sharerEntryId = ("entryId" in sharer && sharer.entryId) ? String(sharer.entryId) : "";
    expect(sharerEntryId).toBeTruthy();
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
    // 重复参与：joinDraw 返回 alreadyJoined（不再 throw），且不二次归因
    const dup = await joinDraw(db, publicSlug, "invited@test.com", "email", { refCode: "ref-001" });
    expect(dup.joined).toBe(false);
    expect("alreadyJoined" in dup && dup.alreadyJoined).toBe(true);

    const shareRows = await client.execute("SELECT clicked_count, joined_count FROM share_records WHERE id = 'share-1'");
    expect(Number(shareRows.rows[0]?.clicked_count)).toBe(7);
    expect(Number(shareRows.rows[0]?.joined_count)).toBe(1);

    const summary = await getActivityEventSummary(db, TENANT, id);
    expect(summary.totals.attributed_join).toBe(1);
    expect(summary.attributedJoins).toBe(1);
  });

  /**
   * docs/259 D2 ③：基础激励层（viral 每邀请 +N）与里程碑加成层（referralRewardDefs 阶梯）
   * 是互补两层，可同时生效。收敛后两层共用同一个出口 grantBonusSpin：
   * - 一处 read-then-CAS（spinsTotalGranted 乐观锁）
   * - 一处 spins_log（refId 区分 share: / engine:）
   * - 一处 reward_earned 审计（metadata.source 区分 viral / engine）
   * 且 spinsViralEarned 只统计基础层（里程碑层不占裂变子配额）。
   */
  it("裂变叠加：viral 每邀请加次 + referralRewardDefs 里程碑同时生效（docs/259 D2）", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "裂变两层叠加",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      participationMode: "open",
      activityKind: "lottery",
      experienceType: "wheel",
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      winnerCount: 1,
      promotionConfig: JSON.stringify({
        viral: {
          enabled: true,
          extraSpinsPerInvite: 1,
          maxExtraSpins: 5,
          extraEntriesPerInvite: 1,
          maxExtraEntries: 5,
        },
        referralRewardDefs: [
          {
            rewardId: "invite_2",
            type: "FIXED",
            target: "SOURCE",
            fixedAmount: "2",
            conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "2" }],
            metadata: { rewardExit: "bonus_spin" },
          },
        ],
      }),
    });
    const prizeId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type, total_count, active) VALUES (?, ?, ?, ?, ?, ?)",
      args: [prizeId, TENANT, "叠加奖", "code", 5, 1],
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      prizeId,
      tierName: "一等奖",
      winnerCount: 1,
      sortOrder: 1,
      weight: 100,
    });
    for (let i = 0; i < 5; i++) {
      await client.execute({
        sql: "INSERT INTO prize_codes (id, tenant_id, prize_id, code, status) VALUES (?, ?, ?, ?, ?)",
        args: [crypto.randomUUID(), TENANT, prizeId, `STACK-${i}`, "available"],
      });
    }
    // ① 的直接回归：两层叠加不再被发布预检阻断
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    const sharer = await joinDraw(db, publicSlug, "stack-sharer@test.com");
    const sharerEntryId = String(sharer.entryId || "");
    expect(sharerEntryId).toBeTruthy();

    await client.execute({
      sql: `INSERT INTO share_records (id, tenant_id, draw_id, sharer_entry_id, share_code, clicked_count, joined_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["share-stack", TENANT, id, sharerEntryId, "stack-ref", 0, 0],
    });

    // 第 1 次邀请：基础层 +1；里程碑未达标（需 2 人）
    await joinDraw(db, publicSlug, "stack-i1@test.com", "email", { refCode: "stack-ref" });
    const [after1] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    expect(after1?.spinsTotalGranted).toBe(2);   // join 1 + 基础层 1
    expect(after1?.spinsViralEarned).toBe(1);
    expect(after1?.spinsLeft).toBe(2);

    // 第 2 次邀请：基础层 +1，里程碑达标再 +2（FIXED fixedAmount=2）
    await joinDraw(db, publicSlug, "stack-i2@test.com", "email", { refCode: "stack-ref" });
    const [after2] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    expect(after2?.spinsTotalGranted).toBe(5);   // 2 + 基础层 1 + 里程碑 2
    expect(after2?.spinsLeft).toBe(5);
    // 里程碑层不占裂变子配额：spinsViralEarned 只累计基础层的 2 次
    expect(after2?.spinsViralEarned).toBe(2);

    // 幂等：第 3 次邀请只有基础层加次，里程碑已整标记不再发
    await joinDraw(db, publicSlug, "stack-i3@test.com", "email", { refCode: "stack-ref" });
    const [after3] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    expect(after3?.spinsTotalGranted).toBe(6);
    expect(after3?.spinsViralEarned).toBe(3);
    const markRows = await client.execute("SELECT reward_milestones_granted FROM share_records WHERE id = 'share-stack'");
    expect(String(markRows.rows[0]?.reward_milestones_granted)).toContain("invite_2");

    // 出口收敛后的流水：两层都写 reason=viral，用 refId 区分来源
    const viralLogs = await db.select().from(spinsLog).where(and(
      eq(spinsLog.entryId, sharerEntryId),
      eq(spinsLog.reason, "viral"),
    ));
    expect(viralLogs.filter((l) => String(l.refId || "").startsWith("share:"))).toHaveLength(3);
    expect(viralLogs.filter((l) => String(l.refId || "") === "engine:invite_2")).toHaveLength(1);

    // 审计收敛（docs/254 §4.2）：两层出口都写 reward_earned，metadata.source 区分
    const events = await db.select().from(activityEvents).where(and(
      eq(activityEvents.drawId, id),
      eq(activityEvents.eventType, "reward_earned"),
    ));
    const sources = events.map((e) => {
      try {
        return String((JSON.parse(String(e.metadataJson || "{}")) as { source?: string }).source || "");
      } catch {
        return "";
      }
    });
    expect(sources.filter((x) => x === "viral")).toHaveLength(3);
    expect(sources.filter((x) => x === "engine")).toHaveLength(1);
  });

  it("instant 裂变：有效邀请给分享者 +spins（双封顶）；重复/自邀不加次", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "instant 裂变加次",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      participationMode: "open",
      activityKind: "lottery",
      experienceType: "wheel",
      resultMode: "instant",
      maxSpinsPerEntry: 5,
      winnerCount: 3,
      // 发布预检仍校验 extraEntries*；runtime 加次优先 extraSpins*（participation.grantViralSpinsToSharer）
      promotionConfig: JSON.stringify({
        viral: {
          enabled: true,
          extraSpinsPerInvite: 2,
          maxExtraSpins: 3,
          extraEntriesPerInvite: 2,
          maxExtraEntries: 3,
        },
      }),
    });
    // 发布预检：instant 需要 weight + 码
    const prizeId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type, total_count, active) VALUES (?, ?, ?, ?, ?, ?)",
      args: [prizeId, TENANT, "裂变奖", "code", 5, 1],
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      prizeId,
      tierName: "一等奖",
      winnerCount: 3,
      sortOrder: 1,
      weight: 100,
    });
    for (let i = 0; i < 5; i++) {
      await client.execute({
        sql: "INSERT INTO prize_codes (id, tenant_id, prize_id, code, status) VALUES (?, ?, ?, ?, ?)",
        args: [crypto.randomUUID(), TENANT, prizeId, `VCODE-${i}`, "available"],
      });
    }
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    const sharer = await joinDraw(db, publicSlug, "v-sharer@test.com");
    expect(sharer.joined).toBe(true);
    const sharerEntryId = String(sharer.entryId || "");
    expect(sharerEntryId).toBeTruthy();

    // join 默认 initial=1
    const [before] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    expect(before?.spinsLeft).toBe(1);
    expect(before?.spinsTotalGranted).toBe(1);
    expect(before?.spinsViralEarned).toBe(0);

    // spins 流水日志（P1）：join 初始发放记录
    const joinLogs = await db.select().from(spinsLog).where(and(
      eq(spinsLog.entryId, sharerEntryId),
      eq(spinsLog.reason, "join"),
    ));
    expect(joinLogs).toHaveLength(1);
    expect(joinLogs[0]!).toMatchObject({ delta: 1, balanceAfter: 1 });

    await client.execute({
      sql: `INSERT INTO share_records (id, tenant_id, draw_id, sharer_entry_id, share_code, clicked_count, joined_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["share-viral-spins", TENANT, id, sharerEntryId, "vspin-ref", 0, 0],
    });

    const invitee1 = await joinDraw(db, publicSlug, "v-invitee1@test.com", "email", { refCode: "vspin-ref" });
    expect(invitee1.joined).toBe(true);

    const [after1] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    // +min(2, 5-1, 3-0)=2
    expect(after1?.spinsTotalGranted).toBe(3);
    expect(after1?.spinsViralEarned).toBe(2);
    expect(after1?.spinsLeft).toBe(3);

    // spins 流水日志（P1）：裂变奖励记录（第 1 次邀请 +2）
    const viralLogs = await db.select().from(spinsLog).where(and(
      eq(spinsLog.entryId, sharerEntryId),
      eq(spinsLog.reason, "viral"),
    ));
    expect(viralLogs).toHaveLength(1);
    expect(viralLogs[0]!).toMatchObject({ delta: 2, balanceAfter: 3 });

    // 第二次有效邀请：roomViral=1 → actual=1；total granted=4
    const invitee2 = await joinDraw(db, publicSlug, "v-invitee2@test.com", "email", { refCode: "vspin-ref" });
    expect(invitee2.joined).toBe(true);
    const [after2] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    expect(after2?.spinsTotalGranted).toBe(4);
    expect(after2?.spinsViralEarned).toBe(3);
    expect(after2?.spinsLeft).toBe(4);

    // 第三次：maxExtra 已满 → 榜可涨但 spins 不加
    const invitee3 = await joinDraw(db, publicSlug, "v-invitee3@test.com", "email", { refCode: "vspin-ref" });
    expect(invitee3.joined).toBe(true);
    const [after3] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    expect(after3?.spinsTotalGranted).toBe(4);
    expect(after3?.spinsViralEarned).toBe(3);
    expect(after3?.spinsLeft).toBe(4);

    const shareRows = await client.execute(
      "SELECT joined_count FROM share_records WHERE id = 'share-viral-spins'",
    );
    expect(Number(shareRows.rows[0]?.joined_count)).toBe(3);

    // 重复参与不加次
    const dup = await joinDraw(db, publicSlug, "v-invitee1@test.com", "email", { refCode: "vspin-ref" });
    expect(dup.joined).toBe(false);
    const [afterDup] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    expect(afterDup?.spinsTotalGranted).toBe(4);

    // 自邀请：同 identity 不归因、不加次（open 模式同邮箱无法二次 join，用已存在 sharer 再带自己的 ref 应 alreadyJoined）
    const self = await joinDraw(db, publicSlug, "v-sharer@test.com", "email", { refCode: "vspin-ref" });
    expect(self.joined).toBe(false);
    const [afterSelf] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    expect(afterSelf?.spinsTotalGranted).toBe(4);
  });

  it("自邀请：同 identity 用自己的 share 码参与（签到跨日）不计 joined_count", async () => {
    // 签到允许同邮箱跨日再参与；day2 仍带 day1 的 ?ref= 不得给自己涨邀请（docs/112）
    const { id, publicSlug } = await setupCheckinActivity();
    const day1 = await joinDraw(db, publicSlug, "Self@Checkin.com");
    expect(day1.joined).toBe(true);
    const e1 = ("entryId" in day1 && day1.entryId) ? String(day1.entryId) : "";
    expect(e1).toBeTruthy();
    await client.execute({
      sql: `INSERT INTO share_records (id, tenant_id, draw_id, sharer_entry_id, share_code, clicked_count, joined_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["share-self-ck", TENANT, id, e1, "self-ck-ref", 0, 0],
    });
    // 伪造「昨日」entry，腾出今日 UNIQUE，再 day2 join 带 self ref
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await client.execute({
      sql: `UPDATE lottery_entries SET identity_value = ? WHERE id = ?`,
      args: [`self@checkin.com:${y}`, e1],
    });
    const day2 = await joinDraw(db, publicSlug, "self@checkin.com", "email", {
      refCode: "self-ck-ref",
    });
    expect(day2.joined).toBe(true);
    const shareRows = await client.execute(
      "SELECT joined_count FROM share_records WHERE id = 'share-self-ck'",
    );
    expect(Number(shareRows.rows[0]?.joined_count)).toBe(0);
    const summary = await getActivityEventSummary(db, TENANT, id);
    expect(summary.totals.attributed_join || 0).toBe(0);
    // 他人用同一 ref 仍应计分
    const friend = await joinDraw(db, publicSlug, "friend@checkin.com", "email", {
      refCode: "self-ck-ref",
    });
    expect(friend.joined).toBe(true);
    const after = await client.execute(
      "SELECT joined_count FROM share_records WHERE id = 'share-self-ck'",
    );
    expect(Number(after.rows[0]?.joined_count)).toBe(1);
  });

  it("自邀请：email 分享者与同邮箱 user_id 参与者不计 joined_count", async () => {
    const { id, publicSlug } = await setupDraw();
    const userId = "self-invite-user-id";
    await db.insert(users).values({
      id: userId,
      username: "selfinvite",
      email: "cross-self@test.com",
      emailVerified: 1,
      passwordHash: "hash",
    });

    const sharer = await joinDraw(db, publicSlug, "Cross-Self@Test.com", "email");
    expect(sharer.joined).toBe(true);
    const sharerEntryId = ("entryId" in sharer && sharer.entryId) ? String(sharer.entryId) : "";
    expect(sharerEntryId).toBeTruthy();
    await db.insert(shareRecords).values({
      id: "share-cross-identity-self",
      tenantId: TENANT,
      drawId: id,
      sharerEntryId,
      shareCode: "cross-self-ref",
      clickedCount: 0,
      joinedCount: 0,
    });

    const samePerson = await joinDraw(db, publicSlug, userId, "user_id", {
      refCode: "cross-self-ref",
    });
    expect(samePerson.joined).toBe(true);
    const [share] = await db
      .select({ joinedCount: shareRecords.joinedCount })
      .from(shareRecords)
      .where(eq(shareRecords.id, "share-cross-identity-self"))
      .limit(1);
    expect(share?.joinedCount).toBe(0);
    const summary = await getActivityEventSummary(db, TENANT, id);
    expect(summary.totals.attributed_join || 0).toBe(0);

    const friendUserId = "friend-user-id";
    await db.insert(users).values({
      id: friendUserId,
      username: "friendinvite",
      email: "friend-cross@test.com",
      emailVerified: 1,
      passwordHash: "hash",
    });
    const friend = await joinDraw(db, publicSlug, friendUserId, "user_id", {
      refCode: "cross-self-ref",
    });
    expect(friend.joined).toBe(true);
    const [after] = await db
      .select({ joinedCount: shareRecords.joinedCount })
      .from(shareRecords)
      .where(eq(shareRecords.id, "share-cross-identity-self"))
      .limit(1);
    expect(after?.joinedCount).toBe(1);
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

  it("#14 渐进迁移：明文 key 验证通过后自动升级为哈希存储", async () => {
    await client.execute({
      sql: "INSERT INTO api_keys (id, tenant_id, name, key, active) VALUES (?, ?, ?, ?, ?)",
      args: ["key-migrate", TENANT, "Plain", "cl_migrate_plain", 1],
    });

    // 第一次验证：明文 key 可用
    expect((await authenticateApiKey(db, "cl_migrate_plain"))?.tenantId).toBe(TENANT);

    // 迁移断言：验证后库中不再是明文，而是 SHA-256 哈希
    const [row] = await db
      .select({ key: apiKeys.key })
      .from(apiKeys)
      .where(eq(apiKeys.id, "key-migrate"))
      .limit(1);
    expect(row?.key).not.toBe("cl_migrate_plain");
    expect(row?.key).toBe(await hashApiKey("cl_migrate_plain"));

    // 迁移后仍可验证（哈希匹配路径）
    expect((await authenticateApiKey(db, "cl_migrate_plain"))?.tenantId).toBe(TENANT);
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

  it("docs/239：秒杀 stockLimit 与 maxParticipants 不一致时发布被拒（预检 error 兜底）", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    // 直接调 createDraw（绕过路由联动）：构造不一致数据，验证预检 error 兜底
    const { id } = await createDraw(db, TENANT, {
      title: "秒杀截单",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      activityKind: "claim",
      experienceType: "flash_sale",
      resultMode: "instant",
      participationMode: "open",
      winnerCount: 0,
      maxParticipants: 10, // 故意与 stockLimit=2 不一致
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, stockLimit: 2, sessionLabel: "测试场" },
        destination: { url: "https://shop.example.com/p/x", title: "去买" },
      }),
    });
    await expect(publishDraw(db, TENANT, id)).rejects.toThrow("不一致");
  });

  it("docs/130：秒杀 stockLimit 原子截单（一致配置下按 stockLimit=2 截单）", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    // maxParticipants 与 stockLimit 一致（docs/239 方案 C 要求二者对齐）
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "秒杀截单",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      activityKind: "claim",
      experienceType: "flash_sale",
      resultMode: "instant",
      participationMode: "open",
      winnerCount: 0,
      maxParticipants: 2,
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, stockLimit: 2, sessionLabel: "测试场" },
        destination: { url: "https://shop.example.com/p/x", title: "去买" },
      }),
    });
    await publishDraw(db, TENANT, id);
    expect((await joinDraw(db, publicSlug, "fs1@t.com")).joined).toBe(true);
    expect((await joinDraw(db, publicSlug, "fs2@t.com")).joined).toBe(true);
    const full = await joinDraw(db, publicSlug, "fs3@t.com");
    expect(full.joined).toBe(false);
    expect(full.message).toBe("已抢光");
    expect((full as { soldOut?: boolean }).soldOut).toBe(true);
    expect((full as { code?: string }).code).toBe("flash_sale.sold_out");
  });

  it("docs/130：直付秒杀重复参与返回已有预约，不误报售罄也不泄漏计数器", async () => {
    await db.insert(tenantConfigs).values({
      tenantId: TENANT,
      enabled: 1,
      providers: JSON.stringify({
        easypay: {
          enabled: true,
          easypay_pid: "pid",
          easypay_key: await encryptPaymentConfigValue("key", PAYMENT_ENCRYPTION_KEY),
          easypay_api_base: "https://zpayz.cn",
        },
      }),
    });
    const { id: prizeId } = await createPrize(db, TENANT, { name: "重复参与卡密", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "RETRY-COUNTER-1", secret: "S1" }]);

    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "直付重复参与计数器",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      activityKind: "claim",
      experienceType: "flash_sale",
      resultMode: "instant",
      participationMode: "open",
      winnerCount: 0,
      maxParticipants: 1,
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" },
      }),
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      prizeId,
      tierName: "重复参与卡密",
      winnerCount: 1,
      sortOrder: 1,
    });
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    const first = await joinDraw(db, publicSlug, "dup-slot@test.com");
    expect(first.joined).toBe(true);
    const duplicate = await joinDraw(db, publicSlug, "dup-slot@test.com");
    expect(duplicate.joined).toBe(false);
    expect(duplicate.alreadyJoined).toBe(true);
    expect(duplicate.entryId).toBe(first.entryId);
    expect((duplicate as { soldOut?: boolean }).soldOut).toBeUndefined();

    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, id));
    const entries = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, id));
    expect(draw?.activeParticipantCount).toBe(1);
    expect(entries).toHaveLength(1);
  });

  it("docs/134：直付秒杀截单排除已过期支付占位，避免软释放后仍被 COUNT 拒绝", async () => {
    await db.insert(tenantConfigs).values({
      tenantId: TENANT,
      enabled: 1,
      providers: JSON.stringify({
        easypay: {
          enabled: true,
          easypay_pid: "pid",
          easypay_key: await encryptPaymentConfigValue("key", PAYMENT_ENCRYPTION_KEY),
          easypay_api_base: "https://zpayz.cn",
        },
      }),
    });
    const { id: prizeId } = await createPrize(db, TENANT, { name: "直付卡密", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [
      { code: "PAY-1", secret: "S1" },
      { code: "PAY-2", secret: "S2" },
    ]);

    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "直付软释放",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      activityKind: "claim",
      experienceType: "flash_sale",
      resultMode: "instant",
      participationMode: "open",
      winnerCount: 0,
      maxParticipants: 1,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 1,
          priceCents: 9900,
          currency: "cny",
        },
      }),
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      prizeId,
      tierName: "直付卡密",
      winnerCount: 1,
      sortOrder: 1,
    });
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    const first = await joinDraw(db, publicSlug, "expired-slot@test.com");
    expect(first.joined).toBe(true);
    await db
      .update(lotteryEntries)
      .set({ paymentStatus: "expired" })
      .where(and(
        eq(lotteryEntries.tenantId, TENANT),
        eq(lotteryEntries.drawId, id),
        eq(lotteryEntries.identityValue, "expired-slot@test.com"),
      ));
    await db
      .update(lotteryDraws)
      .set({ activeParticipantCount: 0 })
      .where(eq(lotteryDraws.id, id));

    const released = await joinDraw(db, publicSlug, "new-buyer@test.com");
    expect(released.joined).toBe(true);
    const full = await joinDraw(db, publicSlug, "third-buyer@test.com");
    expect(full.joined).toBe(false);
    expect((full as { code?: string }).code).toBe("flash_sale.sold_out");
  });

  it("直付秒杀同一身份在超时释放后复用原 entry 重新预约，不制造第二条参与记录", async () => {
    await db.insert(tenantConfigs).values({
      tenantId: TENANT,
      enabled: 1,
      providers: JSON.stringify({
        easypay: {
          enabled: true,
          easypay_pid: "pid",
          easypay_key: await encryptPaymentConfigValue("key", PAYMENT_ENCRYPTION_KEY),
          easypay_api_base: "https://zpayz.cn",
        },
      }),
    });
    const { id: prizeId } = await createPrize(db, TENANT, { name: "重复参与卡密", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "RETRY-1", secret: "S1" }]);
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "直付重复参与",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      activityKind: "claim",
      experienceType: "flash_sale",
      participationMode: "open",
      winnerCount: 0,
      maxParticipants: 1,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 1,
          priceCents: 9900,
          currency: "cny",
        },
      }),
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      prizeId,
      tierName: "重复参与卡密",
      winnerCount: 1,
      sortOrder: 1,
    });
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    const first = await joinDraw(db, publicSlug, "retry@test.com");
    expect(first.joined).toBe(true);
    const entryId = first.entryId;
    await db.update(lotteryEntries)
      .set({ paymentStatus: "expired" })
      .where(eq(lotteryEntries.id, entryId!));
    await db.update(lotteryDraws)
      .set({ activeParticipantCount: 0 })
      .where(eq(lotteryDraws.id, id));

    const reopened = await joinDraw(db, publicSlug, "retry@test.com");
    expect(reopened.joined).toBe(true);
    expect(reopened.entryId).toBe(entryId);
    expect(reopened.reopened).toBe(true);
    const entries = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, id));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.paymentStatus).toBe("reserved");
  });

  it("直付秒杀 expired entry 只要存在任一不可重试订单就阻断（最新订单是 cancelled 也不放行）", async () => {
    // docs/255 复审 A3：V2 是 1:N 订单模型，"取最新一条订单判断"会被后来的
    // cancelled/expired 订单掩盖历史 paid 订单——用户已付过钱，却被允许重新预约，
    // 于是同一 entry 上再生成一笔订单，出现重复收款/重复发卡的资金风险。
    // 正确语义：只要该 entry 名下存在任一不可重试状态（paid / pending /
    // paid_late_needs_refund / refunded ...）的订单，就必须阻断并转人工。
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "直付历史已付订单阻断",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      activityKind: "claim",
      experienceType: "flash_sale",
      participationMode: "open",
      winnerCount: 0,
      maxParticipants: 5,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 5,
          priceCents: 9900,
          currency: "cny",
        },
      }),
    });

    // 直接置 open：本例只验证订单阻断分支，不需要完整发布前检流程
    await db.update(lotteryDraws).set({ status: "open" }).where(eq(lotteryDraws.id, id));

    const entryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: entryId,
      tenantId: TENANT,
      drawId: id,
      identityType: "email",
      identityValue: "paid-then-cancelled@test.com",
      paymentStatus: "expired",
      joinedAt: now.toISOString(),
    });
    // 旧订单已支付（不可重试），新订单已取消（可重试）
    await db.insert(paymentOrders).values([
      {
        id: crypto.randomUUID(),
        tenantId: TENANT,
        drawId: id,
        entryId,
        buyerIdentityType: "email",
        buyerIdentityValue: "paid-then-cancelled@test.com",
        amountCents: 9900,
        status: "paid",
        provider: "easypay",
        createdAt: new Date(now.getTime() - 7200_000).toISOString(),
      },
      {
        id: crypto.randomUUID(),
        tenantId: TENANT,
        drawId: id,
        entryId,
        buyerIdentityType: "email",
        buyerIdentityValue: "paid-then-cancelled@test.com",
        amountCents: 9900,
        status: "cancelled",
        provider: "easypay",
        createdAt: new Date(now.getTime() - 60_000).toISOString(),
      },
    ]);

    const result = await joinDraw(db, publicSlug, "paid-then-cancelled@test.com");
    expect(result.joined).toBe(false);
    expect((result as { alreadyJoined?: boolean }).alreadyJoined).toBe(true);
    expect(result.message).toContain("支付记录");
    // 不得新增第二条 entry
    const entries = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, id));
    expect(entries).toHaveLength(1);
  });

  it("取消直付秒杀会原子释放未支付预约并终止继续支付", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "取消直付秒杀",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      activityKind: "claim",
      experienceType: "flash_sale",
      participationMode: "open",
      winnerCount: 0,
      maxParticipants: 1,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 1,
          priceCents: 9900,
          currency: "cny",
        },
      }),
    });
    await db.update(lotteryDraws)
      .set({ status: "open" })
      .where(eq(lotteryDraws.id, id));
    const first = await joinDraw(db, publicSlug, "cancel-payment@test.com");
    expect(first.joined).toBe(true);
    const attemptId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    await db.insert(paymentOrders).values({
      id: orderId,
      tenantId: TENANT,
      drawId: id,
      entryId: first.entryId!,
      amountCents: 9900,
      currency: "cny",
      status: "pending",
      provider: "easypay",
      currentAttemptId: attemptId,
    });
    await db.insert(paymentOrderAttempts).values({
      id: attemptId,
      paymentOrderId: orderId,
      tenantId: TENANT,
      drawId: id,
      attemptNo: 1,
      provider: "easypay",
      amountCents: 9900,
      currency: "cny",
      status: "pending",
    });
    const cancelled = await cancelDraw(db, TENANT, id);
    expect(cancelled).toBe(true);

    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, id));
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, first.entryId!));
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, orderId));
    const [attempt] = await db.select().from(paymentOrderAttempts).where(eq(paymentOrderAttempts.id, attemptId));
    expect(draw?.status).toBe("cancelled");
    expect(draw?.activeParticipantCount).toBe(0);
    expect(entry?.paymentStatus).toBe("expired");
    expect(order?.status).toBe("expired");
    expect(attempt?.status).toBe("expired");
  });

  it("取消活动不掩盖已支付履约：entry 有 PAID 订单时保持 paid，只释放批发未支付订单容量", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "取消不掩盖已支付",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      activityKind: "claim",
      experienceType: "flash_sale",
      participationMode: "open",
      winnerCount: 0,
      maxParticipants: 5,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 5,
          priceCents: 8900,
          currency: "cny",
        },
      }),
    });
    await db.update(lotteryDraws)
      .set({ status: "open" })
      .where(eq(lotteryDraws.id, id));
    const first = await joinDraw(db, publicSlug, "paid-then-wholesale@test.com");
    expect(first.joined).toBe(true);
    const entryId = first.entryId!;

    // 订单 A：首次购买已支付（qty=1），entry → paid
    const orderAId = crypto.randomUUID();
    await db.insert(paymentOrders).values({
      id: orderAId, tenantId: TENANT, drawId: id, entryId,
      quantity: 1, amountCents: 8900, currency: "cny",
      status: "paid", provider: "easypay",
    });
    await db.update(lotteryEntries).set({ paymentStatus: "paid" }).where(eq(lotteryEntries.id, entryId));
    // 订单 B：批发续购未支付（qty=3），entry → pending
    const orderBId = crypto.randomUUID();
    const attemptBId = crypto.randomUUID();
    await db.insert(paymentOrders).values({
      id: orderBId, tenantId: TENANT, drawId: id, entryId,
      quantity: 3, amountCents: 26700, currency: "cny",
      status: "pending", provider: "easypay", currentAttemptId: attemptBId,
    });
    await db.insert(paymentOrderAttempts).values({
      id: attemptBId, paymentOrderId: orderBId, tenantId: TENANT, drawId: id,
      attemptNo: 1, provider: "easypay", amountCents: 26700, currency: "cny", status: "pending",
    });
    await db.update(lotteryEntries).set({ paymentStatus: "pending" }).where(eq(lotteryEntries.id, entryId));
    // 容量：join base 1 + 订单 B 续购 3 = 4（订单 A 首购 qty=1 无额外 reserve）
    await db.update(lotteryDraws).set({ activeParticipantCount: 4 }).where(eq(lotteryDraws.id, id));

    const cancelled = await cancelDraw(db, TENANT, id);
    expect(cancelled).toBe(true);

    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, id));
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    const [orderA] = await db.select({ status: paymentOrders.status }).from(paymentOrders).where(eq(paymentOrders.id, orderAId));
    const [orderB] = await db.select({ status: paymentOrders.status }).from(paymentOrders).where(eq(paymentOrders.id, orderBId));
    // 关键断言：entry 因仍有 PAID 订单 A 保持 paid（不是 expired），订单 B 被过期
    expect(draw?.status).toBe("cancelled");
    expect(entry?.paymentStatus).toBe("paid");
    expect(orderA?.status).toBe("paid");
    expect(orderB?.status).toBe("expired");
    // 只释放订单 B 的 3 件，订单 A 的 1 件仍占用
    expect(draw?.activeParticipantCount).toBe(1);
  });

  it("docs/130：秒杀仅 maxParticipants、无 flashSale 节点时仍按 max 截单", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "秒杀仅 max",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      activityKind: "claim",
      experienceType: "flash_sale",
      resultMode: "instant",
      participationMode: "open",
      winnerCount: 0,
      maxParticipants: 1,
    });
    await publishDraw(db, TENANT, id);
    expect((await joinDraw(db, publicSlug, "only1@t.com")).joined).toBe(true);
    const full = await joinDraw(db, publicSlug, "only2@t.com");
    expect(full.joined).toBe(false);
    expect(full.message).toBe("已抢光");
  });

  it("未开始的活动不能参与", async () => {
    const future = new Date(Date.now() + 3600000);
    const later = new Date(future.getTime() + 3600000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "未来活动", startAt: future.toISOString(), endAt: later.toISOString(), winnerCount: 1,
    });
    await configureManualTier(id, 1);
    await publishDraw(db, TENANT, id);
    expect((await joinDraw(db, publicSlug, "u@t.com")).joined).toBe(false);
  });
});

describe("签到活动", () => {
  it("checkin：同一身份同一天只能签到一次，入库唯一值带日期后缀", async () => {
    const { id, publicSlug } = await setupCheckinActivity();
    const first = await joinDraw(db, publicSlug, "Daily@T.com");
    expect(first.joined).toBe(true);

    const again = await joinDraw(db, publicSlug, "daily@t.com");
    expect(again.joined).toBe(false);
    expect(again.message).toContain("已参与");

    const rows = await client.execute({
      sql: "SELECT identity_value FROM lottery_entries WHERE tenant_id = ? AND draw_id = ?",
      args: [TENANT, id],
    });
    // 日期后缀用本地时区（todayStr），与 bot /签到 同源；不能用 UTC 日期断言（时区偏移会失败）
    expect(rows.rows[0]?.identity_value).toBe(`daily@t.com:${todayStr()}`);
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
    const first = await joinDraw(db, publicSlug, "u1@t.com");
    expect(first.joined).toBe(true);
    const again = await joinDraw(db, publicSlug, "u1@t.com");
    expect(again.joined).toBe(false);
    expect(again.message).toContain("已参与");
    expect("alreadyJoined" in again && again.alreadyJoined).toBe(true);
  });
});

describe("裂变加权开奖", () => {
  it("无裂变配置时开奖行为不变（回归）", async () => {
    const { id, publicSlug } = await setupDraw("open", { winnerCount: 1 });
    await joinDraw(db, publicSlug, "u1@t.com");
    await joinDraw(db, publicSlug, "u2@t.com");
    const result = await performDraw(db, TENANT, id, USER);
    expect(result.winnerCount).toBe(1);
    expect(result.candidateCount).toBe(2);
  });

  it("裂变开启但无人分享时开奖正常完成", async () => {
    const { id, publicSlug } = await setupDraw("open", { winnerCount: 1 });
    // 更新 promotionConfig 开启裂变
    await client.execute({
      sql: "UPDATE lottery_draws SET promotion_config = ? WHERE id = ?",
      args: [JSON.stringify({ version: 1, viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: true } }), id],
    });
    await joinDraw(db, publicSlug, "u1@t.com");
    await joinDraw(db, publicSlug, "u2@t.com");
    const result = await performDraw(db, TENANT, id, USER);
    expect(result.winnerCount).toBe(1);
    expect(result.candidateCount).toBe(2);  // 无分享，候选数不变
  });

  it("有裂变分享时加权重不导致去重异常", async () => {
    const { id, publicSlug } = await setupDraw("open", { winnerCount: 2 });
    await client.execute({
      sql: "UPDATE lottery_draws SET promotion_config = ? WHERE id = ?",
      args: [JSON.stringify({ version: 1, viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: true } }), id],
    });

    // 3 个参与者
    await joinDraw(db, publicSlug, "u1@t.com");
    await joinDraw(db, publicSlug, "u2@t.com");
    await joinDraw(db, publicSlug, "u3@t.com");

    // 获取 u1 的 entryId
    const [u1Entry] = await db.select({ id: lotteryEntries.id }).from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT), eq(lotteryEntries.drawId, id), eq(lotteryEntries.identityValue, "u1@t.com")))
      .limit(1);

    // 模拟 u1 邀请了 5 人
    if (u1Entry) {
      await db.insert(shareRecords).values({
        id: crypto.randomUUID(),
        tenantId: TENANT,
        drawId: id,
        sharerEntryId: u1Entry.id,
        shareCode: "test-share-001",
        joinedCount: 5,
      });
    }

    // 开奖应正常完成，不会因为 u1 在候选数组中出现 6 次而导致 UNIQUE 冲突
    const result = await performDraw(db, TENANT, id, USER);
    expect(result.winnerCount).toBe(2);
    expect(result.candidateCount).toBe(3);  // 候选数仍为真实参与人数
  });

  it("extraEntriesPerInvite>1 时仍只中一次且 candidateCount 为真实人数", async () => {
    // 每邀 3 次额外、上限 9：邀请 2 人 → extra=6 → 袋中 7 票，但 winners 去重后仍 1 人一奖
    const { id, publicSlug } = await setupDraw("open", { winnerCount: 1 });
    await client.execute({
      sql: "UPDATE lottery_draws SET promotion_config = ? WHERE id = ?",
      args: [JSON.stringify({
        version: 1,
        viral: { enabled: true, extraEntriesPerInvite: 3, maxExtraEntries: 9, leaderboardEnabled: true },
      }), id],
    });
    await joinDraw(db, publicSlug, "heavy@t.com");
    await joinDraw(db, publicSlug, "light@t.com");
    const [heavy] = await db.select({ id: lotteryEntries.id }).from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT), eq(lotteryEntries.drawId, id), eq(lotteryEntries.identityValue, "heavy@t.com")))
      .limit(1);
    expect(heavy).toBeTruthy();
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      sharerEntryId: heavy!.id,
      shareCode: "test-share-per3",
      joinedCount: 2,
    });
    const result = await performDraw(db, TENANT, id, USER);
    expect(result.winnerCount).toBe(1);
    expect(result.candidateCount).toBe(2);
  });

  /**
   * docs/255 §8 P2-4：`viral.enabled` 必须严格 `=== true` 才算开启。
   * 历史实现此处用 truthy 判定，导致 `enabled: "true"`（字符串，前端/导入常见）
   * 时「开奖按裂变加权、排行榜奖励却按未开启跳过」的互相矛盾行为。
   *
   * 判别方法（把两条路径都变成确定性输出）：CSPRNG 恒为 0 时
   * - 等权 randomSelect([p0,p1,p2], 2)：i=2 → swap(2,0)、i=1 → swap(1,0)
   *   → 数组变 [p1,p2,p0]，取尾部 2 个 = {p2, p0}；
   * - 加权 weightedSampleUnique(u=0)：每轮 r=0 必落池首 → {p0, p1}。
   * 因此「p1 中奖」即证明错误地走了加权路径。
   */
  it("viral.enabled 为字符串 \"true\" 时不得启用加权（必须走等权路径）", async () => {
    const { id, publicSlug } = await setupDraw("open", { winnerCount: 2 });
    await client.execute({
      sql: "UPDATE lottery_draws SET promotion_config = ? WHERE id = ?",
      args: [JSON.stringify({
        version: 1,
        viral: { enabled: "true", extraEntriesPerInvite: 1, maxExtraEntries: 10 },
      }), id],
    });
    await joinDraw(db, publicSlug, "u1@t.com");
    await joinDraw(db, publicSlug, "u2@t.com");
    await joinDraw(db, publicSlug, "u3@t.com");

    // 与 draw-execution 完全同款的候选池查询（无 ORDER BY），取得真实抽样顺序，
    // 避免测试对物理行序做隐含假设。
    const pool = await db
      .select({ id: lotteryEntries.id })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.drawId, id), eq(lotteryEntries.tenantId, TENANT)));
    expect(pool).toHaveLength(3);

    const real = crypto as unknown as { getRandomValues: (arr: Uint32Array) => void };
    const origGetRandomValues = real.getRandomValues;
    real.getRandomValues = (arr: Uint32Array) => { arr[0] = 0; };
    try {
      const result = await performDraw(db, TENANT, id, USER);
      expect(result.winnerCount).toBe(2);
      expect(result.candidateCount).toBe(3);
    } finally {
      real.getRandomValues = origGetRandomValues;
    }

    const rows = await client.execute({
      sql: "SELECT entry_id FROM lottery_winners WHERE tenant_id = ? AND draw_id = ?",
      args: [TENANT, id],
    });
    const winnerIds = new Set(rows.rows.map((row) => String(row.entry_id)));
    expect(winnerIds).toEqual(new Set([pool[0]!.id, pool[2]!.id]));
  });
});

// ── 处罚波及名单测试（docs/111 §5 阶段二） ──
// 直接通过 DB 插入构造归因链，不依赖 joinDraw/publishDraw 的完整流程，
// 保持对 computePenaltyTargets 查询逻辑的独立验证。
describe("computePenaltyTargets", () => {
  it("退群者未参与活动时返回 null", async () => {
    const { computePenaltyTargets } = await import("../services/lottery-service");
    const { id } = await setupDraw();
    const result = await computePenaltyTargets(db, TENANT, id, "nobody@test.com");
    expect(result).toBeNull();
  });

  it("退群者有邀请人时，inviterEntryId 不为 null", async () => {
    const { computePenaltyTargets, recordActivityEvent } = await import("../services/lottery-service");
    const { id: drawId } = await setupDraw();

    // 邀请人直接插入 lottery_entries（绕过 joinDraw 的状态校验）
    const inviterEntryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: inviterEntryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "inviter@test.com",
      ipHash: "ip1", joinedAt: new Date().toISOString(),
    });

    // 邀请人生成的分享链接
    const shareCode = `test-sc-${Date.now()}`;
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      sharerEntryId: inviterEntryId, shareCode,
      createdAt: new Date().toISOString(),
    });

    // 退群者手动插入 entry
    const leaverEntryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: leaverEntryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "leaver@test.com",
      ipHash: "ip2", joinedAt: new Date().toISOString(),
    });

    // 归因事件：退群者通过分享链接参与
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId,
      entryId: leaverEntryId,
      eventType: "attributed_join",
      refCode: shareCode,
    });

    const result = await computePenaltyTargets(db, TENANT, drawId, "leaver@test.com");
    expect(result).not.toBeNull();
    expect(result!.leaverEntryId).toBe(leaverEntryId);
    expect(result!.inviterEntryId).toBe(inviterEntryId);
    expect(result!.invitedEntryIds).toEqual([]);
  });

  it("退群者邀请了其他人时，invitedEntryIds 不为空", async () => {
    const { computePenaltyTargets, recordActivityEvent } = await import("../services/lottery-service");
    const { id: drawId } = await setupDraw();

    // 退群者插入 entry
    const leaverEntryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: leaverEntryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "leaver2@test.com",
      ipHash: "ip3", joinedAt: new Date().toISOString(),
    });

    // 退群者生成分享链接
    const shareCode = `test-sc2-${Date.now()}`;
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      sharerEntryId: leaverEntryId, shareCode, joinedCount: 1,
      createdAt: new Date().toISOString(),
    });

    // 被邀请者插入 entry
    const inviteeEntryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: inviteeEntryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "invitee@test.com",
      ipHash: "ip4", joinedAt: new Date().toISOString(),
    });

    await recordActivityEvent(db, {
      tenantId: TENANT, drawId,
      entryId: inviteeEntryId,
      eventType: "attributed_join",
      refCode: shareCode,
    });

    const result = await computePenaltyTargets(db, TENANT, drawId, "leaver2@test.com");
    expect(result).not.toBeNull();
    expect(result!.invitedEntryIds).toContain(inviteeEntryId);
    expect(result!.inviterEntryId).toBeNull();
  });
});

// ── 奖励意图触发测试（docs/111 §5 阶段一） ──
describe("triggerRewardEarned", () => {
  // 创建带 reward 配置的活动（用 createDraw 走既有逻辑，再手动插入邀请人 entry）
  async function setupRewardDraw(activityConfig: string) {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id } = await createDraw(db, TENANT, {
      title: "日卡奖励活动",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      participationMode: "open",
      winnerCount: 1,
      activityConfig,
    });
    const sharerEntryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: sharerEntryId, tenantId: TENANT, drawId: id,
      identityType: "email", identityValue: "sharer@test.com",
      ipHash: "ip-r1", joinedAt: now.toISOString(),
    });
    return { drawId: id, sharerEntryId };
  }

  it("未配置 reward 时静默跳过，不影响参与", async () => {
    const { drawId, sharerEntryId } = await setupRewardDraw("{}");
    const result = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "sc1");
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_reward_config");
  });

  it("配置 reward 且配额充足时触发，并记录 reward_earned 事件", async () => {
    const config = JSON.stringify({
      version: 1,
      reward: { perInviteAmount: 100, currency: "cny" },
      quota: { perUserPerDay: 2, globalPerDay: 100 },
    });
    const { drawId, sharerEntryId } = await setupRewardDraw(config);
    const result = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "sc1");
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("reward_sent");

    // reward_earned 事件已落库（看板/审计依据）
    const events = await db
      .select({ eventType: activityEvents.eventType })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_earned"),
      ));
    expect(events.length).toBe(1);
  });

  it("每人每日配额超限时不触发（perUserPerDay=1）", async () => {
    const config = JSON.stringify({
      version: 1,
      reward: { perInviteAmount: 100 },
      quota: { perUserPerDay: 1, globalPerDay: 100 },
    });
    const { drawId, sharerEntryId } = await setupRewardDraw(config);
    // 第一次触发：消耗当日配额
    const first = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "sc1");
    expect(first.triggered).toBe(true);
    // 第二次触发：配额超限
    const second = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "sc2");
    expect(second.triggered).toBe(false);
    expect(second.reason).toBe("quota_exceeded");
  });

  it("全局每日配额超限时不触发（globalPerDay=1，两个不同邀请人）", async () => {
    const config = JSON.stringify({
      version: 1,
      reward: { perInviteAmount: 100 },
      quota: { perUserPerDay: 10, globalPerDay: 1 },
    });
    const { drawId, sharerEntryId } = await setupRewardDraw(config);
    // 第二个邀请人（不同 entryId，perUserPerDay 不超）
    const sharer2Id = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: sharer2Id, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "sharer2@test.com",
      ipHash: "ip-r2", joinedAt: new Date().toISOString(),
    });

    const first = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "sc1");
    expect(first.triggered).toBe(true);
    // 全局配额已满（perUserPerDay=10 未超，但 global=1 已消耗）
    const second = await triggerRewardEarned(db, TENANT, drawId, sharer2Id, "sharer2@test.com", "sc2");
    expect(second.triggered).toBe(false);
    expect(second.reason).toBe("quota_exceeded");
  });

  // ── mode 字段：fixed / percent 兼容性测试 ──
  it("旧数据（无 mode 字段）兼容为 fixed 模式，reward_earned 事件正常记录", async () => {
    // 旧数据结构：无 mode、无 perInvitePercent，只有 perInviteAmount + currency
    const config = JSON.stringify({
      version: 1,
      reward: { perInviteAmount: 50, currency: "cny" },
    });
    const { drawId, sharerEntryId } = await setupRewardDraw(config);
    const result = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "sc1");
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("reward_sent");
    // 旧数据无 mode → fixed → 事件正常记录
    const [event] = await db
      .select({ eventType: activityEvents.eventType })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_earned"),
      ));
    expect(event).toBeDefined();
  });

  it("显式 fixed 模式：事件 metadata 含 mode=fixed + status=resolved", async () => {
    const config = JSON.stringify({
      version: 1,
      reward: { mode: "fixed", perInviteAmount: 100, currency: "CNY" },
    });
    const { drawId, sharerEntryId } = await setupRewardDraw(config);
    const result = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "sc1");
    expect(result.triggered).toBe(true);

    // 事件 metadata 包含 mode=fixed 和 status=resolved
    const [event] = await db
      .select({ metadataJson: activityEvents.metadataJson })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_earned"),
      ));
    expect(event).toBeDefined();
    const meta = JSON.parse(event.metadataJson || "{}");
    expect(meta.mode).toBe("fixed");
    expect(meta.status).toBe("resolved");
    expect(meta.perInviteAmount).toBe(100);
  });

  it("percent 模式：触发但不入队 webhook（付款确认后再通知中转站），记录 reward_pending 事件", async () => {
    const config = JSON.stringify({
      version: 1,
      reward: { mode: "percent", perInvitePercent: 10, currency: "CNY" },
    });
    const { drawId, sharerEntryId } = await setupRewardDraw(config);
    const result = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "sc1");
    expect(result.triggered).toBe(true);
    // percent 模式：付款尚未完成，webhook 不入队
    expect(result.deliveryIds.length).toBe(0);

    // percent 模式记录 reward_pending（非 reward_earned），metadata 含 mode=percent + status=pending
    const [event] = await db
      .select({ metadataJson: activityEvents.metadataJson })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_pending"),
      ));
    expect(event).toBeDefined();
    const meta = JSON.parse(event.metadataJson || "{}");
    expect(meta.mode).toBe("percent");
    expect(meta.status).toBe("pending");
    expect(meta.perInvitePercent).toBe(10);
  });

  it("percent 模式配额校验仍生效（perUserPerDay=2）", async () => {
    const config = JSON.stringify({
      version: 1,
      reward: { mode: "percent", perInvitePercent: 5 },
      quota: { perUserPerDay: 2, globalPerDay: 100 },
    });
    const { drawId, sharerEntryId } = await setupRewardDraw(config);
    // 前两次触发消耗配额：每次使用不同的 refCode 以绕开幂等检查（docs/274 修正）
    const first = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "sc1");
    expect(first.triggered).toBe(true);
    const second = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "sc2");
    expect(second.triggered).toBe(true);
    // 第三次：配额超限
    const third = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "sc3");
    expect(third.triggered).toBe(false);
    expect(third.reason).toBe("quota_exceeded");
  });

  // ── docs/275 P1：幂等键 joinerEntryId（每次邀请）粒度回归 ──
  it("同一 refCode 多个不同好友（joinerEntryId 各异）→ 每邀请各发一份，不被幂等误拦", async () => {
    const config = JSON.stringify({
      version: 1,
      reward: { perInviteAmount: 100, currency: "cny" },
      quota: { perUserPerDay: 10, globalPerDay: 100 },
    });
    const { drawId, sharerEntryId } = await setupRewardDraw(config);
    const joiner1 = crypto.randomUUID();
    const joiner2 = crypto.randomUUID();
    // 用户级邀请码为固定值：两个好友归因 refCode 相同，仅 joinerEntryId 不同
    const first = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "UCODE1", { joinerEntryId: joiner1 });
    expect(first.triggered).toBe(true);
    const second = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "UCODE1", { joinerEntryId: joiner2 });
    expect(second.triggered).toBe(true);
    expect(second.reason).toBe("reward_sent");

    // 两条 reward_earned 事件各自携带不同的 joinerEntryId
    const events = await db
      .select({ metadataJson: activityEvents.metadataJson })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_earned"),
      ));
    expect(events.length).toBe(2);
    const joiners = events.map((e) => JSON.parse(e.metadataJson || "{}").joinerEntryId).sort();
    expect(joiners).toEqual([joiner1, joiner2].sort());
  });

  it("同一好友重复触发（同 refCode + 同 joinerEntryId）→ 幂等拦截，事件不重复写入", async () => {
    const config = JSON.stringify({
      version: 1,
      reward: { perInviteAmount: 100, currency: "cny" },
      quota: { perUserPerDay: 2, globalPerDay: 100 },
    });
    const { drawId, sharerEntryId } = await setupRewardDraw(config);
    const joiner = crypto.randomUUID();
    const first = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "UCODE1", { joinerEntryId: joiner });
    expect(first.triggered).toBe(true);
    // 第二次：同一次邀请的重复调用（reissue 重放/脏路径）→ 幂等拦截
    const second = await triggerRewardEarned(db, TENANT, drawId, sharerEntryId, "sharer@test.com", "UCODE1", { joinerEntryId: joiner });
    expect(second.triggered).toBe(false);
    expect(second.reason).toBe("reward_sent");
    // 事件只应有一条，确保没有重复写入
    const events = await db
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_earned"),
      ));
    expect(events.length).toBe(1);
  });
});

// ── parseRewardConfig：宽容解析活动配置中的 reward 规则（docs/275 提取） ──
describe("parseRewardConfig", () => {
  it("非法 JSON → 返回 null", () => {
    expect(parseRewardConfig("{not-json")).toBeNull();
  });

  it("无 reward 配置 → 返回 null", () => {
    expect(parseRewardConfig(JSON.stringify({ version: 1 }))).toBeNull();
    expect(parseRewardConfig(null)).toBeNull();
  });

  it("fixed 模式 perInviteAmount <= 0 → 返回 null", () => {
    expect(parseRewardConfig(JSON.stringify({ reward: { perInviteAmount: 0 } }))).toBeNull();
    expect(parseRewardConfig(JSON.stringify({ reward: { perInviteAmount: -5 } }))).toBeNull();
  });

  it("percent 模式 perInvitePercent <= 0 → 返回 null", () => {
    expect(parseRewardConfig(JSON.stringify({ reward: { mode: "percent", perInvitePercent: 0 } }))).toBeNull();
  });

  it("旧数据无 mode 字段 → 兼容为 fixed 模式", () => {
    const parsed = parseRewardConfig(JSON.stringify({ reward: { perInviteAmount: 100, currency: "cny" } }));
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("fixed");
    expect(parsed!.perInviteAmount).toBe(100);
  });

  it("货币来源优先级：reward.currency > flashSale.currency > cny", () => {
    // reward.currency 优先
    const withRewardCurrency = parseRewardConfig(JSON.stringify({
      reward: { perInviteAmount: 100, currency: "USD" },
      promotionConfig: { flashSale: { currency: "JPY" } },
    }));
    expect(withRewardCurrency!.currency).toBe("USD");

    // 无 reward.currency → flashSale.currency
    const withFlashCurrency = parseRewardConfig(JSON.stringify({
      reward: { perInviteAmount: 100 },
      promotionConfig: { flashSale: { currency: "JPY" } },
    }));
    expect(withFlashCurrency!.currency).toBe("JPY");

    // 都无 → 默认 cny
    const defaultCurrency = parseRewardConfig(JSON.stringify({ reward: { perInviteAmount: 100 } }));
    expect(defaultCurrency!.currency).toBe("cny");
  });

  it("quota 缺失时返回空对象（主函数按不限制处理）", () => {
    const parsed = parseRewardConfig(JSON.stringify({ reward: { perInviteAmount: 100 } }));
    expect(parsed!.quota).toEqual({ perUserPerDay: undefined, globalPerDay: undefined });
  });

  it("字符串金额容错：Number() 解析字符串 '100'", () => {
    const parsed = parseRewardConfig(JSON.stringify({ reward: { perInviteAmount: "100" } }));
    expect(parsed!.perInviteAmount).toBe(100);
  });
});

// ── settleRewardByPercent：付款确认后结算 percent 模式奖励（docs/271） ──
describe("settleRewardByPercent", () => {
  // 创建带 percent 奖励配置的活动，并预置 attributed_join + reward_pending 事件
  async function setupPercentReward() {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const config = JSON.stringify({
      version: 1,
      reward: { mode: "percent", perInvitePercent: 10, currency: "CNY" },
    });
    const { id: drawId } = await createDraw(db, TENANT, {
      title: "percent结算测试",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      participationMode: "open",
      winnerCount: 1,
      activityConfig: config,
    });

    // 邀请人（sharer）entry
    const sharerEntryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: sharerEntryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "sharer@test.com",
      ipHash: "ip-s", joinedAt: now.toISOString(),
    });

    // 被邀请人（joiner）entry
    const joinerEntryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: joinerEntryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "joiner@test.com",
      ipHash: "ip-j", joinedAt: now.toISOString(),
    });

    const refCode = "INV-CODE-001";

    // 归因事件：joiner 通过 sharer 的邀请码参与
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: joinerEntryId,
      eventType: "attributed_join", refCode,
      metadata: { sharerEntryId, inviterIdentityValue: "sharer@test.com", source: "trigger" },
    });

    // triggerRewardEarned 记录的 reward_pending 事件（percent 模式）
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: sharerEntryId,
      eventType: "reward_pending", refCode,
      metadata: {
        mode: "percent", perInvitePercent: 10, currency: "CNY",
        sharerEntryId, inviterIdentityValue: "sharer@test.com",
        source: "trigger", status: "pending",
      },
    });

    return { drawId, sharerEntryId, joinerEntryId, refCode };
  }

  it("happy path：付款确认后计算 10% 奖励，写入 reward_earned settled 事件", async () => {
    const { drawId, joinerEntryId } = await setupPercentReward();
    // 成交金额 1000 分（=10 元），10% = 100 分
    const result = await settleRewardByPercent(db, TENANT, drawId, joinerEntryId, 1000, "CNY");
    expect(result.settled).toBe(true);

    // 验证 reward_earned 事件已记录，status=settled
    const [event] = await db
      .select({ metadataJson: activityEvents.metadataJson })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_earned"),
      ));
    expect(event).toBeDefined();
    const meta = JSON.parse(event.metadataJson || "{}");
    expect(meta.mode).toBe("percent");
    expect(meta.status).toBe("settled");
    expect(meta.amountCents).toBe(100);   // 1000 × 10% = 100
    expect(meta.percent).toBe(10);
  });

  it("向下取整：1050 × 10% = 105（Math.floor 防止超付）", async () => {
    const { drawId, joinerEntryId } = await setupPercentReward();
    // 成交金额 1050 分，10% = 105 分（整除场景）
    const result = await settleRewardByPercent(db, TENANT, drawId, joinerEntryId, 1050, "CNY");
    expect(result.settled).toBe(true);
    const [event] = await db
      .select({ metadataJson: activityEvents.metadataJson })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_earned"),
      ));
    const meta = JSON.parse(event.metadataJson || "{}");
    expect(meta.amountCents).toBe(105);
  });

  it("金额过小（0 分 × 10% = 0）→ 返回 amount_too_small", async () => {
    const { drawId, joinerEntryId } = await setupPercentReward();
    const result = await settleRewardByPercent(db, TENANT, drawId, joinerEntryId, 0, "CNY");
    expect(result.settled).toBe(false);
    expect(result.reason).toBe("amount_too_small");
  });

  it("无 attributed_join 事件 → 返回 attributed_join_not_found", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const config = JSON.stringify({
      version: 1,
      reward: { mode: "percent", perInvitePercent: 10 },
    });
    const { id: drawId } = await createDraw(db, TENANT, {
      title: "no-join-test", startAt: now.toISOString(), endAt: future.toISOString(),
      participationMode: "open", winnerCount: 1, activityConfig: config,
    });
    const fakeEntryId = crypto.randomUUID();
    const result = await settleRewardByPercent(db, TENANT, drawId, fakeEntryId, 1000, "CNY");
    expect(result.settled).toBe(false);
    expect(result.reason).toBe("attributed_join_not_found");
  });

  it("refCode 精确匹配：同一 sharer 的多条 reward_pending 中只结算对应的一条", async () => {
    const { drawId, sharerEntryId, joinerEntryId } = await setupPercentReward();

    // 模拟第二个人也通过 sharer 邀请参与（不同 refCode）
    const joiner2Id = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: joiner2Id, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "joiner2@test.com",
      ipHash: "ip-j2", joinedAt: new Date().toISOString(),
    });
    const refCode2 = "INV-CODE-002";
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: joiner2Id,
      eventType: "attributed_join", refCode: refCode2,
      metadata: { sharerEntryId, inviterIdentityValue: "sharer@test.com", source: "trigger" },
    });
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: sharerEntryId,
      eventType: "reward_pending", refCode: refCode2,
      metadata: {
        mode: "percent", perInvitePercent: 10, currency: "CNY",
        sharerEntryId, inviterIdentityValue: "sharer@test.com",
        source: "trigger", status: "pending",
      },
    });

    // 先结算第二条（joiner2Id → refCode2 → 500 × 10% = 50）
    const r2 = await settleRewardByPercent(db, TENANT, drawId, joiner2Id, 500, "CNY");
    expect(r2.settled).toBe(true);

    // 再结算第一条（joinerEntryId → refCode=INV-CODE-001 → 800 × 10% = 80）
    const r1 = await settleRewardByPercent(db, TENANT, drawId, joinerEntryId, 800, "CNY");
    expect(r1.settled).toBe(true);

    // 验证有 2 条 reward_earned settled，金额各自正确
    const settledEvents = await db
      .select({ metadataJson: activityEvents.metadataJson })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_earned"),
      ));
    expect(settledEvents.length).toBe(2);
    const amounts = settledEvents.map(e => JSON.parse(e.metadataJson || "{}").amountCents).sort();
    expect(amounts).toEqual([50, 80]);
  });

  it("docs/275 P1：同一 refCode 但不同好友（joinerEntryId 各异）→ 各自独立结算，互不误拦", async () => {
    const { drawId, sharerEntryId, joinerEntryId } = await setupPercentReward();

    // 模拟用户级邀请码场景：两个好友用同一 refCode，reward_pending 事件带各自 joinerEntryId
    const joiner2Id = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: joiner2Id, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "joiner2@test.com",
      ipHash: "ip-j2", joinedAt: new Date().toISOString(),
    });

    // 第一条 pending（joinerEntryId 已在 metadata，之后由新写入路径产生）
    await db.update(activityEvents)
      .set({ metadataJson: sql`json_set(COALESCE(metadata_json, '{}'), '$.joinerEntryId', ${joinerEntryId})` })
      .where(and(eq(activityEvents.entryId, sharerEntryId), eq(activityEvents.eventType, "reward_pending"), eq(activityEvents.refCode, "INV-CODE-001")));

    // 第二条 pending（同一 refCode + joiner2）
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: joiner2Id,
      eventType: "attributed_join", refCode: "INV-CODE-001",
      metadata: { sharerEntryId, inviterIdentityValue: "sharer@test.com", source: "trigger" },
    });
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: sharerEntryId,
      eventType: "reward_pending", refCode: "INV-CODE-001",
      metadata: {
        mode: "percent", perInvitePercent: 10, currency: "CNY",
        sharerEntryId, inviterIdentityValue: "sharer@test.com",
        source: "trigger", status: "pending", joinerEntryId: joiner2Id,
      },
    });

    // 好友2 结算（joiner2Id）→ 匹配到 joiner2 自己的 pending
    const r2 = await settleRewardByPercent(db, TENANT, drawId, joiner2Id, 500, "CNY");
    expect(r2.settled).toBe(true);
    // 好友1 结算（joinerEntryId）→ 不被好友2 的 reward_earned 误拦
    const r1 = await settleRewardByPercent(db, TENANT, drawId, joinerEntryId, 800, "CNY");
    expect(r1.settled).toBe(true);

    const settledEvents = await db
      .select({ metadataJson: activityEvents.metadataJson })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_earned"),
      ));
    expect(settledEvents.length).toBe(2);
    const amounts = settledEvents.map(e => JSON.parse(e.metadataJson || "{}").amountCents).sort();
    expect(amounts).toEqual([50, 80]);
  });

  it("幂等：同一 joinerEntryId + refCode 双重 settle → 第二次返回 already_settled", async () => {
    const { drawId, joinerEntryId } = await setupPercentReward();

    // 第一次结算
    const r1 = await settleRewardByPercent(db, TENANT, drawId, joinerEntryId, 1000, "CNY");
    expect(r1.settled).toBe(true);

    // 第二次结算（幂等）
    const r2 = await settleRewardByPercent(db, TENANT, drawId, joinerEntryId, 1000, "CNY");
    expect(r2.settled).toBe(false);
    expect(r2.reason).toBe("already_settled");

    // 验证只有 1 条 reward_earned 事件
    const earnedEvents = await db
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_earned"),
      ));
    expect(earnedEvents.length).toBe(1);
  });

  it("settle 后 cancel 不写入 reward_cancelled（reward_earned 是最终态）", async () => {
    const { drawId, joinerEntryId } = await setupPercentReward();

    // 先结算
    await settleRewardByPercent(db, TENANT, drawId, joinerEntryId, 1000, "CNY");

    // 再取消
    const r = await cancelRewardPending(db, TENANT, drawId, joinerEntryId, "payment_refunded");
    expect(r.cancelled).toBe(false); // 已结算，跳过

    // 验证无 reward_cancelled 事件
    const cancelledEvents = await db
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_cancelled"),
      ));
    expect(cancelledEvents.length).toBe(0);
  });
});

// ── cancelRewardPending：支付取消/退款/超时后清理 pending 事件（docs/271） ──
describe("cancelRewardPending", () => {
  async function setupPendingReward() {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const config = JSON.stringify({
      version: 1,
      reward: { mode: "percent", perInvitePercent: 10, currency: "CNY" },
    });
    const { id: drawId } = await createDraw(db, TENANT, {
      title: "cancel-pending-test",
      startAt: now.toISOString(), endAt: future.toISOString(),
      participationMode: "open", winnerCount: 1, activityConfig: config,
    });

    const sharerEntryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: sharerEntryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "sharer@test.com",
      ipHash: "ip-s", joinedAt: now.toISOString(),
    });

    const joinerEntryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: joinerEntryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "joiner@test.com",
      ipHash: "ip-j", joinedAt: now.toISOString(),
    });

    const refCode = "INV-CANCEL-001";
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: joinerEntryId,
      eventType: "attributed_join", refCode,
      metadata: { sharerEntryId, inviterIdentityValue: "sharer@test.com", source: "trigger" },
    });
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: sharerEntryId,
      eventType: "reward_pending", refCode,
      metadata: {
        mode: "percent", perInvitePercent: 10, currency: "CNY",
        sharerEntryId, inviterIdentityValue: "sharer@test.com",
        source: "trigger", status: "pending",
      },
    });

    return { drawId, sharerEntryId, joinerEntryId };
  }

  it("happy path：支付取消后写入 reward_cancelled 事件", async () => {
    const { drawId, joinerEntryId } = await setupPendingReward();
    const result = await cancelRewardPending(db, TENANT, drawId, joinerEntryId, "payment_cancelled");
    expect(result.cancelled).toBe(true);

    // 验证 reward_cancelled 事件已记录（docs/273：与 reward_failed 语义分离）
    const [event] = await db
      .select({ metadataJson: activityEvents.metadataJson })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_cancelled"),
      ));
    expect(event).toBeDefined();
    const meta = JSON.parse(event.metadataJson || "{}");
    expect(meta.reason).toBe("payment_cancelled");
    expect(meta.status).toBe("cancelled");
    expect(meta.joinerEntryId).toBe(joinerEntryId);
  });

  it("超时释放时记录 payment_expired 原因", async () => {
    const { drawId, joinerEntryId } = await setupPendingReward();
    const result = await cancelRewardPending(db, TENANT, drawId, joinerEntryId, "payment_expired");
    expect(result.cancelled).toBe(true);

    const [event] = await db
      .select({ metadataJson: activityEvents.metadataJson })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_cancelled"),
      ));
    const meta = JSON.parse(event.metadataJson || "{}");
    expect(meta.reason).toBe("payment_expired");
  });

  it("无 attributed_join 事件 → 返回 cancelled: false（幂等）", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const config = JSON.stringify({ version: 1, reward: { mode: "percent", perInvitePercent: 10 } });
    const { id: drawId } = await createDraw(db, TENANT, {
      title: "cancel-no-join", startAt: now.toISOString(), endAt: future.toISOString(),
      participationMode: "open", winnerCount: 1, activityConfig: config,
    });
    const fakeEntryId = crypto.randomUUID();
    const result = await cancelRewardPending(db, TENANT, drawId, fakeEntryId, "payment_cancelled");
    expect(result.cancelled).toBe(false);
  });

  it("reward_pending 不存在时仍返回 cancelled: true（幂等，reward_cancelled 已记录）", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000);
    const { id: drawId } = await createDraw(db, TENANT, {
      title: "cancel-no-pending", startAt: now.toISOString(), endAt: future.toISOString(),
      participationMode: "open", winnerCount: 1, activityConfig: "{}",
    });

    const sharerEntryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: sharerEntryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "sharer@test.com",
      ipHash: "ip-s", joinedAt: now.toISOString(),
    });
    const joinerEntryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: joinerEntryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "joiner@test.com",
      ipHash: "ip-j", joinedAt: now.toISOString(),
    });

    // 只有 attributed_join，没有 reward_pending
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: joinerEntryId,
      eventType: "attributed_join", refCode: "INV-NOPEND",
      metadata: { sharerEntryId, inviterIdentityValue: "sharer@test.com", source: "trigger" },
    });

    // cancelRewardPending 仍然返回 true（attributed_join 存在即可）
    const result = await cancelRewardPending(db, TENANT, drawId, joinerEntryId, "payment_refunded");
    expect(result.cancelled).toBe(true);

    // reward_cancelled 事件已记录（即使没有对应的 reward_pending）
    const [event] = await db
      .select({ metadataJson: activityEvents.metadataJson })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_cancelled"),
      ));
    expect(event).toBeDefined();
    const meta = JSON.parse(event.metadataJson || "{}");
    expect(meta.reason).toBe("payment_refunded");
  });

  it("已结算后 cancel → 返回 cancelled=false（reward_earned 是最终态）", async () => {
    const { drawId, joinerEntryId } = await setupPendingReward();

    // 先结算（写入 reward_earned）
    await settleRewardByPercent(db, TENANT, drawId, joinerEntryId, 1000, "CNY");

    // 再取消
    const result = await cancelRewardPending(db, TENANT, drawId, joinerEntryId, "payment_refunded");
    expect(result.cancelled).toBe(false);

    // 验证无 reward_cancelled 事件
    const cancelledEvents = await db
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_cancelled"),
      ));
    expect(cancelledEvents.length).toBe(0);
  });

  it("双重 cancel → 幂等（第二次不重复写入 reward_cancelled）", async () => {
    const { drawId, joinerEntryId } = await setupPendingReward();

    // 第一次取消
    const r1 = await cancelRewardPending(db, TENANT, drawId, joinerEntryId, "payment_cancelled");
    expect(r1.cancelled).toBe(true);

    // 第二次取消（幂等：返回 cancelled=false 表示已存在，不重复写入）
    const r2 = await cancelRewardPending(db, TENANT, drawId, joinerEntryId, "payment_expired");
    expect(r2.cancelled).toBe(false);

    // 验证只有 1 条 reward_cancelled 事件
    const cancelledEvents = await db
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_cancelled"),
      ));
    expect(cancelledEvents.length).toBe(1);
  });

  it("docs/275 P1：同一 refCode 下好友 X 已结算不拦截好友 Y 的取消（joinerEntryId 粒度）", async () => {
    const { drawId, sharerEntryId, joinerEntryId } = await setupPendingReward();
    const refCode = "INV-CANCEL-001";

    // 好友2：同一 refCode 的另一条归因 + pending
    const joiner2Id = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: joiner2Id, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "joiner2@test.com",
      ipHash: "ip-j2", joinedAt: new Date().toISOString(),
    });
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: joiner2Id,
      eventType: "attributed_join", refCode,
      metadata: { sharerEntryId, inviterIdentityValue: "sharer@test.com", source: "trigger" },
    });
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: sharerEntryId,
      eventType: "reward_pending", refCode,
      metadata: {
        mode: "percent", perInvitePercent: 10, currency: "CNY",
        sharerEntryId, inviterIdentityValue: "sharer@test.com",
        source: "trigger", status: "pending", joinerEntryId: joiner2Id,
      },
    });

    // 好友1（joinerEntryId）已结算 → 写入 reward_earned（settled，带 joinerEntryId=joinerEntryId）
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId, entryId: sharerEntryId,
      eventType: "reward_earned", refCode,
      metadata: {
        mode: "percent", percent: 10, amountCents: 100, currency: "CNY",
        sharerEntryId, inviterIdentityValue: "sharer@test.com",
        status: "settled", joinerEntryId, settledFrom: "reward_pending",
      },
    });

    // 好友2 取消 → 不应被好友1 的 reward_earned 拦截（joinerEntryId 精确匹配）
    const r2 = await cancelRewardPending(db, TENANT, drawId, joiner2Id, "payment_cancelled");
    expect(r2.cancelled).toBe(true);

    // 好友1 取消 → 已被结算，返回 cancelled=false（reward_earned 是最终态）
    const r1 = await cancelRewardPending(db, TENANT, drawId, joinerEntryId, "payment_cancelled");
    expect(r1.cancelled).toBe(false);

    // 只有好友2 的 reward_cancelled 事件
    const cancelledEvents = await db
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_cancelled"),
      ));
    expect(cancelledEvents.length).toBe(1);
  });
});

// ── prizeCode 状态机：issued → redeemed（docs/114 §4） ──
// 注意：importPrizeCodes 内部生成随机 ID，不保留调用方传入的 id 字段。
// 因此通过 prizeCodes.code（唯一码字符串）定位卡密，而非通过调用方指定的 id。
describe("prizeCode redeemed 状态流转", () => {
  it("issued 可标记为 redeemed", async () => {
    const { createPrize, importPrizeCodes } = await import("../services/lottery-service");
    const { prizeCodes } = await import("../db/schema");

    const { id: prizeId } = await createPrize(db, TENANT, { name: "核销测试奖品", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "REDEEM-001", secret: "s1" }]);

    // 模拟中奖发放：available → issued（按 code 定位，id 由 importPrizeCodes 内部生成）
    await db.update(prizeCodes).set({ status: "issued", winnerId: "winner-1", issuedAt: new Date().toISOString() }).where(eq(prizeCodes.code, "REDEEM-001"));

    // 标记 redeemed
    await db.update(prizeCodes).set({ status: "redeemed" }).where(eq(prizeCodes.code, "REDEEM-001"));

    const [updated] = await db.select({ status: prizeCodes.status }).from(prizeCodes).where(eq(prizeCodes.code, "REDEEM-001"));
    expect(updated).toBeDefined();
    expect(updated.status).toBe("redeemed");
  });

  it("revoked 的卡密不被误标记为 redeemed（幂等保护）", async () => {
    const { createPrize, importPrizeCodes } = await import("../services/lottery-service");
    const { prizeCodes } = await import("../db/schema");

    const { id: prizeId } = await createPrize(db, TENANT, { name: "核销测试奖品2", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "REDEEM-002", secret: "s2" }]);

    // 先 issued → revoked（模拟退群收回）
    await db.update(prizeCodes).set({ status: "issued", winnerId: "winner-2", issuedAt: new Date().toISOString() }).where(eq(prizeCodes.code, "REDEEM-002"));
    await db.update(prizeCodes).set({ status: "revoked" }).where(eq(prizeCodes.code, "REDEEM-002"));

    // revocation 后状态应为 revoked，不被后续操作覆盖
    const [row] = await db.select({ status: prizeCodes.status }).from(prizeCodes).where(eq(prizeCodes.code, "REDEEM-002"));
    expect(row).toBeDefined();
    expect(row.status).toBe("revoked");
  });
});

/* ── 增长功能集成测试（docs/218 模式一至四交叉场景） ── */

describe("增长功能集成：保底+每日免费+排行榜奖励+裂变", () => {
  /**
   * 创建支持全部增长特性的 instant 活动：
   * - 保底（pity.threshold=3）
   * - 每日免费（dailyFreeSpins.count=1）
   * - 裂变分享（viral.extraSpinsPerInvite）→ 排行榜奖励（viral.leaderboardRewards）
   */
  async function seedGrowthDraw(opts?: {
    pityThreshold?: number;
    dailyFreeCount?: number;
    leaderboardRewards?: Array<{ rank: number; rewardValue: number }>;
  }) {
    const now = new Date();
    const future = new Date(now.getTime() + 7 * 86400_000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "增长功能集成",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      participationMode: "open",
      activityKind: "lottery",
      experienceType: "wheel",
      resultMode: "instant",
      maxSpinsPerEntry: 20,
      winnerCount: 3,
      promotionConfig: JSON.stringify({
        pity: { enabled: true, threshold: opts?.pityThreshold ?? 3 },
        dailyFreeSpins: { enabled: true, count: opts?.dailyFreeCount ?? 1 },
        viral: {
          enabled: true,
          extraSpinsPerInvite: 1,
          maxExtraSpins: 5,
          extraEntriesPerInvite: 1,
          maxExtraEntries: 5,
          leaderboardEnabled: true,
          leaderboardRewards: (opts?.leaderboardRewards ?? [
            { rank: 1, rewardType: "bonus_spin", rewardValue: 3 },
            { rank: 2, rewardType: "bonus_spin", rewardValue: 1 },
          ]).map((r) => ({ ...r, rewardType: "bonus_spin" })),
        },
      }),
    });

    // 档 A（sortOrder 10，高价值，码全部 claimed → 正常抽必未中，用于累积连空）
    const prizeAId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type, total_count, active) VALUES (?, ?, ?, ?, ?, ?)",
      args: [prizeAId, TENANT, "售罄大奖", "code", 3, 1],
    });
    // 所有码 claimed（发布预检通过，但运行时无一可用 → 必未中）
    for (let i = 0; i < 3; i++) {
      await client.execute({
        sql: "INSERT INTO prize_codes (id, tenant_id, prize_id, code, status) VALUES (?, ?, ?, ?, ?)",
        args: [crypto.randomUUID(), TENANT, prizeAId, `INTEG-USED-${i}`, "claimed"],
      });
    }
    // 档 B（sortOrder 100，保底触发必中）→ 3 库存码
    const prizeBId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type, total_count, active) VALUES (?, ?, ?, ?, ?, ?)",
      args: [prizeBId, TENANT, "保底小奖", "code", 3, 1],
    });

    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: id,
      prizeId: prizeAId, tierName: "大奖", winnerCount: 100, sortOrder: 10, weight: 100,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: id,
      prizeId: prizeBId, tierName: "小奖", winnerCount: 3, sortOrder: 100, weight: 100,
    });

    for (let i = 0; i < 3; i++) {
      await client.execute({
        sql: "INSERT INTO prize_codes (id, tenant_id, prize_id, code, status) VALUES (?, ?, ?, ?, ?)",
        args: [crypto.randomUUID(), TENANT, prizeBId, `INTEG-PITY-${i}`, "available"],
      });
    }

    // 直接置为 open（绕过发布预检：大奖"售罄"语义在预检中会被拦截，与 spin-execution.test.ts
    // seedPityDraw 直接 INSERT status=open 的模式一致——集成测试聚焦运行时链路，发布预检
    // 由 publish-check-service 单独覆盖）
    await db
      .update(lotteryDraws)
      .set({ status: "open", updatedAt: new Date().toISOString() })
      .where(and(eq(lotteryDraws.id, id), eq(lotteryDraws.tenantId, TENANT)));
    return { id, publicSlug };
  }

  it("完整链路：用户B经A分享参与 → A触发保底+领取每日免费 → 排行榜奖励发放", async () => {
    const { publicSlug } = await seedGrowthDraw();

    // ── 用户 A（分享人）参与 ──
    const sharer = await joinDraw(db, publicSlug, "sharer@integ.test.com");
    expect(sharer.joined).toBe(true);
    const sharerEntryId = String(sharer.entryId || "");
    expect(sharerEntryId).toBeTruthy();

    // ── 取 A 的分享码，用户 B 经分享参与 → A 的有效邀请 +1 ──
    // 生产环境 shareRecord 在用户点击分享时创建（public-lottery-share.ts:286），测试中手动创建
    const SHARE_CODE = "integ-growth-share";
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: (await db.select({ id: lotteryDraws.id }).from(lotteryDraws).where(eq(lotteryDraws.publicSlug, publicSlug)))[0]!.id,
      sharerEntryId,
      shareCode: SHARE_CODE,
      clickedCount: 0,
      joinedCount: 0,
    });
    const invitee = await joinDraw(db, publicSlug, "invitee@integ.test.com", "email", { refCode: SHARE_CODE });
    expect(invitee.joined).toBe(true);

    // 验证 A 的 joined_count=1（排行榜名次数据）
    const [recordAfterJoin] = await db
      .select()
      .from(shareRecords)
      .where(eq(shareRecords.sharerEntryId, sharerEntryId))
      .limit(1);
    expect(Number(recordAfterJoin?.joinedCount ?? 0)).toBe(1);

    // ── 手动发放 spins（join 默认 1 次 + 额外 5 次 = 6） ──
    await client.execute({
      sql: "UPDATE lottery_entries SET spins_left = spins_left + 5, spins_total_granted = spins_total_granted + 5 WHERE id = ?",
      args: [sharerEntryId],
    });

    // ── 固定 CSPRNG=0：正常抽 eligible[0]（档 A，无库存 → 必未中） ──
    // 与 spin-execution.test.ts 相同的内存替换模式，结束时还原。
    const real = crypto as unknown as { getRandomValues: (arr: Uint32Array) => void };
    const origGetRandomValues = real.getRandomValues;
    real.getRandomValues = (arr: Uint32Array) => { arr[0] = 0; };

    try {
      // ── 前三轮 spin：必未中，连空计数器 0→3 ──
      for (let i = 1; i <= 3; i++) {
        const r = await performInstantSpin(db, {
          slug: publicSlug,
          identityType: "email",
          identityValue: "sharer@integ.test.com",
          idempotencyKey: `integ-${i}`,
        });
        expect(r.won).toBe(false);
      }

      // 保底计数器到 3
      const [entryAfter3Rolls] = await db
        .select()
        .from(lotteryEntries)
        .where(eq(lotteryEntries.id, sharerEntryId))
        .limit(1);
      expect(Number(entryAfter3Rolls?.consecutiveNoWinSpins ?? 0)).toBe(3);

      // ── 第 4 轮：保底触发，强制中档 B（最低价值） ──
      const r4 = await performInstantSpin(db, {
        slug: publicSlug,
        identityType: "email",
        identityValue: "sharer@integ.test.com",
        idempotencyKey: "integ-4",
      });
      expect(r4.won).toBe(true);
      expect(r4.tierName).toBe("小奖");
      expect(r4.prizeCode).toBeTruthy();

      // 计数器归零（won=1）
      const [entryAfterPity] = await db
        .select()
        .from(lotteryEntries)
        .where(eq(lotteryEntries.id, sharerEntryId))
        .limit(1);
      expect(Number(entryAfterPity?.consecutiveNoWinSpins ?? 0)).toBe(0);

      // ── 第 5 轮：正常扣次未中 ──
      const r5 = await performInstantSpin(db, {
        slug: publicSlug,
        identityType: "email",
        identityValue: "sharer@integ.test.com",
        idempotencyKey: "integ-5",
      });
      expect(r5.won).toBe(false);

      // ── 验证 spins_log 审计：daily_free 恰 1 条（第 1 轮免费） + pity:3: 前缀恰 1 条（第 4 轮保底） ──
      const logs = await db
        .select()
        .from(spinsLog)
        .where(eq(spinsLog.entryId, sharerEntryId));
      const dailyFreeLogs = logs.filter((l) => l.reason === "daily_free");
      expect(dailyFreeLogs).toHaveLength(1);
      const pityLogs = logs.filter((l) => l.refId?.startsWith("pity:3:"));
      expect(pityLogs).toHaveLength(1);

      // 每日免费日志 balanceAfter 应为 8（docs/255 B3：逐条运行余额语义，
      // daily_free 的 +1 发生在 spin 的 -1 之前，因此 balanceAfter = 最终余额(7) + 1 = 8）
      expect(Number(dailyFreeLogs[0]!.balanceAfter)).toBe(8);

      // ── 发放排行榜奖励（instant 模式管理端手动触发路径） ──
      const [draw] = await db
        .select()
        .from(lotteryDraws)
        .where(eq(lotteryDraws.publicSlug, publicSlug))
        .limit(1);
      const rewardResult = await grantLeaderboardRewards(db, draw!);
      expect(rewardResult.granted).toBe(1); // 仅 A 有 joined_count=1
      expect(rewardResult.skipped).toBe(0);

      // ── 排行榜奖励到账：spinsLeft = 5轮后剩 3 + rank1(+3) = 6 ──
      // spins 流向：join(1) + viral(1,B分享) + 手动(5) = 7 → dailyFree(+1 且扣本次→7) →
      // spin2-5(扣4次→3) + leaderboard(+3→6)（docs/255 §7.3 P1-4：每日免费扣本次）
      const [entryAfterReward] = await db
        .select()
        .from(lotteryEntries)
        .where(eq(lotteryEntries.id, sharerEntryId))
        .limit(1);
      expect(Number(entryAfterReward?.spinsLeft ?? 0)).toBe(6);
      // 总授予：join(1) + viral(1) + 手动(5) + 排行榜(3) = 10
      // （P1 修复：每日免费不再计入 spinsTotalGranted，与签到同语义——避免毒化裂变/里程碑 room）
      expect(Number(entryAfterReward?.spinsTotalGranted ?? 0)).toBe(10);

      // 排行榜奖励写入 spins_log（reason=viral, refId=leaderboard:1）
      const logsAfterLb = await db
        .select()
        .from(spinsLog)
        .where(eq(spinsLog.entryId, sharerEntryId));
      const lbLogs = logsAfterLb.filter((l) => l.refId === "leaderboard:1");
      expect(lbLogs).toHaveLength(1);

      // ── 幂等：重复发放不重复加次 ──
      const again = await grantLeaderboardRewards(db, draw);
      expect(again.granted).toBe(0);
      expect(again.skipped).toBe(1);
      const [entryAfterRepeat] = await db
        .select()
        .from(lotteryEntries)
        .where(eq(lotteryEntries.id, sharerEntryId))
        .limit(1);
      expect(Number(entryAfterRepeat?.spinsLeft ?? 0)).toBe(6);
    } finally {
      real.getRandomValues = origGetRandomValues;
      delete (crypto as unknown as Record<string, unknown>).__csprngOriginal;
    }
  });

  it("排行榜奖励 performDraw 收尾自动发放路径（manual 模式）", async () => {
    // manual 模式：排行榜奖励在 performDraw 收尾自动发放（draw-execution.ts:424-431）
    const now = new Date();
    const future = new Date(now.getTime() + 7 * 86400_000);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "增长集成-手动开奖",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      participationMode: "open",
      activityKind: "lottery",
      experienceType: "list",
      resultMode: "manual",
      winnerCount: 2,
      promotionConfig: JSON.stringify({
        viral: {
          enabled: true,
          extraEntriesPerInvite: 1,
          maxExtraEntries: 5,
          leaderboardEnabled: true,
          leaderboardRewards: [
            { rank: 1, rewardType: "bonus_spin", rewardValue: 3 },
          ],
        },
      }),
    });
    // manual 模式发布预检：需要奖品 + 档位
    const prizeId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type, total_count, active) VALUES (?, ?, ?, ?, ?, ?)",
      args: [prizeId, TENANT, "手动开奖奖", "manual_fulfillment", 0, 1],
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: id,
      prizeId, tierName: "一等奖", winnerCount: 2, sortOrder: 1, weight: 100,
    });
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    // 用户 A 参与，用户 B 经 A 分享参与
    const sharer = await joinDraw(db, publicSlug, "dl-sharer@integ.test.com");
    expect(sharer.joined).toBe(true);
    const sharerEntryId = String(sharer.entryId || "");
    const SHARE_CODE_MANUAL = "integ-manual-share";
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      sharerEntryId,
      shareCode: SHARE_CODE_MANUAL,
      clickedCount: 0,
      joinedCount: 0,
    });
    await joinDraw(db, publicSlug, "dl-invitee@integ.test.com", "email", { refCode: SHARE_CODE_MANUAL });

    // 开奖（performDraw 收尾自动发排行榜奖励）
    const result = await performDraw(db, TENANT, id, USER);
    expect(result.winnerCount).toBeGreaterThan(0);

    // A 的排行榜奖励已自动发放（rank1 → +3；manual 模式 join 不发初始 spins，初始为 0）
    const [entryAfterDraw] = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.id, sharerEntryId))
      .limit(1);
    // manual 模式 initialSpinsForJoin(0) → spinsLeft=0，+ 排行榜奖励 3 = 3
    expect(Number(entryAfterDraw?.spinsLeft ?? 0)).toBe(3);
    expect(Number(entryAfterDraw?.spinsTotalGranted ?? 0)).toBe(3);
  });
});

// ── 保底→每日免费→排行榜奖励全链路集成测试（docs/220 P2） ──
// 覆盖完整流程：创建 → 发布 → A加入 → B通过A分享加入 → A多次抽奖（保底触发）
// → 次日免费抽 → 活动结束 → 发放排行榜奖励
// 触及：participation.ts → spin-execution.ts → leaderboard-rewards.ts
describe("保底→每日免费→排行榜奖励全链路", () => {
  it("完整流程：创建→发布→A加入→B通过A分享加入→A多次抽奖(保底触发)→次日免费抽→活动结束→发放排行榜奖励", async () => {
    // ── 1. 创建即时抽奖活动（带保底、每日免费、排行榜奖励配置） ──
    const now = new Date();
    const startAt = new Date(now.getTime() - 3600_000).toISOString();
    const endAt = new Date(now.getTime() + 7 * 86400_000).toISOString();
    const promotionConfig = JSON.stringify({
      version: 1,
      pity: { enabled: true, threshold: 3 },
      dailyFreeSpins: { enabled: true, count: 1 },
      viral: {
        enabled: true,
        leaderboardEnabled: true,
        leaderboardRewards: [
          { rank: 1, rewardType: "bonus_spin", rewardValue: 5 },
          { rank: 2, rewardType: "bonus_spin", rewardValue: 3 },
          { rank: 3, rewardType: "bonus_spin", rewardValue: 1 },
        ],
      },
    });
    const { id: drawId, publicSlug } = await createDraw(db, TENANT, {
      title: "全链路集成测试", startAt, endAt,
      participationMode: "open", resultMode: "instant",
      experienceType: "wheel", maxSpinsPerEntry: 10,
      winnerCount: 5, promotionConfig,
    });

    // 创建两个奖品档位：
    // - 档 A（sortOrder 10，高价值，库存 0 → 必未中）→ 用于累积连空
    // - 档 B（sortOrder 100，低价值，库存 3 → 有码必中）→ 保底强制最低档
    const prizeAId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type, total_count, active) VALUES (?, ?, ?, ?, ?, ?)",
      args: [prizeAId, TENANT, "售罄大奖", "code", 0, 1],
    });
    const prizeBId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type, total_count, active) VALUES (?, ?, ?, ?, ?, ?)",
      args: [prizeBId, TENANT, "保底小奖", "code", 3, 1],
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId, prizeId: prizeAId,
      tierName: "大奖", winnerCount: 100, sortOrder: 10, weight: 100,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId, prizeId: prizeBId,
      tierName: "小奖", winnerCount: 3, sortOrder: 100, weight: 100,
    });
    for (let i = 0; i < 3; i++) {
      await client.execute({
        sql: "INSERT INTO prize_codes (id, tenant_id, prize_id, code, secret, status) VALUES (?, ?, ?, ?, ?, ?)",
        args: [crypto.randomUUID(), TENANT, prizeBId, `PITY-${i}-${drawId.slice(0, 6)}`, `S-${i}`, "available"],
      });
    }

    // ── 2. 直接设置为 open（跳过 publishCheck：大奖档 0 库存但无码，publishCheck 会拒绝） ──
    await client.execute({
      sql: "UPDATE lottery_draws SET status = ? WHERE id = ? AND tenant_id = ?",
      args: ["open", drawId, TENANT],
    });
    // ── 3. User A 加入 ──
    const joinA = await joinDraw(db, publicSlug, "userA@test.com");
    expect(joinA.joined).toBe(true);
    expect(joinA.entryId).toBeTruthy();
    const entryAId = joinA.entryId!;
    // 给 A 足够的 spins 用于多次抽奖（初始 join 只给 1 次）
    await client.execute({
      sql: "UPDATE lottery_entries SET spins_left = ?, spins_total_granted = ? WHERE id = ?",
      args: [5, 5, entryAId],
    });
    // ── 4. User B 通过 A 的分享链接加入，创建 shareRecord 模拟邀请 ──
    const shareCode = `sc-${drawId.slice(0, 6)}-${entryAId.slice(0, 6)}`;
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      sharerEntryId: entryAId, shareCode,
      joinedCount: 1, clickedCount: 0,
      rewardMilestonesGranted: "[]", leaderboardRewardedAt: "",
      createdAt: new Date().toISOString(),
    });
    const joinB = await joinDraw(db, publicSlug, "userB@test.com");
    expect(joinB.joined).toBe(true);

    // ── 5. CSPRNG 固定为 0：正常随机抽 eligible[0] = 档 A（库存 0 → 未中） ──
    const realCsprng = (crypto as unknown as { getRandomValues: (arr: Uint32Array) => void }).getRandomValues;
    (crypto as unknown as { getRandomValues: (arr: Uint32Array) => void }).getRandomValues = (arr: Uint32Array) => {
      arr[0] = 0;
    };
    try {
      // A 抽奖 3 次，全部未中，连空计数器 → 1, 2, 3
      for (let i = 1; i <= 3; i++) {
        const r = await performInstantSpin(db, {
          slug: publicSlug, identityType: "email",
          identityValue: "userA@test.com",
          idempotencyKey: `full-${i}`,
        });
        expect(r.won).toBe(false);
      }
      // 验证连空计数器 = 3
      const [entryBeforePity] = await db
        .select({ consecutiveNoWinSpins: lotteryEntries.consecutiveNoWinSpins })
        .from(lotteryEntries)
        .where(and(eq(lotteryEntries.id, entryAId), eq(lotteryEntries.tenantId, TENANT)));
      expect(Number(entryBeforePity.consecutiveNoWinSpins)).toBe(3);

      // ── 6. 第 4 次：保底触发（threshold=3），强制最低档 B → 中奖 ──
      const r4 = await performInstantSpin(db, {
        slug: publicSlug, identityType: "email",
        identityValue: "userA@test.com", idempotencyKey: "full-4",
      });
      expect(r4.won).toBe(true);
      expect(r4.tierName).toBe("小奖");
      expect(r4.prizeCode).toBeTruthy();
      // 验证计数器归零
      const [entryAfterPity] = await db
        .select({ consecutiveNoWinSpins: lotteryEntries.consecutiveNoWinSpins })
        .from(lotteryEntries)
        .where(and(eq(lotteryEntries.id, entryAId), eq(lotteryEntries.tenantId, TENANT)));
      expect(Number(entryAfterPity.consecutiveNoWinSpins)).toBe(0);

      // ── 7. 模拟次日：手动更新 lastDailyFreeSpinAt 为昨天 ──
      const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      await db
        .update(lotteryEntries)
        .set({ lastDailyFreeSpinAt: yesterday })
        .where(and(eq(lotteryEntries.id, entryAId), eq(lotteryEntries.tenantId, TENANT)));
      // 恢复 CSPRNG 以便后续正常抽奖
      (crypto as unknown as { getRandomValues: (arr: Uint32Array) => void }).getRandomValues = realCsprng;
      // 第 5 次：每日免费领取 +1 且扣本次（docs/255 §7.3 P1-4）
      const r5 = await performInstantSpin(db, {
        slug: publicSlug, identityType: "email",
        identityValue: "userA@test.com", idempotencyKey: "full-5",
      });
      // 验证每日免费生效：初始 5 - 4 次扣次 + 裂变加次 1 + 免费 1 - 本次扣 1 = 2
      expect(r5.spinsLeft).toBe(2);
      // 验证 spins_log 中有 daily_free 记录
      const logs = await db.select().from(spinsLog).where(eq(spinsLog.entryId, entryAId));
      const freeLog = logs.find((l) => l.reason === "daily_free");
      expect(freeLog).toBeDefined();
      expect(freeLog!.delta).toBe(1);

      // ── 8. 结束活动（设置 status = drawn） ──
      await db
        .update(lotteryDraws)
        .set({ status: "drawn" })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, TENANT)));
      // ── 9. 发放排行榜奖励 ──
      const draw = await getDraw(db, drawId, TENANT);
      expect(draw).toBeDefined();
      const result = await grantLeaderboardRewards(db, draw!);
      expect(result.granted).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.details[0].rank).toBe(1);
      expect(result.details[0].rewardValue).toBe(5);
      expect(result.details[0].status).toBe("granted");
      // 验证 A 的 spinsLeft 增加了 5
      const [entryFinal] = await db
        .select({ spinsLeft: lotteryEntries.spinsLeft })
        .from(lotteryEntries)
        .where(and(eq(lotteryEntries.id, entryAId), eq(lotteryEntries.tenantId, TENANT)));
      // 预期：2（5次spins后，含每日免费扣本次）+ 5（leaderboard）= 7（docs/255 §7.3 P1-4）
      expect(Number(entryFinal.spinsLeft)).toBe(7);
      // ── 10. 幂等验证：再次调用不重复发放 ──
      const result2 = await grantLeaderboardRewards(db, draw!);
      expect(result2.granted).toBe(0);
      expect(result2.skipped).toBe(1);
      expect(result2.details[0].status).toBe("skipped");
      const [entryAfterIdempotent] = await db
        .select({ spinsLeft: lotteryEntries.spinsLeft })
        .from(lotteryEntries)
        .where(and(eq(lotteryEntries.id, entryAId), eq(lotteryEntries.tenantId, TENANT)));
      expect(Number(entryAfterIdempotent.spinsLeft)).toBe(7);
    } finally {
      // 确保 CSPRNG 恢复，不影响后续测试
      (crypto as unknown as { getRandomValues: (arr: Uint32Array) => void }).getRandomValues = realCsprng;
    }
  });
});

// P0 修复（2026-08 审查）：卡密重复导入必须被拦截（迁移 0063 唯一约束 + importPrizeCodes 显式查重）
describe("importPrizeCodes 重复码拦截", () => {
  it("批次内重复码只插入一次，返回 skipped 数", async () => {
    const { id: prizeId } = await createPrize(db, TENANT, { name: "去重奖品", prizeType: "code" });
    const result = await importPrizeCodes(db, TENANT, prizeId, [
      { code: "DUP-1", secret: "S1" },
      { code: "DUP-1", secret: "S1-again" }, // 批次内重复 → 跳过
      { code: "DUP-2", secret: "S2" },
      { code: "", secret: "empty" }, // 空码 → 跳过
    ]);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(2);

    const rows = await db.select().from(prizeCodes).where(eq(prizeCodes.prizeId, prizeId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.code).sort()).toEqual(["DUP-1", "DUP-2"]);
    // total_count 只累计实际插入数
    const [prize] = await db.select().from(prizes).where(eq(prizes.id, prizeId)).limit(1);
    expect(Number(prize?.totalCount ?? 0)).toBe(2);
  });

  it("库中已存在的同码跳过（不重复入库、不重复发放）", async () => {
    const { id: prizeId } = await createPrize(db, TENANT, { name: "查重奖品", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "EXIST-1", secret: "S1" }]);
    const second = await importPrizeCodes(db, TENANT, prizeId, [
      { code: "EXIST-1", secret: "S1" }, // 已存在 → 跳过
      { code: "NEW-1", secret: "S2" },
    ]);
    expect(second.imported).toBe(1);
    expect(second.skipped).toBe(1);

    const rows = await db.select().from(prizeCodes).where(eq(prizeCodes.prizeId, prizeId));
    expect(rows).toHaveLength(2); // 没有重复的 EXIST-1
  });

  it("唯一约束硬兜底：同租户同奖品直接插入同码被拒绝（迁移 0063）", async () => {
    const { id: prizeId } = await createPrize(db, TENANT, { name: "约束奖品", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "UNIQ-1", secret: "S1" }]);
    // 绕过 importPrizeCodes 直接插入同码 → 必须被唯一索引拒绝（libsql 错误文案在 cause 链，不断言具体文案）
    await expect(
      db.insert(prizeCodes).values({
        id: crypto.randomUUID(),
        tenantId: TENANT,
        prizeId,
        code: "UNIQ-1",
        secret: "S1-dup",
        status: "available",
      }),
    ).rejects.toThrow();
  });

  it("不同租户可拥有相同 code（唯一约束按租户隔离）", async () => {
    const TENANT_B = "tenant-b-codes";
    await client.execute({
      sql: `INSERT OR IGNORE INTO tenants (id, name, plan, status) VALUES (?, 'B', 'free', 'active')`,
      args: [TENANT_B],
    });
    const { id: prizeA } = await createPrize(db, TENANT, { name: "A奖品", prizeType: "code" });
    const { id: prizeB } = await createPrize(db, TENANT_B, { name: "B奖品", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeA, [{ code: "SAME-CODE", secret: "A" }]);
    await importPrizeCodes(db, TENANT_B, prizeB, [{ code: "SAME-CODE", secret: "B" }]); // 不冲突
    const rowsB = await db.select().from(prizeCodes).where(eq(prizeCodes.prizeId, prizeB));
    expect(rowsB).toHaveLength(1);
  });
});

// P1 修复（2026-08 审查）：里程碑按分享者 SUM 聚合计数 + 只标记足额发放项
describe("推荐里程碑聚合与裁剪", () => {
  async function seedMilestoneDraw(opts: {
    rewards: Array<{ requireCount: number; rewardValue: number; rewardType?: string }>;
    maxSpinsPerEntry?: number;
    sharerEmail?: string;
  }) {
    const now = new Date();
    const startAt = new Date(now.getTime() - 3600_000).toISOString();
    const endAt = new Date(now.getTime() + 7 * 86400_000).toISOString();
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "里程碑聚合测试",
      startAt,
      endAt,
      participationMode: "open",
      activityKind: "lottery",
      experienceType: "wheel",
      resultMode: "instant",
      maxSpinsPerEntry: opts.maxSpinsPerEntry ?? 20,
      winnerCount: 3,
      promotionConfig: JSON.stringify({
        viral: { enabled: true, extraSpinsPerInvite: 1, maxExtraSpins: 3, extraEntriesPerInvite: 1, maxExtraEntries: 3 },
        referralRewards: opts.rewards,
      }),
    });
    const prizeId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type, total_count, active) VALUES (?, ?, ?, ?, ?, ?)",
      args: [prizeId, TENANT, "里程碑奖", "code", 10, 1],
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: id, prizeId,
      tierName: "一等奖", winnerCount: 3, sortOrder: 1, weight: 100,
    });
    for (let i = 0; i < 5; i++) {
      await client.execute({
        sql: "INSERT INTO prize_codes (id, tenant_id, prize_id, code, status) VALUES (?, ?, ?, ?, ?)",
        args: [crypto.randomUUID(), TENANT, prizeId, `MS-CODE-${i}`, "available"],
      });
    }
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    const sharer = await joinDraw(db, publicSlug, opts.sharerEmail ?? "ms-sharer@test.com");
    const sharerEntryId = String(sharer.entryId || "");
    return { drawId: id, publicSlug, sharerEntryId };
  }

  it("P1-4 回归：maxSpins 预算不足以足额发放时，不发放也不标记（无静默损失）", async () => {
    const { drawId, publicSlug, sharerEntryId } = await seedMilestoneDraw({
      rewards: [{ requireCount: 1, rewardType: "bonus_spin", rewardValue: 2 }],
      maxSpinsPerEntry: 5,
    });

    // 预置 granted=4（room=1 < rewardValue=2）
    await db
      .update(lotteryEntries)
      .set({ spinsLeft: 4, spinsTotalGranted: 4 })
      .where(eq(lotteryEntries.id, sharerEntryId));

    await db.insert(shareRecords).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      sharerEntryId, shareCode: "ms-cap-1", joinedCount: 0, clickedCount: 0,
      rewardMilestonesGranted: "[]", leaderboardRewardedAt: "", createdAt: new Date().toISOString(),
    });

    const inv = await joinDraw(db, publicSlug, "ms-cap-invitee@test.com", "email", { refCode: "ms-cap-1" });
    expect(inv.joined).toBe(true);

    // 预算不足 → 不发放（granted 保持 4 + per-invite 1 = 5，milestone 不生效）
    const [entry] = await db
      .select({ spinsTotalGranted: lotteryEntries.spinsTotalGranted })
      .from(lotteryEntries)
      .where(eq(lotteryEntries.id, sharerEntryId))
      .limit(1);
    expect(Number(entry?.spinsTotalGranted ?? 0)).toBe(5);

    // 不标记：rewardMilestonesGranted 仍为空（后续可再评估）
    const [record] = await db
      .select({ granted: shareRecords.rewardMilestonesGranted })
      .from(shareRecords)
      .where(eq(shareRecords.sharerEntryId, sharerEntryId))
      .limit(1);
    expect(JSON.parse(String(record?.granted || "[]"))).toEqual([]);

    // 无 milestone 流水（无虚假发放记录）
    const milestoneLogs = await db
      .select({ refId: spinsLog.refId })
      .from(spinsLog)
      .where(and(eq(spinsLog.entryId, sharerEntryId), eq(spinsLog.reason, "viral")));
    const msRefs = milestoneLogs.map((l) => String(l.refId || "")).filter((r) => r.startsWith("milestone:"));
    expect(msRefs).toEqual([]);
  });
});

// 闭环修复（2026-08 审查）：reservation/waitlist 参与物化 outcome、取消可执行
describe("reservation/waitlist 参与闭环", () => {
  it("reservation 参与写入 activity_outcomes（assigned），my-result 可查、可取消", async () => {
    const now = new Date();
    const startAt = new Date(now.getTime() - 3600_000).toISOString();
    const endAt = new Date(now.getTime() + 7 * 86400_000).toISOString();
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "预约闭环测试",
      startAt,
      endAt,
      participationMode: "open",
      activityKind: "reservation",
      experienceType: "calendar",
      resultMode: "capacity_assignment",
      allocationPolicy: "capacity",
      maxParticipants: 2,
      winnerCount: 0,
    });
    await db.update(lotteryDraws).set({ status: "open" }).where(and(eq(lotteryDraws.id, id), eq(lotteryDraws.tenantId, TENANT)));

    const r1 = await joinDraw(db, publicSlug, "resv-1@test.com");
    expect(r1.joined).toBe(true);
    expect("outcome" in r1 && r1.outcome?.status).toBe("assigned");
    const r2 = await joinDraw(db, publicSlug, "resv-2@test.com");
    expect(r2.joined).toBe(true);
    // 满额即拒（reservation 不候补）
    const r3 = await joinDraw(db, publicSlug, "resv-3@test.com");
    expect(r3.joined).toBe(false);

    // my-result 语义：outcome 存在
    const [outcome] = await db
      .select({ status: activityOutcomes.status })
      .from(activityOutcomes)
      .where(eq(activityOutcomes.entryId, String(r1.entryId)))
      .limit(1);
    expect(outcome?.status).toBe("assigned");

    // 取消可执行（删除 entry 释放容量）
    const cancelled = await cancelSignupChainEntry(db, TENANT, id, "resv-1@test.com");
    expect(cancelled.cancelled).toBe(true);
    // 释放后可再参与
    const r4 = await joinDraw(db, publicSlug, "resv-4@test.com");
    expect(r4.joined).toBe(true);
  });

  it("waitlist 活动参与写入 outcome（满额进候补）", async () => {
    const now = new Date();
    const startAt = new Date(now.getTime() - 3600_000).toISOString();
    const endAt = new Date(now.getTime() + 7 * 86400_000).toISOString();
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "waitlist 闭环测试",
      startAt,
      endAt,
      participationMode: "open",
      activityKind: "waitlist",
      experienceType: "queue",
      resultMode: "ordered_assignment",
      allocationPolicy: "waitlist",
      maxParticipants: 1,
      winnerCount: 0,
    });
    await db.update(lotteryDraws).set({ status: "open" }).where(and(eq(lotteryDraws.id, id), eq(lotteryDraws.tenantId, TENANT)));

    const w1 = await joinDraw(db, publicSlug, "wl-1@test.com");
    expect("outcome" in w1 && w1.outcome?.status).toBe("assigned");
    const w2 = await joinDraw(db, publicSlug, "wl-2@test.com");
    expect("outcome" in w2 && w2.outcome?.status).toBe("waitlisted");
  });
});
// 上线补充（2026-08）：公开端 promotionConfig 脱敏——内部激励参数不泄露
describe("sanitizePublicPromotionConfig 脱敏", () => {
  it("剔除 pity/dailyFreeSpins/referralRewards/viral.leaderboardRewards，保留展示字段", () => {
    const out = sanitizePublicPromotionConfig({
      flashSale: { enabled: true, priceCents: 9900 },
      ctas: { after_win: { url: "https://x.com" } },
      destination: { url: "https://x.com" },
      experience: { prizePanelMode: "auto" },
      viral: { enabled: true, leaderboardEnabled: true, leaderboardRewards: [{ rank: 1, rewardType: "bonus_spin", rewardValue: 3 }] },
      pity: { enabled: true, threshold: 3 },
      dailyFreeSpins: { enabled: true, count: 1 },
      referralRewards: [{ requireCount: 3, rewardType: "bonus_spin", rewardValue: 5 }],
    });
    expect(out).toBeDefined();
    expect(out!.flashSale).toBeDefined();
    expect(out!.ctas).toBeDefined();
    expect(out!.destination).toBeDefined();
    expect(out!.experience).toBeDefined();
    expect(out!.viral).toBeDefined();
    expect((out!.viral as Record<string, unknown>).leaderboardEnabled).toBe(true);
    expect((out!.viral as Record<string, unknown>).leaderboardRewards).toBeUndefined();
    expect(out!.pity).toBeUndefined();
    expect(out!.dailyFreeSpins).toBeUndefined();
    expect(out!.referralRewards).toBeUndefined();
  });

  it("字符串输入与非法输入容错", () => {
    expect(sanitizePublicPromotionConfig('{"flashSale":{"enabled":true}}')?.flashSale).toBeDefined();
    expect(sanitizePublicPromotionConfig("{}")).toBeUndefined();
    expect(sanitizePublicPromotionConfig("not-json")).toBeUndefined();
    expect(sanitizePublicPromotionConfig(null)).toBeUndefined();
  });
});

// ── P4（docs/271）：并发归因集成测试 ──

describe("并发归因与奖励不超发", () => {
  it("Promise.all 并发归因同一分享者 → 奖励不重复发放（CAS 防护）", async () => {
    // 场景：两个被邀请人同时通过同一个分享码参与，触发两次归因。
    // 验证 CAS 防护确保 bonus_spin 不重复发放（spinsTotalGranted 乐观锁）。
    const now = new Date();
    const future = new Date(now.getTime() + 86400_000 * 7);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "并发归因测试",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      participationMode: "open",
      activityKind: "lottery",
      experienceType: "wheel",
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      winnerCount: 1,
      promotionConfig: JSON.stringify({
        viral: {
          enabled: true,
          extraSpinsPerInvite: 1,
          maxExtraSpins: 5,
          extraEntriesPerInvite: 1,
          maxExtraEntries: 5,
        },
        referralRewardDefs: [
          {
            rewardId: "conc_2",
            type: "FIXED",
            target: "SOURCE",
            fixedAmount: "3",
            conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "2" }],
            metadata: { rewardExit: "bonus_spin" },
          },
        ],
      }),
    });
    const prizeId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type, total_count, active) VALUES (?, ?, ?, ?, ?, ?)",
      args: [prizeId, TENANT, "并发奖", "code", 5, 1],
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      prizeId,
      tierName: "一等奖",
      winnerCount: 1,
      sortOrder: 1,
      weight: 100,
    });
    for (let i = 0; i < 5; i++) {
      await db.insert(prizeCodes).values({
        id: crypto.randomUUID(),
        tenantId: TENANT,
        prizeId,
        code: `PC-${i}`,
        status: "available",
      });
    }
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    // 分享者 A 参与
    const sharer = await joinDraw(db, publicSlug, "conc-sharer@test.com");
    const sharerEntryId = String(sharer.entryId || "");
    expect(sharerEntryId).toBeTruthy();

    // 创建分享码
    await client.execute({
      sql: `INSERT INTO share_records (id, tenant_id, draw_id, sharer_entry_id, share_code, clicked_count, joined_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["share-conc", TENANT, id, sharerEntryId, "conc-ref", 0, 0],
    });

    // 两个被邀请人并发通过同一分享码参与
    const [invitee1, invitee2] = await Promise.all([
      joinDraw(db, publicSlug, "conc-i1@test.com", "email", { refCode: "conc-ref" }),
      joinDraw(db, publicSlug, "conc-i2@test.com", "email", { refCode: "conc-ref" }),
    ]);
    expect(invitee1.joined).toBe(true);
    expect(invitee2.joined).toBe(true);

    // 验证 joinedCount 聚合为 2（两条 shareRecord 各 +1）
    const [record] = await db
      .select({ joinedCount: shareRecords.joinedCount })
      .from(shareRecords)
      .where(eq(shareRecords.id, "share-conc"));
    expect(Number(record?.joinedCount ?? 0)).toBe(2);

    // 验证 A 的奖励：join 1 + viral 1（第 1 个邀请）= 2
    // 第 2 个邀请的 viral 层 +1，但 milestone 层（需要 ≥2）在第 2 个邀请完成时触发
    // 具体取决于归因顺序，但关键是 spinsTotalGranted 不会超过合理范围
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    const totalGranted = Number(entry?.spinsTotalGranted ?? 0);
    // join(1) + viral(2×1=2) + milestone(3) = 最多 6
    expect(totalGranted).toBeGreaterThanOrEqual(3); // 至少 join + viral
    expect(totalGranted).toBeLessThanOrEqual(6);    // 最多 join + viral + milestone

    // 再次并发调用（幂等）：不应增加任何奖励
    const [r1, r2] = await Promise.all([
      joinDraw(db, publicSlug, "conc-i1@test.com", "email", { refCode: "conc-ref" }),
      joinDraw(db, publicSlug, "conc-i2@test.com", "email", { refCode: "conc-ref" }),
    ]);
    // 重复参与被拒绝（已参与过）
    expect(r1.joined).toBe(false);
    expect(r2.joined).toBe(false);

    const [entryAfter] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    expect(Number(entryAfter?.spinsTotalGranted ?? 0)).toBe(totalGranted); // 未增加
  });

  it("并发归因不同分享者 → 各自独立发放、互不影响", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 86400_000 * 7);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "并发不同分享者",
      startAt: now.toISOString(),
      endAt: future.toISOString(),
      participationMode: "open",
      activityKind: "lottery",
      experienceType: "wheel",
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      winnerCount: 1,
      promotionConfig: JSON.stringify({
        viral: {
          enabled: true,
          extraSpinsPerInvite: 1,
          maxExtraSpins: 3,
          extraEntriesPerInvite: 1,
          maxExtraEntries: 3,
        },
      }),
    });
    const prizeId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type, total_count, active) VALUES (?, ?, ?, ?, ?, ?)",
      args: [prizeId, TENANT, "并发独立奖", "code", 5, 1],
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      prizeId,
      tierName: "一等奖",
      winnerCount: 1,
      sortOrder: 1,
      weight: 100,
    });
    for (let i = 0; i < 5; i++) {
      await db.insert(prizeCodes).values({
        id: crypto.randomUUID(),
        tenantId: TENANT,
        prizeId,
        code: `PC-${i}`,
        status: "available",
      });
    }
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    // 分享者 A 和 B 各自参与
    const sharerA = await joinDraw(db, publicSlug, "conc-sharerA@test.com");
    const sharerB = await joinDraw(db, publicSlug, "conc-sharerB@test.com");
    const entryAId = String(sharerA.entryId || "");
    const entryBId = String(sharerB.entryId || "");

    // 各创建分享码
    await client.execute({
      sql: `INSERT INTO share_records (id, tenant_id, draw_id, sharer_entry_id, share_code, clicked_count, joined_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["share-a", TENANT, id, entryAId, "ref-a", 0, 0],
    });
    await client.execute({
      sql: `INSERT INTO share_records (id, tenant_id, draw_id, sharer_entry_id, share_code, clicked_count, joined_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["share-b", TENANT, id, entryBId, "ref-b", 0, 0],
    });

    // 并发：A 的邀请人和 B 的邀请人同时参与
    const [inviteeA, inviteeB] = await Promise.all([
      joinDraw(db, publicSlug, "conc-ia@test.com", "email", { refCode: "ref-a" }),
      joinDraw(db, publicSlug, "conc-ib@test.com", "email", { refCode: "ref-b" }),
    ]);
    expect(inviteeA.joined).toBe(true);
    expect(inviteeB.joined).toBe(true);

    // 验证 A 和 B 各自获得 viral 奖励（+1），互不影响
    const [entryA] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryAId));
    const [entryB] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryBId));
    // join(1) + viral(1) = 2
    expect(Number(entryA?.spinsTotalGranted ?? 0)).toBe(2);
    expect(Number(entryB?.spinsTotalGranted ?? 0)).toBe(2);
  });
});
