/**
 * my-rewards 路由测试（docs/257 死磕闭环：推广 → 奖励发放 → my-rewards 展示）。
 *
 * 为什么补这个文件：
 * 此前推广链路已有测试覆盖——归因计数（auth-and-public.test.ts registered access-code
 * 带 refCode 计入 joinedCount）、奖励引擎发放（referral-rewards-engine.test.ts 的
 * bonus_spin / bonus_coupon）、my-result 展示（auth-and-public.test.ts claim 端到端），
 * 但 **GET /api/public/my-rewards 路由本身零测试**：「邀请人推广后在 my-rewards 里
 * 能看到什么」从未被断言。本文件补齐三层：
 *
 * 1. 路由基本行为：无/无效 JWT → 401；有效 JWT 但无参与记录 → 空数组。
 * 2. 正向闭环：registered（user_id）分享者推广 → 被邀请人带 ref 参与 →
 *    joinedCount+1 → bonus_spin + bonus_coupon 发放 → 分享者 my-rewards
 *    能查到 spinsLeft 与优惠券（证明整条「推广 → 奖励 → 展示」链路真实闭环）。
 * 3. 跨身份查询：open（email 身份）参与者的奖励在 cf-auth 用户登录后也能看到——
 *    my-rewards 同时查 user_id 和 email 两种身份（修复：open 模式用户查不到自己记录）。
 *    但纯 email 参与者（无 cf-auth 用户记录）仍返回空（无法关联 JWT 身份）。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { performInstantSpin } from "../services/lottery/spin-execution";
import type { AppEnv } from "../bindings";
import {
  couponCodes,
  lotteryDraws,
  lotteryEntries,
  shareRecords,
  systemConfig,
  tenants,
  users,
} from "../db/schema";
import { clearTestData, getTestDb } from "../test-setup";
import { publicLotteryRoute } from "./public-lottery";
import { signJwt } from "../middleware/auth";

let db: Awaited<ReturnType<typeof getTestDb>>["db"];
let client: Awaited<ReturnType<typeof getTestDb>>["client"];

const TENANT = "tenant-my-rewards";
const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET: "test-jwt-secret-0123456789abcdef",
};

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/public", publicLotteryRoute);
  return app;
}

/** 对未来时间取整，避免毫秒差异 */
function futureTimeISO(minutes: number): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

