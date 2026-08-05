/**
 * instant spin 集成测（docs/116/117/119）
 * 覆盖：扣次、幂等、多奖 UNIQUE、performDraw 拒 instant、次数用尽、
 * 中奖邮件按 spin 隔离、码耗尽仍扣次、档位封顶、通知开关。
 *
 * 中奖路径：单档 weight>0 + 有 available 码 → 确定性中奖（无随机跳过）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  systemConfig,
} from "../../db/schema";
import { performInstantSpin, SpinBusinessError } from "./spin-execution";
import { performDraw, notifyInstantSpinWinner, sendWinnerNotifications } from "./draw-execution";
import { joinDraw } from "./participation";

const TENANT = "tenant-spin-t";

async function seedInstantDraw(
  db: DbType,
  client: Client,
  opts?: {
    maxSpins?: number;
    weight?: number;
    codes?: number;
    winnerCount?: number;
    prizeName?: string;
  },
) {
  const maxSpins = opts?.maxSpins ?? 3;
  const weight = opts?.weight ?? 100;
  const codeCount = opts?.codes ?? 5;
  const winnerCount = opts?.winnerCount ?? 3;
  const prizeName = opts?.prizeName ?? "测试奖";
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
    winnerCount,
    maxSpinsPerEntry: maxSpins,
  });

  const prizeId = crypto.randomUUID();
  await db.insert(prizes).values({
    id: prizeId,
    tenantId: TENANT,
    name: prizeName,
    prizeType: "code",
    totalCount: Math.max(codeCount, 1),
    active: 1,
  });

  const tierId = crypto.randomUUID();
  await db.insert(lotteryPrizeTiers).values({
    id: tierId,
    tenantId: TENANT,
    drawId: id,
    prizeId,
    tierName: "一等奖",
    winnerCount,
    sortOrder: 100,
    weight,
  });

  for (let i = 0; i < codeCount; i++) {
    await db.insert(prizeCodes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      prizeId,
      code: `CODE-${i}-${slug}`,
      secret: `SEC-${i}`,
      status: "available",
    });
  }

  return { id, slug, prizeId, tierId };
}

/** 把 entry 额度提到 n，便于多奖 / 多 spin 场景 */
async function grantSpins(client: Client, entryId: string, n: number) {
  await client.execute({
    sql: `UPDATE lottery_entries SET spins_left = ?, spins_total_granted = ? WHERE id = ?`,
    args: [n, n, entryId],
  });
}

