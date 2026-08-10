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
  lotteryEntries,
  lotteryPrizeTiers,
  lotterySpins,
  lotteryWinners,
  prizes,
  prizeCodes,
  systemConfig,
  spinsLog,
} from "../../db/schema";
import { performInstantSpin, SpinBusinessError } from "./spin-execution";
import { performDraw, notifyInstantSpinWinner, sendWinnerNotifications } from "./draw-execution";
import { joinDraw, type JoinDrawResult } from "./participation";

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

    // spins 流水日志（P1）：join 初始 +1、spin 消耗 -1，余额快照正确
    const logs = await db.select().from(spinsLog).where(eq(spinsLog.entryId, join.entryId!));
    expect(logs).toHaveLength(2);
    const joinLog = logs.find((l) => l.reason === "join");
    const spinLog = logs.find((l) => l.reason === "spin");
    expect(joinLog).toMatchObject({ delta: 1, balanceAfter: 1, tenantId: TENANT });
    expect(spinLog).toMatchObject({ delta: -1, balanceAfter: 0, refId: r1.spinId });
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

  it("并发双 spin（left=1）：恰 1 成功 1 耗尽，不双扣、不双占码", async () => {
    const { slug, id, prizeId } = await seedInstantDraw(db, client, {
      maxSpins: 1,
      weight: 100,
      codes: 2,
    });
    await joinDraw(db, slug, "race@test.com");

    const results = await Promise.allSettled([
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "race@test.com",
        idempotencyKey: "race-a",
      }),
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "race@test.com",
        idempotencyKey: "race-b",
      }),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof performInstantSpin>>
    >[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(ok[0]!.value.won).toBe(true);
    expect(ok[0]!.value.spinsLeft).toBe(0);
    const err = rejected[0]!.reason as SpinBusinessError;
    expect(err).toMatchObject({ httpStatus: 409, code: "spin.quota.exhausted" });

    const spins = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, id));
    expect(spins.length).toBe(1);
    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    expect(winners.length).toBe(1);
    const codes = await db.select().from(prizeCodes).where(eq(prizeCodes.prizeId, prizeId));
    expect(codes.filter((c) => c.status === "issued").length).toBe(1);
  });

  it("两用户争抢仅 1 个 available 码：恰 1 中奖 1 未中，不双发同一码", async () => {
    const { slug, id, prizeId } = await seedInstantDraw(db, client, {
      maxSpins: 1,
      weight: 100,
      codes: 1,
      winnerCount: 5,
    });
    await joinDraw(db, slug, "code-a@test.com");
    await joinDraw(db, slug, "code-b@test.com");

    const results = await Promise.all([
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "code-a@test.com",
        idempotencyKey: "code-race-a",
      }),
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "code-b@test.com",
        idempotencyKey: "code-race-b",
      }),
    ]);

    const won = results.filter((r) => r.won);
    const miss = results.filter((r) => !r.won);
    expect(won.length).toBe(1);
    expect(miss.length).toBe(1);
    // 双方都已扣次（各 left=0）
    expect(results.every((r) => r.spinsLeft === 0)).toBe(true);

    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    expect(winners.length).toBe(1);
    const codes = await db.select().from(prizeCodes).where(eq(prizeCodes.prizeId, prizeId));
    expect(codes.filter((c) => c.status === "issued").length).toBe(1);
    expect(codes.filter((c) => c.status === "available").length).toBe(0);
    // 两人各一条 spin（未中也记）
    const spins = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, id));
    expect(spins.length).toBe(2);
    expect(spins.filter((s) => s.won === 1).length).toBe(1);
  });

  it("跨租户：同 slug 不可能；同邮箱不同 tenant 活动互不串码/串 winner", async () => {
    const otherTenant = "tenant-spin-other";
    await client.execute({
      sql: `INSERT OR IGNORE INTO tenants (id, name, plan, status) VALUES (?, 'O', 'free', 'active')`,
      args: [otherTenant],
    });

    const a = await seedInstantDraw(db, client, { maxSpins: 1, weight: 100, codes: 2, prizeName: "租户A奖" });
    // 手写 B 活动（不同 tenant）
    const bId = crypto.randomUUID();
    const bSlug = `ob${bId.slice(0, 6)}`;
    const now = new Date();
    await db.insert(lotteryDraws).values({
      id: bId,
      tenantId: otherTenant,
      publicSlug: bSlug,
      title: "other tenant instant",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "wheel",
      resultMode: "instant",
      startAt: new Date(now.getTime() - 3600_000).toISOString(),
      endAt: new Date(now.getTime() + 86400_000).toISOString(),
      winnerCount: 2,
      maxSpinsPerEntry: 1,
    });
    const bPrize = crypto.randomUUID();
    await db.insert(prizes).values({
      id: bPrize,
      tenantId: otherTenant,
      name: "租户B奖",
      prizeType: "code",
      totalCount: 2,
      active: 1,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: otherTenant,
      drawId: bId,
      prizeId: bPrize,
      tierName: "B档",
      winnerCount: 2,
      sortOrder: 1,
      weight: 100,
    });
    for (let i = 0; i < 2; i++) {
      await db.insert(prizeCodes).values({
        id: crypto.randomUUID(),
        tenantId: otherTenant,
        prizeId: bPrize,
        code: `BCODE-${i}`,
        secret: `BSEC-${i}`,
        status: "available",
      });
    }

    // 同邮箱分别 join 两租户活动
    await joinDraw(db, a.slug, "cross@test.com");
    await joinDraw(db, bSlug, "cross@test.com");

    const rA = await performInstantSpin(db, {
      slug: a.slug,
      identityType: "email",
      identityValue: "cross@test.com",
      idempotencyKey: "cross-a",
    });
    const rB = await performInstantSpin(db, {
      slug: bSlug,
      identityType: "email",
      identityValue: "cross@test.com",
      idempotencyKey: "cross-b",
    });
    expect(rA.won && rB.won).toBe(true);
    expect(rA.prizeCode).toMatch(/CODE-/);
    expect(rB.prizeCode).toMatch(/BCODE-/);
    expect(rA.prizeCode).not.toBe(rB.prizeCode);

    const wA = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, a.id));
    const wB = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, bId));
    expect(wA.length).toBe(1);
    expect(wB.length).toBe(1);
    expect(wA[0]!.tenantId).toBe(TENANT);
    expect(wB[0]!.tenantId).toBe(otherTenant);

    // A 活动码池不得出现 B 的 issued 串写
    const aCodes = await db.select().from(prizeCodes).where(eq(prizeCodes.prizeId, a.prizeId));
    expect(aCodes.every((c) => c.tenantId === TENANT)).toBe(true);
    const bCodes = await db.select().from(prizeCodes).where(eq(prizeCodes.prizeId, bPrize));
    expect(bCodes.every((c) => c.tenantId === otherTenant)).toBe(true);
  });

  it("未参与 / 活动非 open / 缺幂等键：硬拒且不写 spin", async () => {
    const { slug, id } = await seedInstantDraw(db, client, { maxSpins: 2, weight: 100, codes: 2 });

    await expect(
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "nojoin@test.com",
        idempotencyKey: "nojoin-1",
      }),
    ).rejects.toMatchObject({ code: "spin.entry.required", httpStatus: 400 });

    await expect(
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "x@test.com",
        idempotencyKey: "",
      }),
    ).rejects.toMatchObject({ code: "spin.idempotency.required" });

    await joinDraw(db, slug, "paused@test.com");
    await db.update(lotteryDraws).set({ status: "paused" }).where(eq(lotteryDraws.id, id));
    await expect(
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "paused@test.com",
        idempotencyKey: "paused-1",
      }),
    ).rejects.toMatchObject({ code: "spin.draw.not_open" });

    const spins = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, id));
    expect(spins.length).toBe(0);
  });

  it("weight=0 全档：扣次、记未中 spin、不写 winner", async () => {
    const { slug, id } = await seedInstantDraw(db, client, {
      maxSpins: 1,
      weight: 0,
      codes: 3,
      winnerCount: 3,
    });
    await joinDraw(db, slug, "zerow@test.com");
    const r = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "zerow@test.com",
      idempotencyKey: "zerow-1",
    });
    expect(r.won).toBe(false);
    expect(r.spinsLeft).toBe(0);
    expect(r.prizeIndex).toBe(-1);
    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    expect(winners.length).toBe(0);
    const spins = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, id));
    expect(spins.length).toBe(1);
    expect(spins[0]!.won).toBe(0);
  });

  it("两个不同 entry 并发抽 winner_count=1 的同一奖档 → 仅一个 winner", async () => {
    // 与「两用户争抢最后 1 个码」不同：这里码池充足（codes=5），
    // 但 tier 的 winnerCount=1 封顶。即使两人都拿到码，也只允许一个 winner。
    // 这段验证的是档位 winnerCount 的并发封顶，而非码池 CAS。
    const { slug, id, tierId } = await seedInstantDraw(db, client, {
      maxSpins: 2,
      weight: 100,
      codes: 5,
      winnerCount: 1,
    });
    const a = await joinDraw(db, slug, "winrace-a@test.com");
    const b = await joinDraw(db, slug, "winrace-b@test.com");
    expect(a.joined).toBe(true);
    expect(b.joined).toBe(true);
    await grantSpins(client, a.entryId!, 2);
    await grantSpins(client, b.entryId!, 2);

    // 两个不同身份并发抽——SQLite 单写者事务串行化，先拿到写锁的中奖，
    // 后到的在事务内重查 winner 计数时发现档位已满则未中。
    const results = await Promise.allSettled([
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "winrace-a@test.com",
        idempotencyKey: "winrace-a",
      }),
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "winrace-b@test.com",
        idempotencyKey: "winrace-b",
      }),
    ]);

    // 两个都必须成功返回（未中不是错误，是 won=false 的结果）
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // 恰好一个 winner，且属于这两个 entry 之一
    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    expect(winners.length).toBe(1);
    expect(winners[0]!.tierId).toBe(tierId);
    expect([a.entryId, b.entryId]).toContain(winners[0]!.entryId);

    // 两人各记一条 spin（未中也记），仅一条 won=1
    const spins = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, id));
    expect(spins.length).toBe(2);
    expect(spins.filter((s) => s.won === 1).length).toBe(1);
    expect(spins.filter((s) => s.won === 0).length).toBe(1);

    // awarded_count CAS 计数器与 winner 数一致（docs/148 §四）
    const [tier] = await db.select().from(lotteryPrizeTiers).where(eq(lotteryPrizeTiers.id, tierId));
    expect(tier?.awardedCount).toBe(1);
  });

  it("两个不同身份并发抢最后一个直付秒杀名额 → 仅一人抢到，activeParticipantCount=1", async () => {
    // 创建直付秒杀活动：stockLimit=1，open，无码池（join 阶段不涉及抽奖）
    // 名额由 joinDraw 的活动级 CAS（activeParticipantCount < effectiveMax）抢占，
    // 不是 createPaymentOrder 抢占——两类测试必须分开（docs/148 §五）。
    const id = crypto.randomUUID();
    const slug = `fs-cap-${id.slice(0, 6)}`;
    const now = new Date();
    const startAt = new Date(now.getTime() - 3600_000).toISOString();
    const endAt = new Date(now.getTime() + 86400_000 * 7).toISOString();

    await db.insert(lotteryDraws).values({
      id,
      tenantId: TENANT,
      publicSlug: slug,
      title: "直付秒杀名额并发测试",
      description: "",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "flash_sale",
      drawTrigger: "manual",
      resultMode: "instant",
      startAt,
      endAt,
      // stockLimit=1：活动级 activeParticipantCount（0<1）CAS 抢占最后名额
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" },
      }),
      maxParticipants: 1,
      activeParticipantCount: 0,
    });

    // 两个不同身份并发 joinDraw——SQLite 单写者事务串行化：
    // 先拿到写锁的 CAS 成功（activeParticipantCount 0→1），
    // 后到的重查 1<1 失败 → soldOut。
    const results = await Promise.allSettled([
      joinDraw(db, slug, "capfight-a@test.com"),
      joinDraw(db, slug, "capfight-b@test.com"),
    ]);

    // 两个都必须正常返回（soldOut 不是异常，是未抢到结果）
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const joinedCount = results.filter(
      (r) => (r as PromiseFulfilledResult<JoinDrawResult>).value.joined,
    ).length;
    const soldOutCount = results.filter(
      (r) => (r as PromiseFulfilledResult<JoinDrawResult>).value.soldOut,
    ).length;

    // 恰好一人 joined=true，另一人 soldOut=true
    expect(joinedCount).toBe(1);
    expect(soldOutCount).toBe(1);

    // 活动级计数器：只有一个名额被占用
    const [drawAfter] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, id));
    expect(drawAfter!.activeParticipantCount).toBe(1);

    // entries：恰好一条 reserved 预约，另一身份无 entry
    const entries = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, id));
    expect(entries.length).toBe(1);
    expect(entries[0]!.paymentStatus).toBe("reserved");
  });

  it("直付秒杀（paymentRequired）+ instant：未付款 spin 被拒（纵深防御）", async () => {
    // docs/166：发布预检已阻断该组合，这里锁定运行时纵深防御——
    // 对存量/被绕过数据，未付款 entry 不能 spin 中奖。
    const id = crypto.randomUUID();
    const slug = `fs-pay-${id.slice(0, 6)}`;
    const now = new Date();
    const startAt = new Date(now.getTime() - 3600_000).toISOString();
    const endAt = new Date(now.getTime() + 86400_000 * 7).toISOString();

    await db.insert(lotteryDraws).values({
      id,
      tenantId: TENANT,
      publicSlug: slug,
      title: "直付秒杀 instant spin 防御",
      description: "",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "flash_sale",
      drawTrigger: "manual",
      resultMode: "instant",
      startAt,
      endAt,
      maxSpinsPerEntry: 3,
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, stockLimit: 10, priceCents: 9900, currency: "cny" },
      }),
      maxParticipants: 10,
      activeParticipantCount: 0,
    });

    // 建一个 code 奖档，保证若防御失效能真正中奖
    const prizeId = crypto.randomUUID();
    await db.insert(prizes).values({
      id: prizeId, tenantId: TENANT, name: "付费奖", prizeType: "code", totalCount: 1, active: 1,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: id, prizeId,
      tierName: "一等奖", winnerCount: 1, sortOrder: 100, weight: 100,
    });
    await db.insert(prizeCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, prizeId, code: "PAYCODE-1", secret: "s", status: "available",
    });

    // 未付款身份 join → entry 为 reserved（尚未下单）
    const joined = await joinDraw(db, slug, "buyer-nopay@test.com");
    expect(joined.joined).toBe(true);

    // spin 必须被纵深防御拒绝
    await expect(
      performInstantSpin(db, {
        slug,
        identityType: "email",
        identityValue: "buyer-nopay@test.com",
        idempotencyKey: "k1",
      }),
    ).rejects.toMatchObject({ httpStatus: 402, code: "spin.payment.required" });
  });
});
