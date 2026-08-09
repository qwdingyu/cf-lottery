/**
 * QQ 群助手入站路由测试（docs/167）。
 *
 * 这组测试先锁住安全边界与 SaaS 内置命令骨架：
 * - NapCat/OneBot 入站必须带共享 token；
 * - 未绑定群不写业务数据，只提示管理员配置；
 * - 已绑定群使用系统内置命令，不要求租户逐条创建命令。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { platformQQRoute } from "./platform-qq";
import { clearTestData, getTestDb } from "../test-setup";
import { activityEvents, lotteryDraws, lotteryEntries, platformTargets, tenants } from "../db/schema";
import { hashPlatformInboundSecret } from "../services/platform/security";
import { and, eq } from "drizzle-orm";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];

const TENANT_ID = "tenant-platform-qq";
const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
};
const INBOUND_SECRET = "qq-inbound-secret";

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/platform/qq", platformQQRoute);
  return app;
}

function qqMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_type: "group",
    group_id: 123456,
    user_id: 998877,
    message_id: 42,
    message: [{ type: "text", data: { text: "/帮助" } }],
    sender: { nickname: "测试用户" },
    ...overrides,
  };
}

async function seedTarget(builtinCommandsJson = "{}") {
  await db.insert(tenants).values({ id: TENANT_ID, name: "QQ 群助手测试租户" });
  await db.insert(platformTargets).values({
    id: "pt-qq-1",
    tenantId: TENANT_ID,
    platform: "qq",
    targetId: "123456",
    targetName: "测试群",
    activeDrawId: "draw-qq-1",
    activePublicSlug: "qq-lottery",
    assistantEnabled: 1,
    adapterDeploymentMode: "tenant_hosted",
    adapterProvider: "napcat",
    adapterConfigJson: JSON.stringify({ baseUrl: "http://tenant.example:3000" }),
    inboundSecretHash: await hashPlatformInboundSecret(INBOUND_SECRET),
    builtinCommandsJson,
  });
}

async function seedCheckinDraw(status = "open") {
  const now = new Date();
  await db.insert(lotteryDraws).values({
    id: "draw-qq-1",
    tenantId: TENANT_ID,
    title: "QQ 签到活动",
    publicSlug: "qq-lottery",
    status,
    activityKind: "checkin",
    participationMode: "open",
    experienceType: "submit",
    resultMode: "manual",
    startAt: new Date(now.getTime() - 3600000).toISOString(),
    endAt: new Date(now.getTime() + 3600000).toISOString(),
    activityConfig: "{}",
  });
}

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

beforeEach(async () => {
  await clearTestData(client);
});

describe("POST /api/platform/qq/message", () => {
  it("缺少入站 token 返回 403", async () => {
    await seedTarget();
    const app = createTestApp();
    const res = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(qqMessage()),
    }, TEST_ENV);

    expect(res.status).toBe(403);
  });

  it("非群消息直接忽略", async () => {
    const app = createTestApp();
    const res = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CF-Lottery-Platform-Token": INBOUND_SECRET,
      },
      body: JSON.stringify(qqMessage({ message_type: "private", group_id: undefined })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reason?: string };
    expect(body.handled).toBe(false);
    expect(body.reason).toBe("非群消息");
  });

  it("未绑定群返回 404，不进入业务写入", async () => {
    const app = createTestApp();
    const res = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INBOUND_SECRET}`,
      },
      body: JSON.stringify(qqMessage({ message: "/签到" })),
    }, TEST_ENV);

    expect(res.status).toBe(404);
  });

  it("已绑定群返回当前启用的内置命令帮助", async () => {
    await seedTarget(JSON.stringify({ spinEnabled: false }));
    const app = createTestApp();
    const res = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CF-Lottery-Platform-Token": INBOUND_SECRET,
      },
      body: JSON.stringify(qqMessage()),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("/签到");
    expect(body.reply).not.toContain("/抽奖");
    expect(body.reply).toContain("/我的奖品");
  });

  it("已关闭的内置命令返回关闭提示", async () => {
    await seedTarget(JSON.stringify({ shareEnabled: false }));
    const app = createTestApp();
    const res = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CF-Lottery-Platform-Token": INBOUND_SECRET,
      },
      body: JSON.stringify(qqMessage({ message: "/分享" })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("未启用 /分享");
  });

  it("/签到 使用 QQ 身份创建参与记录并记录群来源事件", async () => {
    await seedTarget();
    await seedCheckinDraw();
    const app = createTestApp();
    const res = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CF-Lottery-Platform-Token": INBOUND_SECRET,
      },
      body: JSON.stringify(qqMessage({ message: "/签到" })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("签到成功");

    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.tenantId, TENANT_ID),
        eq(lotteryEntries.drawId, "draw-qq-1"),
        eq(lotteryEntries.identityType, "qq"),
      ));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.identityValue).toContain("998877");
    expect(entries[0]?.displayName).toBe("测试用户");

    const events = await db
      .select()
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT_ID),
        eq(activityEvents.drawId, "draw-qq-1"),
        eq(activityEvents.eventType, "participation_completed"),
        eq(activityEvents.source, "qq_group"),
        eq(activityEvents.medium, "platform_command"),
      ));
    expect(events).toHaveLength(1);
    expect(events[0]?.entryId).toBe(entries[0]?.id);
  });

  it("/签到 同一天重复调用不重复创建参与记录", async () => {
    await seedTarget();
    await seedCheckinDraw();
    const app = createTestApp();
    const request = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CF-Lottery-Platform-Token": INBOUND_SECRET,
      },
      body: JSON.stringify(qqMessage({ message: "/签到" })),
    };

    const first = await app.request("/api/platform/qq/message", request, TEST_ENV);
    expect(first.status).toBe(200);
    const second = await app.request("/api/platform/qq/message", request, TEST_ENV);
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { reply?: string };
    expect(secondBody.reply).toContain("已参与");

    const entries = await db
      .select({ id: lotteryEntries.id })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, "draw-qq-1")));
    expect(entries).toHaveLength(1);
  });

  it("/签到 绑定活动未开启时返回业务失败提示", async () => {
    await seedTarget();
    await seedCheckinDraw("draft");
    const app = createTestApp();
    const res = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CF-Lottery-Platform-Token": INBOUND_SECRET,
      },
      body: JSON.stringify(qqMessage({ message: "/签到" })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { reply?: string };
    expect(body.reply).toContain("活动未开启");
  });
});
