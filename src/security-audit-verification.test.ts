/**
 * 安全审计验证测试（2026-08-02 代码审查配套，修复后行为断言版）
 *
 * 目的：用真实数据库验证代码审查报告中的关键发现，避免"凭感觉报漏洞"。
 * 每个用例对应审查报告中的一个发现，测试通过才认定为真实问题。
 *
 * 覆盖（docs/049 报告条目，已修复项断言"修复后行为"）：
 * 1. 开奖一致性（#3.4）：winners 与 status=drawn 同事务——正常原子落库、失败全回滚可重试。
 * 2. 限流竞态（#6）：checkDbRateLimit 原子条件 INSERT——同一 key 并发通过数严格 ≤ limit。
 * 3. verify-email 验证码猜测（#3.1）：内存 + DB 双层 IP 限流（10 次/15 分钟）。
 * 4. /result 端点邮箱枚举（#3.5）：与 my-result 对齐，要求验证码。
 * 5. 请求体大小闸门（#8）：chunked（无 content-length）请求体流式限幅，超限 413、正常可解析。
 *
 * 说明：这组测试是"验证审查结论"的正式测试，保留作为回归保护——
 * 未来任何一处改回缺陷实现，对应用例会立即失败。
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Hono } from "hono";
import { eq, and, count, like } from "drizzle-orm";
import type { AppEnv } from "./bindings";
import { clearTestData, getTestDb } from "./test-setup";
import { checkDbRateLimit } from "./lib/rate-limit";
import { enforceRequestBodyLimit } from "./lib/body-limit";
import { getClientIp } from "./lib/platform";
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
  lotteryEntries,
  lotteryPrizeTiers,
  lotteryWinners,
  rateLimitLog,
  tenantMembers,
  tenants,
  users,
} from "./db/schema";

/* ── 数据库设置 ───────────────────────────────────────────── */

let db: Awaited<ReturnType<typeof getTestDb>>["db"];
let client: Awaited<ReturnType<typeof getTestDb>>["client"];

const TENANT = "sec-audit-tenant";
const USER = "sec-audit-owner";

/**
 * 与 auth-and-public.test.ts 一致：Hono app.request 第三参注入 Bindings。
 * 不注入时 getEnv 读不到 JWT_SECRET → register 在 hash 密码阶段 500，
 * 会被误判为「限流未生效」或生产回归（本文件曾因此 flaky/红）。
 */
const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET: "test-sec-audit-jwt-secret-0123456789",
};

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

/* ── 测试 1：开奖一致性（winners 与 status=drawn 同事务，修复后行为） ── */

describe("开奖一致性：winners 写入与 status=drawn 同事务", () => {
  it("修复后：正常开奖 winners 与 drawn 状态原子落库（状态必为 drawn）", async () => {
    await seedOwner();
    const { id, publicSlug } = await setupOneWinnerDraw();

    const join = await joinDraw(db, publicSlug, "victim@test.com");
    expect(join.joined).toBe(true);

    const result = await performDraw(db, TENANT, id, USER);
    expect(result.winnerCount).toBe(1);

    // 原子性：开奖成功后 winners 存在且状态必为 drawn（二者同事务，不可能出现"有 winners 但状态 open"）
    const [draw] = await db
      .select()
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, id))
      .limit(1);
    expect(draw?.status).toBe("drawn");

    const winners = await db
      .select()
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.drawId, id), eq(lotteryWinners.tenantId, TENANT)));
    expect(winners.length).toBe(1);
  });

  it("修复后：事务中途失败时 winners 与 drawn 全部回滚，活动回滚 open 可重试（不再残留自锁）", async () => {
    await seedOwner();
    const { id, publicSlug } = await setupOneWinnerDraw();

    await joinDraw(db, publicSlug, "victim@test.com");

    // 预置一条与参与者同 entry 的 winner 记录，制造 UNIQUE(tenantId, drawId, entryId) 冲突，
    // 模拟开奖事务中途写入失败（并发残留或历史脏数据场景）。
    const [entry] = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.drawId, id))
      .limit(1);
    await db.insert(lotteryWinners).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: id,
      tierId: "tier-preset",
      entryId: entry!.id,
      identityType: "email",
      identityValue: "victim@test.com",
      prizeCodeId: "",
      drawnAt: new Date().toISOString(),
      notificationStatus: "pending",
    });

    // 开奖：winners 插入必然 UNIQUE 冲突 → 整个事务（含 status=drawn 更新）回滚
    await expect(performDraw(db, TENANT, id, USER)).rejects.toThrow();

    // 状态回滚为 open（可重试）：修复前残留场景会因二次开奖再冲突而永久自锁，
    // 修复后事务失败不落任何新数据，catch 将状态回滚 open 让运营者可重新开奖。
    const [draw] = await db
      .select()
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, id))
      .limit(1);
    expect(draw?.status).toBe("open");

    // winners 表无新增（事务原子性）：只有预置的那条，无新残留
    const winners = await db
      .select()
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.drawId, id), eq(lotteryWinners.tenantId, TENANT)));
    expect(winners.length).toBe(1);
  });
});

