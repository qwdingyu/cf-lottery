/**
 * cf-auth OAuth RP 测试：驱动仓库内真实函数（非硬编码假成功）。
 *
 * 覆盖：
 * 1. resolve / meta / PKCE / authorize URL
 * 2. 缺配置与错误 token 响应
 * 3. map + issueBusinessToken → verifyJwt
 * 4. 对同源 cf-auth createTestApp 的 code→token→userinfo→**provision**→业务 JWT 闭环
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { verifyJwt } from "../middleware/auth";
import { clearTestData, getTestDb } from "../test-setup";
import { authIdentities, users } from "../db/schema";
import {
  IDP_PROVIDER_CF_AUTH,
  provisionIdpUser,
} from "../services/idp-user-provision";
import {
  buildAuthorizeUrl,
  completeCfAuthCodeExchange,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  fetchCfAuthUserInfo,
  issueBusinessTokenFromCfAuth,
  mapCfAuthUserToJwtClaims,
  publicCfAuthMeta,
  resolveCfAuthConfig,
  type CfAuthClientConfig,
} from "./cf-auth-oauth";

const JWT_SECRET = "test-jwt-secret-cf-auth-oauth-0123456789";
const HERE = dirname(fileURLToPath(import.meta.url));
const CF_AUTH_HELPERS = join(HERE, "../../../cf-auth/src/test-helpers.ts");

const JWT_SECRET_ENV = JWT_SECRET;

describe("cf-auth OAuth RP（纯逻辑）", () => {
  it("未开开关或缺字段时 enabled=false", () => {
    expect(resolveCfAuthConfig({}).enabled).toBe(false);
    expect(
      resolveCfAuthConfig({
        CF_AUTH_ENABLED: "true",
        CF_AUTH_ISSUER: "http://localhost:8788",
        CF_AUTH_CLIENT_ID: "cid",
        // 缺 secret / redirect
      }).enabled,
    ).toBe(false);
    const full = resolveCfAuthConfig({
      CF_AUTH_ENABLED: "true",
      CF_AUTH_ISSUER: "http://localhost:8788/",
      CF_AUTH_CLIENT_ID: "cid",
      CF_AUTH_CLIENT_SECRET: "sec",
      CF_AUTH_REDIRECT_URI: "http://localhost:8787/auth/callback",
    });
    expect(full.enabled).toBe(true);
    expect(full.issuer).toBe("http://localhost:8788");
  });

  it("publicCfAuthMeta 不下发 secret", () => {
    const meta = publicCfAuthMeta({
      enabled: true,
      issuer: "http://localhost:8788",
      clientId: "cid",
      clientSecret: "MUST_NOT_LEAK",
      redirectUri: "http://localhost:8787/auth/callback",
      scopes: "openid email",
    });
    expect(meta.enabled).toBe(true);
    expect(meta.authorizeUrl).toContain("/api/auth/oauth2/authorize");
    expect(JSON.stringify(meta)).not.toContain("MUST_NOT_LEAK");
    expect((meta as { clientSecret?: string }).clientSecret).toBeUndefined();
  });

  it("createPkcePair 生成 S256 challenge", async () => {
    const pair = await createPkcePair();
    expect(pair.verifier.length).toBeGreaterThan(20);
    expect(pair.challenge.length).toBeGreaterThan(20);
    // 独立用 node crypto 复算，证明 challenge = BASE64URL(SHA256(verifier))
    const expected = createHash("sha256").update(pair.verifier).digest("base64url");
    expect(pair.challenge).toBe(expected);
    expect(createOAuthState().length).toBeGreaterThan(10);
  });

  it("buildAuthorizeUrl 含 code_challenge 与 client_id", () => {
    const url = buildAuthorizeUrl(
      {
        issuer: "http://localhost:8788",
        clientId: "lottery-client",
        redirectUri: "http://localhost:8787/auth/callback",
        scopes: "openid profile email",
      },
      { state: "st-1", codeChallenge: "chal-abc" },
    );
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("http://localhost:8788/api/auth/oauth2/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("lottery-client");
    expect(u.searchParams.get("code_challenge")).toBe("chal-abc");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:8787/auth/callback");
  });

  it("exchangeAuthorizationCode 缺 code 返回 400", async () => {
    const config: CfAuthClientConfig = {
      enabled: true,
      issuer: "http://localhost:8788",
      clientId: "c",
      clientSecret: "s",
      redirectUri: "http://localhost:8787/auth/callback",
      scopes: "openid",
    };
    const r = await exchangeAuthorizationCode(config, { code: "", codeVerifier: "v" }, async () => {
      throw new Error("should not fetch");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("exchangeAuthorizationCode 对 IdP 错误状态透传", async () => {
    const config: CfAuthClientConfig = {
      enabled: true,
      issuer: "http://idp.test",
      clientId: "c",
      clientSecret: "s",
      redirectUri: "http://localhost:8787/auth/callback",
      scopes: "openid",
    };
    const r = await exchangeAuthorizationCode(
      config,
      { code: "bad-code", codeVerifier: "verifier-xxx" },
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.message).toContain("token");
    }
  });

  it("map + issueBusinessToken 可被 verifyJwt 验证（本地 userId 为 JWT.sub）", async () => {
    const claims = mapCfAuthUserToJwtClaims(
      { sub: "idp-sub-1", email: "rp@example.com" },
      { userId: "local-uuid-1", tenantId: "", email: "rp@example.com" },
    );
    expect(claims.identityProvider).toBe("cf-auth");
    expect(claims.sub).toBe("local-uuid-1");
    expect(claims.idpSub).toBe("idp-sub-1");
    const token = await issueBusinessTokenFromCfAuth(
      { sub: "idp-sub-1", email: "rp@example.com" },
      JWT_SECRET_ENV,
      3600,
      { userId: "local-uuid-1", email: "rp@example.com" },
    );
    const payload = await verifyJwt(token, JWT_SECRET_ENV);
    expect(payload).toBeTruthy();
    expect(payload!.sub).toBe("local-uuid-1");
    expect(payload!.email).toBe("rp@example.com");
    expect(payload!.identityProvider).toBe("cf-auth");
    expect(payload!.idpSub).toBe("idp-sub-1");
  });

  it("completeCfAuthCodeExchange 在 mock IdP 上跑完整 code 路径", async () => {
    const config: CfAuthClientConfig = {
      enabled: true,
      issuer: "http://idp.test",
      clientId: "c",
      clientSecret: "s",
      redirectUri: "http://localhost:8787/auth/callback",
      scopes: "openid email",
    };
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token") && init?.method === "POST") {
        const body = String(init.body || "");
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("code=the-code");
        expect(body).toContain("code_verifier=");
        return new Response(
          JSON.stringify({
            access_token: "at-test",
            id_token: "idt-test",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/oauth2/userinfo")) {
        const auth = (init?.headers as Record<string, string>)?.Authorization
          || (init?.headers as Headers)?.get?.("Authorization");
        expect(String(auth)).toContain("Bearer at-test");
        return new Response(JSON.stringify({ sub: "sub-from-idp", email: "from-idp@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await completeCfAuthCodeExchange(
      config,
      { code: "the-code", codeVerifier: "verifier-abc" },
      JWT_SECRET_ENV,
      fetcher,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 未注入 provision 时：降级 JWT.sub = 上游 sub（仅测 code 路径）
    expect(result.sub).toBe("sub-from-idp");
    expect(result.idpSub).toBe("sub-from-idp");
    expect(result.email).toBe("from-idp@example.com");
    expect(result.accessToken).toBe("at-test");
    const payload = await verifyJwt(result.token, JWT_SECRET_ENV);
    expect(payload!.sub).toBe("sub-from-idp");
  });

  it("completeCfAuthCodeExchange 注入 provision 后 JWT.sub 为本地 userId", async () => {
    const config: CfAuthClientConfig = {
      enabled: true,
      issuer: "http://idp.test",
      clientId: "c",
      clientSecret: "s",
      redirectUri: "http://localhost:8787/auth/callback",
      scopes: "openid email",
    };
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "at2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/oauth2/userinfo")) {
        return new Response(
          JSON.stringify({ sub: "upstream-99", email: "p@example.com" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("nf", { status: 404 });
    };
    const result = await completeCfAuthCodeExchange(
      config,
      { code: "c", codeVerifier: "v" },
      JWT_SECRET_ENV,
      fetcher,
      async () => ({
        userId: "local-from-provision",
        email: "p@example.com",
        tenantId: "",
        tenantRole: "",
        needsTenant: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sub).toBe("local-from-provision");
    expect(result.idpSub).toBe("upstream-99");
    expect(result.needsTenant).toBe(true);
    const payload = await verifyJwt(result.token, JWT_SECRET_ENV);
    expect(payload!.sub).toBe("local-from-provision");
    expect(payload!.idpSub).toBe("upstream-99");
  });
});

describe("cf-auth OAuth RP × 真实 cf-auth createTestApp 闭环", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let lotteryDb: Awaited<ReturnType<typeof getTestDb>>["db"];
  let lotteryClient: Awaited<ReturnType<typeof getTestDb>>["client"];

  beforeAll(async () => {
    ({ db: lotteryDb, client: lotteryClient } = await getTestDb());
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
    await clearTestData(lotteryClient);
  });

  it("authorize→code→provision→业务 JWT（sub=本地 users.id）", async () => {
    // 动态加载兄弟仓库 cf-auth 测试工厂（同机 monorepo 模板布局）
    // 动态加载兄弟仓库；类型用 any，避免 lottery tsconfig 解析 cf-auth 源码路径
    let helpers: {
      cleanupTestDbs: () => Promise<void>;
      createTestApp: (opts?: { enableOAuthProvider?: boolean }) => Promise<{
        app: { request: typeof fetch };
        auth: {
          api: {
            createOAuthClient: (args: unknown) => Promise<unknown>;
            adminUpdateOAuthClient: (args: unknown) => Promise<unknown>;
          };
        };
        baseURL: string;
      }>;
      jsonPost: (body: Record<string, unknown>) => RequestInit;
      cookieHeaderFrom: (v: string | null) => string;
      mergeCookies: (...parts: string[]) => string;
    };
    try {
      helpers = (await import(pathToFileURL(CF_AUTH_HELPERS).href)) as typeof helpers;
    } catch (err) {
      throw new Error(
        `无法加载 cf-auth test-helpers（${CF_AUTH_HELPERS}）: ${err instanceof Error ? err.message : err}`,
      );
    }

    cleanup = async () => {
      await helpers.cleanupTestDbs();
    };

    const { app, auth, baseURL } = await helpers.createTestApp({ enableOAuthProvider: true });
    const email = `lottery-rp-${randomBytes(4).toString("hex")}@example.com`;
    const password = "strong-password-123";

    const signUp = await app.request(
      "/api/auth/sign-up/email",
      helpers.jsonPost({ name: "Lottery RP", email, password }),
    );
    // 失败时打印响应体便于定位（better-auth 422 会返回错误码）
    if (signUp.status !== 200) {
      console.log("[cf-auth-oauth] sign-up 失败", signUp.status, await signUp.text());
    }
    expect(signUp.status).toBe(200);
    let cookie = helpers.cookieHeaderFrom(signUp.headers.get("set-cookie"));
    const login = await app.request(
      "/api/auth/sign-in/email",
      helpers.jsonPost({ email, password }),
    );
    expect(login.status).toBe(200);
    cookie = helpers.mergeCookies(cookie, helpers.cookieHeaderFrom(login.headers.get("set-cookie")));

    const redirectUri = "http://localhost:8787/auth/callback";
    const created = (await auth.api.createOAuthClient({
      body: {
        client_name: "cf-lottery-vitest",
        redirect_uris: [redirectUri],
      },
      headers: new Headers({ cookie, origin: baseURL }),
    })) as { client_id: string; client_secret: string };

    await auth.api.adminUpdateOAuthClient({
      body: {
        client_id: created.client_id,
        update: { skip_consent: true },
      },
      headers: new Headers({ cookie, origin: baseURL }),
    });

    const pkce = await createPkcePair();
    const state = createOAuthState();
    const authorizeUrl = buildAuthorizeUrl(
      {
        issuer: baseURL,
        clientId: created.client_id,
        redirectUri,
        scopes: "openid profile email",
      },
      { state, codeChallenge: pkce.challenge },
    );

    // 相对路径给 app.request
    const path = authorizeUrl.replace(baseURL, "");
    const authz = await app.request(path, {
      method: "GET",
      redirect: "manual",
      headers: { Cookie: cookie },
    });
    expect(authz.status).toBe(302);
    const loc = authz.headers.get("location") || "";
    expect(loc).toContain(redirectUri);
    expect(loc).toContain("code=");
    const code = new URL(loc).searchParams.get("code");
    expect(code).toBeTruthy();

    const config: CfAuthClientConfig = {
      enabled: true,
      issuer: baseURL,
      clientId: created.client_id,
      clientSecret: created.client_secret,
      redirectUri,
      scopes: "openid profile email",
    };

    // 关键 fetcher：把绝对 URL 转成 cf-auth app.request（不经真实 TCP）
    const idpFetch: typeof fetch = async (input, init) => {
      const raw = String(input);
      const u = new URL(raw);
      const rel = u.pathname + u.search;
      return app.request(rel, {
        method: (init?.method as string) || "GET",
        headers: init?.headers as HeadersInit,
        body: init?.body as BodyInit,
      });
    };

    // 生产路径：必须 provision（与 authRoute exchange 一致）
    const result = await completeCfAuthCodeExchange(
      config,
      { code: code!, codeVerifier: pkce.verifier, redirectUri },
      JWT_SECRET_ENV,
      idpFetch,
      async (profile) => {
        const p = await provisionIdpUser(lotteryDb, {
          provider: IDP_PROVIDER_CF_AUTH,
          idpSub: String(profile.sub || ""),
          email: String(profile.email || ""),
          displayName: String(profile.name || profile.preferred_username || ""),
          emailVerified: profile.email_verified !== false,
        });
        return {
          userId: p.userId,
          email: p.email,
          tenantId: p.tenantId,
          tenantRole: p.tenantRole,
          needsTenant: p.needsTenant,
        };
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`${result.message} ${result.detail || ""}`);
    }
    expect(result.email).toBe(email);
    expect(result.sub).toBeTruthy();
    expect(result.token).toBeTruthy();
    expect(result.needsTenant).toBe(true);
    expect(result.idpSub).toBeTruthy();
    // 062：业务 sub 必须是本地 UUID，不能是裸 IdP sub
    expect(result.sub).not.toBe(result.idpSub);
    expect(result.sub).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const payload = await verifyJwt(result.token, JWT_SECRET_ENV);
    expect(payload).toBeTruthy();
    expect(payload!.sub).toBe(result.sub);
    expect(payload!.idpSub).toBe(result.idpSub);
    expect(payload!.email).toBe(email);
    expect(payload!.identityProvider).toBe("cf-auth");

    const [localUser] = await lotteryDb
      .select()
      .from(users)
      .where(eq(users.id, result.sub))
      .limit(1);
    expect(localUser?.email).toBe(email);

    const ids = await lotteryDb.select().from(authIdentities);
    expect(ids.some((r) => r.userId === result.sub && r.providerUserId === result.idpSub)).toBe(
      true,
    );

    // userinfo 也可单独验证
    const info = await fetchCfAuthUserInfo({ issuer: baseURL }, result.accessToken, idpFetch);
    expect(info.ok).toBe(true);
    if (info.ok) {
      expect(info.profile.email).toBe(email);
      expect(info.profile.sub).toBe(result.idpSub);
    }
  }, 30_000);
});
