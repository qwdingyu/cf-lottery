import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { lotteryDraws, lotteryEntries, tenants } from "../db/schema";
import { publicLotteryRoute } from "./public-lottery";
import { clearTestData, getTestDb } from "../test-setup";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const TENANT = "tenant-public-home";
const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET: "test-public-home-secret",
};

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

function app() {
  const h = new Hono<AppEnv>();
  h.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  h.route("/public", publicLotteryRoute);
  return h;
}

function iso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function seedDraw(input: {
  id: string;
  slug: string;
  title: string;
  status?: string;
  visible?: number;
  endOffset?: number;
  experienceType?: string;
  productLink?: unknown;
  promotionConfig?: unknown;
  showParticipantCount?: number;
}) {
  await db.insert(lotteryDraws).values({
    id: input.id,
    tenantId: TENANT,
    publicSlug: input.slug,
    title: input.title,
    status: input.status || "open",
    visible: input.visible ?? 1,
    activityKind: "claim",
    participationMode: "open",
    experienceType: input.experienceType || "flash_sale",
    resultMode: "instant",
    startAt: iso(-10),
    endAt: iso(input.endOffset ?? 60),
    maxParticipants: 10,
      winnerCount: 0,
      showParticipantCount: input.showParticipantCount ?? 1,
      activeParticipantCount: 0,
      productLink: JSON.stringify(input.productLink || {}),
      promotionConfig: JSON.stringify(input.promotionConfig || {}),
  });
}

describe("GET /public/home-activities", () => {
  it("只返回公开、open、未结束活动，并隐藏内部 ID/租户 ID", async () => {
    await db.insert(tenants).values({ id: TENANT, name: "Public Home Tenant" });
    await seedDraw({
      id: "flash-open",
      slug: "flash-open-slug",
      title: "Token 秒杀",
      productLink: { title: "Token 日卡", imageUrl: "data:text/html,<svg />", price: "¥9.90", url: "javascript:alert(1)" },
      promotionConfig: { flashSale: { enabled: true, paymentRequired: true, priceCents: 990, currency: "cny", stockLimit: 10, sessionLabel: "12:00场", title: "Token 日卡" } },
    });
    await db.insert(lotteryEntries).values({
      id: "entry-1",
      tenantId: TENANT,
      drawId: "flash-open",
      identityType: "email",
      identityValue: "buyer@example.com",
      paymentStatus: "pending",
      joinedAt: iso(-5),
    });
    await db.update(lotteryDraws)
      .set({ activeParticipantCount: 1 })
      .where(eq(lotteryDraws.id, "flash-open"));
    await db.insert(lotteryEntries).values({
      id: "entry-expired",
      tenantId: TENANT,
      drawId: "flash-open",
      identityType: "email",
      identityValue: "expired@example.com",
      paymentStatus: "expired",
      joinedAt: iso(-4),
    });
    await seedDraw({ id: "hidden", slug: "hidden-slug", title: "隐藏活动", visible: 0 });
    await seedDraw({ id: "empty-slug", slug: "", title: "空公开标识活动" });
    await seedDraw({ id: "ended", slug: "ended-slug", title: "已结束活动", endOffset: -1 });
    await seedDraw({ id: "draft", slug: "draft-slug", title: "草稿活动", status: "draft" });

    const res = await app().request("/public/home-activities?limit=12", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; activities: any[] };
    expect(body.ok).toBe(true);
    expect(body.activities).toHaveLength(1);
    expect(body.activities[0]).toMatchObject({
      publicSlug: "flash-open-slug",
      title: "Token 秒杀",
      participationMode: "open",
      product: { title: "Token 日卡", imageUrl: "", priceText: "¥9.90", url: "" },
      flashSale: {
        paymentRequired: true,
        priceCents: 990,
        remaining: 9,
        progressPercent: 10,
      },
    });
    expect(body.activities[0]).not.toHaveProperty("tenantId");
    expect(body.activities[0]).not.toHaveProperty("id");
    expect(JSON.stringify(body.activities[0])).not.toContain("tenant-public-home");
  });

  it("未开启参与数展示时不泄露 claimed 原始人数，但秒杀进度仍可计算", async () => {
    await db.insert(tenants).values({ id: TENANT, name: "Public Home Tenant" });
    await seedDraw({
      id: "private-count",
      slug: "private-count-slug",
      title: "隐藏人数秒杀",
      showParticipantCount: 0,
      promotionConfig: { flashSale: { enabled: true, paymentRequired: true, priceCents: 1990, currency: "cny", stockLimit: 5 } },
    });
    await db.insert(lotteryEntries).values({
      id: "private-entry",
      tenantId: TENANT,
      drawId: "private-count",
      identityType: "email",
      identityValue: "buyer@example.com",
      paymentStatus: "paid",
      joinedAt: iso(-5),
    });
    await db.update(lotteryDraws)
      .set({ activeParticipantCount: 1 })
      .where(eq(lotteryDraws.id, "private-count"));

    const res = await app().request("/public/home-activities", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; activities: any[] };

    expect(body.activities[0]).not.toHaveProperty("claimed");
    expect(body.activities[0].flashSale.progressPercent).toBe(20);
    expect(body.activities[0].flashSale.remaining).toBe(4);
  });

  it("直付秒杀缺展示价时用 priceCents 生成公开价格文本，并保持币种规则一致", async () => {
    await db.insert(tenants).values({ id: TENANT, name: "Public Home Tenant" });
    await seedDraw({
      id: "jpy-price",
      slug: "jpy-price-slug",
      title: "日元秒杀",
      productLink: { title: "JPY 卡密" },
      promotionConfig: { flashSale: { enabled: true, paymentRequired: true, priceCents: 1200, currency: "jpy", stockLimit: 5 } },
    });

    const res = await app().request("/public/home-activities", {}, TEST_ENV);
    const body = await res.json() as { ok: boolean; activities: any[] };

    expect(res.status).toBe(200);
    expect(body.activities[0].product.priceText).toBe("¥1200");
    expect(body.activities[0].flashSale.priceCents).toBe(1200);
  });
});