/* ── 测试 2：限流竞态（check-then-insert 非原子） ── */

describe("checkDbRateLimit 并发限流", () => {
  it("修复后：同一 key 20 并发、阈值 3，通过数严格等于 3（原子条件 INSERT）", async () => {
    const limit = 3;
    // key 在测试开始时固定：所有并发调用共享同一计数窗口（修复前用例误用 Date.now() 生成
    // 不同 key 导致各自独立计数，无法证明竞态；本次固定 key 才能验证限流正确性）
    const key = `race:${Date.now()}`;
    const concurrency = 20;
    const calls = Array.from({ length: concurrency }, () =>
      checkDbRateLimit(db, key, limit, 60000),
    );
    const results = await Promise.all(calls);
    const passed = results.filter(Boolean).length;

    // 原子实现下通过数严格等于 limit（前 limit 个通过，其余拒绝）
    expect(passed).toBe(limit);
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

    // 注册与 verify 分 IP：避免 register 内存/DB 计数污染 verify-email 窗口断言
    const regIp = "198.51.100.50";
    const verifyIp = "198.51.100.51";

    // 注册触发验证码落库（验证码 6 位数字，10 分钟有效，无盐 SHA-256 存储）
    const reg = await app.request(
      "/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": regIp },
        body: JSON.stringify({ username: "secuser", password: "Passw0rd123", email: "sec-user@test.com" }),
      },
      TEST_ENV,
    );
    expect(reg.status).toBe(200);

    // 对照组：register 内存 + DB 限流 3 次/分钟/IP；限流在业务校验前，连续请求必出 429。
    let register429 = 0;
    for (let i = 0; i < 5; i++) {
      const r = await app.request(
        "/auth/register",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": regIp },
          body: JSON.stringify({
            username: `secuserctrl${i}`,
            password: "Passw0rd123",
            email: `sec-user-ctrl-${i}@test.com`,
          }),
        },
        TEST_ENV,
      );
      if (r.status === 429) register429++;
    }
    expect(register429).toBeGreaterThan(0);

    // 目标组：verify-email 已加 IP 限流（10 次/15 分钟，auth.ts）。
    // 前 10 次通过限流 → 验证码错误返回 400；第 11 次起被限流 → 429。
    let verify400 = 0;
    let verify429 = 0;
    for (let i = 0; i < 12; i++) {
      const r = await app.request(
        "/auth/verify-email",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": verifyIp },
          body: JSON.stringify({
            email: "sec-user@test.com",
            code: String((100000 + i) % 1000000).padStart(6, "0"),
          }),
        },
        TEST_ENV,
      );
      if (r.status === 400) verify400++;
      if (r.status === 429) verify429++;
    }
    expect(verify400).toBe(10);
    expect(verify429).toBeGreaterThanOrEqual(2);
  });
});

/* ── 测试 5：#8 请求体大小闸门（chunked 绕过防护） ── */

describe("#8 请求体大小闸门", () => {
  function createBodyLimitApp() {
    const app = new Hono<AppEnv>();
    app.use("*", enforceRequestBodyLimit);
    app.post("/echo", async (c) => {
      const body = await c.req.json<{ hello?: string }>();
      return c.json({ ok: true, hello: body.hello });
    });
    return app;
  }

  /** 构造无 content-length 的请求（body 用 ReadableStream，阻止 Request 构造器自动加头） */
  function chunkedRequest(payload: string): Request {
    // node 运行时要求流式 body 带 duplex: "half"；workers RequestInit 类型无该字段，
    // 故整体断言为 RequestInit 绕过 excess property 检查（测试环境为 node）
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      duplex: "half" as const,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      }),
    } as RequestInit;
    return new Request("http://test/echo", init);
  }

  it("无 content-length（chunked）的超限请求体返回 413（绕过防护生效）", async () => {
    const app = createBodyLimitApp();
    const res = await app.request(chunkedRequest(JSON.stringify({ data: "x".repeat(200 * 1024) })));
    expect(res.status).toBe(413);
  });

  it("无 content-length 的正常请求体被重建并可供下游解析（功能不回归）", async () => {
    const app = createBodyLimitApp();
    const res = await app.request(chunkedRequest(JSON.stringify({ hello: "world" })));
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; hello: string };
    expect(data.ok).toBe(true);
    expect(data.hello).toBe("world");
  });

  it("有 content-length 的超限请求体返回 413（content-length 分支，手动设头）", async () => {
    const app = createBodyLimitApp();
    const payload = JSON.stringify({ data: "x".repeat(200 * 1024) });
    const res = await app.request("http://test/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(payload.length) },
      body: payload,
    });
    expect(res.status).toBe(413);
  });
});

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

