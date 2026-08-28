import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { clearTestData, getTestDb } from "../test-setup";
import { emailDeliveries, tenants } from "../db/schema";
import { dispatchEmailDeliveries, enqueueEmailDelivery } from "./email-delivery";

let db: Awaited<ReturnType<typeof getTestDb>>["db"];
let client: Awaited<ReturnType<typeof getTestDb>>["client"];

beforeAll(async () => {
  const ctx = await getTestDb();
  db = ctx.db;
  client = ctx.client;
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await clearTestData(client);
  await db.insert(tenants).values({ id: "tenant-email-delivery", name: "邮件队列测试租户" });
});

describe("email delivery queue", () => {
  it("pending 邮件先落库，再由发送器处理成 sent", async () => {
    const queued = await enqueueEmailDelivery(db, {
      tenantId: "tenant-email-delivery",
      drawId: "draw-email-delivery",
      sourceType: "draw_reminder",
      sourceId: "draw-email-delivery:user@test.com",
      recipientEmail: "user@test.com",
      template: "draw_reminder",
      templateData: { drawName: "队列活动", shareUrl: "slug", reminderText: "60 分钟" },
    });

    const [pending] = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, queued.deliveryId));
    expect(pending?.status).toBe("pending");

    let capturedTo = "";
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("resend.com")) {
        capturedTo = (JSON.parse(String(init?.body || "{}")) as { to: string }).to;
        return new Response(JSON.stringify({ id: "mail-queued-1" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const result = await dispatchEmailDeliveries(db, {
      resendApiKey: "test-key",
      emailFrom: "noreply@test.com",
    });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(capturedTo).toBe("user@test.com");

    const [sent] = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, queued.deliveryId));
    expect(sent?.status).toBe("sent");
    expect(sent?.providerMessageId).toBe("mail-queued-1");
  });

  it("独立远程邮件网关配置可发送队列邮件", async () => {
    const queued = await enqueueEmailDelivery(db, {
      tenantId: "tenant-email-delivery",
      drawId: "draw-remote",
      sourceType: "lottery_winner",
      sourceId: "winner-remote",
      recipientEmail: "remote@test.com",
      template: "lottery_winner",
      templateData: { drawName: "远程网关活动", productName: "AAA", accountLabel: "CODE", deliverySecret: "SECRET" },
    });
    let called = false;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://mail.test/send");
      expect(init?.headers).toMatchObject({ Authorization: `Basic ${btoa("client:secret")}` });
      called = true;
      return new Response(JSON.stringify({ ok: true, provider: "remote-test" }), { status: 200 });
    });

    const result = await dispatchEmailDeliveries(db, {
      remoteEmailUrl: "https://mail.test/send",
      remoteEmailClientId: "client",
      remoteEmailClientSecret: "secret",
      emailFrom: "noreply@test.com",
    });

    expect(result).toEqual({ sent: 1, failed: 0, errors: [] });
    expect(called).toBe(true);
    const [sent] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.id, queued.deliveryId));
    expect(sent?.status).toBe("sent");
  });


  it("同一业务来源重复入队不会重复发送已 sent 邮件", async () => {
    const input = {
      tenantId: "tenant-email-delivery",
      drawId: "draw-email-delivery",
      sourceType: "payment_order" as const,
      sourceId: "order-1",
      recipientEmail: "buyer@test.com",
      template: "lottery_winner",
      templateData: { drawName: "订单活动", productName: "卡密", accountLabel: "CODE", deliverySecret: "SECRET" },
    };
    const first = await enqueueEmailDelivery(db, input);
    await db.update(emailDeliveries).set({ status: "sent" }).where(eq(emailDeliveries.id, first.deliveryId));

    const second = await enqueueEmailDelivery(db, input);
    expect(second.deliveryId).toBe(first.deliveryId);
    expect(second.enqueued).toBe(false);
  });
});