function stubResendCapture() {
  const captured: Array<{ to: string; html: string; subject?: string }> = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string; html: string; subject?: string };
      captured.push(body);
      return new Response(JSON.stringify({ id: `mock-${captured.length}` }), { status: 200 });
    }
    return new Response("", { status: 404 });
  });
  return captured;
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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("单档有码时确定性中奖并写 winners.spin_id；可二次中奖（多奖 UNIQUE）", async () => {
    const { slug, id } = await seedInstantDraw(db, client, { maxSpins: 3, weight: 100, codes: 5 });
    const joined = await joinDraw(db, slug, "multi@test.com");
    expect(joined.joined).toBe(true);
    await grantSpins(client, joined.entryId!, 3);

    const r1 = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "multi@test.com",
      idempotencyKey: "multi-0",
    });
    const r2 = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "multi@test.com",
      idempotencyKey: "multi-1",
    });
    // 单正权重档 + available 码 → 必中（不允许随机跳过）
    expect(r1.won).toBe(true);
    expect(r2.won).toBe(true);
    expect(r1.spinId).not.toBe(r2.spinId);
    expect(r1.prizeCode).toBeTruthy();
    expect(r2.prizeCode).toBeTruthy();
    expect(r1.prizeCode).not.toBe(r2.prizeCode);

    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    expect(winners.length).toBe(2);
    const spinIds = winners.map((w) => w.spinId);
    expect(new Set(spinIds).size).toBe(2);
    expect(spinIds).toContain(r1.spinId);
    expect(spinIds).toContain(r2.spinId);

    const spins = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, id));
    expect(spins.length).toBe(2);
    expect(spins.every((s) => s.won === 1)).toBe(true);
  });

  it("码池耗尽：仍扣次、记 spin、won=false、不写 winner", async () => {
    const { slug, id } = await seedInstantDraw(db, client, {
      maxSpins: 2,
      weight: 100,
      codes: 0,
      winnerCount: 5,
    });
    const joined = await joinDraw(db, slug, "nocode@test.com");
    await grantSpins(client, joined.entryId!, 2);

    const r = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "nocode@test.com",
      idempotencyKey: "nocode-1",
    });
    expect(r.won).toBe(false);
    expect(r.spinsUsed).toBe(1);
    expect(r.spinsLeft).toBe(1);
    expect(r.prizeCode).toBeNull();

    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    expect(winners.length).toBe(0);
    const spins = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, id));
    expect(spins.length).toBe(1);
    expect(spins[0]!.won).toBe(0);
  });

  it("档位 winnerCount 封顶后不再中奖（仍扣次）", async () => {
    const { slug, id, tierId } = await seedInstantDraw(db, client, {
      maxSpins: 3,
      weight: 100,
      codes: 5,
      winnerCount: 1,
    });
    const a = await joinDraw(db, slug, "cap-a@test.com");
    const b = await joinDraw(db, slug, "cap-b@test.com");
    await grantSpins(client, a.entryId!, 2);
    await grantSpins(client, b.entryId!, 2);

    const rA = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "cap-a@test.com",
      idempotencyKey: "cap-a",
    });
    expect(rA.won).toBe(true);

    const rB = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "cap-b@test.com",
      idempotencyKey: "cap-b",
    });
    // 档位 cap=1 已满 → B 未中，但次数已扣
    expect(rB.won).toBe(false);
    expect(rB.spinsLeft).toBe(1);

    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    expect(winners.length).toBe(1);
    expect(winners[0]!.tierId).toBe(tierId);
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

  it("instant 中奖通知：按 spin 只发本奖；多奖各自一封且 productName 为奖品名", async () => {
    const { slug, id } = await seedInstantDraw(db, client, {
      maxSpins: 3,
      weight: 100,
      codes: 5,
      prizeName: "黄金卡密礼包",
    });
    const joined = await joinDraw(db, slug, "mail@test.com");
    await grantSpins(client, joined.entryId!, 3);

    const r1 = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "mail@test.com",
      idempotencyKey: "mail-1",
    });
    expect(r1.won).toBe(true);

    const captured = stubResendCapture();

    await notifyInstantSpinWinner(db, TENANT, id, r1.spinId, {
      resendApiKey: "test-key",
      emailFrom: "noreply@test.com",
    });

    expect(captured.length).toBe(1);
    expect(captured[0]!.to).toBe("mail@test.com");
    expect(captured[0]!.html).toContain("黄金卡密礼包");
    // 不应把活动标题当成奖品名主展示（仍可出现在 drawName）
    expect(captured[0]!.html).toMatch(/奖品名称：[\s\S]*黄金卡密礼包/);

    const [w1] = await db.select().from(lotteryWinners).where(eq(lotteryWinners.spinId, r1.spinId));
    expect(w1?.notificationStatus).toBe("sent");
    expect(w1?.prizeCodeId).toBeTruthy();
    // 卡密应进邮件
    expect(captured[0]!.html).toMatch(/CODE-|SEC-/);

    // 同一 spin 再 notify：已 sent 不重发
    await notifyInstantSpinWinner(db, TENANT, id, r1.spinId, {
      resendApiKey: "test-key",
      emailFrom: "noreply@test.com",
    });
    expect(captured.length).toBe(1);

    // 第二次中奖：只发新 winner，不重发已 sent；多奖备注
    const r2 = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "mail@test.com",
      idempotencyKey: "mail-2",
    });
    expect(r2.won).toBe(true);
    await notifyInstantSpinWinner(db, TENANT, id, r2.spinId, {
      resendApiKey: "test-key",
      emailFrom: "noreply@test.com",
    });
    expect(captured.length).toBe(2);
    expect(captured[1]!.html).toMatch(/多次中奖|每份奖品/);
    expect(captured[1]!.html).toContain("黄金卡密礼包");

    // 全量 sendWinnerNotifications 不重发已 sent
    const before = captured.length;
    const bulk = await sendWinnerNotifications(db, TENANT, id, {
      resendApiKey: "test-key",
      emailFrom: "noreply@test.com",
    });
    expect(bulk.sent).toBe(0);
    expect(captured.length).toBe(before);
  });

  it("winnerIds 过滤：只通知指定 winner，不影响同活动其它 pending", async () => {
    const { slug, id } = await seedInstantDraw(db, client, { maxSpins: 3, weight: 100, codes: 5 });
    const a = await joinDraw(db, slug, "iso-a@test.com");
    const b = await joinDraw(db, slug, "iso-b@test.com");
    await grantSpins(client, a.entryId!, 1);
    await grantSpins(client, b.entryId!, 1);

    const rA = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "iso-a@test.com",
      idempotencyKey: "iso-a",
    });
    const rB = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "iso-b@test.com",
      idempotencyKey: "iso-b",
    });
    expect(rA.won && rB.won).toBe(true);

    const [wA] = await db.select().from(lotteryWinners).where(eq(lotteryWinners.spinId, rA.spinId));
    const [wB] = await db.select().from(lotteryWinners).where(eq(lotteryWinners.spinId, rB.spinId));
    expect(wA && wB).toBeTruthy();

    const captured = stubResendCapture();
    const result = await sendWinnerNotifications(db, TENANT, id, {
      resendApiKey: "test-key",
      emailFrom: "noreply@test.com",
    }, { winnerIds: [wA!.id] });

    expect(result.sent).toBe(1);
    expect(captured.length).toBe(1);
    expect(captured[0]!.to).toBe("iso-a@test.com");

    const [wA2] = await db.select().from(lotteryWinners).where(eq(lotteryWinners.id, wA!.id));
    const [wB2] = await db.select().from(lotteryWinners).where(eq(lotteryWinners.id, wB!.id));
    expect(wA2?.notificationStatus).toBe("sent");
    expect(wB2?.notificationStatus).toBe("pending");
  });

  it("notify 开关关闭或无 API Key：不发信、状态保持 pending", async () => {
    const { slug, id } = await seedInstantDraw(db, client, { maxSpins: 1, weight: 100, codes: 2 });
    await joinDraw(db, slug, "off@test.com");
    const r = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "off@test.com",
      idempotencyKey: "off-1",
    });
    expect(r.won).toBe(true);

    const captured = stubResendCapture();

    // 无 key
    await notifyInstantSpinWinner(db, TENANT, id, r.spinId, {
      resendApiKey: "",
      emailFrom: "noreply@test.com",
    });
    expect(captured.length).toBe(0);

    // 显式关闭
    await db.insert(systemConfig).values({
      key: "notify_winner_email_enabled",
      value: "false",
      updatedAt: new Date().toISOString(),
    });
    await notifyInstantSpinWinner(db, TENANT, id, r.spinId, {
      resendApiKey: "test-key",
      emailFrom: "noreply@test.com",
    });
    expect(captured.length).toBe(0);

    const [w] = await db.select().from(lotteryWinners).where(eq(lotteryWinners.spinId, r.spinId));
    expect(w?.notificationStatus).toBe("pending");
  });

  it("幂等回放：不新增 spin/winner，不重复占码", async () => {
    const { slug, id, prizeId } = await seedInstantDraw(db, client, {
      maxSpins: 2,
      weight: 100,
      codes: 3,
    });
    const joined = await joinDraw(db, slug, "idem@test.com");
    expect(joined.joined).toBe(true);
    await grantSpins(client, joined.entryId!, 2);

    const key = "idem-win-1";
    const r1 = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "idem@test.com",
      idempotencyKey: key,
    });
    expect(r1.won).toBe(true);
    const r2 = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "idem@test.com",
      idempotencyKey: key,
    });
    expect(r2.replayed).toBe(true);
    expect(r2.spinId).toBe(r1.spinId);
    expect(r2.won).toBe(true);

    const spins = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, id));
    expect(spins.length).toBe(1);
    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    expect(winners.length).toBe(1);
    const codes = await db.select().from(prizeCodes).where(eq(prizeCodes.prizeId, prizeId));
    expect(codes.filter((c) => c.status === "issued").length).toBe(1);
  });
});
