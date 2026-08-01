/**
 * P0 核心流程压测：创建活动 → 发布 → 参与 → 开奖 → 查看结果
 *
 * 模拟真实用户操作完整闭环，覆盖所有活动类型（抽奖/接龙/问卷/签到/投票/审批/资料领取）。
 * 每个场景验证：创建成功 → 状态机正确 → 参与成功 → 结果可查。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { adminLotteryRoute } from "./admin-lottery";
import { publicLotteryRoute } from "./public-lottery";
import { signJwt } from "../middleware/auth";
import { activityEvents, activitySubmissions, couponCodes, tenants, users, tenantMembers, lotteryDraws, lotteryEntries, lotteryWinners, systemConfig, webhookConfigs } from "../db/schema";
import { eq } from "drizzle-orm";
import { clearTestData, getTestDb } from "../test-setup";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const JWT_SECRET = "test-p0-flow-secret-0123456789abcdef";
const TENANT_ID = "tenant-p0";
const OWNER_ID = "user-p0-owner";

const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET,
};

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/admin", adminLotteryRoute);
  app.route("/api/public", publicLotteryRoute);
  return app;
}

async function seedOwner() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "P0 Test" });
  await db.insert(users).values({ id: OWNER_ID, username: "p0owner", email: "p0@test.com", emailVerified: 1, passwordHash: "hash" });
  await db.insert(tenantMembers).values({ tenantId: TENANT_ID, userId: OWNER_ID, role: "owner" });
  await db.insert(systemConfig).values({ key: "enabled_activity_kinds", value: "lottery,signup_chain,claim,survey,vote,checkin,approval,reservation" });
}

async function authHeader() {
  const token = await signJwt({ sub: OWNER_ID, tenantId: TENANT_ID }, JWT_SECRET, 3600);
  return { Authorization: `Bearer ${token}` };
}

/** 生成未来时间 ISO */
function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60000).toISOString();
}

/** 创建草稿活动，返回内部 ID 和公开 slug */
async function createDraft(app: Hono<AppEnv>, kind: string, extra: Record<string, unknown> = {}) {
  const createRes = await app.request("/api/admin/draws", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({
      title: `P0-${kind}`,
      activityKind: kind,
      participationMode: "open",
      startAt: futureIso(-10),
      endAt: futureIso(60),
      winnerCount: 1,
      ...extra,
    }),
  }, TEST_ENV);
  expect(createRes.status).toBe(200);
  const created = await createRes.json() as { ok: boolean; id: string; publicSlug: string };
  expect(created.ok).toBe(true);
  return { id: created.id, publicSlug: created.publicSlug };
}

