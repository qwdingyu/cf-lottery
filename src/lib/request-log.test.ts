/**
 * request_logs + consumeOnce 集成测试（docs/243）
 * 通过测试路由验证 `writeRequestLog` 和 `consumeOnce` 的 DB 行为。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { requestLogs, consumeOnceTokens } from "../db/schema";
import { eq } from "drizzle-orm";
import { clearTestData, getTestDb } from "../test-setup";
import { writeRequestLog, consumeOnce } from "./request-log";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET: "test-request-log-001",
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
  // 测试路由：writeRequestLog
  app.post("/test/write-log", async (c) => {
    await writeRequestLog(c, "test_action", 429);
    return c.json({ ok: true });
  });
  // 测试路由：consumeOnce 首次消费
  app.post("/test/consume-first", async (c) => {
    const result = await consumeOnce(c, "test_token", "token-abc");
    return c.json(result);
  });
  // 测试路由：consumeOnce 空 token
  app.post("/test/consume-empty", async (c) => {
    const result = await consumeOnce(c, "test_empty_token", "   ");
    return c.json(result);
  });
  // 测试路由：consumeOnce 重放
  app.post("/test/consume-replay", async (c) => {
    const first = await consumeOnce(c, "test_token", "token-abc");
    const second = await consumeOnce(c, "test_token", "token-abc");
    return c.json({ first, second });
  });
  // 测试路由：consumeOnce 并发（验证原子防重放）
  app.post("/test/consume-concurrent", async (c) => {
    const results = await Promise.all([
      consumeOnce(c, "test_concurrent", "token-conc"),
      consumeOnce(c, "test_concurrent", "token-conc"),
      consumeOnce(c, "test_concurrent", "token-conc"),
    ]);
    return c.json(results);
  });
  return app;
}

describe("writeRequestLog", () => {
  it("写入一条请求日志并包含 ipHash/method/path/action/statusCode", async () => {
    const app = createTestApp();
    const res = await app.request("/test/write-log", { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(200);

    const logs = await db.select().from(requestLogs).where(eq(requestLogs.action, "test_action"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.method).toBe("POST");
    expect(logs[0]!.path).toBe("/test/write-log");
    expect(logs[0]!.statusCode).toBe(429);
    expect(logs[0]!.ipHash).toBeTruthy();
  });
});

describe("consumeOnce", () => {
  it("首次消费返回 ok:true，重放返回 already_used", async () => {
    const app = createTestApp();
    const res = await app.request("/test/consume-replay", { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { first: { ok: boolean }; second: { ok: boolean; reason: string } };
    expect(body.first).toEqual({ ok: true });
    expect(body.second).toEqual({ ok: false, reason: "already_used" });

    // DB 中只有一条记录
    const tokens = await db
      .select()
      .from(consumeOnceTokens)
      .where(eq(consumeOnceTokens.action, "test_token"));
    expect(tokens).toHaveLength(1);
  });

  it("空 token 返回 empty_token 且不触库", async () => {
    const app = createTestApp();
    const res = await app.request("/test/consume-empty", { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; reason: string };
    expect(body).toEqual({ ok: false, reason: "empty_token" });

    // 空 token 不触库
    const tokens = await db
      .select()
      .from(consumeOnceTokens)
      .where(eq(consumeOnceTokens.action, "test_empty_token"));
    expect(tokens).toHaveLength(0);
  });

  it("并发消费同一 token 只成功一次（原子防重放）", async () => {
    const app = createTestApp();
    const res = await app.request("/test/consume-concurrent", { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(200);
    const results = await res.json() as Array<{ ok: boolean; reason?: string }>;
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(1); // 3 个并发只有 1 个成功
    expect(results.filter((r) => !r.ok && r.reason === "already_used").length).toBe(2);

    // DB 只有一条记录
    const tokens = await db
      .select()
      .from(consumeOnceTokens)
      .where(eq(consumeOnceTokens.action, "test_concurrent"));
    expect(tokens).toHaveLength(1);
  });
});