async function seedDraw(overrides: Partial<typeof lotteryDraws.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  await db.insert(lotteryDraws).values({
    id,
    tenantId: TENANT,
    publicSlug: `my-rewards-${id.slice(0, 8)}`,
    title: "my-rewards 测试活动",
    status: "open",
    activityKind: "lottery",
    experienceType: "wheel",
    resultMode: "instant",
    participationMode: "registered",
    startAt: futureTimeISO(-60),
    endAt: futureTimeISO(60),
    winnerCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

describe("GET /api/public/my-rewards 路由基本行为", () => {
  it("无 Bearer JWT → 401", async () => {
    const app = createApp();
    const res = await app.request("/public/my-rewards", {}, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("无效 JWT → 401", async () => {
    const app = createApp();
    const res = await app.request("/public/my-rewards", {
      headers: { Authorization: "Bearer not-a-real-token" },
    }, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("有效 JWT 但无 user_id 参与记录 → 空数组", async () => {
    await db.insert(tenants).values({ id: TENANT, name: "my-rewards" });
    const token = await signJwt({ sub: "user-with-no-entry", tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);
    const app = createApp();
    const res = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${token}` },
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rewards: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.rewards).toEqual([]);
  });

  it("有 user_id 参与记录 → 返回该活动的 spinsLeft 与优惠券", async () => {
    const userId = "user-has-entry";
    await db.insert(tenants).values({ id: TENANT, name: "my-rewards" });
    await db.insert(users).values({
      id: userId,
      username: "has-entry",
      email: "has-entry@test.com",
      passwordHash: "x",
    });
    const drawId = await seedDraw();
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      identityType: "user_id",
      identityValue: userId,
      joinedAt: new Date().toISOString(),
      spinsLeft: 5,
      spinsTotalGranted: 5,
    });
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      code: "MR-COUPON-1",
      label: "invite",
      status: "issued",
      recipientEmail: "has-entry@test.com",
    });

    const token = await signJwt({ sub: userId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);
    const app = createApp();
    const res = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${token}` },
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      rewards: Array<{ slug: string; spinsLeft: number; coupons: string[] }>;
    };
    expect(body.rewards).toHaveLength(1);
    expect(body.rewards[0]!.spinsLeft).toBe(5);
    expect(body.rewards[0]!.coupons).toContain("MR-COUPON-1");
  });
});

describe("推广 → 奖励 → my-rewards 正向闭环（registered 分享者）", () => {
  it("分享者推广后被邀请人参与，bonus_spin/bonus_coupon 入账且 my-rewards 可见", async () => {
    const sharerId = "sharer-user-id";
    const sharerEmail = "sharer@test.com";
    const inviteeId = "invitee-user-id";
    const inviteeEmail = "invitee@test.com";
    await db.insert(tenants).values({ id: TENANT, name: "my-rewards" });
    // 两位 registered 用户（分享者 / 被邀请人）
    await db.insert(users).values([
      { id: sharerId, username: "sharer", email: sharerEmail, passwordHash: "x" },
      { id: inviteeId, username: "invitee", email: inviteeEmail, passwordHash: "x" },
    ]);

    // 活动：registered 模式；配 bonus_spin（+2 次）+ bonus_coupon（1 张）两个推荐奖励
    const drawId = await seedDraw({
      publicSlug: "registered-referral-mr",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({
        version: 1,
        referralRewardDefs: [
          { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
          { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
        ],
      }),
    });
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      code: "REF-INVITE-1",
      label: "invite",
      status: "available",
    });

    const app = createApp();
    const sharerToken = await signJwt({ sub: sharerId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);
    const inviteeToken = await signJwt({ sub: inviteeId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);

    // ① 分享者 registered 参与 → 拿到 entryId（maxSpinsPerEntry=10 → 初始 spinsLeft=1）
    const joinSharer = await app.request("/public/draws/registered-referral-mr/access-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sharerToken}`,
        "CF-Connecting-IP": "10.0.0.91",
      },
      body: JSON.stringify({ email: sharerEmail }),
    }, TEST_ENV);
    expect(joinSharer.status).toBe(200);
    const sharerBody = await joinSharer.json() as { ok: boolean; joined: boolean; entryId: string };
    expect(sharerBody.ok).toBe(true);
    expect(sharerBody.joined).toBe(true);
    const sharerEntryId = sharerBody.entryId;

    // ② 分享者生成分享链接
    const shareRes = await app.request("/public/draws/registered-referral-mr/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.91" },
      body: JSON.stringify({ entryId: sharerEntryId }),
    }, TEST_ENV);
    expect(shareRes.status).toBe(200);
    const shareUrl = String((await shareRes.json() as { shareUrl: string }).shareUrl || "");
    const refCode = shareUrl.match(/ref=([^&]+)/)?.[1];
    expect(refCode).toBeTruthy();

    // ③ 被邀请人带 ref 参与 → join 事务内归因 + 发放奖励
    const joinInvitee = await app.request("/public/draws/registered-referral-mr/access-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inviteeToken}`,
        "CF-Connecting-IP": "10.0.0.92",
      },
      body: JSON.stringify({ email: inviteeEmail, refCode }),
    }, TEST_ENV);
    expect(joinInvitee.status).toBe(200);
    const inviteeBody = await joinInvitee.json() as { ok: boolean; joined: boolean };
    expect(inviteeBody.ok).toBe(true);
    expect(inviteeBody.joined).toBe(true);

    // ④ 归因与奖励落库断言
    const [share] = await db.select().from(shareRecords).where(eq(shareRecords.shareCode, refCode!));
    expect(share?.joinedCount).toBe(1);
    const granted = JSON.parse(share?.rewardMilestonesGranted || "[]") as string[];
    expect(granted).toContain("m1");
    expect(granted).toContain("c1");

    const [sharerEntry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    // 初始 1 次 + bonus_spin 2 次 = 3 次
    expect(Number(sharerEntry?.spinsLeft ?? 0)).toBe(3);
    // spinsTotalGranted 同样记录奖励发放（引擎路径只写 granted+left，不写 viralEarned）
    expect(Number(sharerEntry?.spinsTotalGranted ?? 0)).toBe(3);
    // 引擎路径（referralRewardDefs）不写 spinsViralEarned（与 viral.extraSpins 路径不同），
    // 断言保持 0 以固化这一设计差异，防止未来误改引擎写入逻辑。
    expect(Number(sharerEntry?.spinsViralEarned ?? 0)).toBe(0);

    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.code, "REF-INVITE-1"));
    expect(coupon?.status).toBe("issued");
    expect(coupon?.recipientEmail).toBe(sharerEmail);

    // ⑤ 分享者 my-rewards 可见奖励（完整闭环终点）
    const mrRes = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${sharerToken}` },
    }, TEST_ENV);
    expect(mrRes.status).toBe(200);
    const mrBody = await mrRes.json() as {
      ok: boolean;
      rewards: Array<{ slug: string; title: string; spinsLeft: number; coupons: string[] }>;
    };
    expect(mrBody.rewards).toHaveLength(1);
    expect(mrBody.rewards[0]!.slug).toBe("registered-referral-mr");
    expect(mrBody.rewards[0]!.spinsLeft).toBe(3);
    expect(mrBody.rewards[0]!.coupons).toContain("REF-INVITE-1");

    // ⑥ 被邀请人也有自己的 user_id 参与记录（spinsLeft=1），my-rewards 同样可见
    const inviteeMr = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${inviteeToken}` },
    }, TEST_ENV);
    const inviteeMrBody = await inviteeMr.json() as {
      rewards: Array<{ spinsLeft: number }>;
    };
    expect(inviteeMrBody.rewards).toHaveLength(1);
    expect(inviteeMrBody.rewards[0]!.spinsLeft).toBe(1);
  });
});

