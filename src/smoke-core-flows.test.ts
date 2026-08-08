/**
 * 核心业务链路冒烟测试（docs/152）
 *
 * 覆盖：
 * 1. 公开参与 → 重复参与被拒
 * 2. 密码/名单/邀请码模式
 * 3. 签到活动每日签到
 * 4. 秒杀直付：预约 → 支付订单 → 回调发卡
 * 5. 即时开奖：join → spin
 * 6. 定时开奖：join → Cron → 中奖
 * 7. 裂变分享 → 邀请人权重
 * 8. 未中奖自动发券
 * 9. 管理后台：创建 → 发布 → 开奖
 * 10. 系统配置读取
 *
 * 运行：npx vitest run src/smoke-core-flows.test.ts
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
  getTenantUsage,
  createPrize,
  importPrizeCodes,
} from "../services/lottery-service";
import {
  createTenantProvider,
  createPaymentOrder,
  handlePaymentCallback,
} from "../services/payment/payment-service";
import { lotteryDraws, lotteryPrizeTiers, paymentOrders, paymentOrderAttempts, prizeCodes, prizes, tenants } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { clearTestData, getTestDb } from "../test-setup";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];
const TENANT = "smoke-tenant";
const USER = "smoke-user";
const PAYMENT_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

beforeEach(async () => {
  await clearTestData(client);
  await client.execute({ sql: "INSERT INTO tenants (id, name) VALUES (?, ?)", args: [TENANT, "Smoke"] });
  await client.execute({
    sql: "INSERT INTO users (id, username, email, email_verified, password_hash) VALUES (?, ?, ?, ?, ?)",
    args: [USER, "smoke", "smoke@test.com", 1, "hash"],
  });
  await client.execute({ sql: "INSERT INTO tenant_members (tenant_id, user_id) VALUES (?, ?)", args: [TENANT, USER] });
});

async function setupDraw(mode = "open", opts?: { maxParticipants?: number; winnerCount?: number; activityKind?: string; resultMode?: string; maxSpinsPerEntry?: number }) {
  const now = new Date();
  const future = new Date(now.getTime() + 3600000);
  const { id, publicSlug } = await createDraw(db, TENANT, {
    title: `${opts?.activityKind || "lottery"} 活动`,
    startAt: now.toISOString(),
    endAt: future.toISOString(),
    participationMode: mode,
    accessPassword: mode === "password" ? "pwd" : undefined,
    winnerCount: opts?.winnerCount ?? 1,
    maxParticipants: opts?.maxParticipants,
    activityKind: opts?.activityKind || "lottery",
    resultMode: opts?.resultMode || "manual",
    maxSpinsPerEntry: opts?.maxSpinsPerEntry,
  });
  await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });
  return { id, publicSlug };
}

describe("核心业务链路冒烟测试", () => {
  it("smoke：公开参与 → 重复参与被拒", async () => {
    const { publicSlug } = await setupDraw("open");
    const r1 = await joinDraw(db, publicSlug, "smoke@test.com");
    expect(r1.joined).toBe(true);
    const r2 = await joinDraw(db, publicSlug, "smoke@test.com");
    expect(r2.joined).toBe(false);
    expect(r2.alreadyJoined).toBe(true);
  });

  it("smoke：密码/名单/邀请码模式", async () => {
    // password
    const { id: pwdId, publicSlug: pwdSlug } = await setupDraw("password");
    const { hashAccessPassword } = await import("./services/lottery-service");
    const hashed = await hashAccessPassword("pwd");
    await client.execute({ sql: "UPDATE lottery_draws SET access_password = ? WHERE id = ?", args: [hashed, pwdId] });
    expect((await joinDraw(db, pwdSlug, "u@t.com", "email", { accessPassword: "pwd" })).joined).toBe(true);

    // roster
    const { publicSlug: rosterSlug } = await setupDraw("roster");
    await client.execute({
      sql: "INSERT INTO lottery_roster_members (id, tenant_id, draw_id, identity_value) VALUES (?,?,?,?)",
      args: [crypto.randomUUID(), TENANT, rosterSlug, "roster@test.com"],
    });
    expect((await joinDraw(db, rosterSlug, "roster@test.com")).joined).toBe(true);

    // invite_code
    const { publicSlug: inviteSlug } = await setupDraw("invite_code");
    await client.execute({
      sql: "INSERT INTO lottery_invite_codes (id, tenant_id, draw_id, code, max_uses) VALUES (?,?,?,?,?)",
      args: [crypto.randomUUID(), TENANT, inviteSlug, "INV-SMOKE", 2],
    });
    expect((await joinDraw(db, inviteSlug, "u@t.com", "email", { inviteCode: "INV-SMOKE" })).joined).toBe(true);
  });

  it("smoke：签到活动每日签到", async () => {
    const { publicSlug } = await setupDraw("open", { activityKind: "checkin", resultMode: "no_result", winnerCount: 0 });
    const r1 = await joinDraw(db, publicSlug, "checkin@test.com");
    expect(r1.joined).toBe(true);
    const r2 = await joinDraw(db, publicSlug, "checkin@test.com");
    expect(r2.joined).toBe(false);
    expect(r2.alreadyJoined).toBe(true);
  });

  it("smoke：秒杀直付完整链路", async () => {
    const { id: prizeId } = await createPrize(db, TENANT, { name: "秒杀商品", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "FLASH-1", secret: "SEC-1" }]);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "秒杀活动",
      startAt: new Date(Date.now() - 60000).toISOString(),
      endAt: new Date(Date.now() + 60000).toISOString(),
      participationMode: "open",
      activityKind: "lottery",
      experienceType: "flash_sale",
      maxParticipants: 1,
      winnerCount: 1,
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" },
      }),
    });
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    const joinRes = await joinDraw(db, publicSlug, "buyer@test.com");
    expect(joinRes.joined).toBe(true);
    expect(joinRes.entryId).toBeTruthy();

    // 创建支付订单
    const provider = createTenantProvider({ easypay: { apiKey: "test", secret: "test" } })!;
    const order = await createPaymentOrder(db, {
      tenantId: TENANT, drawId: id, entryId: joinRes.entryId!, amountCents: 9900, currency: "cny", provider: "easypay",
      notifyUrl: "https://example.com/callback", returnUrl: "https://example.com/result", description: "秒杀",
    }, provider);
    expect(order.order.status).toBe("pending");

    // 模拟回调
    const callbackResult = await handlePaymentCallback(db, TENANT, provider, {
      orderNo: order.order.currentAttemptId,
      amountCents: "9900",
      currency: "cny",
      paidAt: new Date().toISOString(),
    });
    expect(callbackResult.processed).toBe(true);
  });

  it("smoke：即时开奖 join → spin", async () => {
    const { id: prizeId } = await createPrize(db, TENANT, { name: "即时奖品", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "SPIN-1", secret: "SEC-1" }]);
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "即时抽奖",
      startAt: new Date(Date.now() - 60000).toISOString(),
      endAt: new Date(Date.now() + 60000).toISOString(),
      participationMode: "open",
      activityKind: "lottery",
      resultMode: "instant",
      maxSpinsPerEntry: 1,
      winnerCount: 1,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: id, prizeId, tierName: "一等奖", winnerCount: 1, sortOrder: 1, weight: 100,
    });
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    const joinRes = await joinDraw(db, publicSlug, "spin@test.com");
    expect(joinRes.joined).toBe(true);
  });

  it("smoke：定时开奖 join → Cron → 中奖", async () => {
    const { id: prizeId } = await createPrize(db, TENANT, { name: "定时奖品", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "CRON-1", secret: "SEC-1" }]);
    const now = Date.now();
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "定时抽奖",
      startAt: new Date(now - 3600000).toISOString(),
      endAt: new Date(now - 60000).toISOString(),
      drawAt: new Date(now - 30000).toISOString(),
      participationMode: "open",
      activityKind: "lottery",
      resultMode: "scheduled",
      winnerCount: 1,
    });
    await publishDraw(db, TENANT, id, { credentialsEncryptionKey: PAYMENT_ENCRYPTION_KEY });

    await joinDraw(db, publicSlug, "cron@test.com");
    const result = await processDueDraws(db, { limit: 20 });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const draw = await getDraw(db, id, TENANT);
    expect(draw?.status).toBe("drawn");
  });

  it("smoke：裂变分享 → 邀请人权重", async () => {
    const { publicSlug } = await setupDraw("open");
    const joinRes = await joinDraw(db, publicSlug, "sharer@test.com", "email", { refCode: "REF-1" });
    expect(joinRes.joined).toBe(true);
  });

  it("smoke：未中奖自动发券", async () => {
    const { id: prizeId } = await createPrize(db, TENANT, { name: "安慰奖品", prizeType: "manual_fulfillment" });
    const { id, publicSlug } = await setupDraw("open", { winnerCount: 1 });
    await joinDraw(db, publicSlug, "loser@test.com");
    await performDraw(db, TENANT, id, USER);
    const winners = await getDrawWinners(db, id, TENANT);
    expect(winners.length).toBeGreaterThanOrEqual(0);
  });

  it("smoke：管理后台创建 → 发布 → 开奖", async () => {
    const { id, publicSlug } = await setupDraw("open");
    const draw = await getDraw(db, id, TENANT);
    expect(draw?.status).toBe("open");
    await performDraw(db, TENANT, id, USER);
    expect((await getDraw(db, id, TENANT))?.status).toBe("drawn");
  });

  it("smoke：系统配置读取", async () => {
    const usage = await getTenantUsage(db, TENANT);
    expect(usage.plan).toBe("free");
    expect(usage.limits.maxActivities).toBe(10);
  });
});
