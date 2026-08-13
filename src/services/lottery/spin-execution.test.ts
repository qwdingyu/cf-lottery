/**
 * instant spin 集成测（docs/116/117/119）
 * 覆盖：扣次、幂等、多奖 UNIQUE、performDraw 拒 instant、次数用尽、
 * 中奖邮件按 spin 隔离、码耗尽仍扣次、档位封顶、通知开关。
 *
 * 中奖路径：单档 weight>0 + 有 available 码 → 确定性中奖（无随机跳过）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
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
import { performInstantSpin, cleanExpiredSpins } from "./spin-execution";
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

  it("maxSpins=1 第二次 spin 返回业务失败（businessError），不抛异常", async () => {
    const { slug } = await seedInstantDraw(db, client, { maxSpins: 1 });
    await joinDraw(db, slug, "once@test.com");
    const first = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "once@test.com",
      idempotencyKey: "k1",
    });
    // 第一次正常返回（无 businessError，表示成功扣次）
    expect(first.businessError).toBeUndefined();
    // weight=100 有码 → 必中
    const second = await performInstantSpin(db, {
      slug,
      identityType: "email",
      identityValue: "once@test.com",
      idempotencyKey: "k2",
    });
    // 第二次不抛异常，通过 businessError 告知调用方次数耗尽（P0 防无限消耗）
    expect(second.businessError).toBe("抽奖次数已用完");
    expect(second.businessErrorCode).toBe("spin.quota.exhausted");
    expect(second.spinId).toBe("");       // 无 spin 写入
    expect(second.spinsLeft).toBe(0);      // 确认未扣次
    expect(second.won).toBe(false);
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
    // quotaExhausted 不再抛异常，两个都 resolve（一个成功，一个 businessError）
    expect(ok.length).toBe(2);
    expect(rejected.length).toBe(0);
    // 第一个成功：中奖
    const winner = ok.find((r) => r.value.won === true);
    expect(winner).toBeDefined();
    expect(winner!.value.spinsLeft).toBe(0);
    // 第二个失败：businessError（未扣次，无 spin 写入）
    const exhausted = ok.find((r) => r.value.businessErrorCode === "spin.quota.exhausted");
    expect(exhausted).toBeDefined();
    expect(exhausted!.value.businessError).toBe("抽奖次数已用完");
    expect(exhausted!.value.spinId).toBe("");
    // 剩余次数必须反映库内真实值（并发下事务内重读，不接受预读旧值虚高）
    expect(exhausted!.value.spinsLeft).toBe(0);

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
/**
 * cleanExpiredSpins 幂等抽奖执行记录清理测试
 *
 * 覆盖：
 * - 超出保留窗口的记录被删除
 * - 保留窗口内的记录不受影响
 * - 表为空时清理不影响（无报错）
 * - 自定义保留窗口参数生效
 */