describe("open（email 身份）+ cf-auth 用户：my-rewards 跨身份查询", () => {
  it("open 模式 email 身份参与 + cf-auth 用户查 my-rewards → 可见（修复：email 身份也匹配）", async () => {
    const sharerEmail = "open-sharer@test.com";
    const sharerUserId = "cf-auth-sharer-user-id";
    const inviteeEmail = "open-invitee@test.com";
    await db.insert(tenants).values({ id: TENANT, name: "my-rewards" });

    // 分享者同时有 cf-auth 用户记录（模拟真实场景：用户先通过 cf-auth 注册，再参与 open 活动）
    await db.insert(users).values({
      id: sharerUserId,
      username: "open-sharer",
      email: sharerEmail,
      passwordHash: "x",
    });

    // open 模式活动 + bonus_coupon 推荐奖励
    const drawId = await seedDraw({
      publicSlug: "open-referral-mr",
      participationMode: "open",
      promotionConfig: JSON.stringify({
        version: 1,
        referralRewardDefs: [
          { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
        ],
      }),
    });
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      code: "OPEN-INVITE-1",
      label: "invite",
      status: "available",
    });

    const app = createApp();
    // 关闭邮箱验证，使 open 模式可直接 POST /join 参与（无需 OTP 验证码）
    await db.insert(systemConfig).values({ key: "enable_email_verification", value: "false" })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value: "false" } });
    // ① 分享者 open 参与（email 身份，entry.identityType='email'）
    const joinSharer = await app.request("/public/draws/open-referral-mr/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.93" },
      body: JSON.stringify({ email: sharerEmail }),
    }, TEST_ENV);
    expect(joinSharer.status).toBe(200);
    const sharerEntryId = (await joinSharer.json() as { entryId: string }).entryId;

    // ② 分享者生成分享链接
    const shareRes = await app.request("/public/draws/open-referral-mr/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.93" },
      body: JSON.stringify({ entryId: sharerEntryId }),
    }, TEST_ENV);
    expect(shareRes.status).toBe(200);
    const refCode = String((await shareRes.json() as { shareUrl: string }).shareUrl || "").match(/ref=([^&]+)/)?.[1]!;

    // ③ 被邀请人带 ref 参与 → 归因成功、优惠券发放到分享者邮箱
    const joinInvitee = await app.request("/public/draws/open-referral-mr/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.94" },
      body: JSON.stringify({ email: inviteeEmail, refCode }),
    }, TEST_ENV);
    expect(joinInvitee.status).toBe(200);

    const [share] = await db.select().from(shareRecords).where(eq(shareRecords.shareCode, refCode));
    expect(share?.joinedCount).toBe(1);
    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.code, "OPEN-INVITE-1"));
    expect(coupon?.status).toBe("issued");
    expect(coupon?.recipientEmail).toBe(sharerEmail);

    // ④ 分享者用 cf-auth JWT（user_id 身份）查 my-rewards：
    //    entry 是 email 身份，但 users.email 匹配 → my-rewards 同时查 email 身份 → 可见
    const token = await signJwt({ sub: sharerUserId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);
    const mrRes = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${token}` },
    }, TEST_ENV);
    expect(mrRes.status).toBe(200);
    const body = await mrRes.json() as {
      ok: boolean;
      rewards: Array<{ slug: string; title: string; spinsLeft: number; coupons: string[] }>;
    };
    expect(body.rewards).toHaveLength(1);
    expect(body.rewards[0]!.slug).toBe("open-referral-mr");
    expect(body.rewards[0]!.coupons).toContain("OPEN-INVITE-1");
  });

  it("无 cf-auth 用户记录时（纯 email 参与者）：my-rewards 仍返回空", async () => {
    const sharerEmail = "no-user-record@test.com";
    await db.insert(tenants).values({ id: TENANT, name: "my-rewards" });
    // 注意：不创建 users 记录

    await seedDraw({
      publicSlug: "open-no-user-mr",
      participationMode: "open",
    });

    const app = createApp();
    await db.insert(systemConfig).values({ key: "enable_email_verification", value: "false" })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value: "false" } });
    // email 身份参与
    await app.request("/public/draws/open-no-user-mr/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.95" },
      body: JSON.stringify({ email: sharerEmail }),
    }, TEST_ENV);

    // 用任意 JWT 查 my-rewards：无 users 记录 → userEmail 为空 → email 查询不触发 → 空
    const token = await signJwt({ sub: "random-user-id", tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);
    const mrRes = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${token}` },
    }, TEST_ENV);
    expect(mrRes.status).toBe(200);
    const body = await mrRes.json() as { rewards: unknown[] };
    expect(body.rewards).toEqual([]);
  });
});

