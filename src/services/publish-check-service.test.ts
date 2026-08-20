/**
 * 发布前预检服务测试。
 *
 * 该测试直接锁住 publish-check-service 的结构化规则：
 * - 不依赖未安装的 better-sqlite3，统一使用项目现有 libSQL 测试方式。
 * - 只构造当前活动需要的少量关联行，避免测试本身鼓励全表扫描式实现。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildPublishCheckForDraw } from "./publish-check-service";
import { clearTestData, getTestDb } from "../test-setup";

const TENANT = "test-tenant-check";
let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

function makeDraw(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const future = new Date(now.getTime() + 86400000);
  return {
    id: crypto.randomUUID(),
    tenantId: TENANT,
    publicSlug: crypto.randomUUID().slice(0, 8),
    title: "测试活动",
    description: "",
    status: "draft",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    drawTrigger: "manual",
    resultMode: "manual",
    allocationPolicy: "capacity",
    policyVersion: 1,
    startAt: now.toISOString(),
    endAt: future.toISOString(),
    drawAt: null,
    accessPassword: "",
    maxParticipants: 100,
    winnerCount: 1,
    showParticipantCount: 1,
    showWinnerCount: 1,
    showWinnerList: 0,
    drawnAt: null,
    failureReason: "",
    drawSeedHash: "",
    drawSeed: "",
    algorithmVersion: "uniform_v1",
    productLink: "{}",
    promotionConfig: "{}",
    activityConfig: "{}",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

async function addManualTier(drawId: string, winnerCount = 1) {
  const prizeId = crypto.randomUUID();
  await client.execute({
    sql: "INSERT INTO prizes (id, tenant_id, name, prize_type) VALUES (?, ?, ?, ?)",
    args: [prizeId, TENANT, "手动奖品", "manual_fulfillment"],
  });
  await client.execute({
    sql: "INSERT INTO lottery_prize_tiers (id, tenant_id, draw_id, prize_id, winner_count, tier_name) VALUES (?, ?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), TENANT, drawId, prizeId, winnerCount, "一等奖"],
  });
}

async function addCodeTier(drawId: string, winnerCount: number, availableCodes: number) {
  const prizeId = crypto.randomUUID();
  await client.execute({
    sql: "INSERT INTO prizes (id, tenant_id, name, prize_type) VALUES (?, ?, ?, ?)",
    args: [prizeId, TENANT, "卡密奖品", "code"],
  });
  await client.execute({
    sql: "INSERT INTO lottery_prize_tiers (id, tenant_id, draw_id, prize_id, winner_count, tier_name) VALUES (?, ?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), TENANT, drawId, prizeId, winnerCount, "卡密奖"],
  });
  for (let i = 0; i < availableCodes; i++) {
    await client.execute({
      sql: "INSERT INTO prize_codes (id, tenant_id, prize_id, code, status) VALUES (?, ?, ?, ?, ?)",
      args: [crypto.randomUUID(), TENANT, prizeId, `CODE-${i}`, "available"],
    });
  }
}

async function addAlipayConfig() {
  await client.execute({
    sql: "INSERT INTO tenant_configs (tenant_id, enabled, providers) VALUES (?, ?, ?)",
    args: [TENANT, 1, JSON.stringify({
      alipay: {
        enabled: true,
        alipay_app_id: "app",
        alipay_private_key: "private",
        alipay_public_key: "public",
      },
    })],
  });
}

async function addEasyPayConfig() {
  const { encryptSecretConfigValue } = await import("../lib/secret-config");
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY || "test-key-32-bytes-long!";
  const encryptedKey = await encryptSecretConfigValue("key", key);
  await client.execute({
    sql: "INSERT INTO tenant_configs (tenant_id, enabled, providers) VALUES (?, ?, ?)",
    args: [TENANT, 1, JSON.stringify({
      easypay: {
        enabled: true,
        easypay_pid: "pid",
        easypay_key: encryptedKey,
        easypay_api_base: "https://zpayz.cn",
      },
    })],
  });
}

describe("发布预检 — 基础信息", () => {
  it("标题为空时返回结构化错误", async () => {
    const draw = makeDraw({ title: "" });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "basic.title.required" && item.section === "basic")).toBe(true);
  });

  it("结束时间已过时阻断发布", async () => {
    const draw = makeDraw({
      startAt: "2020-01-01T00:00:00Z",
      endAt: "2020-01-02T00:00:00Z",
    });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some((item) => item.code === "basic.time.ended")).toBe(true);
  });

  it("正常抽奖配置可发布，但缺 CTA 和 Webhook 只提示", async () => {
    const draw = makeDraw();
    await addManualTier(draw.id);
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(true);
    expect(result.warnings.some((item) => item.code === "promotion.empty")).toBe(true);
    expect(result.infos.some((item) => item.code === "webhook.empty")).toBe(true);
  });

  it("lottery 有 drawAt 但 trigger=manual：警告 orphan，仍可发布（可手动开奖）", async () => {
    const future = new Date(Date.now() + 2 * 86400000).toISOString();
    const draw = makeDraw({
      drawTrigger: "manual",
      resultMode: "manual",
      drawAt: future,
      endAt: new Date(Date.now() + 86400000).toISOString(),
    });
    await addManualTier(draw.id);
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(true);
    expect(result.warnings.some((item) => item.code === "basic.draw_at.orphan")).toBe(true);
  });

  it("lottery + scheduled + 合法 drawAt：无 orphan 警告", async () => {
    const end = new Date(Date.now() + 86400000).toISOString();
    const drawAt = new Date(Date.now() + 2 * 86400000).toISOString();
    const draw = makeDraw({
      drawTrigger: "scheduled",
      resultMode: "scheduled",
      endAt: end,
      drawAt,
    });
    await addManualTier(draw.id);
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.warnings.some((item) => item.code === "basic.draw_at.orphan")).toBe(false);
  });
});

describe("发布预检 — 参与模式", () => {
  it("密码模式未设置密码时返回错误", async () => {
    const draw = makeDraw({ participationMode: "password", accessPassword: "" });
    await addManualTier(draw.id);
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some((item) => item.code === "participation.password.required")).toBe(true);
  });

  it("名单和邀请码模式必须有可用资格数据", async () => {
    const rosterDraw = makeDraw({ participationMode: "roster" });
    await addManualTier(rosterDraw.id);
    const rosterResult = await buildPublishCheckForDraw(db, TENANT, rosterDraw as any);
    expect(rosterResult.errors.some((item) => item.code === "participation.roster.empty")).toBe(true);

    const inviteDraw = makeDraw({ participationMode: "invite_code" });
    await addManualTier(inviteDraw.id);
    const inviteResult = await buildPublishCheckForDraw(db, TENANT, inviteDraw as any);
    expect(inviteResult.errors.some((item) => item.code === "participation.invite_code.empty")).toBe(true);
  });
});

describe("发布预检 — 奖项与码池", () => {
  it("抽奖活动无奖项时返回错误", async () => {
    const draw = makeDraw({ activityKind: "lottery" });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some((item) => item.code === "prizes.tiers.required")).toBe(true);
  });

  it("卡密码池不足时返回错误，码池充足时不返回该错误", async () => {
    const insufficientDraw = makeDraw();
    await addCodeTier(insufficientDraw.id, 3, 1);
    const insufficient = await buildPublishCheckForDraw(db, TENANT, insufficientDraw as any);
    expect(insufficient.errors.some((item) => item.code === "prizes.codes.insufficient")).toBe(true);

    const enoughDraw = makeDraw();
    await addCodeTier(enoughDraw.id, 3, 3);
    const enough = await buildPublishCheckForDraw(db, TENANT, enoughDraw as any);
    expect(enough.errors.some((item) => item.code === "prizes.codes.insufficient")).toBe(false);
  });
});

describe("发布预检 — instant 结果机闸门", () => {
  it("非 lottery 活动误配 wheel 时阻断发布", async () => {
    const draw = makeDraw({
      activityKind: "claim",
      experienceType: "wheel",
      resultMode: "instant",
    });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some((item) => item.code === "basic.experience.wheel_requires_lottery")).toBe(true);
  });

  it("instant 缺 maxSpinsPerEntry 阻断", async () => {
    const draw = makeDraw({
      resultMode: "instant",
      drawTrigger: "manual",
      maxSpinsPerEntry: 0,
    });
    await addManualTier(draw.id);
    // manual 档默认 weight 可能为 0/null，先保证奖项存在；本用例只断言 max_spins
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "basic.max_spins.required")).toBe(true);
  });

  it("instant + scheduled 触发器阻断", async () => {
    const draw = makeDraw({
      resultMode: "instant",
      drawTrigger: "scheduled",
      maxSpinsPerEntry: 3,
      drawAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    });
    await addCodeTier(draw.id, 1, 1);
    // 给档位 weight（addCodeTier 未写 weight 列时库默认可能 0）
    await client.execute({
      sql: "UPDATE lottery_prize_tiers SET weight = 100 WHERE draw_id = ?",
      args: [draw.id],
    });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some((item) => item.code === "basic.instant.scheduled_forbidden")).toBe(true);
    expect(result.canPublish).toBe(false);
  });

  it("instant 全档 weight=0 阻断；有 weight 且码足可通过", async () => {
    const bad = makeDraw({
      resultMode: "instant",
      drawTrigger: "manual",
      maxSpinsPerEntry: 3,
    });
    await addCodeTier(bad.id, 2, 2);
    await client.execute({
      sql: "UPDATE lottery_prize_tiers SET weight = 0 WHERE draw_id = ?",
      args: [bad.id],
    });
    const badResult = await buildPublishCheckForDraw(db, TENANT, bad as any);
    expect(badResult.errors.some((item) => item.code === "prizes.instant.weight_required")).toBe(true);
    expect(badResult.canPublish).toBe(false);

    const good = makeDraw({
      resultMode: "instant",
      drawTrigger: "manual",
      maxSpinsPerEntry: 3,
    });
    await addCodeTier(good.id, 2, 2);
    await client.execute({
      sql: "UPDATE lottery_prize_tiers SET weight = 50 WHERE draw_id = ?",
      args: [good.id],
    });
    const goodResult = await buildPublishCheckForDraw(db, TENANT, good as any);
    expect(goodResult.errors.some((item) => item.code === "basic.max_spins.required")).toBe(false);
    expect(goodResult.errors.some((item) => item.code === "prizes.instant.weight_required")).toBe(false);
    expect(goodResult.errors.some((item) => item.code === "basic.instant.scheduled_forbidden")).toBe(false);
    expect(goodResult.canPublish).toBe(true);
  });

  it("即时大转盘奖品缺少权益说明时给出发布可见警告", async () => {
    const draw = makeDraw({
      resultMode: "instant",
      experienceType: "wheel",
      drawTrigger: "manual",
      maxSpinsPerEntry: 1,
    });
    await addManualTier(draw.id);
    await client.execute({
      sql: "UPDATE lottery_prize_tiers SET weight = 1 WHERE draw_id = ?",
      args: [draw.id],
    });

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.warnings.some((item) => item.code === "prizes.instant_wheel.value_required")).toBe(true);
  });

  it("lottery + 直付秒杀（paymentRequired）阻断，任何 resultMode 均不允许", async () => {
    // docs/166：lottery 的 performDraw 不校验 entry.paymentStatus，所有 entry 都在候选池中；
    // 若允许组合，未付款用户可进入候选池并被抽中（白嫖卡密），且支付回调已通过 direct fulfillment
    // 发卡导致 double-issuance。发布门禁必须阻断所有 resultMode。
    for (const resultMode of ["instant", "manual", "scheduled"] as const) {
      const draw = makeDraw({
        resultMode,
        ...(resultMode === "instant" ? { drawTrigger: "manual", maxSpinsPerEntry: 3 } : { drawTrigger: "manual" }),
        experienceType: "flash_sale",
        promotionConfig: JSON.stringify({
          flashSale: { enabled: true, paymentRequired: true, priceCents: 9900, stockLimit: 10, maxPerUser: 1, currency: "cny" },
          destination: { url: "https://shop.example.com/p/1", title: "去购买" },
        }),
      });
      await addCodeTier(draw.id, 1, 1);
      await client.execute({
        sql: "UPDATE lottery_prize_tiers SET weight = 100 WHERE draw_id = ?",
        args: [draw.id],
      });
      const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
      expect(result.errors.some((item) => item.code === "promotion.lottery_payment.conflict")).toBe(true);
      expect(result.canPublish).toBe(false);
      await clearTestData(client);
    }
  });

  it("lottery + 展示型秒杀（非 paymentRequired）不受该红线阻断", async () => {
    // 展示型秒杀（paymentRequired=false）仍是免费参与，允许通过。
    const draw = makeDraw({
      resultMode: "instant",
      drawTrigger: "manual",
      maxSpinsPerEntry: 3,
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, stockLimit: 10, maxPerUser: 1 },
        destination: { url: "https://shop.example.com/p/1", title: "去购买" },
      }),
    });
    await addCodeTier(draw.id, 1, 1);
    await client.execute({
      sql: "UPDATE lottery_prize_tiers SET weight = 100 WHERE draw_id = ?",
      args: [draw.id],
    });
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.errors.some((item) => item.code === "promotion.lottery_payment.conflict")).toBe(false);
  });

  it("秒杀配置只允许 lottery 或 claim，防止旧数据和 API 绕过后台类型联动", async () => {
    const draw = makeDraw({
      activityKind: "survey",
      experienceType: "flash_sale",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, stockLimit: 10 },
        destination: { url: "https://shop.example.com/p/1", title: "去购买" },
      }),
    });

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "flash_sale.activity_kind.conflict")).toBe(true);
  });

  it("启用秒杀配置但体验类型不是 flash_sale 时阻断发布", async () => {
    const draw = makeDraw({
      activityKind: "claim",
      experienceType: "submit",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, stockLimit: 10 },
        destination: { url: "https://shop.example.com/p/1", title: "去购买" },
      }),
    });

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "flash_sale.experience.required")).toBe(true);
  });

  it("非 claim 活动不能开启站内直付，即使它不是 lottery", async () => {
    const draw = makeDraw({
      activityKind: "signup_chain",
      experienceType: "flash_sale",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, priceCents: 9900, stockLimit: 10, currency: "cny" },
      }),
    });

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "flash_sale.payment.activity_kind.required")).toBe(true);
  });
});

describe("发布预检 — 导流、Webhook、未闭环玩法", () => {
  it("危险导流链接和异常 Webhook 会阻断发布", async () => {
    const draw = makeDraw({
      promotionConfig: JSON.stringify({ enabled: true, destination: { url: "javascript:alert(1)", title: "危险链接" } }),
    });
    await addManualTier(draw.id);
    await client.execute({
      sql: "INSERT INTO webhook_configs (id, tenant_id, url, events, active, signing_secret) VALUES (?, ?, ?, ?, ?, ?)",
      args: [crypto.randomUUID(), TENANT, "ftp://example.com/hook", "[]", 1, ""],
    });

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "promotion.url.invalid")).toBe(true);
    expect(result.errors.some((item) => item.code === "webhook.url.invalid")).toBe(true);
    expect(result.errors.some((item) => item.code === "webhook.events.invalid")).toBe(true);
  });

  it("docs/130：秒杀启用但无名额上限则阻断；有 stockLimit 可通过 flash 门禁", async () => {
    const noStock = makeDraw({
      maxParticipants: null,
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true },
        destination: { url: "https://shop.example.com/p/1", title: "去购买" },
      }),
    });
    // claim 类可不配奖项；本 makeDraw 默认 lottery，仍需奖项才能过 prizes 门禁
    await addManualTier(noStock.id);
    const r1 = await buildPublishCheckForDraw(db, TENANT, noStock as any);
    expect(r1.errors.some((item) => item.code === "flash_sale.stock.required")).toBe(true);

    const withStock = makeDraw({
      maxParticipants: 100,
      experienceType: "flash_sale",
      activityKind: "claim",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, stockLimit: 100, sessionLabel: "12:00场" },
        destination: { url: "https://shop.example.com/p/1", title: "去购买" },
      }),
    });
    const r2 = await buildPublishCheckForDraw(db, TENANT, withStock as any);
    expect(r2.errors.some((item) => item.code.startsWith("flash_sale."))).toBe(false);
    expect(r2.canPublish).toBe(true);
  });

  it("docs/239：秒杀 stockLimit 与 maxParticipants 不一致时阻断发布（error，防御运营误解）", async () => {
    const draw = makeDraw({
      maxParticipants: 50,
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, stockLimit: 100 },
        destination: { url: "https://shop.example.com/item", title: "买" },
      }),
    });
    await addManualTier(draw.id);
    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    // docs/239 方案 C：不一致从 warning 升级为 error，阻断发布
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "flash_sale.stock.mismatch")).toBe(true);
    expect(result.warnings.some((item) => item.code === "flash_sale.stock.mismatch")).toBe(false);
  });

  it("docs/130：导流秒杀没有购买链接时阻断发布，避免空抢购壳上线", async () => {
    const draw = makeDraw({
      maxParticipants: 10,
      experienceType: "flash_sale",
      activityKind: "claim",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, stockLimit: 10 },
      }),
    });

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "flash_sale.destination.missing")).toBe(true);
  });

  it("docs/131：直付秒杀缺价格、支付配置或卡密奖品时阻断发布", async () => {
    const draw = makeDraw({
      maxParticipants: 10,
      experienceType: "flash_sale",
      activityKind: "claim",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
        },
      }),
    });

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "flash_sale.payment.price.required")).toBe(true);
    expect(result.errors.some((item) => item.code === "payment.config.required")).toBe(true);
    expect(result.errors.some((item) => item.code === "payment.fulfillment.code_prize.required")).toBe(true);
  });

  it("docs/131：直付秒杀 priceCents 必须是整数分，小数金额发布前阻断", async () => {
    const draw = makeDraw({
      maxParticipants: 10,
      experienceType: "flash_sale",
      activityKind: "claim",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          priceCents: 9900.9,
          currency: "cny",
        },
      }),
    });

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "flash_sale.price.invalid")).toBe(true);
    expect(result.errors.some((item) => item.code === "flash_sale.payment.price.required")).toBe(true);
  });

  it("docs/131：直付秒杀必须使用 email 身份，registered 模式发布前阻断", async () => {
    const draw = makeDraw({
      maxParticipants: 10,
      experienceType: "flash_sale",
      activityKind: "claim",
      participationMode: "registered",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          priceCents: 9900,
          currency: "cny",
        },
      }),
    });
    await addAlipayConfig();
    await addCodeTier(draw.id, 1, 10);

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "payment.identity.email_required")).toBe(true);
  });

  it("docs/131：直付秒杀价格、易支付 CNY 渠道和单一卡密池充足时可发布", async () => {
    const draw = makeDraw({
      maxParticipants: 10,
      experienceType: "flash_sale",
      activityKind: "claim",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          priceCents: 9900,
          currency: "cny",
        },
      }),
    });
    await addEasyPayConfig();
    await addCodeTier(draw.id, 1, 10);

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any, {
      credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY,
    });
    expect(result.errors.filter((item) => item.section === "payment")).toEqual([]);
    expect(result.canPublish).toBe(true);
  });

  it("docs/141：直付秒杀允许 maxPerUser>1 表示单笔批量购买上限", async () => {
    const draw = makeDraw({
      maxParticipants: 10,
      experienceType: "flash_sale",
      activityKind: "claim",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          maxPerUser: 2,
          priceCents: 9900,
          currency: "cny",
        },
      }),
    });
    await addEasyPayConfig();
    await addCodeTier(draw.id, 1, 10);

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any, {
      credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY,
    });
    expect(result.errors.filter((item) => item.section === "payment")).toEqual([]);
    expect(result.canPublish).toBe(true);
  });

  it("docs/141：阶梯价起购数量不能超过单笔购买上限", async () => {
    const draw = makeDraw({
      maxParticipants: 10,
      experienceType: "flash_sale",
      activityKind: "claim",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          maxPerUser: 2,
          priceCents: 9900,
          currency: "cny",
          pricingTiers: [{ minQuantity: 3, unitPriceCents: 8900, label: "批发价" }],
        },
      }),
    });
    await addEasyPayConfig();
    await addCodeTier(draw.id, 1, 10);

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any, {
      credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY,
    });
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "flash_sale.payment.pricing_tier.exceeds_max")).toBe(true);
  });

  it("docs/141：重复起购数量的阶梯价发布前阻断，避免运营以为两档同时生效", async () => {
    const draw = makeDraw({
      maxParticipants: 10,
      experienceType: "flash_sale",
      activityKind: "claim",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          maxPerUser: 10,
          priceCents: 9900,
          currency: "cny",
          pricingTiers: [
            { minQuantity: 3, unitPriceCents: 8900, label: "小批量" },
            { minQuantity: 3, unitPriceCents: 7900, label: "重复档" },
          ],
        },
      }),
    });
    await addEasyPayConfig();
    await addCodeTier(draw.id, 1, 10);

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any, {
      credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY,
    });
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "flash_sale.payment.pricing_tier.duplicate")).toBe(true);
  });

  it("docs/141：首档阶梯起购数量不为 1 时阻断发布，避免用户买不到首档价格", async () => {
    const draw = makeDraw({
      maxParticipants: 10,
      experienceType: "flash_sale",
      activityKind: "claim",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          maxPerUser: 10,
          priceCents: 9900,
          currency: "cny",
          pricingTiers: [
            { minQuantity: 5, unitPriceCents: 8900, label: "首档不从 1 开始" },
          ],
        },
      }),
    });
    await addEasyPayConfig();
    await addCodeTier(draw.id, 1, 10);

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any, {
      credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY,
    });
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "flash_sale.payment.pricing_tier.first_min_quantity_not_one")).toBe(true);
  });

  it("docs/141：阶梯档位超过 MAX_TIERS 时阻断发布，避免静默截断尾部档位", async () => {
    const draw = makeDraw({
      maxParticipants: 10,
      experienceType: "flash_sale",
      activityKind: "claim",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          maxPerUser: 10,
          priceCents: 9900,
          currency: "cny",
          pricingTiers: Array.from({ length: 9 }, (_, i) => ({
            minQuantity: i + 1,
            unitPriceCents: 9900 - i * 100,
            label: `档位${i + 1}`,
          })),
        },
      }),
    });
    await addEasyPayConfig();
    await addCodeTier(draw.id, 1, 10);

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any, {
      credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY,
    });
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "flash_sale.pricing_tier.too_many")).toBe(true);
  });

  it("docs/131：进行中活动不能共享同一卡密池，避免发布后竞争库存", async () => {
    const sharedPrizeId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO prizes (id, tenant_id, name, prize_type) VALUES (?, ?, ?, ?)",
      args: [sharedPrizeId, TENANT, "共享卡密池", "code"],
    });
    await client.execute({
      sql: "INSERT INTO prize_codes (id, tenant_id, prize_id, code, status) VALUES (?, ?, ?, ?, ?)",
      args: [crypto.randomUUID(), TENANT, sharedPrizeId, "SHARED-1", "available"],
    });

    const existingDraw = makeDraw({
      status: "open",
      activityKind: "claim",
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" },
      }),
    });
    const currentDraw = makeDraw({
      activityKind: "claim",
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" },
      }),
    });
    await client.execute({
      sql: "INSERT INTO lottery_draws (id, tenant_id, public_slug, title, status, activity_kind, experience_type, start_at, end_at, max_participants, promotion_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        existingDraw.id,
        TENANT,
        existingDraw.publicSlug,
        existingDraw.title,
        existingDraw.status,
        existingDraw.activityKind,
        existingDraw.experienceType,
        existingDraw.startAt,
        existingDraw.endAt,
        existingDraw.maxParticipants,
        existingDraw.promotionConfig,
      ],
    });
    await client.execute({
      sql: "INSERT INTO lottery_prize_tiers (id, tenant_id, draw_id, prize_id, winner_count, tier_name) VALUES (?, ?, ?, ?, ?, ?)",
      args: [crypto.randomUUID(), TENANT, existingDraw.id, sharedPrizeId, 1, "共享卡密"],
    });
    await client.execute({
      sql: "INSERT INTO lottery_prize_tiers (id, tenant_id, draw_id, prize_id, winner_count, tier_name) VALUES (?, ?, ?, ?, ?, ?)",
      args: [crypto.randomUUID(), TENANT, currentDraw.id, sharedPrizeId, 1, "共享卡密"],
    });
    await addEasyPayConfig();

    const result = await buildPublishCheckForDraw(db, TENANT, currentDraw as any, {
      credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY,
    });
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "payment.fulfillment.code_prize.shared")).toBe(true);
  });

  it("docs/131：区块链支付暂不进入当前直付目录，USDT 发布被阻断", async () => {
    const draw = makeDraw({
      maxParticipants: 10,
      experienceType: "flash_sale",
      activityKind: "claim",
      winnerCount: 0,
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          priceCents: 9900,
          currency: "usdt",
        },
      }),
    });
    await addCodeTier(draw.id, 1, 10);

    const result = await buildPublishCheckForDraw(db, TENANT, draw as any);
    expect(result.canPublish).toBe(false);
    expect(result.errors.some((item) => item.code === "payment.currency.unsupported")).toBe(true);
  });

  it("docs/128 红线：手动/定时开奖 + 扇面真奖名 阻断发布；instant 放行", async () => {
    const delayed = await buildPublishCheckForDraw(db, TENANT, makeDraw({
      resultMode: "manual",
      promotionConfig: JSON.stringify({ experience: { prizePanelMode: "full_on_shell" } }),
    }) as any);
    expect(delayed.errors.some((item) => item.code === "promotion.experience.conflict")).toBe(true);

    const scheduled = await buildPublishCheckForDraw(db, TENANT, makeDraw({
      resultMode: "scheduled",
      promotionConfig: JSON.stringify({ experience: { prizePanelMode: "full_on_shell" } }),
    }) as any);
    expect(scheduled.errors.some((item) => item.code === "promotion.experience.conflict")).toBe(true);

    const instant = await buildPublishCheckForDraw(db, TENANT, makeDraw({
      resultMode: "instant",
      promotionConfig: JSON.stringify({ experience: { prizePanelMode: "full_on_shell" } }),
    }) as any);
    expect(instant.errors.some((item) => item.code === "promotion.experience.conflict")).toBe(false);
  });

  it("问卷和投票缺少有效配置时禁止正式发布", async () => {
    const survey = await buildPublishCheckForDraw(db, TENANT, makeDraw({ activityKind: "survey", winnerCount: 0 }) as any);
    const vote = await buildPublishCheckForDraw(db, TENANT, makeDraw({ activityKind: "vote", winnerCount: 0 }) as any);
    expect(survey.errors.some((item) => item.code === "survey.config.missing")).toBe(true);
    expect(vote.errors.some((item) => item.code === "vote.options.missing")).toBe(true);
  });

  it("有效问卷和投票配置允许通过 activity_config 发布闸门", async () => {
    const survey = await buildPublishCheckForDraw(db, TENANT, makeDraw({
      activityKind: "survey",
      winnerCount: 0,
      activityConfig: JSON.stringify({
        version: 1,
        kind: "survey",
        fields: [{ id: "feedback", label: "反馈", type: "textarea", required: true, maxLength: 500, options: [] }],
      }),
    }) as any);
    const vote = await buildPublishCheckForDraw(db, TENANT, makeDraw({
      activityKind: "vote",
      winnerCount: 0,
      activityConfig: JSON.stringify({
        version: 1,
        kind: "vote",
        selection: "single",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      }),
    }) as any);

    expect(survey.errors.some((item) => item.section === "activity_config")).toBe(false);
    expect(vote.errors.some((item) => item.section === "activity_config")).toBe(false);
    // config.ready 噪音已移除（"配置已完成"无行动价值，infos 通道只承载可行动的提示）
    expect(survey.infos.some((item) => item.code === "survey.config.ready")).toBe(false);
    expect(vote.infos.some((item) => item.code === "vote.config.ready")).toBe(false);
  });

  it("活动级运营参数非法时禁止发布，避免运行时静默忽略配置错误", async () => {
    const draw = await buildPublishCheckForDraw(db, TENANT, makeDraw({
      activityConfig: JSON.stringify({
        operational: {
          joinIpLimitPerMinute: 0,
          lockJoinBeforeDrawMinutes: 20000,
        },
      }),
    }) as any);

    expect(draw.canPublish).toBe(false);
    expect(draw.errors.some((item) => item.code === "activity.operational.joinIpLimitPerMinute.invalid")).toBe(true);
    expect(draw.errors.some((item) => item.code === "activity.operational.lockJoinBeforeDrawMinutes.invalid")).toBe(true);
  });

  it("裂变配置校验：非法值报错，排行榜关闭提示", async () => {
    // 每邀请次数为 0 → 报错
    const badPerInvite = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, viral: { enabled: true, extraEntriesPerInvite: 0, maxExtraEntries: 10, leaderboardEnabled: true } }),
    });
    await addManualTier(badPerInvite.id);
    const r1 = await buildPublishCheckForDraw(db, TENANT, badPerInvite as any);
    expect(r1.errors.some((item) => item.code === "viral.extra_entries.invalid")).toBe(true);

    // 最大次数为 0 → 报错
    const badMax = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 0, leaderboardEnabled: true } }),
    });
    await addManualTier(badMax.id);
    const r2 = await buildPublishCheckForDraw(db, TENANT, badMax as any);
    expect(r2.errors.some((item) => item.code === "viral.max_extra.invalid")).toBe(true);

    // 每邀请大于最大上限 → 警告
    const perLarger = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, viral: { enabled: true, extraEntriesPerInvite: 20, maxExtraEntries: 10, leaderboardEnabled: true } }),
    });
    await addManualTier(perLarger.id);
    const r3 = await buildPublishCheckForDraw(db, TENANT, perLarger as any);
    expect(r3.warnings.some((item) => item.code === "viral.extra_exceeds_max")).toBe(true);

    // 排行榜关闭 → 提示
    const noBoard = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: false } }),
    });
    await addManualTier(noBoard.id);
    const r4 = await buildPublishCheckForDraw(db, TENANT, noBoard as any);
    expect(r4.infos.some((item) => item.code === "viral.leaderboard.off")).toBe(true);

    // 缺省 leaderboardEnabled（与运行时一致视为开）→ 不误报 off
    const defaultBoard = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10 } }),
    });
    await addManualTier(defaultBoard.id);
    const r4b = await buildPublishCheckForDraw(db, TENANT, defaultBoard as any);
    expect(r4b.infos.some((item) => item.code === "viral.leaderboard.off")).toBe(false);

    // 合法配置 → 无错误
    const ok = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: true } }),
    });
    await addManualTier(ok.id);
    const r5 = await buildPublishCheckForDraw(db, TENANT, ok as any);
    expect(r5.errors.some((item) => item.section === "promotion" && (item.code as string).startsWith("viral"))).toBe(false);
  });

  it("非 lottery 活动（接龙/问卷等）裂变数值不校验：perInvite=0 不报错（前端已隐藏参数，P2 打磨）", async () => {
    // signup_chain + 裂变开启 + perInvite/maxExtra=0 → 不再报错（数值仅对 lottery 有意义）
    const chain = makeDraw({
      activityKind: "signup_chain",
      resultMode: "ordered_assignment",
      promotionConfig: JSON.stringify({ version: 1, viral: { enabled: true, leaderboardEnabled: true } }),
    });
    const r1 = await buildPublishCheckForDraw(db, TENANT, chain as any);
    expect(r1.errors.some((item) => item.code === "viral.extra_entries.invalid")).toBe(false);
    expect(r1.errors.some((item) => item.code === "viral.max_extra.invalid")).toBe(false);

    // 排行榜能力仍保留校验（off 提示对非 lottery 也成立）
    const chainNoBoard = makeDraw({
      activityKind: "signup_chain",
      resultMode: "ordered_assignment",
      promotionConfig: JSON.stringify({ version: 1, viral: { enabled: true, leaderboardEnabled: false } }),
    });
    const r2 = await buildPublishCheckForDraw(db, TENANT, chainNoBoard as any);
    expect(r2.infos.some((item) => item.code === "viral.leaderboard.off")).toBe(true);
  });

  it("保底/每日免费仅支持即时开奖：manual/delayed 模式阻断，instant 放行", async () => {
    // manual 模式 + 保底 → 阻断
    const pityManual = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, pity: { enabled: true, threshold: 3 } }),
    });
    await addManualTier(pityManual.id);
    const r1 = await buildPublishCheckForDraw(db, TENANT, pityManual as any);
    expect(r1.errors.some((item) => item.code === "promotion.pity.delayed_not_supported")).toBe(true);

    // manual 模式 + 每日免费 → 阻断
    const dailyManual = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, dailyFreeSpins: { enabled: true, count: 1 } }),
    });
    await addManualTier(dailyManual.id);
    const r2 = await buildPublishCheckForDraw(db, TENANT, dailyManual as any);
    expect(r2.errors.some((item) => item.code === "promotion.dailyFree.delayed_not_supported")).toBe(true);

    // scheduled 模式 + 保底/每日免费 → 阻断（performInstantSpin 同样不执行）
    const pityScheduled = makeDraw({
      drawTrigger: "scheduled",
      resultMode: "scheduled",
      drawAt: new Date(Date.now() + 86400000).toISOString(),
      promotionConfig: JSON.stringify({ version: 1, pity: { enabled: true, threshold: 3 }, dailyFreeSpins: { enabled: true, count: 1 } }),
    });
    await addManualTier(pityScheduled.id);
    const r3 = await buildPublishCheckForDraw(db, TENANT, pityScheduled as any);
    expect(r3.errors.some((item) => item.code === "promotion.pity.delayed_not_supported")).toBe(true);
    expect(r3.errors.some((item) => item.code === "promotion.dailyFree.delayed_not_supported")).toBe(true);

    // instant 模式 + 保底/每日免费 → 放行
    const instant = makeDraw({
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({ version: 1, pity: { enabled: true, threshold: 3 }, dailyFreeSpins: { enabled: true, count: 1 } }),
    });
    await addManualTier(instant.id);
    const r4 = await buildPublishCheckForDraw(db, TENANT, instant as any);
    expect(r4.errors.some((item) => item.code === "promotion.pity.delayed_not_supported")).toBe(false);
    expect(r4.errors.some((item) => item.code === "promotion.dailyFree.delayed_not_supported")).toBe(false);

    // 未启用（enabled=false）→ 不误报
    const disabled = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, pity: { enabled: false }, dailyFreeSpins: { enabled: false } }),
    });
    await addManualTier(disabled.id);
    const r5 = await buildPublishCheckForDraw(db, TENANT, disabled as any);
    expect(r5.errors.some((item) => item.code === "promotion.pity.delayed_not_supported")).toBe(false);
    expect(r5.errors.some((item) => item.code === "promotion.dailyFree.delayed_not_supported")).toBe(false);

    // enabled 幻值（"true" 字符串）：normalize 判启用 → delayed 阻断（与运行时同一判定来源）
    const pityTruthy = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, pity: { enabled: "true", threshold: 3 } }),
    });
    await addManualTier(pityTruthy.id);
    const r6 = await buildPublishCheckForDraw(db, TENANT, pityTruthy as any);
    expect(r6.errors.some((item) => item.code === "promotion.pity.delayed_not_supported")).toBe(true);

    // threshold=0：normalize 归一化为禁用 → 不再误报「不支持」，但提示配置无效
    const pityInvalidThreshold = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, pity: { enabled: true, threshold: 0 } }),
    });
    await addManualTier(pityInvalidThreshold.id);
    const r7 = await buildPublishCheckForDraw(db, TENANT, pityInvalidThreshold as any);
    expect(r7.errors.some((item) => item.code === "promotion.pity.delayed_not_supported")).toBe(false);
    expect(r7.warnings.some((item) => item.code === "promotion.pity.disabled_by_invalid_threshold")).toBe(true);

    // count=0：同样归一化禁用 + 配置无效警告
    const dailyInvalidCount = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, dailyFreeSpins: { enabled: true, count: 0 } }),
    });
    await addManualTier(dailyInvalidCount.id);
    const r8 = await buildPublishCheckForDraw(db, TENANT, dailyInvalidCount as any);
    expect(r8.errors.some((item) => item.code === "promotion.dailyFree.delayed_not_supported")).toBe(false);
    expect(r8.warnings.some((item) => item.code === "promotion.dailyFree.disabled_by_invalid_count")).toBe(true);
  });

  it("推荐里程碑（referralRewards）仅支持即时开奖：manual 阻断，instant 放行，未配置不误报", async () => {
    // manual + referralRewards → 阻断
    const manual = makeDraw({
      promotionConfig: JSON.stringify({
        version: 1,
        referralRewards: [{ requireCount: 1, rewardType: "bonus_spin", rewardValue: 2 }],
      }),
    });
    await addManualTier(manual.id);
    const r1 = await buildPublishCheckForDraw(db, TENANT, manual as any);
    expect(r1.errors.some((item) => item.code === "promotion.referralRewards.delayed_not_supported")).toBe(true);

    // instant + referralRewards → 放行
    const instant = makeDraw({
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({
        version: 1,
        referralRewards: [{ requireCount: 1, rewardType: "bonus_spin", rewardValue: 2 }],
      }),
    });
    await addManualTier(instant.id);
    const r2 = await buildPublishCheckForDraw(db, TENANT, instant as any);
    expect(r2.errors.some((item) => item.code === "promotion.referralRewards.delayed_not_supported")).toBe(false);

    // 空数组 → 不误报
    const empty = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, referralRewards: [] }),
    });
    await addManualTier(empty.id);
    const r3 = await buildPublishCheckForDraw(db, TENANT, empty as any);
    expect(r3.errors.some((item) => item.code === "promotion.referralRewards.delayed_not_supported")).toBe(false);
  });

  it("instant + referralRewards 全无效项 → warning 告知不会发放（P2 审查修复）", async () => {
    const instant = makeDraw({
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({
        version: 1,
        referralRewards: [
          { requireCount: 101, rewardType: "bonus_spin", rewardValue: 1 }, // requireCount 越界
          { requireCount: 1, rewardType: "bonus_spin", rewardValue: 2000 }, // rewardValue 越界
        ],
      }),
    });
    await addManualTier(instant.id);
    const r = await buildPublishCheckForDraw(db, TENANT, instant as any);
    expect(r.errors.some((item) => item.code === "promotion.referralRewards.delayed_not_supported")).toBe(false);
    expect(r.warnings.some((item) => item.code === "promotion.referralRewards.invalid_entries")).toBe(true);
  });

  it("instant + 排行榜奖励：warning 提示手动发放（发布确认框可见）；manual 模式不误报", async () => {
    // instant + leaderboardRewards → warning 提示手动发放（info 级前端无展示通道，warning 才在发布确认框可见）
    const instant = makeDraw({
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: true, leaderboardRewards: [{ rank: 1, rewardType: "bonus_spin", rewardValue: 3 }] },
      }),
    });
    await addManualTier(instant.id);
    const r1 = await buildPublishCheckForDraw(db, TENANT, instant as any);
    expect(r1.warnings.some((item) => item.code === "viral.leaderboard.manual_grant")).toBe(true);
    expect(r1.infos.some((item) => item.code === "viral.leaderboard.manual_grant")).toBe(false);

    // manual 模式 + leaderboardRewards → 不提示（performDraw 自动发放）
    const manual = makeDraw({
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: true, leaderboardRewards: [{ rank: 1, rewardType: "bonus_spin", rewardValue: 3 }] },
      }),
    });
    await addManualTier(manual.id);
    const r2 = await buildPublishCheckForDraw(db, TENANT, manual as any);
    expect(r2.warnings.some((item) => item.code === "viral.leaderboard.manual_grant")).toBe(false);

    // instant + 未配置 leaderboardRewards → 不提示
    const noRewards = makeDraw({
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({ version: 1, viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: true } }),
    });
    await addManualTier(noRewards.id);
    const r3 = await buildPublishCheckForDraw(db, TENANT, noRewards as any);
    expect(r3.warnings.some((item) => item.code === "viral.leaderboard.manual_grant")).toBe(false);

    // instant + 排行榜未开启 + 已配置奖励 → rewards_require_enabled 警告，不提示 manual_grant
    const offWithRewards = makeDraw({
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: false, leaderboardRewards: [{ rank: 1, rewardType: "bonus_spin", rewardValue: 3 }] },
      }),
    });
    await addManualTier(offWithRewards.id);
    const r4 = await buildPublishCheckForDraw(db, TENANT, offWithRewards as any);
    expect(r4.infos.some((item) => item.code === "viral.leaderboard.off")).toBe(true);
    expect(r4.warnings.some((item) => item.code === "viral.leaderboard.manual_grant")).toBe(false);
    expect(r4.warnings.some((item) => item.code === "viral.leaderboard.rewards_require_enabled")).toBe(true);

    // scheduled 模式 + leaderboardRewards → 不提示（performDraw 自动发放）
    const scheduled = makeDraw({
      resultMode: "scheduled",
      drawTrigger: "manual",
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: true, leaderboardRewards: [{ rank: 1, rewardType: "bonus_spin", rewardValue: 3 }] },
      }),
    });
    await addManualTier(scheduled.id);
    const r5 = await buildPublishCheckForDraw(db, TENANT, scheduled as any);
    expect(r5.warnings.some((item) => item.code === "viral.leaderboard.manual_grant")).toBe(false);

    // instant + 无效奖励项（rank=0）→ normalize 过滤后为空，不提示
    const invalidRewards = makeDraw({
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: true, leaderboardRewards: [{ rank: 0, rewardType: "bonus_spin", rewardValue: 3 }] },
      }),
    });
    await addManualTier(invalidRewards.id);
    const r6 = await buildPublishCheckForDraw(db, TENANT, invalidRewards as any);
    expect(r6.warnings.some((item) => item.code === "viral.leaderboard.manual_grant")).toBe(false);
    expect(r6.infos.some((item) => item.code === "viral.leaderboard.manual_grant")).toBe(false);
  });

  it("referralRewardDefs 适配性校验：bonus_spin 非 lottery/非 instant 阻断（docs/253 §3.1）", async () => {
    // claim + bonus_spin → 阻断（非 lottery 不能消费抽奖次数）
    const claim = makeDraw({
      activityKind: "claim",
      promotionConfig: JSON.stringify({
        version: 1,
        referralRewardDefs: [
          { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
        ],
      }),
    });
    await addManualTier(claim.id);
    const r1 = await buildPublishCheckForDraw(db, TENANT, claim as any);
    expect(r1.errors.some((item) => item.code === "promotion.referralRewardDefs.bonus_spin.not_lottery")).toBe(true);

    // lottery + manual（非 instant）+ bonus_spin → 阻断
    const manual = makeDraw({
      activityKind: "lottery",
      resultMode: "manual",
      promotionConfig: JSON.stringify({
        version: 1,
        referralRewardDefs: [
          { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
        ],
      }),
    });
    await addManualTier(manual.id);
    const r2 = await buildPublishCheckForDraw(db, TENANT, manual as any);
    expect(r2.errors.some((item) => item.code === "promotion.referralRewardDefs.bonus_spin.not_instant")).toBe(true);

    // lottery + instant + bonus_spin + bonus_coupon → 放行（bonus_coupon 仅 warning 缺码池）
    const instant = makeDraw({
      activityKind: "lottery",
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({
        version: 1,
        referralRewardDefs: [
          { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
        ],
      }),
    });
    await addManualTier(instant.id);
    const r3 = await buildPublishCheckForDraw(db, TENANT, instant as any);
    expect(r3.errors.some((item) => item.code === "promotion.referralRewardDefs.bonus_spin.not_lottery")).toBe(false);
    expect(r3.errors.some((item) => item.code === "promotion.referralRewardDefs.bonus_spin.not_instant")).toBe(false);
  });

  it("viral.extraSpinsPerInvite 与 referralRewardDefs 同时配置 → 阻断（docs/254 审查发现）", async () => {
    // viral 每邀请加次 + referralRewardDefs 同时配置 → 阻断（同一邀请触发两次加次，语义重复）
    const conflict = makeDraw({
      activityKind: "lottery",
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: true, extraSpinsPerInvite: 1, maxExtraSpins: 10, leaderboardEnabled: true },
        referralRewardDefs: [
          { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
        ],
      }),
    });
    await addManualTier(conflict.id);
    const r1 = await buildPublishCheckForDraw(db, TENANT, conflict as any);
    expect(r1.errors.some((item) => item.code === "viral.extra_entries.conflict_with_reward_defs")).toBe(true);

    // viral 无每邀请加次（extraSpinsPerInvite 未配置）+ referralRewardDefs → 放行
    const noConflict = makeDraw({
      activityKind: "lottery",
      resultMode: "instant",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: true, leaderboardEnabled: true },
        referralRewardDefs: [
          { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
        ],
      }),
    });
    await addManualTier(noConflict.id);
    const r2 = await buildPublishCheckForDraw(db, TENANT, noConflict as any);
    expect(r2.errors.some((item) => item.code === "viral.extra_entries.conflict_with_reward_defs")).toBe(false);
  });
});
