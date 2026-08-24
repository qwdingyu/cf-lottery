/**
 * experienceType 业务冒烟测试（docs/269 补充）
 *
 * 验证 activityKind ↔ experienceType 组合校验在完整业务流程中的正确性：
 * 1. 默认 experienceType：创建时未传 experienceType，验证自动选择正确默认值
 * 2. 合法组合正向创建：每种 activityKind + experienceType 合法组合能通过 API 创建
 * 3. kindChanged 联动重置：PATCH 切换 activityKind 时 experienceType 自动重置为新 kind 默认值
 * 4. 公开页 experienceType 渲染：GET /api/public/draws/:slug 返回的 experienceType 与创建时一致
 * 5. 端到端流程：创建 → 发布 → 公开页查看 → 参与，experienceType 在链路中正确传递
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { adminLotteryRoute } from "./admin-lottery";
import { publicLotteryRoute } from "./public-lottery";
import { signJwt } from "../middleware/auth";
import { lotteryDraws, tenants, users, tenantMembers, systemConfig, lotteryEntries, prizes, lotteryPrizeTiers } from "../db/schema";
import { eq } from "drizzle-orm";
import { clearTestData, getTestDb } from "../test-setup";
import { ALLOWED_EXPERIENCE_TYPES } from "../lib/activity-utils";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const JWT_SECRET = "test-smoke-secret-0123456789abcdef";
const TENANT_ID = "tenant-smoke";
const OWNER_ID = "user-smoke-owner";

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
  await db.insert(tenants).values({ id: TENANT_ID, name: "Smoke Test" });
  await db.insert(users).values({ id: OWNER_ID, username: "smokeowner", email: "smoke@test.com", emailVerified: 1, passwordHash: "hash" });
  await db.insert(tenantMembers).values({ tenantId: TENANT_ID, userId: OWNER_ID, role: "owner" });
  await db.insert(systemConfig).values({ key: "enabled_activity_kinds", value: "lottery,signup_chain,claim,survey,vote,checkin,approval,reservation,waitlist" });
  await db.insert(systemConfig).values({ key: "enable_email_verification", value: "false" });
}

async function authHeader() {
  const token = await signJwt({ sub: OWNER_ID, tenantId: TENANT_ID }, JWT_SECRET, 3600);
  return { Authorization: `Bearer ${token}` };
}

function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60000).toISOString();
}

/** 通过 POST API 创建活动，返回响应和解析后的 JSON */
async function createDrawViaApi(
  app: Hono<AppEnv>,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await app.request("/api/admin/draws", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({
      title: "冒烟测试活动",
      startAt: futureIso(-10),
      endAt: futureIso(60),
      ...body,
    }),
  }, TEST_ENV);
  const json = await res.json() as any;
  return { status: res.status, json };
}

/** 通过 PATCH API 编辑活动 */
async function patchDrawViaApi(
  app: Hono<AppEnv>,
  drawId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await app.request(`/api/admin/draws/${drawId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(body),
  }, TEST_ENV);
  const json = await res.json() as any;
  return { status: res.status, json };
}

/** 配置手动奖项并发布（仅 lottery 需要） */
async function configureAndPublish(app: Hono<AppEnv>, drawId: string) {
  // 创建奖品
  const prizeRes = await app.request("/api/admin/prizes", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ name: "测试奖品", prizeType: "manual_fulfillment" }),
  }, TEST_ENV);
  const prizeData = await prizeRes.json() as { ok: boolean; id: string };

  // 配置奖项
  await app.request(`/api/admin/draws/${drawId}/tiers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ tiers: [{ prizeId: prizeData.id, tierName: "一等奖", winnerCount: 1 }] }),
  }, TEST_ENV);

  // 发布
  await app.request(`/api/admin/draws/${drawId}/publish`, {
    method: "POST",
    headers: { ...(await authHeader()) },
  }, TEST_ENV);
}

