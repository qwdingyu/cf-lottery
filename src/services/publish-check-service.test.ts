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
    expect(survey.infos.some((item) => item.code === "survey.config.ready")).toBe(true);
    expect(vote.infos.some((item) => item.code === "vote.config.ready")).toBe(true);
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

    // 合法配置 → 无错误
    const ok = makeDraw({
      promotionConfig: JSON.stringify({ version: 1, viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: true } }),
    });
    await addManualTier(ok.id);
    const r5 = await buildPublishCheckForDraw(db, TENANT, ok as any);
    expect(r5.errors.some((item) => item.section === "promotion" && (item.code as string).startsWith("viral"))).toBe(false);
  });
});
