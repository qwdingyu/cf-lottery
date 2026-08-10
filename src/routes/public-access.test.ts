/**
 * 公共访问令牌路由测试（docs/179）。
 *
 * 核心测试目标：
 * 1. P0-1 跨租户隔离：令牌绑定了 drawId，则只返回该 draw 下的卡密。
 *    防止同一 userId 因跨租户有多个活动时，凭一个令牌看到其他租户活动的卡密。
 * 2. 向后兼容：drawId 为空字符串时不做过滤，返回所有卡密。
 * 3. 令牌安全：无效/过期令牌返回 404，一次性令牌不可复用。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { publicAccessRoute } from "./public-access";
import { clearTestData, getTestDb } from "../test-setup";
import {
  accessTokens,
  authIdentities,
  lotteryDraws,
  lotteryEntries,
  lotteryWinners,
  lotteryPrizeTiers,
  prizes,
  prizeCodes,
  users,
  tenants,
} from "../db/schema";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];

const TEST_USER_ID = "test-user-id";
const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
};

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/public/access", publicAccessRoute);
  return app;
}

/**
 * SHA-256 哈希，返回十六进制小写字符串（与 access-token.ts 的 sha256Hex 逻辑一致）。
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 生成一个有效的访问令牌并存入数据库，返回 token 明文。
 * tokenHash 用 SHA-256 哈希后存储，与 consumeAccessToken 逻辑一致。
 */
async function createValidToken(opts: { drawId?: string; userId?: string } = {}): Promise<string> {
  const { drawId = "", userId = TEST_USER_ID } = opts;
  const token = crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + 600000).toISOString(); // 10 分钟后过期

  await db.insert(accessTokens).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash,
    purpose: "card_code",
    drawId,
    expiresAt,
    used: 0,
  });

  return token;
}

/**
 * 播种两个租户、两个活动、同一个用户在不同租户下的参与记录和卡密中奖。
 *
 * 租户A（draw-a）：活动 "抽奖A"，卡密 "CODE-A:SECRET-A"
 * 租户B（draw-b）：活动 "抽奖B"，卡密 "CODE-B:SECRET-B"
 * 用户 TEST_USER_ID 在两个活动中都有 entry 和 winner 记录，
 * 用于验证 P0-1 跨租户隔离：drawId 绑定后只返回该租户活动的卡密。
 */
async function seedTwoTenantDraws() {
  const now = new Date();

  // ── 租户A ──
  await db.insert(tenants).values({ id: "tenant-a", name: "租户A" });
  await db.insert(users).values({ id: TEST_USER_ID, username: "testuser", passwordHash: "test" });
  await db.insert(authIdentities).values({
    id: crypto.randomUUID(),
    userId: TEST_USER_ID,
    provider: "qq",
    providerUserId: "12345",
  });

  await db.insert(lotteryDraws).values({
    id: "draw-a",
    tenantId: "tenant-a",
    publicSlug: "public-slug-a",
    title: "抽奖A",
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    resultMode: "manual",
    startAt: new Date(now.getTime() - 86400000).toISOString(),
    endAt: new Date(now.getTime() + 86400000).toISOString(),
  });

  await db.insert(prizes).values({ id: "prize-a", tenantId: "tenant-a", name: "奖品A" });
  await db.insert(lotteryPrizeTiers).values({
    id: "tier-a",
    tenantId: "tenant-a",
    drawId: "draw-a",
    prizeId: "prize-a",
    tierName: "一等奖",
    winnerCount: 1,
  });
  await db.insert(prizeCodes).values({
    id: "code-a-1",
    tenantId: "tenant-a",
    prizeId: "prize-a",
    code: "CODE-A",
    secret: "SECRET-A",
    status: "issued",
  });
  await db.insert(lotteryEntries).values({
    id: "entry-a-1",
    tenantId: "tenant-a",
    drawId: "draw-a",
    identityType: "qq",
    identityValue: "12345",
    displayName: "测试用户",
    joinedAt: now.toISOString(),
  });
  await db.insert(lotteryWinners).values({
    id: "winner-a-1",
    tenantId: "tenant-a",
    drawId: "draw-a",
    tierId: "tier-a",
    entryId: "entry-a-1",
    identityType: "qq",
    identityValue: "12345",
    prizeCodeId: "code-a-1",
    drawnAt: now.toISOString(),
  });

  // ── 租户B ──
  await db.insert(tenants).values({ id: "tenant-b", name: "租户B" });

  await db.insert(lotteryDraws).values({
    id: "draw-b",
    tenantId: "tenant-b",
    publicSlug: "public-slug-b",
    title: "抽奖B",
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    resultMode: "manual",
    startAt: new Date(now.getTime() - 86400000).toISOString(),
    endAt: new Date(now.getTime() + 86400000).toISOString(),
  });

  await db.insert(prizes).values({ id: "prize-b", tenantId: "tenant-b", name: "奖品B" });
  await db.insert(lotteryPrizeTiers).values({
    id: "tier-b",
    tenantId: "tenant-b",
    drawId: "draw-b",
    prizeId: "prize-b",
    tierName: "一等奖",
    winnerCount: 1,
  });
  await db.insert(prizeCodes).values({
    id: "code-b-1",
    tenantId: "tenant-b",
    prizeId: "prize-b",
    code: "CODE-B",
    secret: "SECRET-B",
    status: "issued",
  });
  await db.insert(lotteryEntries).values({
    id: "entry-b-1",
    tenantId: "tenant-b",
    drawId: "draw-b",
    identityType: "qq",
    identityValue: "12345",
    displayName: "测试用户",
    joinedAt: now.toISOString(),
  });
  await db.insert(lotteryWinners).values({
    id: "winner-b-1",
    tenantId: "tenant-b",
    drawId: "draw-b",
    tierId: "tier-b",
    entryId: "entry-b-1",
    identityType: "qq",
    identityValue: "12345",
    prizeCodeId: "code-b-1",
    drawnAt: now.toISOString(),
  });
}