describe("cleanExpiredSpins", () => {
  let db: DbType;
  let client: Client;

  beforeEach(async () => {
    const t = await getTestDb();
    db = t.db;
    client = t.client;
    await clearTestData(client);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("删除超出保留窗口的记录，保留窗口内的记录不受影响", async () => {
    // 准备：插入一条超旧的记录（30 天前）
    const oldSpinId = crypto.randomUUID();
    const oldCreatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.insert(lotterySpins).values({
      id: oldSpinId,
      tenantId: "t-clean",
      drawId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      idempotencyKey: "old-key",
      won: 0,
      createdAt: oldCreatedAt,
    });

    // 准备：插入一条较新的记录（1 小时前）
    const recentSpinId = crypto.randomUUID();
    const recentCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.insert(lotterySpins).values({
      id: recentSpinId,
      tenantId: "t-clean",
      drawId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      idempotencyKey: "recent-key",
      won: 0,
      createdAt: recentCreatedAt,
    });

    // 准备：插入一条刚好在边界上的记录（7 天前 - 1 秒，在窗口内）
    const boundarySpinId = crypto.randomUUID();
    const boundaryCreatedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 1000).toISOString();
    await db.insert(lotterySpins).values({
      id: boundarySpinId,
      tenantId: "t-clean",
      drawId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      idempotencyKey: "boundary-key",
      won: 0,
      createdAt: boundaryCreatedAt,
    });

    // 执行：保留 7 天（默认参数）
    const deleted = await cleanExpiredSpins(db);

    // 断言：旧记录被删除
    const oldRows = await db.select().from(lotterySpins).where(eq(lotterySpins.id, oldSpinId));
    expect(oldRows).toHaveLength(0);

    // 断言：新记录保留
    const recentRows = await db.select().from(lotterySpins).where(eq(lotterySpins.id, recentSpinId));
    expect(recentRows).toHaveLength(1);

    // 断言：边界记录保留（略小于 7 天，在窗口内）
    const boundaryRows = await db.select().from(lotterySpins).where(eq(lotterySpins.id, boundarySpinId));
    expect(boundaryRows).toHaveLength(1);

    // 断言：删除数至少为 1（旧记录）
    expect(deleted).toBeGreaterThanOrEqual(1);
  });

  it("被 winner 引用的 spins 不被删除（引用完整性保护）", async () => {
    // 准备：插入一条超旧的 spin（30 天前）
    const oldSpinId = crypto.randomUUID();
    const oldCreatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.insert(lotterySpins).values({
      id: oldSpinId,
      tenantId: "t-clean",
      drawId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      idempotencyKey: "old-key",
      won: 1,
      createdAt: oldCreatedAt,
    });

    // 准备：插入一条 winner，引用该 spin（模拟 instant 中奖）
    const winnerId = crypto.randomUUID();
    await db.insert(lotteryWinners).values({
      id: winnerId,
      tenantId: "t-clean",
      drawId: crypto.randomUUID(),
      tierId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      spinId: oldSpinId, // 引用旧 spin
      identityType: "email",
      identityValue: "test@test.com",
      prizeCodeId: "",
      drawnAt: new Date().toISOString(),
    });

    // 执行：保留 7 天（默认参数）
    const deleted = await cleanExpiredSpins(db);

    // 断言：被引用的旧 spin 未被删除
    const oldRows = await db.select().from(lotterySpins).where(eq(lotterySpins.id, oldSpinId));
    expect(oldRows).toHaveLength(1);

    // 断言：删除数为 0（因为有 winner 引用）
    expect(deleted).toBe(0);
  });

  it("空表调用不影响", async () => {
    // 确保表为空
    await db.delete(lotterySpins);

    // 执行不应报错
    const deleted = await cleanExpiredSpins(db);
    expect(deleted).toBe(0);
  });

  it("自定义保留窗口参数生效", async () => {
    // 准备：插入一条 2 小时前的记录
    const spinId = crypto.randomUUID();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await db.insert(lotterySpins).values({
      id: spinId,
      tenantId: "t-clean",
      drawId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      idempotencyKey: "custom-key",
      won: 0,
      createdAt: twoHoursAgo,
    });

    // 执行：保留 1 小时（2 小时前的记录应被删除）
    const deleted = await cleanExpiredSpins(db, 60 * 60 * 1000);
    expect(deleted).toBe(1);

    const rows = await db.select().from(lotterySpins).where(eq(lotterySpins.id, spinId));
    expect(rows).toHaveLength(0);
  });
});
describe("保底机制与每日免费抽奖（docs/218 模式一/模式二）", () => {
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
    restoreCsprng();
  });

  /**
   * 双档活动辅助：
   * - 档 A（sortOrder 10, 高价值, 库存 0 → 必未中）→ 用于累积连空
   * - 档 B（sortOrder 100, 低价值, 库存 3 → 有码必中）→ 保底强制最低档
   * CSPRNG 固定为 0 时 normal 随机抽 eligible[0] = 档 A，必未中。
   */
  async function seedPityDraw(opts?: { threshold?: number; dailyCount?: number; maxSpins?: number }) {
    const maxSpins = opts?.maxSpins ?? 5;
    const id = crypto.randomUUID();
    const slug = `py${id.slice(0, 6)}`;
    const now = new Date();
    const startAt = new Date(now.getTime() - 3600_000).toISOString();
    const endAt = new Date(now.getTime() + 7 * 86400_000).toISOString();

    const promotion: Record<string, unknown> = {};
    if (typeof opts?.threshold === "number") {
      promotion.pity = { enabled: true, threshold: opts.threshold };
    }
    if (typeof opts?.dailyCount === "number") {
      promotion.dailyFreeSpins = { enabled: true, count: opts.dailyCount };
    }

    await db.insert(lotteryDraws).values({
      id,
      tenantId: TENANT,
      publicSlug: slug,
      title: "pity test",
      description: "",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "wheel",
      drawTrigger: "manual",
      resultMode: "instant",
      startAt,
      endAt,
      winnerCount: 5,
      maxSpinsPerEntry: maxSpins,
      promotionConfig: JSON.stringify(promotion),
    });

    // 奖品 A：0 库存 → 正常抽中必未中（模拟高价值奖品售罄）
    const prizeAId = crypto.randomUUID();
    await db.insert(prizes).values({
      id: prizeAId, tenantId: TENANT, name: "售罄大奖", prizeType: "code", totalCount: 0, active: 1,
    });
    // 奖品 B：3 库存 → 保底触发时必中
    const prizeBId = crypto.randomUUID();
    await db.insert(prizes).values({
      id: prizeBId, tenantId: TENANT, name: "保底小奖", prizeType: "code", totalCount: 3, active: 1,
    });

    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: id, prizeId: prizeAId,
      tierName: "大奖", winnerCount: 100, sortOrder: 10, weight: 100,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: id, prizeId: prizeBId,
      tierName: "小奖", winnerCount: 3, sortOrder: 100, weight: 100,
    });

    for (let i = 0; i < 3; i++) {
      await db.insert(prizeCodes).values({
        id: crypto.randomUUID(), tenantId: TENANT, prizeId: prizeBId,
        code: `PITY-${i}-${slug}`, secret: `S-${i}`, status: "available",
      });
    }

    return { id, slug };
  }

  /** 固定 CSPRNG 结果：0 → 抽 eligible[0]（档 A 必未中）；MAX → 抽末尾（档 B 必中） */
  function stubCsprng(intValue: number) {
    // getRandomValues 是 crypto 的自身属性（可写），直接原地替换。
    // randomUUID 是原型方法，不受影响（this 绑定正确）。
    const real = crypto as unknown as { getRandomValues: (arr: Uint32Array) => void };
    (crypto as unknown as Record<string, unknown>).__csprngOriginal = real.getRandomValues;
    real.getRandomValues = (arr: Uint32Array) => {
      arr[0] = intValue >>> 0;
    };
  }

  function restoreCsprng() {
    const orig = (crypto as unknown as Record<string, unknown>).__csprngOriginal as
      | ((arr: Uint32Array) => void)
      | undefined;
    if (orig) {
      const real = crypto as unknown as { getRandomValues: (arr: Uint32Array) => void };
      real.getRandomValues = orig;
      delete (crypto as unknown as Record<string, unknown>).__csprngOriginal;
    }
  }

