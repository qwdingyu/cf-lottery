/**
 * 安全审计验证测试（2026-08-02 代码审查配套，2026-08-02 修复复核更新）
 *
 * 目的：用真实数据库验证代码审查报告中的关键发现，避免"凭感觉报漏洞"。
 * 每个用例对应审查报告中的一个发现，测试通过才认定为真实问题。
 *
 * 覆盖（对应 docs/049 报告条目）：
 * 1. 开奖一致性缺陷（报告 #4）：performDraw 中 winners 写入与 status=drawn 更新分离，
 *    故障残留（winners 已存在但状态被回滚为 open）会导致活动永久无法再次开奖（自锁）。
 *    【尚未修复】测试断言缺陷仍然存在。
 * 2. 限流竞态（报告 #6）：checkDbRateLimit 是 check-then-insert 非原子实现，
 *    并发请求可同时通过检查，绕过限流阈值。
 *    【尚未修复】测试断言缺陷仍然存在。
 * 3. verify-email 无限流（报告 #1）：修复后已加 IP 限流（10 次/15 分钟）。
 *    【已修复】测试断言修复后行为：前 10 次返回 400，第 11 次起返回 429。
 * 4. /result 端点邮箱枚举（报告 #3.5）：修复后与 my-result 对齐，要求验证码。
 *    【已修复】测试断言修复后行为：无验证码/错误验证码被拒，有效验证码可查询。
 *
 * 说明：这组测试是"验证审查结论"的正式测试，保留作为知识沉淀；
 * 修复对应缺陷后，相关用例应被更新为"断言修复后行为"而非删除。
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "./bindings";
import { clearTestData, getTestDb } from "./test-setup";
import { checkDbRateLimit } from "./lib/rate-limit";
import { authRoute } from "./routes/auth";
import { publicLotteryRoute } from "./routes/public-lottery";
import {
  createDraw,
  publishDraw,
  performDraw,
  joinDraw,
  createPrize,
} from "./services/lottery-service";
import {
  emailAccessCodes,
  lotteryDraws,
  lotteryPrizeTiers,
  lotteryWinners,
  tenantMembers,
  tenants,
  users,
} from "./db/schema";

/* ── 数据库设置 ───────────────────────────────────────────── */

let db: Awaited<ReturnType<typeof getTestDb>>["db"];
let client: Awaited<ReturnType<typeof getTestDb>>["client"];

const TENANT = "sec-audit-tenant";
const USER = "sec-audit-owner";

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

/* ── 辅助函数 ─────────────────────────────────────────────── */

async function seedOwner() {
  await db.insert(tenants).values({ id: TENANT, name: "安全审计租户" });
  await db.insert(users).values({
    id: USER,
    username: "sec-owner",
    email: "sec@test.com",
    emailVerified: 1,
    passwordHash: "hash",
  });
  await db.insert(tenantMembers).values({ tenantId: TENANT, userId: USER, role: "owner" });
}

/** SHA-256 hex（与后端 hashCode 一致的验证码 hash 算法，用于构造有效验证码） */
async function sha256hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 公开路由测试 app（与 auth-and-public.test.ts 约定一致） */
function createPublicTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/public", publicLotteryRoute);
  return app;
}

/**
 * 创建 1 个中奖名额、1 个奖项的抽奖活动并发布。
 * 候选池唯一时，第二次开奖必然选中同一参与者。
 */
async function setupOneWinnerDraw() {
  const now = new Date();
  const future = new Date(now.getTime() + 3600000);
  const { id, publicSlug } = await createDraw(db, TENANT, {
    title: "安全审计活动",
    startAt: now.toISOString(),
    endAt: future.toISOString(),
    participationMode: "open",
    winnerCount: 1,
    maxParticipants: 100,
  });
  const { id: prizeId } = await createPrize(db, TENANT, { name: "审计奖品", prizeType: "manual_fulfillment" });
  await db.insert(lotteryPrizeTiers).values({
    id: crypto.randomUUID(),
    tenantId: TENANT,
    drawId: id,
    prizeId,
    tierName: "中奖",
    winnerCount: 1,
    sortOrder: 100,
  });
  await publishDraw(db, TENANT, id);
  return { id, publicSlug };
}

/* ── 测试 1：开奖一致性缺陷（winners 与 drawn 状态分离） ── */