describe("ref → bonus_spin → spin 执行 → my-rewards 更新 端到端闭环", () => {
  it("被邀请人参与后分享者获得 bonus_spin，使用后 my-rewards spinsLeft 正确递减", async () => {
    const sharerId = "sharer-spin-user";
    const sharerEmail = "sharer-spin@test.com";
    const inviteeId = "invitee-spin-user";
    const inviteeEmail = "invitee-spin@test.com";
    await db.insert(tenants).values({ id: TENANT, name: "my-rewards" });
    await db.insert(users).values([
      { id: sharerId, username: "sharer-spin", email: sharerEmail, passwordHash: "x" },
      { id: inviteeId, username: "invitee-spin", email: inviteeEmail, passwordHash: "x" },
    ]);

    // instant + registered 活动，配 bonus_spin（+3 次）+ 1 个码池奖品
    const drawId = await seedDraw({
      publicSlug: "spin-e2e-mr",
      experienceType: "wheel",
      resultMode: "instant",
      maxSpinsPerEntry: 5,
      promotionConfig: JSON.stringify({
        version: 1,
        referralRewardDefs: [
          { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "3", metadata: { rewardExit: "bonus_spin" } },
        ],
      }),
    });
    // 奖品码池（1 个 available 码，spin 中奖时占码）
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      code: "SPIN-PRIZE-1",
      label: "大奖",
      status: "available",
    });

    const app = createApp();
    const sharerToken = await signJwt({ sub: sharerId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);
    const inviteeToken = await signJwt({ sub: inviteeId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);

    // ① 分享者参与 → 初始 spinsLeft=1（maxSpinsPerEntry=5, 但初始只给 1 次）
    const joinSharer = await app.request("/public/draws/spin-e2e-mr/access-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sharerToken}`,
        "CF-Connecting-IP": "10.0.0.101",
      },
      body: JSON.stringify({ email: sharerEmail }),
    }, TEST_ENV);
    expect(joinSharer.status).toBe(200);
    const sharerEntryId = (await joinSharer.json() as { entryId: string }).entryId;

    // ② 分享者生成分享链接
    const shareRes = await app.request("/public/draws/spin-e2e-mr/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.101" },
      body: JSON.stringify({ entryId: sharerEntryId }),
    }, TEST_ENV);
    expect(shareRes.status).toBe(200);
    const refCode = String((await shareRes.json() as { shareUrl: string }).shareUrl || "").match(/ref=([^&]+)/)?.[1]!;
    expect(refCode).toBeTruthy();

    // ③ 被邀请人带 ref 参与 → 归因触发 bonus_spin +3
    const joinInvitee = await app.request("/public/draws/spin-e2e-mr/access-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inviteeToken}`,
        "CF-Connecting-IP": "10.0.0.102",
      },
      body: JSON.stringify({ email: inviteeEmail, refCode }),
    }, TEST_ENV);
    expect(joinInvitee.status).toBe(200);

    // ④ 验证分享者 spinsLeft：初始 1 + bonus_spin 3 = 4
    const [entryAfterRef] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, sharerEntryId));
    expect(Number(entryAfterRef?.spinsLeft ?? 0)).toBe(4);

    // ⑤ my-rewards 可见 spinsLeft=4
    const mrBefore = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${sharerToken}` },
    }, TEST_ENV);
    const mrBodyBefore = await mrBefore.json() as {
      rewards: Array<{ slug: string; spinsLeft: number; coupons: string[] }>;
    };
    expect(mrBodyBefore.rewards).toHaveLength(1);
    expect(mrBodyBefore.rewards[0]!.slug).toBe("spin-e2e-mr");
    expect(mrBodyBefore.rewards[0]!.spinsLeft).toBe(4);

    // ⑥ 分享者使用 1 次 bonus spin（performInstantSpin）
    const spinResult = await performInstantSpin(db, {
      slug: "spin-e2e-mr",
      identityType: "user_id",
      identityValue: sharerId,
      idempotencyKey: `spin-e2e-${Date.now()}`,
    });
    expect(spinResult.spinsUsed).toBe(1);
    expect(spinResult.spinsLeft).toBe(3); // 4 - 1 = 3

    // ⑦ my-rewards 更新：spinsLeft 从 4 递减到 3
    const mrAfter = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${sharerToken}` },
    }, TEST_ENV);
    const mrBodyAfter = await mrAfter.json() as {
      rewards: Array<{ slug: string; spinsLeft: number; coupons: string[] }>;
    };
    expect(mrBodyAfter.rewards).toHaveLength(1);
    expect(mrBodyAfter.rewards[0]!.spinsLeft).toBe(3);
  });
});