// ── 保底机制 ──

  it("保底未达阈值：不触发，连空计数器正确累加", async () => {
    const { slug } = await seedPityDraw({ threshold: 10 }); // 阈值 10，远高于测试次数
    const join = await joinDraw(db, slug, "pity0@test.com");
    expect(join.joined).toBe(true);
    await grantSpins(client, join.entryId!, 5);
    stubCsprng(0); // 每次都抽 eligible[0]（档 A，库存 0 → 未中）

    for (let i = 1; i <= 5; i++) {
      const r = await performInstantSpin(db, {
        slug, identityType: "email", identityValue: "pity0@test.com", idempotencyKey: `p0-${i}`,
      });
      expect(r.won).toBe(false);
      // 查 spins_log 确认 refId 不包含 "pity" 前缀（非保底触发）
      const logs = await db.select().from(spinsLog).where(eq(spinsLog.refId, r.spinId));
      for (const log of logs) {
        expect(log.refId).not.toMatch(/^pity:/);
      }
    }

    // 断言：连空计数器 = 5，档 A 未中过（awardedCount 仍为 0）
    const entry = await readEntry(join.entryId!);
    expect(Number(entry.consecutiveNoWinSpins)).toBe(5);
    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, slug));
    expect(winners).toHaveLength(0);
  });

  it("保底达阈值：强制最低档中奖，计数器归零，spins_log 标识阈值", async () => {
    const { slug } = await seedPityDraw({ threshold: 3 });
    const join = await joinDraw(db, slug, "pity1@test.com");
    expect(join.joined).toBe(true);
    await grantSpins(client, join.entryId!, 5);
    stubCsprng(0); // 前 3 次抽 eligible[0]（档 A，库存 0 → 未中），计数器累加

    // 前 3 次：累计未中，counter→1,2,3
    for (let i = 1; i <= 3; i++) {
      const r = await performInstantSpin(db, {
        slug, identityType: "email", identityValue: "pity1@test.com", idempotencyKey: `p1-${i}`,
      });
      expect(r.won).toBe(false);
    }
    const entryBefore = await readEntry(join.entryId!);
    expect(Number(entryBefore.consecutiveNoWinSpins)).toBe(3);

    // 第 4 次：counter=3 ≥ threshold=3 → 保底触发！强制 eligibility[1] = 档 B（有库存）
    // CSPRNG 对保底无效（强制不调用 weightedPickTier）
    const r4 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "pity1@test.com", idempotencyKey: `p1-4`,
    });
    expect(r4.won).toBe(true);
    expect(r4.tierName).toBe("小奖");
    expect(r4.prizeCode).toBeTruthy();

    // 计数器归零
    const entryAfter = await readEntry(join.entryId!);
    expect(Number(entryAfter.consecutiveNoWinSpins)).toBe(0);

    // spins_log 中该 spin 记录 refId 应包含 "pity:3" 标识保底阈值
    const logs = await db.select().from(spinsLog).where(eq(spinsLog.refId, `pity:3`));
    expect(logs.length).toBeGreaterThanOrEqual(1);
    // 查该 spin 的 log: reason=spin, delta=-1（正常扣次，不免费）
    const spinLog = logs.find((l) => l.entryId === join.entryId);
    expect(spinLog).toBeDefined();
    expect(spinLog!.reason).toBe("spin");
    expect(spinLog!.delta).toBe(-1);
  });
  async function readEntry(entryId: string) {
    const rows = await db
      .select()
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.id, entryId), eq(lotteryEntries.tenantId, TENANT)));
    return rows[0]!;
  }
