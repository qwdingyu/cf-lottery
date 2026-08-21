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
 * 1. 路由基本行为：无/无效 JWT → 401；有效 JWT 但无 user_id 参与记录 → 空数组。
 * 2. 正向闭环：registered（user_id）分享者推广 → 被邀请人带 ref 参与 →
 *    joinedCount+1 → bonus_spin + bonus_coupon 发放 → 分享者 my-rewards
 *    能查到 spinsLeft 与优惠券（证明整条「推广 → 奖励 → 展示」链路真实闭环）。
 * 3. 结构性边界：open（email 身份）推广者的奖励**不会**出现在 my-rewards——
 *    my-rewards 只查 identityType='user_id' 的参与记录（docs/257 §5.2 原因A）。
 *    固化这一预期，防止未来查询逻辑被改动时悄悄破坏或意外改变语义。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
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

describe("结构性边界：open（email 身份）推广者的奖励不出现在 my-rewards", () => {
  it("email 身份参与并推广成功后，my-rewards 仍返回空（docs/257 §5.2 原因A）", async () => {
    const sharerEmail = "open-sharer@test.com";
    const inviteeEmail = "open-invitee@test.com";
    await db.insert(tenants).values({ id: TENANT, name: "my-rewards" });

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

    // ④ 分享者（任意 user_id JWT）查 my-rewards：email 身份 entry 查不到 → 空数组
    const token = await signJwt({ sub: "some-registered-user", tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);
    const mrRes = await app.request("/public/my-rewards", {
      headers: { Authorization: `Bearer ${token}` },
    }, TEST_ENV);
    expect(mrRes.status).toBe(200);
    const body = await mrRes.json() as { rewards: unknown[] };
    expect(body.rewards).toEqual([]);
  });
});