// ═══════════════════════════════════════════════════════════════
// 场景 1：默认 experienceType 验证
// ═══════════════════════════════════════════════════════════════
describe("冒烟：默认 experienceType", () => {
  /** 各 activityKind 不传 experienceType 时应自动选择的默认值 */
  const expectedDefaults: Record<string, string> = {
    lottery: "wheel",
    signup_chain: "list",
    reservation: "calendar",
    vote: "ballot",
    survey: "form",
    checkin: "checkin",
    waitlist: "queue",
    approval: "form",
    claim: "reveal",
  };

  for (const [kind, expectedDefault] of Object.entries(expectedDefaults)) {
    it(`${kind} → 默认 experienceType = ${expectedDefault}`, async () => {
      await seedOwner();
      const app = createTestApp();

      const { status, json } = await createDrawViaApi(app, {
        activityKind: kind,
        participationMode: "open",
      });
      expect(status).toBe(200);
      expect(json.ok).toBe(true);

      // 从 DB 验证 experienceType 被正确设置为默认值
      const [draw] = await db.select({ experienceType: lotteryDraws.experienceType })
        .from(lotteryDraws).where(eq(lotteryDraws.id, json.id)).limit(1);
      expect(draw?.experienceType).toBe(expectedDefault);
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// 场景 2：所有合法组合正向创建
// ═══════════════════════════════════════════════════════════════
describe("冒烟：合法组合正向创建", () => {
  for (const [kind, allowed] of Object.entries(ALLOWED_EXPERIENCE_TYPES)) {
    for (const exp of allowed) {
      it(`${kind} + ${exp} → 创建成功（200）`, async () => {
        await seedOwner();
        const app = createTestApp();

        const { status, json } = await createDrawViaApi(app, {
          activityKind: kind,
          experienceType: exp,
          participationMode: "open",
        });
        expect(status).toBe(200);
        expect(json.ok).toBe(true);

        // 验证 DB 中的 experienceType
        const [draw] = await db.select({ experienceType: lotteryDraws.experienceType })
          .from(lotteryDraws).where(eq(lotteryDraws.id, json.id)).limit(1);
        expect(draw?.experienceType).toBe(exp);
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// 场景 3：不合法组合拒绝（端到端 API 校验）
// ═══════════════════════════════════════════════════════════════
describe("冒烟：不合法组合拒绝", () => {
  /** 所有不合法组合：每个 activityKind 的不允许的 experienceType */
  const illegalCombos: Array<[string, string]> = [
    ["lottery", "ballot"],
    ["lottery", "form"],
    ["lottery", "list"],
    ["lottery", "calendar"],
    ["lottery", "checkin"],
    ["lottery", "queue"],
    ["vote", "wheel"],
    ["vote", "slot"],
    ["vote", "scratch"],
    ["checkin", "wheel"],
    ["checkin", "form"],
    ["claim", "wheel"],
    ["claim", "ballot"],
    ["approval", "wheel"],
  ];

  for (const [kind, exp] of illegalCombos) {
    it(`${kind} + ${exp} → POST 400`, async () => {
      await seedOwner();
      const app = createTestApp();

      const { status, json } = await createDrawViaApi(app, {
        activityKind: kind,
        experienceType: exp,
      });
      expect(status).toBe(400);
      expect(json.error).toContain("不适用于活动类型");
    });
  }

  for (const [kind, exp] of illegalCombos.slice(0, 5)) {
    it(`${kind} + ${exp} → PATCH 400`, async () => {
      await seedOwner();
      const app = createTestApp();

      // 先创建一个合法活动
      const { json: created } = await createDrawViaApi(app, {
        activityKind: "lottery",
        experienceType: "wheel",
      });

      // 尝试切换到不合法组合
      const { status, json } = await patchDrawViaApi(app, created.id, {
        activityKind: kind,
        experienceType: exp,
      });
      expect(status).toBe(400);
      expect(json.error).toContain("不适用于活动类型");
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// 场景 4：kindChanged 联动重置 experienceType
// ═══════════════════════════════════════════════════════════════
describe("冒烟：kindChanged 联动重置", () => {
  const switchCases: Array<[string, string, string]> = [
    // [从 kind, 到 kind, 预期重置后的 experienceType]
    ["lottery", "signup_chain", "list"],
    ["lottery", "vote", "ballot"],
    ["lottery", "survey", "form"],
    ["lottery", "checkin", "checkin"],
    ["lottery", "approval", "form"],
    ["lottery", "claim", "reveal"],
    ["signup_chain", "lottery", "wheel"],
    ["vote", "lottery", "wheel"],
  ];

  for (const [fromKind, toKind, expectedExp] of switchCases) {
    it(`${fromKind} → ${toKind}：experienceType 重置为 ${expectedExp}`, async () => {
      await seedOwner();
      const app = createTestApp();

      // 创建源活动
      const { json: created } = await createDrawViaApi(app, {
        activityKind: fromKind,
        experienceType: ALLOWED_EXPERIENCE_TYPES[fromKind]?.[0] || "wheel",
      });

      // 切换 activityKind，不传 experienceType
      const { status, json } = await patchDrawViaApi(app, created.id, {
        activityKind: toKind,
      });
      expect(status).toBe(200);

      // 验证 experienceType 被重置为新 kind 的默认值
      const [draw] = await db.select({ experienceType: lotteryDraws.experienceType })
        .from(lotteryDraws).where(eq(lotteryDraws.id, created.id)).limit(1);
      expect(draw?.experienceType).toBe(expectedExp);
    });
  }

  it("同 kind 切换不触发重置（保留原 experienceType）", async () => {
    await seedOwner();
    const app = createTestApp();

    // 创建 lottery + slot
    const { json: created } = await createDrawViaApi(app, {
      activityKind: "lottery",
      experienceType: "slot",
    });

    // PATCH 同一 kind，不传 experienceType → 应保留 slot
    const { status } = await patchDrawViaApi(app, created.id, {
      activityKind: "lottery",
    });
    expect(status).toBe(200);

    const [draw] = await db.select({ experienceType: lotteryDraws.experienceType })
      .from(lotteryDraws).where(eq(lotteryDraws.id, created.id)).limit(1);
    expect(draw?.experienceType).toBe("slot");
  });

  it("显式传入 experienceType 覆盖默认值", async () => {
    await seedOwner();
    const app = createTestApp();

    // 创建 lottery + wheel
    const { json: created } = await createDrawViaApi(app, {
      activityKind: "lottery",
      experienceType: "wheel",
    });

    // 切换到 lottery + scratch（显式传入）
    const { status } = await patchDrawViaApi(app, created.id, {
      activityKind: "lottery",
      experienceType: "scratch",
    });
    expect(status).toBe(200);

    const [draw] = await db.select({ experienceType: lotteryDraws.experienceType })
      .from(lotteryDraws).where(eq(lotteryDraws.id, created.id)).limit(1);
    expect(draw?.experienceType).toBe("scratch");
  });
});

// ═══════════════════════════════════════════════════════════════
// 场景 5：公开页 experienceType 渲染
// ═══════════════════════════════════════════════════════════════
describe("冒烟：公开页 experienceType 渲染", () => {
  it("创建 → 发布 → 公开页 GET 返回正确的 experienceType", async () => {
    await seedOwner();
    const app = createTestApp();

    // 创建 lottery + scratch
    const { json: created } = await createDrawViaApi(app, {
      activityKind: "lottery",
      experienceType: "scratch",
      participationMode: "open",
    });

    // 配置奖项并发布
    await configureAndPublish(app, created.id);

    // 获取 publicSlug
    const [draw] = await db.select({ publicSlug: lotteryDraws.publicSlug })
      .from(lotteryDraws).where(eq(lotteryDraws.id, created.id)).limit(1);
    expect(draw?.publicSlug).toBeTruthy();

    // 公开页查看详情
    const detailRes = await app.request(`/api/public/draws/${draw!.publicSlug}`, {
      method: "GET",
    }, TEST_ENV);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as any;
    expect(detail.ok).toBe(true);
    expect(detail.experienceType).toBe("scratch");
    expect(detail.activityKind).toBe("lottery");
  });

  it("多种 activityKind 的公开页 experienceType 均正确", async () => {
    await seedOwner();
    const app = createTestApp();

    // 仅测试无需额外 activityConfig 即可发布的 activityKind
    // survey 需要 fields 配置、vote 需要 options 配置，此处跳过（在端到端流程中单独覆盖）
    const combos: Array<[string, string]> = [
      ["lottery", "wheel"],
      ["signup_chain", "list"],
      ["checkin", "submit"],
      ["approval", "form"],
      ["claim", "reveal"],
    ];

    for (const [kind, exp] of combos) {
      const { json: created } = await createDrawViaApi(app, {
        activityKind: kind,
        experienceType: exp,
        participationMode: "open",
      });

      // lottery 需要奖项才能发布
      if (kind === "lottery") {
        await configureAndPublish(app, created.id);
      } else {
        // 非 lottery 直接发布
        await app.request(`/api/admin/draws/${created.id}/publish`, {
          method: "POST",
          headers: { ...(await authHeader()) },
        }, TEST_ENV);
      }

      const [draw] = await db.select({ publicSlug: lotteryDraws.publicSlug })
        .from(lotteryDraws).where(eq(lotteryDraws.id, created.id)).limit(1);

      const detailRes = await app.request(`/api/public/draws/${draw!.publicSlug}`, { method: "GET" }, TEST_ENV);
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json() as any;
      expect(detail.activityKind).toBe(kind);
      expect(detail.experienceType).toBe(exp);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 场景 6：端到端流程（创建 → 发布 → 公开页 → 参与）
// ═══════════════════════════════════════════════════════════════
describe("冒烟：端到端业务流程", () => {
  it("lottery + wheel：创建→发布→公开页→参与→验证", async () => {
    await seedOwner();
    const app = createTestApp();

    // 1. 创建
    const { json: created } = await createDrawViaApi(app, {
      activityKind: "lottery",
      experienceType: "wheel",
      participationMode: "open",
      winnerCount: 1,
    });
    expect(created.ok).toBe(true);

    // 2. 配置奖项 + 发布
    await configureAndPublish(app, created.id);

    // 3. 公开页查看
    const [draw] = await db.select({ publicSlug: lotteryDraws.publicSlug })
      .from(lotteryDraws).where(eq(lotteryDraws.id, created.id)).limit(1);

    const detailRes = await app.request(`/api/public/draws/${draw!.publicSlug}`, { method: "GET" }, TEST_ENV);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as any;
    expect(detail.experienceType).toBe("wheel");
    expect(detail.activityKind).toBe("lottery");

    // 4. 用户参与
    const joinRes = await app.request(`/api/public/draws/${draw!.publicSlug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.1" },
      body: JSON.stringify({ email: "smoke-user@test.com" }),
    }, TEST_ENV);
    expect(joinRes.status).toBe(200);
    const joinData = await joinRes.json() as any;
    expect(joinData.ok).toBe(true);

    // 5. 验证参与记录
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, created.id));
    expect(entry?.identityValue).toBe("smoke-user@test.com");
  });

  it("signup_chain + list：创建→发布→参与→顺序分配", async () => {
    await seedOwner();
    const app = createTestApp();

    const { json: created } = await createDrawViaApi(app, {
      activityKind: "signup_chain",
      experienceType: "list",
      participationMode: "open",
      allocationPolicy: "capacity",
      maxParticipants: 2,
    });

    // 发布
    await app.request(`/api/admin/draws/${created.id}/publish`, {
      method: "POST",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);

    const [draw] = await db.select({ publicSlug: lotteryDraws.publicSlug })
      .from(lotteryDraws).where(eq(lotteryDraws.id, created.id)).limit(1);

    // 2 人参与
    for (let i = 1; i <= 2; i++) {
      const joinRes = await app.request(`/api/public/draws/${draw!.publicSlug}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.0.0.${i}` },
        body: JSON.stringify({ email: `signup${i}@test.com` }),
      }, TEST_ENV);
      expect(joinRes.status).toBe(200);
    }

    // 第 3 人被拒
    const join3 = await app.request(`/api/public/draws/${draw!.publicSlug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.3" },
      body: JSON.stringify({ email: "signup3@test.com" }),
    }, TEST_ENV);
    const data3 = await join3.json() as any;
    expect(data3.ok).toBe(false);
  });

  it("claim + submit：创建→发布→参与（支付后留资场景）", async () => {
    await seedOwner();
    const app = createTestApp();

    const { json: created } = await createDrawViaApi(app, {
      activityKind: "claim",
      experienceType: "submit",
      participationMode: "open",
    });

    // 发布
    await app.request(`/api/admin/draws/${created.id}/publish`, {
      method: "POST",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);

    const [draw] = await db.select({ publicSlug: lotteryDraws.publicSlug })
      .from(lotteryDraws).where(eq(lotteryDraws.id, created.id)).limit(1);

    // 公开页验证
    const detailRes = await app.request(`/api/public/draws/${draw!.publicSlug}`, { method: "GET" }, TEST_ENV);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as any;
    expect(detail.experienceType).toBe("submit");
    expect(detail.activityKind).toBe("claim");

    // 用户参与
    const joinRes = await app.request(`/api/public/draws/${draw!.publicSlug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.1" },
      body: JSON.stringify({ email: "claim-user@test.com" }),
    }, TEST_ENV);
    expect(joinRes.status).toBe(200);
  });

  it("vote + ballot：创建→发布→参与→投票", async () => {
    await seedOwner();
    const app = createTestApp();

    const { json: created } = await createDrawViaApi(app, {
      activityKind: "vote",
      experienceType: "ballot",
      participationMode: "open",
      activityConfig: JSON.stringify({
        version: 1,
        kind: "vote",
        selection: "single",
        options: [
          { id: "opt-a", label: "选项A", description: "", imageUrl: "" },
          { id: "opt-b", label: "选项B", description: "", imageUrl: "" },
        ],
      }),
    });

    // 发布
    await app.request(`/api/admin/draws/${created.id}/publish`, {
      method: "POST",
      headers: { ...(await authHeader()) },
    }, TEST_ENV);

    const [draw] = await db.select({ publicSlug: lotteryDraws.publicSlug })
      .from(lotteryDraws).where(eq(lotteryDraws.id, created.id)).limit(1);

    // 用户投票
    const joinRes = await app.request(`/api/public/draws/${draw!.publicSlug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.1" },
      body: JSON.stringify({ email: "voter@test.com", submission: { optionId: "opt-a" } }),
    }, TEST_ENV);
    expect(joinRes.status).toBe(200);
  });
});