// ── 每日免费抽奖 ──

  it("每日免费：首次领取成功+1，当日不重复累加，spinsLeft 不扣本次", async () => {
    const { slug } = await seedPityDraw({ dailyCount: 1, maxSpins: 2 });
    const join = await joinDraw(db, slug, "free0@test.com");
    expect(join.joined).toBe(true);
    // 初始 spinsLeft = 1（join grant）

    // 第一次 spin：每日免费领取 +1 → spinsLeft = 2，跳过扣次
    const r1 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "free0@test.com", idempotencyKey: "f0-1",
    });
    expect(r1.spinsLeft).toBe(2); // 初始 1 + 免费 1，本次未扣

    // spins_log 有 daily_free 记录
    const logs1 = await db.select().from(spinsLog).where(eq(spinsLog.entryId, join.entryId!));
    const freeLog = logs1.find((l) => l.reason === "daily_free");
    expect(freeLog).toBeDefined();
    expect(freeLog!.delta).toBe(1);          // 发放 1 次
    expect(freeLog!.balanceAfter).toBe(2);   // 余额 2

    // 第二次 spin：当日已领，正常扣次 → spinsLeft = 1
    const r2 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "free0@test.com", idempotencyKey: "f0-2",
    });
    expect(r2.spinsLeft).toBe(1);
    expect(r2.won).toBe(false);

    // 第三次 spin：正常扣次 → spinsLeft = 0
    const r3 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "free0@test.com", idempotencyKey: "f0-3",
    });
    expect(r3.spinsLeft).toBe(0);

    // 第四次 spin：次数耗尽
    const r4 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "free0@test.com", idempotencyKey: "f0-4",
    });
    expect(r4.businessErrorCode).toBe("spin.quota.exhausted");

    // lastDailyFreeSpinAt 记录为今日
    const entry = await readEntry(join.entryId!);
    const today = new Date().toISOString().slice(0, 10);
    expect(entry.lastDailyFreeSpinAt).toBe(today);
  });

  it("每日免费：次日自动重置，可再次领取", async () => {
    const { slug } = await seedPityDraw({ dailyCount: 1, maxSpins: 3 });
    const join = await joinDraw(db, slug, "free1@test.com");
    expect(join.joined).toBe(true);
    await grantSpins(client, join.entryId!, 2); // 覆盖为 2 → spinsLeft=2（join 1 + 覆盖 2 取后值 2）

    // 第一次 spin：领取免费 +1 → spinsLeft = 3
    const r1 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "free1@test.com", idempotencyKey: "f1-1",
    });
    expect(r1.spinsLeft).toBe(3);

    // 手动将 lastDailyFreeSpinAt 改为昨天，模拟次日
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    await db
      .update(lotteryEntries)
      .set({ lastDailyFreeSpinAt: yesterday })
      .where(and(eq(lotteryEntries.id, join.entryId!), eq(lotteryEntries.tenantId, TENANT)));

    // 第二次 spin：应再次领取免费 +1 → spinsLeft = 4（3+1，跳过扣次）
    const r2 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "free1@test.com", idempotencyKey: "f1-2",
    });
    expect(r2.spinsLeft).toBe(4); // 3 + 1，未扣

    // lastDailyFreeSpinAt 更新为今日
    const entry = await readEntry(join.entryId!);
    const today = new Date().toISOString().slice(0, 10);
    expect(entry.lastDailyFreeSpinAt).toBe(today);
  });