describe("GET /public/draws/:slug/og", () => {
  it("返回活动动态 OG 元数据并保留分享参数", async () => {
    await db.insert(tenants).values({ id: TENANT, name: "OG Tenant" });
    await seedDraw({
      id: "og-draw",
      slug: "og-draw-slug",
      title: "OG 活动标题",
      promotionConfig: {},
    });

    const res = await app().request(
      "/public/draws/og-draw-slug/og?ref=share-code",
      { headers: { "User-Agent": "Twitterbot/1.0" } },
      { ...TEST_ENV, APP_ORIGIN: "https://lucky.eforge.xyz" },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="OG 活动标题"');
    expect(html).toContain('https://lucky.eforge.xyz/lottery/og-draw-slug?ref=share-code');
  });

  it("不为隐藏或草稿活动暴露 OG 元数据", async () => {
    await db.insert(tenants).values({ id: TENANT, name: "OG Hidden Tenant" });
    await seedDraw({
      id: "og-hidden",
      slug: "og-hidden-slug",
      title: "不应公开",
      visible: 0,
    });
    await seedDraw({
      id: "og-draft",
      slug: "og-draft-slug",
      title: "草稿不应公开",
      status: "draft",
    });

    const hidden = await app().request("/public/draws/og-hidden-slug/og", {}, TEST_ENV);
    const draft = await app().request("/public/draws/og-draft-slug/og", {}, TEST_ENV);
    expect(hidden.status).toBe(404);
    expect(draft.status).toBe(404);
  });
});

describe("GET /public/draws/:slug", () => {
  it("公开详情带回店铺公开信息，但不暴露 tenantId", async () => {
    await db.insert(tenants).values({ id: TENANT, name: "Detail Store", storeSlug: "detail-store" });
    await seedDraw({
      id: "detail-draw-id",
      slug: "detail-draw-slug",
      title: "详情页活动",
      promotionConfig: { flashSale: { enabled: true, paymentRequired: true, priceCents: 990, currency: "cny", stockLimit: 10 } },
    });

    const res = await app().request("/public/draws/detail-draw-slug", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; store?: { name?: string; storeSlug?: string; brand?: Record<string, unknown> } };

    expect(body.ok).toBe(true);
    expect(body.store).toMatchObject({
      name: "Detail Store",
      storeSlug: "detail-store",
    });
    expect(JSON.stringify(body)).not.toContain("tenant-public-home");
    expect(JSON.stringify(body)).not.toContain("detail-draw-id");
  });
});

describe("GET /public/shops/:storeSlug", () => {
  it("店铺首页直付秒杀按活动计数器计算进度，且不暴露内部 ID", async () => {
    await db.insert(tenants).values({ id: TENANT, name: "Public Shop Tenant", storeSlug: "token-shop" });
    await seedDraw({
      id: "internal-shop-draw-id",
      slug: "shop-flash-slug",
      title: "店铺 Token 秒杀",
      productLink: { title: "Token 日卡" },
      promotionConfig: {
        flashSale: {
          enabled: true,
          paymentRequired: true,
          priceCents: 990,
          currency: "cny",
          stockLimit: 10,
          sessionLabel: "12:00场",
        },
      },
    });
    await db.insert(lotteryEntries).values({
      id: "shop-paid-entry",
      tenantId: TENANT,
      drawId: "internal-shop-draw-id",
      identityType: "email",
      identityValue: "buyer@example.com",
      paymentStatus: "paid",
      joinedAt: iso(-5),
    });
    await db.update(lotteryDraws)
      .set({ activeParticipantCount: 3 })
      .where(eq(lotteryDraws.id, "internal-shop-draw-id"));

    const res = await app().request("/public/shops/token-shop", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; activities: any[] };

    expect(body.ok).toBe(true);
    expect(body.activities).toHaveLength(1);
    expect(body.activities[0]).toMatchObject({
      publicSlug: "shop-flash-slug",
      product: { title: "Token 日卡", priceText: "¥9.90" },
      flashSale: {
        paymentRequired: true,
        priceCents: 990,
        remaining: 7,
        progressPercent: 30,
        effectiveStockLimit: 10,
      },
    });
    expect(body.activities[0]).not.toHaveProperty("id");
    expect(JSON.stringify(body.activities[0])).not.toContain("internal-shop-draw-id");
    expect(JSON.stringify(body.activities[0])).not.toContain("tenant-public-home");
  });

  it("店铺首页展示型秒杀按真实 entry 聚合，且排除 expired 占位", async () => {
    await db.insert(tenants).values({ id: TENANT, name: "Public Shop Tenant 2", storeSlug: "display-shop" });
    await seedDraw({
      id: "internal-display-draw-id",
      slug: "display-shop-slug",
      title: "展示型秒杀",
      productLink: { title: "Token 周卡" },
      promotionConfig: {
        flashSale: {
          enabled: true,
          paymentRequired: false,
          priceCents: 1990,
          currency: "cny",
          stockLimit: 5,
          sessionLabel: "18:00场",
        },
      },
    });
    await db.insert(lotteryEntries).values([
      {
        id: "display-paid-entry",
        tenantId: TENANT,
        drawId: "internal-display-draw-id",
        identityType: "email",
        identityValue: "buyer@example.com",
        paymentStatus: "paid",
        joinedAt: iso(-5),
      },
      {
        id: "display-expired-entry",
        tenantId: TENANT,
        drawId: "internal-display-draw-id",
        identityType: "email",
        identityValue: "expired@example.com",
        paymentStatus: "expired",
        joinedAt: iso(-4),
      },
    ]);

    const res = await app().request("/public/shops/display-shop", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; activities: any[] };

    expect(body.ok).toBe(true);
    expect(body.activities[0].flashSale).toMatchObject({
      paymentRequired: false,
      remaining: 4,
      progressPercent: 20,
      effectiveStockLimit: 5,
    });
  });
});
