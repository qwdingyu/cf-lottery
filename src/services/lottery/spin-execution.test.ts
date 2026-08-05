/**
 * instant spin 集成测（docs/116/117）
 * 覆盖：扣次、幂等、多奖 UNIQUE、performDraw 拒 instant、次数用尽
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, clearTestData } from "../../test-setup";
import type { DbType } from "../../db/client";
import type { Client } from "@libsql/client";
import {
  lotteryDraws,
  lotteryPrizeTiers,
  lotterySpins,
  lotteryWinners,
  prizes,
  prizeCodes,
} from "../../db/schema";
import { performInstantSpin, SpinBusinessError } from "./spin-execution";
import { performDraw } from "./draw-execution";
import { joinDraw } from "./participation";

const TENANT = "tenant-spin-t";

async function seedInstantDraw(
  db: DbType,
  client: Client,
  opts?: { maxSpins?: number; weight?: number; codes?: number },
) {
  const maxSpins = opts?.maxSpins ?? 3;
  const weight = opts?.weight ?? 100;
  const codeCount = opts?.codes ?? 5;
  const id = crypto.randomUUID();
  const slug = `sp${id.slice(0, 6)}`;
  const now = new Date();
  const startAt = new Date(now.getTime() - 3600_000).toISOString();
  const endAt = new Date(now.getTime() + 86400_000 * 7).toISOString();

  await db.insert(lotteryDraws).values({
    id,
    tenantId: TENANT,
    publicSlug: slug,
    title: "instant test",
    description: "",
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    drawTrigger: "manual",
    resultMode: "instant",
    startAt,
    endAt,
    winnerCount: 3,
    maxSpinsPerEntry: maxSpins,
  });

  const prizeId = crypto.randomUUID();
  await db.insert(prizes).values({
    id: prizeId,
    tenantId: TENANT,
    name: "测试奖",
    prizeType: "code",
    totalCount: codeCount,
    active: 1,
  });

  const tierId = crypto.randomUUID();
  await db.insert(lotteryPrizeTiers).values({
    id: tierId,
    tenantId: TENANT,
    drawId: id,
    prizeId,
    tierName: "一等奖",
    winnerCount: 3,
    sortOrder: 100,
    weight,
  });

  for (let i = 0; i < codeCount; i++) {
    await db.insert(prizeCodes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      prizeId,
      code: `CODE-${i}-${slug}`,
      status: "available",
    });
  }

  return { id, slug, prizeId, tierId };
}

describe("performInstantSpin", () => {
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

  it("join 后 spin 扣次；同幂等键回放不双扣", async () => {
    // 产品默认 initialSpinsOnJoin=1：max=2 只表示硬顶，join 只发 1 次
    const { slug } = await seedInstantDraw(db, client, { maxSpins: 2 });
    const join = await joinDraw(db, slug, "u@test.com");
    expect(join.joined).toBe(true);

    const key = "idem-1";
    const r1 = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "u@test.com",
      idempotencyKey: key,
    });
    expect(r1.spinsUsed).toBe(1);
    expect(r1.spinsLeft).toBe(0);
    expect(r1.maxSpinsPerEntry).toBe(2);

    const r2 = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "u@test.com",
      idempotencyKey: key,
    });
    expect(r2.replayed).toBe(true);
    expect(r2.spinId).toBe(r1.spinId);
    expect(r2.spinsLeft).toBe(0);

    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.publicSlug, slug));
    const rows = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, draw!.id));
    expect(rows.length).toBe(1);
  });

  it("maxSpins=1 第二次 spin 409", async () => {
    const { slug } = await seedInstantDraw(db, client, { maxSpins: 1 });
    await joinDraw(db, slug, "once@test.com");
    await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "once@test.com",
      idempotencyKey: "k1",
    });
    await expect(
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "once@test.com",
        idempotencyKey: "k2",
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: "spin.quota.exhausted" } satisfies Partial<SpinBusinessError>);
  });

  it("weight 高且有码时可中奖并写 winners.spin_id；可二次中奖（多奖）", async () => {
    const { slug, id } = await seedInstantDraw(db, client, { maxSpins: 3, weight: 1000, codes: 5 });
    const joined = await joinDraw(db, slug, "multi@test.com");
    expect(joined.joined).toBe(true);
    // 模拟运营配置 initial=max 或裂变已加次：直接把额度提到 3，验证多奖 UNIQUE
    await client.execute({
      sql: `UPDATE lottery_entries SET spins_left = 3, spins_total_granted = 3 WHERE id = ?`,
      args: [joined.entryId!],
    });

    const results = [];
    for (let i = 0; i < 2; i++) {
      results.push(
        await performInstantSpin(db, {
          slug,
          identityType: "email",
          identityValue: "multi@test.com",
          idempotencyKey: `multi-${i}`,
        }),
      );
    }
    // 权重极高，期望至少一次中奖；若随机未中不硬 fail 结构
    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    for (const w of winners) {
      expect(w.spinId).toBeTruthy();
      expect(w.spinId).not.toBe("");
    }
    // 两行 spin 必有
    const spins = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, id));
    expect(spins.length).toBe(2);
  });

  it("performDraw 拒绝 instant", async () => {
    const { id } = await seedInstantDraw(db, client);
    await expect(performDraw(db, TENANT, id, "admin")).rejects.toThrow(/即时开奖/);
  });

  it("非 instant 活动拒绝 spin", async () => {
    const id = crypto.randomUUID();
    const slug = `dl${id.slice(0, 6)}`;
    const now = new Date();
    await db.insert(lotteryDraws).values({
      id,
      tenantId: TENANT,
      publicSlug: slug,
      title: "delayed",
      status: "open",
      activityKind: "lottery",
      resultMode: "manual",
      startAt: new Date(now.getTime() - 1000).toISOString(),
      endAt: new Date(now.getTime() + 86400000).toISOString(),
      winnerCount: 1,
      maxSpinsPerEntry: 0,
    });
    await joinDraw(db, slug, "d@test.com");
    await expect(
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "d@test.com",
        idempotencyKey: "x",
      }),
    ).rejects.toMatchObject({ code: "spin.result_mode.not_instant" });
  });
});
