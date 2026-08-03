/**
 * cf-auth exchange HTTP 接入测试（docs/062 / 063）。
 *
 * 驱动真实 authRoute + 测试库 + mock IdP fetch：
 * meta → exchange(provision) → JWT.sub=本地 users.id → create-tenant membership。
 * 禁止硬编码「假成功」；失败必须红。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authRoute } from "./auth";
import { clearTestData, getTestDb } from "../test-setup";
import { authIdentities, tenantMembers, users } from "../db/schema";
import { IDP_PROVIDER_CF_AUTH, OAUTH_PASSWORD_PLACEHOLDER } from "../services/idp-user-provision";
import { verifyJwt } from "../middleware/auth";

let db: Awaited<ReturnType<typeof getTestDb>>["db"];
let client: Awaited<ReturnType<typeof getTestDb>>["client"];

const JWT_SECRET = "test-jwt-secret-cf-auth-http-0123456789";
const IDP_ISSUER = "http://idp.mock.cf-auth";
const CLIENT_ID = "lottery-rp-test";
const CLIENT_SECRET = "lottery-rp-secret";
const REDIRECT_URI = "http://localhost:8787/auth/callback";

const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET,
  CF_AUTH_ENABLED: "true",
  CF_AUTH_ISSUER: IDP_ISSUER,
  CF_AUTH_CLIENT_ID: CLIENT_ID,
  CF_AUTH_CLIENT_SECRET: CLIENT_SECRET,
  CF_AUTH_REDIRECT_URI: REDIRECT_URI,
  CF_AUTH_SCOPES: "openid profile email",
};

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await clearTestData(client);
});

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/auth", authRoute);
  return app;
}

/** mock IdP：token + userinfo；其它 URL 404 */
function stubIdpFetch(profile: { sub: string; email: string; email_verified?: boolean }) {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes("/oauth2/token")) {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            access_token: "at-integration",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/oauth2/userinfo")) {
        return new Response(JSON.stringify(profile), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  );
}

describe("GET /auth/cf-auth/meta", () => {
  it("配置完整时 enabled=true 且无 secret", async () => {
    const app = createApp();
    const res = await app.request("/auth/cf-auth/meta", { method: "GET" }, TEST_ENV);
    const data = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.enabled).toBe(true);
    expect(data.issuer).toBe(IDP_ISSUER);
    expect(data.clientId).toBe(CLIENT_ID);
    expect(data.redirectUri).toBe(REDIRECT_URI);
    expect(String(data.authorizeUrl)).toContain("/api/auth/oauth2/authorize");
    expect(JSON.stringify(data)).not.toContain(CLIENT_SECRET);
  });

  it("未启用时 enabled=false", async () => {
    const app = createApp();
    const res = await app.request(
      "/auth/cf-auth/meta",
      { method: "GET" },
      { ...TEST_ENV, CF_AUTH_ENABLED: "false" },
    );
    const data = (await res.json()) as { enabled?: boolean };
    expect(data.enabled).toBe(false);
  });
});

describe("POST /auth/cf-auth/exchange → create-tenant 接入", () => {
  it("缺 code 返回 400", async () => {
    const app = createApp();
    const res = await app.request(
      "/auth/cf-auth/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeVerifier: "v" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { ok?: boolean };
    expect(data.ok).toBe(false);
  });

  it("cf-auth 关闭时 503", async () => {
    const app = createApp();
    const res = await app.request(
      "/auth/cf-auth/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "c", codeVerifier: "v" }),
      },
      { ...TEST_ENV, CF_AUTH_ENABLED: "false" },
    );
    expect(res.status).toBe(503);
  });

  it("首次 exchange：建档 + needsTenant + JWT.sub 本地 id + create-tenant", async () => {
    const idpSub = `idp-sub-${crypto.randomUUID()}`;
    const email = `oauth-${crypto.randomUUID().slice(0, 8)}@example.com`;
    stubIdpFetch({ sub: idpSub, email, email_verified: true });

    const app = createApp();
    const ex = await app.request(
      "/auth/cf-auth/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "auth-code-1", codeVerifier: "verifier-1" }),
      },
      TEST_ENV,
    );
    const body = (await ex.json()) as {
      ok?: boolean;
      token?: string;
      sub?: string;
      idpSub?: string;
      email?: string;
      tenantId?: string;
      needsTenant?: boolean;
      message?: string;
    };
    expect(ex.status, body.message).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.email).toBe(email);
    expect(body.idpSub).toBe(idpSub);
    expect(body.needsTenant).toBe(true);
    expect(body.tenantId).toBe("");
    expect(body.sub).toBeTruthy();
    expect(body.sub).not.toBe(idpSub);

    const payload = await verifyJwt(body.token!, JWT_SECRET);
    expect(payload?.sub).toBe(body.sub);
    expect(payload?.idpSub).toBe(idpSub);
    expect(payload?.identityProvider).toBe("cf-auth");
    expect(payload?.tenantId || "").toBe("");

    const [user] = await db.select().from(users).where(eq(users.id, body.sub!)).limit(1);
    expect(user).toBeTruthy();
    expect(user!.email).toBe(email);
    expect(user!.emailVerified).toBe(1);
    expect(user!.passwordHash).toBe(OAUTH_PASSWORD_PLACEHOLDER);

    const [idRow] = await db
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.provider, IDP_PROVIDER_CF_AUTH),
          eq(authIdentities.providerUserId, idpSub),
        ),
      )
      .limit(1);
    expect(idRow?.userId).toBe(body.sub);

    // create-tenant 必须吃本地 sub
    const ct = await app.request(
      "/auth/create-tenant",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${body.token}`,
        },
        body: JSON.stringify({ name: "接入测试工作区" }),
      },
      TEST_ENV,
    );
    const ctBody = (await ct.json()) as {
      ok?: boolean;
      tenantId?: string;
      token?: string;
      message?: string;
    };
    expect(ct.status, ctBody.message).toBe(200);
    expect(ctBody.ok).toBe(true);
    expect(ctBody.tenantId).toBeTruthy();
    expect(ctBody.token).toBeTruthy();

    const members = await db
      .select()
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, body.sub!));
    expect(members.some((m) => m.tenantId === ctBody.tenantId)).toBe(true);

    const newPayload = await verifyJwt(ctBody.token!, JWT_SECRET);
    expect(newPayload?.sub).toBe(body.sub);
    expect(newPayload?.tenantId).toBe(ctBody.tenantId);

    // 再次 exchange：幂等，needsTenant=false
    stubIdpFetch({ sub: idpSub, email, email_verified: true });
    const ex2 = await app.request(
      "/auth/cf-auth/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "auth-code-2", codeVerifier: "verifier-2" }),
      },
      TEST_ENV,
    );
    const body2 = (await ex2.json()) as {
      ok?: boolean;
      sub?: string;
      needsTenant?: boolean;
      tenantId?: string;
    };
    expect(ex2.status).toBe(200);
    expect(body2.sub).toBe(body.sub);
    expect(body2.needsTenant).toBe(false);
    expect(body2.tenantId).toBe(ctBody.tenantId);
  });
});
