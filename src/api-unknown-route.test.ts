/**
 * 未知 /api/* 必须 JSON 404，不得落入 SPA HTML fallback。
 * 与 src/index.ts 路由顺序保持一致（API 路由 → all /api/* → SPA get *）。
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";

function createAppWithSpaFallback() {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true, db: true }));
  // 与生产一致：未知 API 先截获
  app.all("/api/*", (c) => c.json({ ok: false, message: "接口不存在" }, 404));
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/") || c.req.path === "/api") {
      return c.json({ ok: false, message: "接口不存在" }, 404);
    }
    return c.html("<!DOCTYPE html><html><body>spa</body></html>");
  });
  return app;
}

describe("未知 API 不回落 SPA HTML", () => {
  it("已注册 /api/health 仍为 JSON 200", async () => {
    const app = createAppWithSpaFallback();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toMatch(/json/);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("未知 /api 路径返回 JSON 404", async () => {
    const app = createAppWithSpaFallback();
    const res = await app.request("/api/totally-missing-xyz");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") || "").toMatch(/json/);
    const body = await res.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("接口不存在");
  });

  it("基线安全响应头存在（nosniff）", async () => {
    // 与生产 index 一致：CORS 后挂安全头中间件
    const app = new Hono();
    app.use("*", async (c, next) => {
      await next();
      c.res.headers.set("X-Content-Type-Options", "nosniff");
      c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    });
    app.get("/api/ping", (c) => c.json({ ok: true }));
    const res = await app.request("/api/ping");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  /**
   * Cron 运维入口：Bearer 与 CRON_SECRET 用常量时间比较（docs/073）。
   * 此处只测比较语义与分支，不拉起完整 processDueDraws。
   */
  it("CRON_SECRET 比较：空 token 拒绝；匹配通过语义与 timingSafeEqualString 一致", async () => {
    const { timingSafeEqualString } = await import("./lib/crypto-compare");
    const secret = "cron-test-secret-0123456789abcdef";
    expect(timingSafeEqualString("", secret)).toBe(false);
    expect(timingSafeEqualString("wrong", secret)).toBe(false);
    expect(timingSafeEqualString(secret, secret)).toBe(true);
    // 前缀相同但整体不同 → false（避免依赖 === 短路语义）
    expect(timingSafeEqualString(secret.slice(0, 8), secret)).toBe(false);
  });

  it("非 API 路径仍可走 SPA HTML", async () => {
    const app = createAppWithSpaFallback();
    const res = await app.request("/admin/login");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("spa");
  });
});