describe("bonus_coupon 核销后 my-rewards 不显示已核销券", () => {
  it("核销前券在 my-rewards 可见，核销后从 my-rewards 消失", async () => {
    const sharerId = "redeem-sharer";
    const sharerEmail = "redeem-sharer@test.com";
    const inviteeId = "redeem-invitee";
    const inviteeEmail = "redeem-invitee@test.com";
    await db.insert(tenants).values({ id: TENANT, name: "my-rewards" });
    await db.insert(users).values([
      { id: sharerId, username: "redeem-sharer", email: sharerEmail, passwordHash: "x" },
      { id: inviteeId, username: "redeem-invitee", email: inviteeEmail, passwordHash: "x" },
    ]);

    const drawId = await seedDraw({
      publicSlug: "redeem-e2e-mr",
      participationMode: "registered",
      promotionConfig: JSON.stringify({
        version: 1,
        referralRewardDefs: [
          { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_coupon", couponLabel: "redeem-test" } },
        ],
      }),
    });
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "REDEEM-COUPON-1", label: "redeem-test", status: "available",
    });

    const app = createApp();
    const sharerToken = await signJwt({ sub: sharerId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);
    const inviteeToken = await signJwt({ sub: inviteeId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);

    // ① 分享者参与
    const joinSharer = await app.request("/public/draws/redeem-e2e-mr/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sharerToken}`, "CF-Connecting-IP": "10.0.0.111" },
      body: JSON.stringify({ email: sharerEmail }),
    }, TEST_ENV);
    expect(joinSharer.status).toBe(200);
    const sharerEntryId = (await joinSharer.json() as { entryId: string }).entryId;

    // ② 生成分享链接
    const shareRes = await app.request("/public/draws/redeem-e2e-mr/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.111" },
      body: JSON.stringify({ entryId: sharerEntryId }),
    }, TEST_ENV);
    expect(shareRes.status).toBe(200);
    const refCode = String((await shareRes.json() as { shareUrl: string }).shareUrl || "").match(/ref=([^&]+)/)?.[1]!;

    // ③ 被邀请人带 ref 参与 → 分享者获 bonus_coupon
    const joinInvitee = await app.request("/public/draws/redeem-e2e-mr/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${inviteeToken}`, "CF-Connecting-IP": "10.0.0.112" },
      body: JSON.stringify({ email: inviteeEmail, refCode }),
    }, TEST_ENV);
    expect(joinInvitee.status).toBe(200);

    // ④ 核销前：my-rewards 可见该券
    const mrBefore = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${sharerToken}` },
    }, TEST_ENV);
    const bodyBefore = await mrBefore.json() as { rewards: Array<{ coupons: string[] }> };
    expect(bodyBefore.rewards[0]!.coupons).toContain("REDEEM-COUPON-1");

    // ⑤ 分享者核销该券（L1 自助核销：POST /public/coupons/redeem + JWT 免 OTP）
    const redeemRes = await app.request("/public/coupons/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sharerToken}`, "CF-Connecting-IP": "10.0.0.111" },
      body: JSON.stringify({ code: "REDEEM-COUPON-1", email: sharerEmail, otp: "" }),
    }, TEST_ENV);
    expect(redeemRes.status).toBe(200);
    const redeemBody = await redeemRes.json() as { ok: boolean; redeemed: boolean };
    expect(redeemBody.ok).toBe(true);
    expect(redeemBody.redeemed).toBe(true);

    // ⑥ 核销后：my-rewards 不再包含已核销的券（status 从 issued → redeemed，被 WHERE 过滤）
    const mrAfter = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${sharerToken}` },
    }, TEST_ENV);
    const bodyAfter = await mrAfter.json() as { rewards: Array<{ coupons: string[] }> };
    expect(bodyAfter.rewards[0]!.coupons).not.toContain("REDEEM-COUPON-1");
  });
});

describe("my-rewards 跨活动聚合", () => {
  it("同一用户参与 2 个活动，my-rewards 返回 2 条奖励记录", async () => {
    const userId = "multi-activity-user";
    const userEmail = "multi@test.com";
    await db.insert(tenants).values({ id: TENANT, name: "my-rewards" });
    await db.insert(users).values({ id: userId, username: "multi-user", email: userEmail, passwordHash: "x" });

    // 两个独立活动（设 maxSpinsPerEntry 使 spinsLeft>0，验证初始额度在多活动中各自独立）
    await seedDraw({ publicSlug: "multi-a", participationMode: "registered", maxSpinsPerEntry: 3 });
    await seedDraw({ publicSlug: "multi-b", participationMode: "registered", maxSpinsPerEntry: 3 });

    const app = createApp();
    const token = await signJwt({ sub: userId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);

    // ① 参与活动 A
    const joinA = await app.request("/public/draws/multi-a/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "CF-Connecting-IP": "10.0.0.121" },
      body: JSON.stringify({ email: userEmail }),
    }, TEST_ENV);
    expect(joinA.status).toBe(200);

    // ② 参与活动 B
    const joinB = await app.request("/public/draws/multi-b/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "CF-Connecting-IP": "10.0.0.122" },
      body: JSON.stringify({ email: userEmail }),
    }, TEST_ENV);
    expect(joinB.status).toBe(200);

    // ③ my-rewards 返回 2 条（每个活动一条）
    const mrRes = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${token}` },
    }, TEST_ENV);
    expect(mrRes.status).toBe(200);
    const body = await mrRes.json() as {
      rewards: Array<{ slug: string; spinsLeft: number; coupons: string[] }>;
    };
    expect(body.rewards).toHaveLength(2);
    const slugs = body.rewards.map(r => r.slug).sort();
    expect(slugs).toEqual(["multi-a", "multi-b"]);
    // 每条 spinsLeft=1（初始参与次数）
    for (const r of body.rewards) {
      expect(r.spinsLeft).toBe(1);
    }
  });
});

