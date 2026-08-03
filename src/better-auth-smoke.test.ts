/**
 * Better Auth 最小验证（根项目 POC）
 *
 * 目的：
 * - 不接入业务路由，只验证 Better Auth 在当前根项目依赖栈中能否跑通；
 * - 使用 Hono handler + libSQL SQLite + Drizzle adapter，贴近 cf-lottery 现有后端形态；
 * - 证明 Google provider 能生成授权 URL，但不伪造真实 Google OAuth 回调。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanupBetterAuthSmokeDbs, createBetterAuthSmokeApp } from "./better-auth-smoke-setup";

afterEach(async () => {
  await cleanupBetterAuthSmokeDbs();
});

function jsonPost(body: Record<string, unknown>, cookie?: string) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  };
}

function cookieHeaderFrom(setCookie: string | null): string {
  if (!setCookie) return "";
  return setCookie
    .split(/,(?=\s*better-auth\.)/)
    .map((cookie) => cookie.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
}

describe("Better Auth 最小验证", () => {
  it("Hono + Drizzle/libSQL 可以完成注册、登录和 session 查询", async () => {
    const { app, client } = await createBetterAuthSmokeApp();

    const signUp = await app.request("/api/auth/sign-up/email", jsonPost({
      name: "Smoke User",
      email: "smoke@example.com",
      password: "strong-password-123",
    }));
    expect(signUp.status).toBe(200);
    const signUpBody = await signUp.json() as { user: { id: string; email: string }; token: string };
    expect(signUpBody.user.email).toBe("smoke@example.com");
    expect(signUpBody.token).toBeTruthy();

    const login = await app.request("/api/auth/sign-in/email", jsonPost({
      email: "smoke@example.com",
      password: "strong-password-123",
    }));
    expect(login.status).toBe(200);
    const cookie = cookieHeaderFrom(login.headers.get("set-cookie"));
    expect(cookie).toContain("better-auth.session_token=");

    const sessionRes = await app.request("/api/auth/get-session", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json() as { user: { email: string }; session: { token: string } };
    expect(sessionBody.user.email).toBe("smoke@example.com");
    expect(sessionBody.session.token).toBeTruthy();

    const rows = await client.execute(`SELECT COUNT(*) AS total FROM "user"`);
    expect(Number(rows.rows[0]?.total)).toBe(1);
  });

  it("Google provider 可以生成 OAuth 授权 URL，但真实回调需要 Google Cloud 配置", async () => {
    const { app } = await createBetterAuthSmokeApp();

    const social = await app.request("/api/auth/sign-in/social", jsonPost({
      provider: "google",
      callbackURL: "http://localhost:3000/lottery/example",
      disableRedirect: true,
    }));
    expect(social.status).toBe(200);
    const body = await social.json() as { url: string; redirect: boolean };
    expect(body.redirect).toBe(false);
    expect(body.url).toContain("https://accounts.google.com/o/oauth2");
    expect(body.url).toContain("client_id=google-client-id-for-smoke-test");
    expect(body.url).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fauth%2Fcallback%2Fgoogle");
  });
});