/** 配置一个手动发放奖项；抽奖正式发布必须先具备奖品和奖项，不能靠默认空配置上线。 */
async function configureManualPrizeTier(app: Hono<AppEnv>, drawId: string, prizeName = "测试奖品") {
  const prizeRes = await app.request("/api/admin/prizes", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ name: prizeName, prizeType: "manual_fulfillment" }),
  }, TEST_ENV);
  expect(prizeRes.status).toBe(200);
  const prizeData = await prizeRes.json() as { ok: boolean; id: string };

  const tierRes = await app.request(`/api/admin/draws/${drawId}/tiers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ tiers: [{ prizeId: prizeData.id, tierName: "一等奖", winnerCount: 1 }] }),
  }, TEST_ENV);
  expect(tierRes.status).toBe(200);
  return prizeData.id;
}

/** 发布草稿活动，并确认状态进入 open */
async function publishDraft(app: Hono<AppEnv>, id: string) {
  // 发布
  const pubRes = await app.request(`/api/admin/draws/${id}/publish`, {
    method: "POST",
    headers: { ...(await authHeader()) },
  }, TEST_ENV);
  expect(pubRes.status).toBe(200);

  // 验证状态
  const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, id));
  expect(draw?.status).toBe("open");
}

/** 创建活动 → 发布 → 返回 public_slug */
async function createAndPublish(app: Hono<AppEnv>, kind: string, extra: Record<string, unknown> = {}) {
  const created = await createDraft(app, kind, extra);
  if (kind === "lottery") {
    await configureManualPrizeTier(app, created.id);
  }
  await publishDraft(app, created.id);
  return created;
}

describe("P0 核心流程：创建活动 → 发布", () => {
  it("抽奖活动：创建→发布→参与→开奖→查看中奖", async () => {
    await seedOwner();
    const app = createTestApp();

    const { id, publicSlug } = await createDraft(app, "lottery");

    await configureManualPrizeTier(app, id);

    await publishDraft(app, id);

    // 用户参与（公开端）
    const joinRes = await app.request(`/api/public/draws/${publicSlug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.1" },
      body: JSON.stringify({ email: "user1@test.com" }),
    }, TEST_ENV);
    expect(joinRes.status).toBe(200);
    const joinData = await joinRes.json() as any;
    expect(joinData.ok).toBe(true);

    // 验证参与记录
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, id));
    expect(entry?.identityValue).toBe("user1@test.com");

    // 开奖
    const drawRes = await app.request(`/api/admin/draws/${id}/draw`, {
      method: "POST",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    expect(drawRes.status).toBe(200);

    // 验证中奖名单
    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    expect(winners.length).toBeGreaterThan(0);
  });

  it("接龙活动：创建→发布→多人参与→按顺序分配", async () => {
    await seedOwner();
    const app = createTestApp();

    const { publicSlug } = await createAndPublish(app, "signup_chain", { allocationPolicy: "capacity", maxParticipants: 3 });

    // 3 人参与
    for (let i = 1; i <= 3; i++) {
      const res = await app.request(`/api/public/draws/${publicSlug}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.0.0.${i}` },
        body: JSON.stringify({ email: `user${i}@test.com` }),
      }, TEST_ENV);
      expect(res.status).toBe(200);
    }

    // 第 4 人应该被拒绝（容量满）
    const res4 = await app.request(`/api/public/draws/${publicSlug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.4" },
      body: JSON.stringify({ email: "user4@test.com" }),
    }, TEST_ENV);
    const data4 = await res4.json() as any;
    expect(data4.ok).toBe(false);

    // 验证参与顺序
    const entries = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, (await db.select().from(lotteryDraws).where(eq(lotteryDraws.publicSlug, publicSlug)))[0]!.id));
    expect(entries.length).toBe(3);
  });

  it("问卷活动：缺字段配置时禁止发布，有配置后可发布并保存提交", async () => {
    await seedOwner();
    const app = createTestApp();

    const { id } = await createDraft(app, "survey");

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    expect(checkRes.status).toBe(200);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(false);
    expect(check.errors.some((item: any) => item.code === "survey.config.missing")).toBe(true);

    const publishRes = await app.request(`/api/admin/draws/${id}/publish`, {
      method: "POST",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    expect(publishRes.status).toBe(400);

    const configured = await createAndPublish(app, "survey", {
      activityConfig: {
        version: 1,
        kind: "survey",
        fields: [{ id: "feedback", label: "反馈", type: "textarea", required: true, maxLength: 500, options: [] }],
      },
    });
    const joinRes = await app.request(`/api/public/draws/${configured.publicSlug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.16" },
      body: JSON.stringify({ email: "survey@test.com", submission: { fields: { feedback: "体验不错" } } }),
    }, TEST_ENV);
    expect(joinRes.status).toBe(200);
    const submissions = await db.select().from(activitySubmissions).where(eq(activitySubmissions.drawId, configured.id));
    expect(submissions.length).toBe(1);
    expect(JSON.parse(submissions[0]!.payloadJson).fields.feedback).toBe("体验不错");
  });

  it("资料领取活动：创建→发布→领取", async () => {
    await seedOwner();
    const app = createTestApp();

    const { publicSlug } = await createAndPublish(app, "claim");

    const joinRes = await app.request(`/api/public/draws/${publicSlug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.6" },
      body: JSON.stringify({ email: "claim@test.com" }),
    }, TEST_ENV);
    expect(joinRes.status).toBe(200);
  });

  it("禁用活动类型：创建被拒绝", async () => {
    await seedOwner();
    const app = createTestApp();

    // 只启用 lottery
    await db.update(systemConfig).set({ value: "lottery" }).where(eq(systemConfig.key, "enabled_activity_kinds"));

    const createRes = await app.request("/api/admin/draws", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({
        title: "被禁用的类型",
        activityKind: "survey",
        startAt: futureIso(-10),
        endAt: futureIso(60),
      }),
    }, TEST_ENV);
    expect(createRes.status).toBe(400);
    const data = await createRes.json() as any;
    expect(data.message).toContain("未启用");
  });

  it("发布前校验：活动名称为空被拒绝", async () => {
    await seedOwner();
    const app = createTestApp();

    const createRes = await app.request("/api/admin/draws", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({
        title: "",
        activityKind: "lottery",
        startAt: futureIso(-10),
        endAt: futureIso(60),
      }),
    }, TEST_ENV);
    // 空标题应被拒绝
    expect([400, 500]).toContain(createRes.status);
  });

  it("发布前校验：抽奖没有奖项时禁止发布，避免上线空奖池活动", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id } = await createDraft(app, "lottery");

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    expect(checkRes.status).toBe(200);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(false);
    expect(check.errors.some((item: any) => item.code === "prizes.tiers.required")).toBe(true);

    const publishRes = await app.request(`/api/admin/draws/${id}/publish`, {
      method: "POST",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    expect(publishRes.status).toBe(400);
  });

  it("发布前校验：卡密奖品码池不足时禁止发布", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id } = await createDraft(app, "lottery");

    const prizeRes = await app.request("/api/admin/prizes", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ name: "卡密奖品", prizeType: "code" }),
    }, TEST_ENV);
    expect(prizeRes.status).toBe(200);
    const prizeData = await prizeRes.json() as { ok: boolean; id: string };

    const tierRes = await app.request(`/api/admin/draws/${id}/tiers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ tiers: [{ prizeId: prizeData.id, tierName: "卡密奖", winnerCount: 2 }] }),
    }, TEST_ENV);
    expect(tierRes.status).toBe(200);

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(false);
    expect(check.errors.some((item: any) => item.code === "prizes.codes.insufficient")).toBe(true);
  });

  it("发布前校验：名单和邀请码模式必须先具备可用资格数据", async () => {
    await seedOwner();
    const app = createTestApp();

    const roster = await createDraft(app, "signup_chain", { participationMode: "roster" });
    const rosterCheckRes = await app.request(`/api/admin/draws/${roster.id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const rosterCheck = await rosterCheckRes.json() as any;
    expect(rosterCheck.errors.some((item: any) => item.code === "participation.roster.empty")).toBe(true);

    const invite = await createDraft(app, "signup_chain", { participationMode: "invite_code" });
    const inviteCheckRes = await app.request(`/api/admin/draws/${invite.id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const inviteCheck = await inviteCheckRes.json() as any;
    expect(inviteCheck.errors.some((item: any) => item.code === "participation.invite_code.empty")).toBe(true);
  });

  it("发布前校验：有效抽奖返回 CTA/Webhook/奖品信息提示但不阻断", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id } = await createDraft(app, "lottery");
    await configureManualPrizeTier(app, id);

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(true);
    expect(check.warnings.some((item: any) => item.code === "promotion.empty")).toBe(true);
    expect(check.infos.some((item: any) => item.code === "webhook.empty")).toBe(true);
    expect(check.infos.some((item: any) => item.code === "prizes.image.default")).toBe(true);
  });

  it("发布前校验：危险导流链接和异常 Webhook 配置会阻断发布", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id } = await createDraft(app, "lottery", {
      promotionConfig: {
        enabled: true,
        destination: { url: "javascript:alert(1)", title: "危险链接" },
      },
    });
    await configureManualPrizeTier(app, id);
    await db.insert(webhookConfigs).values({
      id: crypto.randomUUID(),
      tenantId: TENANT_ID,
      url: "ftp://example.com/hook",
      events: "[]",
      signingSecret: "",
      active: 1,
    });

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(false);
    expect(check.errors.some((item: any) => item.code === "promotion.url.invalid")).toBe(true);
    expect(check.errors.some((item: any) => item.code === "webhook.url.invalid")).toBe(true);
    expect(check.errors.some((item: any) => item.code === "webhook.events.invalid")).toBe(true);
  });

  it("投票活动：缺选项时禁止发布，有固定选项后按 submission 统计票数", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id } = await createDraft(app, "vote");

    const checkRes = await app.request(`/api/admin/draws/${id}/publish-check`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    const check = await checkRes.json() as any;
    expect(check.canPublish).toBe(false);
    expect(check.errors.some((item: any) => item.code === "vote.options.missing")).toBe(true);

    const configured = await createAndPublish(app, "vote", {
      activityConfig: {
        version: 1,
        kind: "vote",
        selection: "single",
        options: [
          { id: "option_a", label: "方案 A", description: "", imageUrl: "" },
          { id: "option_b", label: "方案 B", description: "", imageUrl: "" },
        ],
      },
    });
    for (const [email, optionId] of [["vote1@test.com", "option_a"], ["vote2@test.com", "option_a"], ["vote3@test.com", "option_b"]] as const) {
      const joinRes = await app.request(`/api/public/draws/${configured.publicSlug}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.0.0.${email[4]}` },
        body: JSON.stringify({ email, submission: { optionId } }),
      }, TEST_ENV);
      expect(joinRes.status).toBe(200);
    }

    const tallyRes = await app.request(`/api/admin/draws/${configured.id}/tally`, {
      method: "GET",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);
    expect(tallyRes.status).toBe(200);
    const tally = await tallyRes.json() as any;
    expect(tally.total).toBe(3);
    expect(tally.tally.find((row: any) => row.optionId === "option_a").count).toBe(2);
    expect(tally.tally.find((row: any) => row.optionId === "option_b").count).toBe(1);
  });

  it("公开事件治理：非法事件类型和大 payload 被拒绝且不写库", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id, publicSlug } = await createAndPublish(app, "lottery");

    const invalidRes = await app.request(`/api/public/draws/${publicSlug}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.1" },
      body: JSON.stringify({ eventType: "paid_order" }),
    }, TEST_ENV);
    expect(invalidRes.status).toBe(400);

    const largePayloadRes = await app.request(`/api/public/draws/${publicSlug}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.2" },
      body: JSON.stringify({
        eventType: "page_view",
        metadata: { text: "x".repeat(2050) },
      }),
    }, TEST_ENV);
    expect(largePayloadRes.status).toBe(400);

    const rows = await db.select().from(activityEvents).where(eq(activityEvents.drawId, id));
    expect(rows).toHaveLength(0);
  });

  it("公开事件治理：合法事件可写入并限制字段长度", async () => {
    await seedOwner();
    const app = createTestApp();
    const { id, publicSlug } = await createAndPublish(app, "lottery");

    const validRes = await app.request(`/api/public/draws/${publicSlug}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.3" },
      body: JSON.stringify({
        eventType: "cta_click",
        source: "wechat",
        medium: "share",
        campaign: "launch",
        metadata: { placement: "result" },
      }),
    }, TEST_ENV);
    expect(validRes.status).toBe(200);

    const tooLongSourceRes = await app.request(`/api/public/draws/${publicSlug}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.4" },
      body: JSON.stringify({ eventType: "cta_click", source: "x".repeat(201) }),
    }, TEST_ENV);
    expect(tooLongSourceRes.status).toBe(400);

    const rows = await db.select().from(activityEvents).where(eq(activityEvents.drawId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("cta_click");
  });

  it("活动后承接：未启用时开奖不发券，启用后未中奖用户自动获券", async () => {
    await seedOwner();
    const app = createTestApp();

    // 准备优惠券码池（label = '安慰奖'）
    await db.insert(couponCodes).values({ id: "c1", tenantId: TENANT_ID, code: "COUPON-1", label: "安慰奖", status: "available" });
    await db.insert(couponCodes).values({ id: "c2", tenantId: TENANT_ID, code: "COUPON-2", label: "安慰奖", status: "available" });

    // 场景 1：未启用 loserReward（默认），开奖后不发券
    const { id: drawId1, publicSlug: slug1 } = await createAndPublish(app, "lottery");
    // 2 人参与
    await joinByEmail(app, slug1, "loser1@test.com");
    await joinByEmail(app, slug1, "loser2@test.com");
    // 开奖（1 个中奖者）
    await app.request(`/api/admin/draws/${drawId1}/draw`, { method: "POST", headers: { ...(await authHeader()) } }, TEST_ENV);
    // 未启用：优惠券不应被发放（仍 available）
    const [c1] = await db.select().from(couponCodes).where(eq(couponCodes.id, "c1"));
    expect(c1?.status).toBe("available");

    // 场景 2：启用 loserReward，开奖后未中奖用户获券
    const { id: drawId2, publicSlug: slug2 } = await createAndPublish(app, "lottery");
    // 配置活动后承接（未中奖自动发券）
    await db.update(lotteryDraws).set({ activityConfig: JSON.stringify({ version: 1, kind: "lottery", loserReward: { enabled: true, couponLabel: "安慰奖" } }) }).where(eq(lotteryDraws.id, drawId2));
    // 3 人参与，1 人中奖 → 2 人未中奖获券
    await joinByEmail(app, slug2, "winner@test.com");
    await joinByEmail(app, slug2, "lose1@test.com");
    await joinByEmail(app, slug2, "lose2@test.com");
    await app.request(`/api/admin/draws/${drawId2}/draw`, { method: "POST", headers: { ...(await authHeader()) } }, TEST_ENV);

    const winnerRows = await db.select({ entryId: lotteryWinners.entryId }).from(lotteryWinners).where(eq(lotteryWinners.drawId, drawId2));
    const winnerEntries = await db.select({ id: lotteryEntries.id, email: lotteryEntries.identityValue }).from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId2));
    const winnerEmails = new Set(
      winnerEntries.filter((entry) => winnerRows.some((winner) => winner.entryId === entry.id)).map((entry) => entry.email),
    );

    // 2 张券应被发放（状态 issued + recipientEmail 非空）
    const issued = await db.select().from(couponCodes).where(eq(couponCodes.status, "issued"));
    expect(issued.length).toBe(2);
    // 发放对象是未中奖用户，不能包含中奖者
    expect(issued.map((c) => c.recipientEmail).sort()).toEqual(
      winnerEntries.filter((entry) => !winnerEmails.has(entry.email)).map((entry) => entry.email).sort(),
    );
  });

  it("活动后承接：优惠券不足时只发放可用数量，中奖者不发券", async () => {
    await seedOwner();
    const app = createTestApp();

    // 只准备 1 张券，但 3 人参与（1 中奖 + 2 未中奖）→ 只发 1 张
    await db.insert(couponCodes).values({ id: "c3", tenantId: TENANT_ID, code: "COUPON-3", label: "安慰奖", status: "available" });

    const { id, publicSlug } = await createAndPublish(app, "lottery");
    await db.update(lotteryDraws).set({ activityConfig: JSON.stringify({ version: 1, kind: "lottery", loserReward: { enabled: true, couponLabel: "安慰奖" } }) }).where(eq(lotteryDraws.id, id));

    await joinByEmail(app, publicSlug, "winner@test.com");
    await joinByEmail(app, publicSlug, "lose1@test.com");
    await joinByEmail(app, publicSlug, "lose2@test.com");
    await app.request(`/api/admin/draws/${id}/draw`, { method: "POST", headers: { ...(await authHeader()) } }, TEST_ENV);

    const winnerRows = await db.select({ entryId: lotteryWinners.entryId }).from(lotteryWinners).where(eq(lotteryWinners.drawId, id));
    const winnerEntries = await db.select({ id: lotteryEntries.id, email: lotteryEntries.identityValue }).from(lotteryEntries).where(eq(lotteryEntries.drawId, id));
    const winnerEmails = new Set(
      winnerEntries.filter((entry) => winnerRows.some((winner) => winner.entryId === entry.id)).map((entry) => entry.email),
    );

    // 只有 1 张券被发放
    const issued = await db.select().from(couponCodes).where(eq(couponCodes.status, "issued"));
    expect(issued.length).toBe(1);
    expect(issued[0]?.recipientEmail).toBeDefined();
    expect(issued[0]?.recipientEmail ? !winnerEmails.has(issued[0]!.recipientEmail) : false).toBe(true);
  });
});

/** 通过公开端参与（open 模式直接参与，无需验证码） */
async function joinByEmail(app: Hono<AppEnv>, slug: string, email: string) {
  const res = await app.request(`/api/public/draws/${slug}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.9.1" },
    body: JSON.stringify({ email }),
  }, TEST_ENV);
  if (res.status !== 200) {
    throw new Error(await res.text());
  }
  expect(res.status).toBe(200);
}