it("每日免费未配置时保持原扣次行为，last_daily_free 保持 NULL", async () => {
    const { slug } = await seedPityDraw({}); // 无 dailyFree 配置
    const join = await joinDraw(db, slug, "free2@test.com");
    expect(join.joined).toBe(true);
    // 初始 spinsLeft = 1

    const r1 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "free2@test.com", idempotencyKey: "f2-1",
    });
    expect(r1.spinsLeft).toBe(0); // 正常扣次 1→0
    expect(r1.won).toBe(false);

    // 断言：无 daily_free 日志
    const logs = await db.select().from(spinsLog).where(eq(spinsLog.entryId, join.entryId!));
    expect(logs.every((l) => l.reason !== "daily_free")).toBe(true);

    // lastDailyFreeSpinAt 保持 NULL
    const entry = await readEntry(join.entryId!);
    expect(entry.lastDailyFreeSpinAt).toBeNull();
  });

  it("保底 + 每日免费组合：免费领取不影响保底计数", async () => {
    const { slug } = await seedPityDraw({ threshold: 3, dailyCount: 1, maxSpins: 5 });
    const join = await joinDraw(db, slug, "combo@test.com");
    expect(join.joined).toBe(true);
    await grantSpins(client, join.entryId!, 4); // 覆盖为 4 → spinsLeft=4
    stubCsprng(0); // 正常抽档 A → 必未中

    // spin1：免费领取 +1 → spinsLeft = 5，跳过扣次，未中 → counter 0→1
    const r1 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "combo@test.com", idempotencyKey: "c-1",
    });
    expect(r1.spinsLeft).toBe(5);
    expect(r1.won).toBe(false);

    // spin2：正常扣次 → spinsLeft = 4，未中 → counter 1→2
    const r2 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "combo@test.com", idempotencyKey: "c-2",
    });
    expect(r2.spinsLeft).toBe(4);
    expect(r2.won).toBe(false);

    // spin3：正常扣次 → spinsLeft = 3，未中 → counter 2→3（本轮仍正常抽）
    const r3 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "combo@test.com", idempotencyKey: "c-3",
    });
    expect(r3.spinsLeft).toBe(3);
    expect(r3.won).toBe(false);

    // spin4：正常扣次 → spinsLeft = 2，counter=3 ≥ threshold → 保底触发！强制中档 B
    const r4 = await performInstantSpin(db, {
      slug, identityType: "email", identityValue: "combo@test.com", idempotencyKey: "c-4",
    });
    expect(r4.won).toBe(true);
    expect(r4.tierName).toBe("小奖");
    expect(r4.prizeCode).toBeTruthy();
    expect(r4.spinsLeft).toBe(2); // 正常扣次 1

    // 计数器归零
    const entry = await readEntry(join.entryId!);
    expect(Number(entry.consecutiveNoWinSpins)).toBe(0);
  });
});
