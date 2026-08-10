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
import { and, eq } from "drizzle-orm";
import {
  enqueuePlatformEvent,
  enqueuePrivatePlatformMessage,
  dispatchPlatformDeliveries,
  logPrivateMessageFailure,
} from "./delivery";

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

  it("跳过未超时的 processing 投递，避免维护任务并发重复发送", async () => {
    const now = new Date().toISOString();
    await db.insert(platformDeliveries).values({
      id: "dlv-processing-fresh",
      tenantId: TENANT_ID,
      platformTargetId: TARGET_ID,
      platform: "qq",
      targetId: "999999",
      eventId: "evt-processing-fresh",
      eventType: "draw.completed",
      payloadJson: JSON.stringify({ renderedMessage: "处理中消息" }),
      status: "processing",
      createdAt: now,
      updatedAt: now,
    });

    let called = 0;
    const result = await dispatchPlatformDeliveries(db, 10, async () => {
      called++;
      return new Response("{}", { status: 200 });
    });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(called).toBe(0);
  });

  it("重新领取超时 processing 投递，避免进程崩溃后永久卡住", async () => {
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await db.insert(platformDeliveries).values({
      id: "dlv-processing-stale",
      tenantId: TENANT_ID,
      platformTargetId: TARGET_ID,
      platform: "qq",
      targetId: "999999",
      eventId: "evt-processing-stale",
      eventType: "draw.completed",
      payloadJson: JSON.stringify({ renderedMessage: "超时恢复消息" }),
      status: "processing",
      createdAt: old,
      updatedAt: old,
    });

    const result = await dispatchPlatformDeliveries(db, 10, async () => {
      return new Response(JSON.stringify({ data: { message_id: 123 } }), { status: 200 });
    });

    expect(result.sent).toBe(1);
    const [delivery] = await db
      .select()
      .from(platformDeliveries)
      .where(eq(platformDeliveries.id, "dlv-processing-stale"));
    expect(delivery.status).toBe("sent");
    expect(delivery.providerMessageId).toBe("123");
  });

  it("私聊队列投递调用 QQ 临时私聊接口，并传递用户 ID 与群上下文", async () => {
    await enqueuePrivatePlatformMessage(db, {
      tenantId: TENANT_ID,
      platformTargetId: TARGET_ID,
      platform: "qq",
      targetId: "999999",
      targetUserId: "123456",
      groupId: "999999",
      text: "你的卡密是 CODE-001",
    });

    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const result = await dispatchPlatformDeliveries(db, 10, async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: { message_id: "pm-1" } }), { status: 200 });
    });

    expect(result.sent).toBe(1);
    expect(requestUrl).toContain("/send_private_msg");
    expect(requestBody.user_id).toBe("123456");
    expect(requestBody.group_id).toBe("999999");
    expect(requestBody.message).toBe("你的卡密是 CODE-001");
  });
});

describe("enqueuePrivatePlatformMessage", () => {
  it("将私聊消息写入 pending 队列并保留临时会话群 ID", async () => {
    const result = await enqueuePrivatePlatformMessage(db, {
      tenantId: TENANT_ID,
      platformTargetId: TARGET_ID,
      platform: "telegram",
      targetId: "999999",
      targetUserId: "123456",
      groupId: "999999",
      text: "卡密内容",
    });

    const [delivery] = await db
      .select()
      .from(platformDeliveries)
      .where(eq(platformDeliveries.id, result.deliveryId));
    expect(delivery?.status).toBe("pending");
    const payload = JSON.parse(delivery?.payloadJson || "{}") as Record<string, unknown>;
    expect(payload.targetType).toBe("private");
    expect(payload.privateTargetId).toBe("123456");
    expect(payload.groupId).toBe("999999");
  });
});

describe("logPrivateMessageFailure", () => {
  it("私聊发送失败时写入一条 platformDeliveries 审计记录", async () => {
    await logPrivateMessageFailure(
      db,
      { tenantId: TENANT_ID, id: TARGET_ID, targetId: "999999" },
      "qq",
      "123456789",
      "恭喜你中奖了！卡密是：XXXX-XXXX",
      "私聊发送失败: 对方未开启临时会话",
    );

    const [delivery] = await db
      .select()
      .from(platformDeliveries)
      .where(and(
        eq(platformDeliveries.tenantId, TENANT_ID),
        eq(platformDeliveries.platformTargetId, TARGET_ID),
        eq(platformDeliveries.eventType, "private_message"),
      ));

    expect(delivery).toBeDefined();
    expect(delivery.status).toBe("failed");
    expect(delivery.lastError).toContain("私聊发送失败");
    expect(delivery.platform).toBe("qq");
    expect(delivery.targetId).toBe("999999");
    // payloadJson 应包含 targetUserId 和 textPreview（前 50 字符）
    const payload = JSON.parse(delivery.payloadJson);
    expect(payload.targetUserId).toBe("123456789");
    expect(payload.textPreview).toBe("恭喜你中奖了！卡密是：XXXX-XXXX");
  });

  it("textPreview 超过 50 字符时截断", async () => {
    const longText = "这是一条很长的私聊消息，超过了五十个字符的限制，应该被截断处理。后面还有更多内容……";
    await logPrivateMessageFailure(
      db,
      { tenantId: TENANT_ID, id: TARGET_ID, targetId: "999999" },
      "telegram",
      "987654321",
      longText,
      "timeout",
    );

    const [delivery] = await db
      .select()
      .from(platformDeliveries)
      .where(and(
        eq(platformDeliveries.tenantId, TENANT_ID),
        eq(platformDeliveries.platformTargetId, TARGET_ID),
        eq(platformDeliveries.eventType, "private_message"),
        eq(platformDeliveries.platform, "telegram"),
      ));

    expect(delivery).toBeDefined();
    const payload = JSON.parse(delivery.payloadJson);
    expect(payload.textPreview.length).toBeLessThanOrEqual(50);
  });

  it("审计日志写入失败不抛出异常，主流程不阻塞", async () => {
    // 传入无效的 db 对象（null 上的方法调用会抛出），但函数内部 catch 后应静默返回
    const badDb = null as unknown as typeof db;
    await expect(
      logPrivateMessageFailure(
        badDb,
        { tenantId: "bad", id: "bad", targetId: "bad" },
        "qq",
        "000",
        "test",
        "boom",
      ),
    ).resolves.toBeUndefined();
  });
});
});
