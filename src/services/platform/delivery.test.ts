/**
 * 平台出站投递服务测试（docs/167 出站方向）
 *
 * 覆盖：
 * - enqueuePlatformEvent 无匹配/匹配/多 target/禁用 target/无效事件类型
 * - dispatchPlatformDeliveries 各种失败与跳过场景
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTestData, getTestDb } from "../../test-setup";
import { platformTargets, platformDeliveries, tenants } from "../../db/schema";
import { eq } from "drizzle-orm";
import { enqueuePlatformEvent, dispatchPlatformDeliveries } from "./delivery";

let db: Awaited<ReturnType<typeof getTestDb>>["db"];
let client: Awaited<ReturnType<typeof getTestDb>>["client"];

const TENANT_ID = "tenant-delivery-test";
const DRAW_ID = "draw-delivery-1";
const TARGET_ID = "pt-delivery-1";

beforeAll(async () => {
  const ctx = await getTestDb();
  db = ctx.db;
  client = ctx.client;
});

beforeEach(async () => {
  await clearTestData(client);
  // 插入租户
  await db.insert(tenants).values({ id: TENANT_ID, name: "投递测试租户" });
  // 插入平台目标（已启用助手，配置 baseUrl）
  await db.insert(platformTargets).values({
    id: TARGET_ID,
    tenantId: TENANT_ID,
    platform: "qq",
    targetId: "999999",
    targetName: "投递测试群",
    activeDrawId: DRAW_ID,
    activePublicSlug: "delivery-test",
    assistantEnabled: 1,
    adapterDeploymentMode: "tenant_hosted",
    adapterProvider: "napcat",
    adapterConfigJson: JSON.stringify({ baseUrl: "http://localhost:3000" }),
    builtinCommandsJson: "{}",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe("enqueuePlatformEvent", () => {
  it("无匹配 target 时返回空结果", async () => {
    const result = await enqueuePlatformEvent(db, {
      tenantId: TENANT_ID,
      drawId: "non-existent-draw",
      eventType: "draw.completed",
      data: { drawName: "测试", winnerSummary: "1 人获奖" },
    });
    expect(result.targetCount).toBe(0);
    expect(result.deliveryIds).toEqual([]);
  });

  it("匹配到 target 时创建 delivery 记录", async () => {
    const result = await enqueuePlatformEvent(db, {
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      eventType: "draw.completed",
      data: { drawName: "测试活动", winnerSummary: "共 5 人获奖，100 人参与" },
    });
    expect(result.targetCount).toBe(1);
    expect(result.deliveryIds).toHaveLength(1);

    // 验证 delivery 记录
    const [delivery] = await db
      .select()
      .from(platformDeliveries)
      .where(eq(platformDeliveries.id, result.deliveryIds[0]!));
    expect(delivery).toBeDefined();
    expect(delivery.status).toBe("pending");
    expect(delivery.tenantId).toBe(TENANT_ID);
    expect(delivery.platformTargetId).toBe(TARGET_ID);
    expect(delivery.eventType).toBe("draw.completed");
    // payloadJson 应包含渲染后的消息
    const payload = JSON.parse(delivery.payloadJson);
    expect(payload.renderedMessage).toContain("测试活动");
    expect(payload.renderedMessage).toContain("5 人获奖");
  });

  it("匹配到多个 target 时创建多条记录", async () => {
    // 插入第二个 target
    await db.insert(platformTargets).values({
      id: "pt-delivery-2",
      tenantId: TENANT_ID,
      platform: "qq",
      targetId: "888888",
      targetName: "第二个群",
      activeDrawId: DRAW_ID,
      assistantEnabled: 1,
      adapterConfigJson: "{}",
      builtinCommandsJson: "{}",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await enqueuePlatformEvent(db, {
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      eventType: "draw.completed",
      data: { drawName: "测试", winnerSummary: "1 人获奖" },
    });
    expect(result.targetCount).toBe(2);
    expect(result.deliveryIds).toHaveLength(2);
  });

  it("跳过 assistantEnabled=0 的 target", async () => {
    // 插入一个禁用的 target
    await db.insert(platformTargets).values({
      id: "pt-delivery-disabled",
      tenantId: TENANT_ID,
      platform: "qq",
      targetId: "777777",
      targetName: "禁用群",
      activeDrawId: DRAW_ID,
      assistantEnabled: 0,
      adapterConfigJson: "{}",
      builtinCommandsJson: "{}",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await enqueuePlatformEvent(db, {
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      eventType: "draw.completed",
      data: { drawName: "测试", winnerSummary: "1 人获奖" },
    });
    // 只匹配到第一个（已启用），禁用的被跳过
    expect(result.deliveryIds).toHaveLength(1);
  });

  it("无效事件类型抛异常", async () => {
    await expect(
      enqueuePlatformEvent(db, {
        tenantId: TENANT_ID,
        drawId: DRAW_ID,
        eventType: "invalid.event" as never,
        data: {},
      }),
    ).rejects.toThrow("平台事件类型无效");
  });
describe("dispatchPlatformDeliveries", () => {
  it("无 pending 投递时正常返回零结果", async () => {
    const result = await dispatchPlatformDeliveries(db, 10, async () => {
      return new Response("ok", { status: 200 });
    });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("baseUrl 未配置时标记失败", async () => {
    // 创建一个 baseUrl 为空的 target
    await db.insert(platformTargets).values({
      id: "pt-no-baseurl",
      tenantId: TENANT_ID,
      platform: "qq",
      targetId: "666666",
      targetName: "未配置群",
      activeDrawId: DRAW_ID,
      assistantEnabled: 1,
      adapterConfigJson: "{}",
      builtinCommandsJson: "{}",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 为目标创建一条 pending delivery
    const now = new Date().toISOString();
    await db.insert(platformDeliveries).values({
      id: "dlv-no-baseurl",
      tenantId: TENANT_ID,
      platformTargetId: "pt-no-baseurl",
      platform: "qq",
      targetId: "666666",
      eventId: "evt-test-1",
      eventType: "draw.completed",
      payloadJson: JSON.stringify({ renderedMessage: "测试消息" }),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    const result = await dispatchPlatformDeliveries(db, 10, async () => {
      return new Response("ok", { status: 200 });
    });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);

    // 验证 delivery 被标记为 pending（第 1 次重试，3 次后才变为 failed）
    const [delivery] = await db
      .select()
      .from(platformDeliveries)
      .where(eq(platformDeliveries.id, "dlv-no-baseurl"));
    expect(delivery.status).toBe("pending");
    expect(delivery.lastError).toContain("baseUrl");
  });

  it("目标已删除时标记失败", async () => {
    const now = new Date().toISOString();
    await db.insert(platformDeliveries).values({
      id: "dlv-deleted-target",
      tenantId: TENANT_ID,
      platformTargetId: "non-existent-target",
      platform: "qq",
      targetId: "555555",
      eventId: "evt-test-2",
      eventType: "draw.completed",
      payloadJson: JSON.stringify({ renderedMessage: "测试消息" }),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    const result = await dispatchPlatformDeliveries(db, 10, async () => {
      return new Response("ok", { status: 200 });
    });
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("non-existent-target");
  });

  it("跳过非 pending 状态的投递", async () => {
    const now = new Date().toISOString();
    // 插入一条已发送的投递
    await db.insert(platformDeliveries).values({
      id: "dlv-already-sent",
      tenantId: TENANT_ID,
      platformTargetId: TARGET_ID,
      platform: "qq",
      targetId: "999999",
      eventId: "evt-sent",
      eventType: "draw.completed",
      payloadJson: JSON.stringify({ renderedMessage: "已发送" }),
      status: "sent",
      sentAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const result = await dispatchPlatformDeliveries(db, 10, async () => {
      return new Response("ok", { status: 200 });
    });
    // 已发送的不应被处理
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });
});
});