describe("公开端敏感操作持久限流", () => {
  it("my-result 错误验证码按 IP + 身份写入 DB 限流，超过阈值返回 429", async () => {
    await seedOwner();
    const { publicSlug } = await setupOneWinnerDraw();
    const app = createPublicTestApp();
    const email = "victim-my-result@test.com";

    const post = () =>
      app.request(`/public/draws/${publicSlug}/my-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.11" },
        body: JSON.stringify({ email, code: "000000" }),
      });

    for (let i = 0; i < 10; i++) {
      const res = await post();
      expect(res.status).toBe(400);
    }
    const limited = await post();
    expect(limited.status).toBe(429);

    const [{ ipLogs }] = await db
      .select({ ipLogs: count() })
      .from(rateLimitLog)
      .where(eq(rateLimitLog.key, "my-result:198.51.100.11"));
    expect(Number(ipLogs)).toBe(10);

    const [{ identityLogs }] = await db
      .select({ identityLogs: count() })
      .from(rateLimitLog)
      .where(like(rateLimitLog.key, "my-result:identity:%"));
    expect(Number(identityLogs)).toBe(10);

    const plainEmailKeys = await db
      .select({ key: rateLimitLog.key })
      .from(rateLimitLog)
      .where(like(rateLimitLog.key, `%${email}%`));
    expect(plainEmailKeys).toHaveLength(0);
  });

  it("cancel 错误验证码同样有 DB 持久限流保护", async () => {
    await seedOwner();
    const now = new Date();
    const { id, publicSlug } = await createDraw(db, TENANT, {
      title: "取消限流接龙",
      startAt: now.toISOString(),
      endAt: new Date(now.getTime() + 3600000).toISOString(),
      activityKind: "signup_chain",
      participationMode: "open",
      experienceType: "list",
      resultMode: "ordered_assignment",
      allocationPolicy: "capacity",
      maxParticipants: 10,
      winnerCount: 1,
    });
    await publishDraw(db, TENANT, id);

    const app = createPublicTestApp();
    const post = () =>
      app.request(`/public/draws/${publicSlug}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.12" },
        body: JSON.stringify({ email: "cancel-target@test.com", code: "000000" }),
      });

    for (let i = 0; i < 10; i++) {
      const res = await post();
      expect(res.status).toBe(400);
    }
    const limited = await post();
    expect(limited.status).toBe(429);

    const [{ total }] = await db
      .select({ total: count() })
      .from(rateLimitLog)
      .where(eq(rateLimitLog.key, "cancel:198.51.100.12"));
    expect(Number(total)).toBe(10);
  });
});

describe("客户端 IP 解析", () => {
  it("默认不信任 X-Forwarded-For，显式 TRUST_PROXY_HEADERS=true 后才读取", async () => {
    const app = new Hono<AppEnv>();
    app.get("/ip", (c) => c.text(getClientIp(c)));

    const untrusted = await app.request("/ip", {
      headers: { "X-Forwarded-For": "203.0.113.1, 10.0.0.1" },
    });
    expect(await untrusted.text()).toBe("unknown");

    const trusted = await app.request("/ip", {
      headers: { "X-Forwarded-For": "203.0.113.1, 10.0.0.1" },
    }, { TRUST_PROXY_HEADERS: "true" } as any);
    expect(await trusted.text()).toBe("203.0.113.1");

    const cf = await app.request("/ip", {
      headers: { "CF-Connecting-IP": "198.51.100.20", "X-Forwarded-For": "203.0.113.1" },
    });
    expect(await cf.text()).toBe("198.51.100.20");
  });
});