describe("开奖一致性：winners 写入与 status=drawn 更新分离", () => {
  it("故障残留（winners 已存在但状态回滚 open）后，活动永久无法再次开奖", async () => {
    await seedOwner();
    const { id, publicSlug } = await setupOneWinnerDraw();

    // 唯一参与者 → 第二次开奖必然选中同一人 → UNIQUE(tenantId, drawId, entryId) 冲突必然触发
    const join = await joinDraw(db, publicSlug, "victim@test.com");
    expect(join.joined).toBe(true);

    // 第一次开奖正常完成（对照组，证明流程本身可用）
    const first = await performDraw(db, TENANT, id, USER);
    expect(first.winnerCount).toBe(1);

    // 模拟故障残留：performDraw 中"事务提交 winners 成功、但随后 status=drawn 更新失败"，
    // 此时 catch 分支会把状态回滚为 open（lottery-service.ts:2054），winners 残留。
    await db
      .update(lotteryDraws)
      .set({ status: "open", failureReason: "模拟：drawn 状态更新失败", updatedAt: new Date().toISOString() })
      .where(eq(lotteryDraws.id, id));

    // 第二次开奖：重新随机抽取必然选中已中奖的同一人 → UNIQUE 冲突 → 开奖失败并再次回滚 open
    await expect(performDraw(db, TENANT, id, USER)).rejects.toThrow();

    // 活动既无法进入 drawn，也无法通过 healDrawingState 治愈（该函数只处理 drawing 状态）→ 永久自锁
    const [draw] = await db
      .select()
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, id))
      .limit(1);
    expect(draw?.status).toBe("open");

    // winners 残留未清理：运营者视角看到"已开奖数据"与"未开奖状态"矛盾
    const winners = await db
      .select()
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.drawId, id), eq(lotteryWinners.tenantId, TENANT)));
    expect(winners.length).toBeGreaterThan(0);
  });
});

/* ── 测试 2：限流竞态（check-then-insert 非原子） ── */

describe("checkDbRateLimit 并发竞态", () => {
  it("并发请求可绕过限流阈值（check-then-insert 非原子）", async () => {
    const limit = 3;
    const concurrency = 20;
    const calls = Array.from({ length: concurrency }, () =>
      checkDbRateLimit(db, `race:${Date.now()}`, limit, 60000),
    );
    const results = await Promise.all(calls);
    const passed = results.filter(Boolean).length;

    // 原子实现下通过数 ≤ limit；check-then-insert 下多个并发请求会先全部通过检查再各自写入
    expect(passed).toBeGreaterThan(limit);
  });
});

/* ── 测试 3：verify-email 无任何限流（对比 register） ── */

describe("verify-email 验证码猜测", () => {
  it("限流已生效：前 10 次验证码错误返回 400，第 11 次起返回 429（对照组 register 同样有限流）", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/auth", authRoute);

    // 注册触发验证码落库（验证码 6 位数字，10 分钟有效，无盐 SHA-256 存储）
    const reg = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "secuser", password: "Passw0rd123", email: "sec-user@test.com" }),
    });
    expect(reg.status).toBe(200);

    // 对照组：register 内存限流 3 次/分钟/IP（测试环境 IP 统一为 unknown），
    // 限流检查在用户名/邮箱校验之前，连续请求必然触发 429。
    let register429 = 0;
    for (let i = 0; i < 5; i++) {
      const r = await app.request("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: `secuserctrl${i}`,
          password: "Passw0rd123",
          email: `sec-user-ctrl-${i}@test.com`,
        }),
      });
      if (r.status === 429) register429++;
    }
    expect(register429).toBeGreaterThan(0);

    // 目标组：verify-email 已加 IP 限流（10 次/15 分钟，auth.ts）。
    // 前 10 次通过限流 → 验证码错误返回 400；第 11 次起被限流 → 429。
    let verify400 = 0;
    let verify429 = 0;
    for (let i = 0; i < 12; i++) {
      const r = await app.request("/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "sec-user@test.com",
          code: String((100000 + i) % 1000000).padStart(6, "0"),
        }),
      });
      if (r.status === 400) verify400++;
      if (r.status === 429) verify429++;
    }
    expect(verify400).toBe(10);
    expect(verify429).toBeGreaterThanOrEqual(2);
  });
});

/* ── 测试 4：/result 端点防枚举（对齐 my-result） ── */

describe("/result 端点防邮箱枚举", () => {
  it("无验证码/错误验证码被拒，有效验证码可查询（与 my-result 行为对齐）", async () => {
    await seedOwner();
    const { publicSlug } = await setupOneWinnerDraw();

    // 参与者入库
    const join = await joinDraw(db, publicSlug, "victim@test.com");
    expect(join.joined).toBe(true);

    // 直接构造一条有效验证码记录（模拟用户已通过邮件收到验证码；drawId 需匹配活动内部 ID）
    const [draw] = await db
      .select({ id: lotteryDraws.id })
      .from(lotteryDraws)
      .where(eq(lotteryDraws.publicSlug, publicSlug))
      .limit(1);
    const code = "123456";
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email: "victim@test.com",
      drawId: draw!.id,
      codeHash: await sha256hex(code),
      used: 0,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    });

    const app = createPublicTestApp();
    const post = (body: Record<string, unknown>) =>
      app.request(`/public/draws/${publicSlug}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // 无验证码 → 400（防枚举：任意邮箱无法探测是否参与）
    const noCode = await post({ email: "victim@test.com" });
    expect(noCode.status).toBe(400);

    // 错误验证码 → 400
    const wrongCode = await post({ email: "victim@test.com", code: "000000" });
    expect(wrongCode.status).toBe(400);

    // 有效验证码 → 200，可查询到参与状态
    const okRes = await post({ email: "victim@test.com", code });
    expect(okRes.status).toBe(200);
    const data = await okRes.json() as { joined: boolean };
    expect(data.joined).toBe(true);
  });
});
