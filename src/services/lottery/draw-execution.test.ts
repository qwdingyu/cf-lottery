/**
 * grantLoserRewards 安慰券发放测（docs/255 P2-3 复审 A2）
 *
 * 核心不变式：paymentRequired 的判定必须与 performDraw 候选池（draw-execution.ts:161-162）
 * 完全同源——都走 parseFlashSaleConfig。手写 JSON.parse 会产生两处漂移：
 * 1. flashSale.enabled 未开启时仍按 PAID 过滤 → 普通抽奖（entry.paymentStatus 为 NULL）
 *    一张安慰券都发不出去（静默不发奖）
 * 2. 只认 camelCase flashSale，读不到 snake_case flash_sale → 直付秒杀下
 *    未付款 entry 也能拿安慰券（资金口径不一致）
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { getTestDb, clearTestData } from "../../test-setup";
import type { DbType } from "../../db/client";
import type { Client } from "@libsql/client";
import { lotteryDraws, lotteryEntries, couponCodes } from "../../db/schema";
import { grantLoserRewards } from "./draw-execution";
import { PAYMENT_ENTRY_STATUS } from "../payment/payment-status";

const TENANT = "tenant-loser-reward";

/** 播种一个已开奖活动 + 两个未中奖 entry（一个 paid、一个未付款） */
async function seedDrawWithLosers(db: DbType, promotionConfig: string) {
  const drawId = crypto.randomUUID();
  const now = new Date();
  await db.insert(lotteryDraws).values({
    id: drawId,
    tenantId: TENANT,
    publicSlug: `lr${drawId.slice(0, 6)}`,
    title: "安慰券测试",
    status: "drawn",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    resultMode: "batch",
    startAt: new Date(now.getTime() - 3600_000).toISOString(),
    endAt: new Date(now.getTime() - 60_000).toISOString(),
    winnerCount: 1,
    activityConfig: JSON.stringify({ loserReward: { enabled: true, couponLabel: "loser" } }),
    promotionConfig,
  });

  const paidEntryId = crypto.randomUUID();
  const unpaidEntryId = crypto.randomUUID();
  await db.insert(lotteryEntries).values([
    {
      id: paidEntryId,
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: "paid@test.com",
      paymentStatus: PAYMENT_ENTRY_STATUS.PAID,
      joinedAt: now.toISOString(),
    },
    {
      id: unpaidEntryId,
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: "unpaid@test.com",
      paymentStatus: PAYMENT_ENTRY_STATUS.PENDING,
      joinedAt: now.toISOString(),
    },
  ]);

  // 码池：2 张 available，足够两人各一张
  await db.insert(couponCodes).values([
    { id: crypto.randomUUID(), tenantId: TENANT, code: `LOSER-A-${drawId.slice(0, 4)}`, label: "loser", status: "available" },
    { id: crypto.randomUUID(), tenantId: TENANT, code: `LOSER-B-${drawId.slice(0, 4)}`, label: "loser", status: "available" },
  ]);

  return { drawId, paidEntryId, unpaidEntryId };
}

/** 查出已发放（issued）的收券人邮箱集合 */
async function issuedRecipients(db: DbType, drawId: string): Promise<string[]> {
  const rows = await db
    .select({ recipientEmail: couponCodes.recipientEmail })
    .from(couponCodes)
    .where(and(eq(couponCodes.tenantId, TENANT), eq(couponCodes.drawId, drawId), eq(couponCodes.status, "issued")));
  return rows.map((r) => r.recipientEmail || "").sort();
}

describe("grantLoserRewards paymentRequired 判定（parseFlashSaleConfig 单一真相）", () => {
  let db: DbType;
  let client: Client;

  beforeEach(async () => {
    const t = await getTestDb();
    db = t.db;
    client = t.client;
    await clearTestData(client);
    await client.execute({
      sql: `INSERT OR IGNORE INTO tenants (id, name, plan, status) VALUES (?, 'T', 'free', 'active')`,
      args: [TENANT],
    });
  });

  it("秒杀未启用（enabled 缺失）时忽略 paymentRequired：未付款 entry 也应拿到安慰券", async () => {
    // 运营只在 promotionConfig 里留了 flashSale.paymentRequired 却没开 enabled
    // （或秒杀被关停）。此时活动没有付款环节，entry.paymentStatus 与 PAID 无关，
    // 若仍按 PAID 过滤则一张券都发不出去。
    const { drawId } = await seedDrawWithLosers(
      db,
      JSON.stringify({ flashSale: { paymentRequired: true } }),
    );
    const result = await grantLoserRewards(db, TENANT, drawId);
    expect(result.totalLosers).toBe(2);
    expect(result.granted).toBe(2);
    expect(await issuedRecipients(db, drawId)).toEqual(["paid@test.com", "unpaid@test.com"]);
  });

  it("直付秒杀（enabled + paymentRequired）：只有 PAID entry 拿安慰券", async () => {
    const { drawId } = await seedDrawWithLosers(
      db,
      JSON.stringify({ flashSale: { enabled: true, paymentRequired: true } }),
    );
    const result = await grantLoserRewards(db, TENANT, drawId);
    expect(result.totalLosers).toBe(1);
    expect(result.granted).toBe(1);
    expect(await issuedRecipients(db, drawId)).toEqual(["paid@test.com"]);
  });

  it("snake_case flash_sale / payment_required 同样生效（与 parseFlashSaleConfig 一致）", async () => {
    const { drawId } = await seedDrawWithLosers(
      db,
      JSON.stringify({ flash_sale: { enabled: true, payment_required: "true" } }),
    );
    const result = await grantLoserRewards(db, TENANT, drawId);
    expect(result.totalLosers).toBe(1);
    expect(await issuedRecipients(db, drawId)).toEqual(["paid@test.com"]);
  });

  it("promotionConfig 为空：全部未中奖者发券（无付款门槛）", async () => {
    const { drawId } = await seedDrawWithLosers(db, "");
    const result = await grantLoserRewards(db, TENANT, drawId);
    expect(result.granted).toBe(2);
  });
});