describe("open 模式端到端旅程：分享 → 加入 → 归因 → 奖励 → 使用 → 核销", () => {
  it("open email 分享者：被邀请人加入后获 bonus_spin + bonus_coupon，spin 使用 + 券核销后 my-rewards 正确更新", async () => {
    // ── 准备 ──
    const sharerEmail = "open-e2e-sharer@test.com";
    const sharerUserId = "open-e2e-sharer-uid";
    const inviteeEmail = "open-e2e-invitee@test.com";
    await db.insert(tenants).values({ id: TENANT, name: "my-rewards" });
    await db.insert(users).values({
      id: sharerUserId, username: "open-e2e-sharer", email: sharerEmail, passwordHash: "x",
    });

    // instant + open 活动：bonus_spin(+2) + bonus_coupon(1 张)
    const drawId = await seedDraw({
      publicSlug: "open-e2e-journey",
      participationMode: "open",
      experienceType: "wheel",
      resultMode: "instant",
      maxSpinsPerEntry: 5,
      promotionConfig: JSON.stringify({
        version: 1,
        referralRewardDefs: [
          { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
          { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_coupon", couponLabel: "open-invite" } },
        ],
      }),
    });
    // 码池：1 个 spin 奖品 + 1 个邀请券
    await db.insert(couponCodes).values([
      { id: crypto.randomUUID(), tenantId: TENANT, drawId, code: "OPEN-SPIN-PRIZE", label: "spin奖", status: "available" },
      { id: crypto.randomUUID(), tenantId: TENANT, drawId, code: "OPEN-INVITE-E2E", label: "open-invite", status: "available" },
    ]);

    // 关闭 OTP，使 open 模式 /join 可免验证码直接参与
    await db.insert(systemConfig).values({ key: "enable_email_verification", value: "false" })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value: "false" } });

    const app = createApp();
    const sharerToken = await signJwt({ sub: sharerUserId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);

    // ── 旅程 ──

    // ① 分享者 open 参与（email 身份）
    const joinSharer = await app.request("/public/draws/open-e2e-journey/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.201" },
      body: JSON.stringify({ email: sharerEmail }),
    }, TEST_ENV);
    expect(joinSharer.status).toBe(200);
    const sharerEntryId = (await joinSharer.json() as { entryId: string }).entryId;

    // ② 分享者生成分享链接
    const shareRes = await app.request("/public/draws/open-e2e-journey/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.201" },
      body: JSON.stringify({ entryId: sharerEntryId }),
    }, TEST_ENV);
    expect(shareRes.status).toBe(200);
    const refCode = String((await shareRes.json() as { shareUrl: string }).shareUrl || "").match(/ref=([^&]+)/)?.[1]!;
    expect(refCode).toBeTruthy();

    // ③ 被邀请人带 ref 参与 → 归因 → bonus_spin(+2) + bonus_coupon 发放
    const joinInvitee = await app.request("/public/draws/open-e2e-journey/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.202" },
      body: JSON.stringify({ email: inviteeEmail, refCode }),
    }, TEST_ENV);
    expect(joinInvitee.status).toBe(200);

    // ④ 验证归因：joined_count=1，券 issued 给分享者
    const [share] = await db.select().from(shareRecords).where(eq(shareRecords.shareCode, refCode));
    expect(share?.joinedCount).toBe(1);
    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.code, "OPEN-INVITE-E2E"));
    expect(coupon?.status).toBe("issued");
    expect(coupon?.recipientEmail).toBe(sharerEmail);

    // ⑤ my-rewards 可见：spinsLeft=1(初始) + 2(bonus_spin) = 3，券可见
    const mr1 = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${sharerToken}` },
    }, TEST_ENV);
    expect(mr1.status).toBe(200);
    const body1 = await mr1.json() as { rewards: Array<{ spinsLeft: number; coupons: string[] }> };
    expect(body1.rewards).toHaveLength(1);
    expect(body1.rewards[0]!.spinsLeft).toBe(3);
    expect(body1.rewards[0]!.coupons).toContain("OPEN-INVITE-E2E");

    // ⑥ 分享者使用 1 次 bonus spin（open 模式 entry 是 email 身份）
    const spinResult = await performInstantSpin(db, {
      slug: "open-e2e-journey",
      identityType: "email",
      identityValue: sharerEmail,
      idempotencyKey: `open-e2e-spin-${Date.now()}`,
    });
    expect(spinResult.spinsUsed).toBe(1);
    expect(spinResult.spinsLeft).toBe(2); // 3 - 1 = 2

    // ⑦ my-rewards spinsLeft 更新为 2
    const mr2 = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${sharerToken}` },
    }, TEST_ENV);
    const body2 = await mr2.json() as { rewards: Array<{ spinsLeft: number; coupons: string[] }> };
    expect(body2.rewards[0]!.spinsLeft).toBe(2);
    expect(body2.rewards[0]!.coupons).toContain("OPEN-INVITE-E2E"); // 券仍在

    // ⑧ 分享者核销优惠券
    const redeemRes = await app.request("/public/coupons/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sharerToken}`, "CF-Connecting-IP": "10.0.0.201" },
      body: JSON.stringify({ code: "OPEN-INVITE-E2E", email: sharerEmail, otp: "" }),
    }, TEST_ENV);
    expect(redeemRes.status).toBe(200);
    const redeemBody = await redeemRes.json() as { ok: boolean; redeemed: boolean };
    expect(redeemBody.ok).toBe(true);
    expect(redeemBody.redeemed).toBe(true);

    // ⑨ my-rewards：券消失（status → redeemed），spinsLeft 仍为 2
    const mr3 = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${sharerToken}` },
    }, TEST_ENV);
    const body3 = await mr3.json() as { rewards: Array<{ spinsLeft: number; coupons: string[] }> };
    expect(body3.rewards[0]!.spinsLeft).toBe(2);
    expect(body3.rewards[0]!.coupons).not.toContain("OPEN-INVITE-E2E");
  });
});