beforeAll(async () => {
  const ctx = await getTestDb();
  db = ctx.db;
  client = ctx.client;
});

beforeEach(async () => {
  await clearTestData(client);
});

describe("GET /api/public/access/card-codes", () => {
  it("缺少 token 参数时返回 400", async () => {
    const app = createTestApp();
    const res = await app.request("/api/public/access/card-codes", {}, TEST_ENV);
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain("缺少令牌参数");
  });

  it("无效令牌（不存在的哈希）返回 404", async () => {
    const app = createTestApp();
    const res = await app.request("/api/public/access/card-codes?token=invalid-token", {}, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("正常返回卡密列表（no drawId 过滤，向后兼容）", async () => {
    await seedTwoTenantDraws();
    const token = await createValidToken({ drawId: "" });
    const app = createTestApp();
    const res = await app.request(`/api/public/access/card-codes?token=${token}`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { cardCodes?: Array<unknown>; total?: number };
    // drawId 为空字符串时不过滤，应返回所有租户的卡密
    expect(body.total).toBe(2);
    expect(body.cardCodes).toHaveLength(2);
    expect(body.cardCodes!.some((c: any) => c.cardCode === "CODE-A:SECRET-A")).toBe(true);
    expect(body.cardCodes!.some((c: any) => c.cardCode === "CODE-B:SECRET-B")).toBe(true);
  });

  it("P0-1 跨租户隔离：drawId 绑定 draw-a 只返回租户A的卡密", async () => {
    await seedTwoTenantDraws();
    const token = await createValidToken({ drawId: "draw-a" });
    const app = createTestApp();
    const res = await app.request(`/api/public/access/card-codes?token=${token}`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { cardCodes?: Array<unknown>; total?: number };
    expect(body.total).toBe(1);
    expect(body.cardCodes).toHaveLength(1);
    expect(body.cardCodes![0]).toMatchObject({
      drawTitle: "抽奖A",
      cardCode: "CODE-A:SECRET-A",
    });
    // 不应包含租户B的卡密
    expect(body.cardCodes!.some((c: any) => c.cardCode === "CODE-B:SECRET-B")).toBe(false);
  });

  it("P0-1 跨租户隔离：drawId 绑定 draw-b 只返回租户B的卡密", async () => {
    await seedTwoTenantDraws();
    const token = await createValidToken({ drawId: "draw-b" });
    const app = createTestApp();
    const res = await app.request(`/api/public/access/card-codes?token=${token}`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { cardCodes?: Array<unknown>; total?: number };
    expect(body.total).toBe(1);
    expect(body.cardCodes).toHaveLength(1);
    expect(body.cardCodes![0]).toMatchObject({
      drawTitle: "抽奖B",
      cardCode: "CODE-B:SECRET-B",
    });
  });

  it("令牌一次性：使用后再次请求返回 404", async () => {
    await seedTwoTenantDraws();
    const token = await createValidToken({ drawId: "" });
    const app = createTestApp();
    const first = await app.request(`/api/public/access/card-codes?token=${token}`, {}, TEST_ENV);
    expect(first.status).toBe(200);
    const second = await app.request(`/api/public/access/card-codes?token=${token}`, {}, TEST_ENV);
    expect(second.status).toBe(404);
  });

  it("未找到用户身份时返回 404", async () => {
    const token = await createValidToken({ userId: "non-existent-user" });
    const app = createTestApp();
    const res = await app.request(`/api/public/access/card-codes?token=${token}`, {}, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("用户有 entry 但无中奖记录时返回空数组", async () => {
    const now = new Date();
    await db.insert(tenants).values({ id: "tenant-empty", name: "空租户" });
    await db.insert(users).values({ id: TEST_USER_ID, username: "emptytest", passwordHash: "test" });
    await db.insert(authIdentities).values({
      id: crypto.randomUUID(),
      userId: TEST_USER_ID,
      provider: "qq",
      providerUserId: "12345",
    });
    await db.insert(lotteryDraws).values({
      id: "draw-empty",
      tenantId: "tenant-empty",
      publicSlug: "public-slug-empty",
      title: "空活动",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "wheel",
      resultMode: "manual",
      startAt: new Date(now.getTime() - 86400000).toISOString(),
      endAt: new Date(now.getTime() + 86400000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: "entry-empty-1",
      tenantId: "tenant-empty",
      drawId: "draw-empty",
      identityType: "qq",
      identityValue: "12345",
      displayName: "测试用户",
      joinedAt: now.toISOString(),
    });

    const token = await createValidToken({ drawId: "draw-empty" });
    const app = createTestApp();
    const res = await app.request(`/api/public/access/card-codes?token=${token}`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { cardCodes?: Array<unknown>; total?: number };
    expect(body.total).toBe(0);
    expect(body.cardCodes).toHaveLength(0);
  });
});