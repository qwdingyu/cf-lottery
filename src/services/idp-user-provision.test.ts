/**
 * IdP 用户建档：驱动真实 provisionIdpUser + 测试库，禁止假成功。
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { clearTestData, getTestDb } from "../test-setup";
import { authIdentities, tenantMembers, tenants, users } from "../db/schema";
import {
  buildOauthUsernameCandidate,
  IDP_PROVIDER_CF_AUTH,
  OAUTH_PASSWORD_PLACEHOLDER,
  provisionIdpUser,
} from "./idp-user-provision";

let db: Awaited<ReturnType<typeof getTestDb>>["db"];
let client: Awaited<ReturnType<typeof getTestDb>>["client"];

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

describe("buildOauthUsernameCandidate", () => {
  it("从 email 本地部分生成合法用户名", () => {
    const u = buildOauthUsernameCandidate({
      email: "Alice.Bob+tag@Example.COM",
      idpSub: "sub-abc",
    });
    expect(u).toMatch(/^[a-zA-Z0-9_]{2,40}$/);
    expect(u.startsWith("alice")).toBe(true);
  });

  it("同一 idpSub 不同 attempt 结果不同", () => {
    const a = buildOauthUsernameCandidate({ email: "a@b.c", idpSub: "x" }, 0);
    const b = buildOauthUsernameCandidate({ email: "a@b.c", idpSub: "x" }, 1);
    expect(a).not.toBe(b);
  });
});

describe("provisionIdpUser", () => {
  it("首次 OAuth：新建 users + identity，needsTenant=true，JWT 用本地 id", async () => {
    const r = await provisionIdpUser(db, {
      provider: IDP_PROVIDER_CF_AUTH,
      idpSub: "cf-auth-sub-001",
      email: "first@example.com",
      displayName: "First User",
    });
    expect(r.createdUser).toBe(true);
    expect(r.linkedIdentity).toBe(true);
    expect(r.needsTenant).toBe(true);
    expect(r.tenantId).toBe("");
    expect(r.userId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(r.userId).not.toBe("cf-auth-sub-001");

    const [user] = await db.select().from(users).where(eq(users.id, r.userId)).limit(1);
    expect(user?.email).toBe("first@example.com");
    expect(user?.emailVerified).toBe(1);
    expect(user?.passwordHash).toBe(OAUTH_PASSWORD_PLACEHOLDER);

    const [idRow] = await db
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.provider, IDP_PROVIDER_CF_AUTH),
          eq(authIdentities.providerUserId, "cf-auth-sub-001"),
        ),
      )
      .limit(1);
    expect(idRow?.userId).toBe(r.userId);
  });

  it("同一 idp sub 再次 provision 幂等，不重复建用户", async () => {
    const a = await provisionIdpUser(db, {
      provider: IDP_PROVIDER_CF_AUTH,
      idpSub: "same-sub",
      email: "same@example.com",
    });
    const b = await provisionIdpUser(db, {
      provider: IDP_PROVIDER_CF_AUTH,
      idpSub: "same-sub",
      email: "same@example.com",
    });
    expect(b.userId).toBe(a.userId);
    expect(b.createdUser).toBe(false);
    expect(b.linkedIdentity).toBe(false);

    const all = await db.select().from(users);
    expect(all.filter((u) => u.email === "same@example.com")).toHaveLength(1);
  });

  it("已验证邮箱的存量用户：按 email 链接，不新建 users", async () => {
    const existingId = crypto.randomUUID();
    await db.insert(users).values({
      id: existingId,
      username: "legacy_owner",
      email: "linkme@example.com",
      emailVerified: 1,
      passwordHash: "hmac_sha256_v1:aa:bb",
      status: "active",
    });
    const tid = crypto.randomUUID();
    await db.insert(tenants).values({ id: tid, name: "已有租户" });
    await db.insert(tenantMembers).values({ tenantId: tid, userId: existingId, role: "owner" });

    const r = await provisionIdpUser(db, {
      provider: IDP_PROVIDER_CF_AUTH,
      idpSub: "link-sub",
      email: "linkme@example.com",
    });
    expect(r.userId).toBe(existingId);
    expect(r.createdUser).toBe(false);
    expect(r.linkedIdentity).toBe(true);
    expect(r.needsTenant).toBe(false);
    expect(r.tenantId).toBe(tid);
  });

  it("未验证邮箱的注册草稿不可被 OAuth 按 email 绑定（防接管）", async () => {
    const draftId = crypto.randomUUID();
    await db.insert(users).values({
      id: draftId,
      username: "draft_user",
      email: "unverified@example.com",
      emailVerified: 0,
      passwordHash: "hmac_sha256_v1:aa:bb",
      status: "active",
    });

    const r = await provisionIdpUser(db, {
      provider: IDP_PROVIDER_CF_AUTH,
      idpSub: "attacker-or-same-person",
      email: "unverified@example.com",
    });
    // 应新建独立用户，而不是绑到 draft
    expect(r.userId).not.toBe(draftId);
    expect(r.createdUser).toBe(true);

    const drafts = await db.select().from(users).where(eq(users.id, draftId));
    expect(drafts[0]?.emailVerified).toBe(0);
  });

  it("禁用账号拒绝 provision", async () => {
    const banId = crypto.randomUUID();
    await db.insert(users).values({
      id: banId,
      username: "banned_u",
      email: "banned@example.com",
      emailVerified: 1,
      passwordHash: "h",
      status: "disabled",
    });
    await expect(
      provisionIdpUser(db, {
        provider: IDP_PROVIDER_CF_AUTH,
        idpSub: "ban-sub",
        email: "banned@example.com",
      }),
    ).rejects.toThrow(/禁用/);
  });
});

describe("provision → create-tenant 闭环（防 JWT.sub 非本地用户）", () => {
  it("本地 userId 的 JWT 可创建租户", async () => {
    const { signJwt } = await import("../middleware/auth");
    const { authRoute } = await import("../routes/auth");
    const { Hono } = await import("hono");
    type AppEnv = import("../bindings").AppEnv;

    const p = await provisionIdpUser(db, {
      provider: IDP_PROVIDER_CF_AUTH,
      idpSub: "onboard-sub",
      email: "onboard@example.com",
    });
    expect(p.needsTenant).toBe(true);

    const secret = "test-jwt-secret-0123456789abcdef";
    const token = await signJwt(
      { sub: p.userId, tenantId: "", email: p.email, identityProvider: "cf-auth" },
      secret,
      3600,
    );

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/auth", authRoute);

    const res = await app.request(
      "/auth/create-tenant",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "OAuth工作空间" }),
      },
      {
        TURSO_URL: "",
        ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
        JWT_SECRET: secret,
      },
    );
    const data = (await res.json()) as {
      ok?: boolean;
      tenantId?: string;
      token?: string;
      message?: string;
    };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.tenantId).toBeTruthy();
    expect(data.token).toBeTruthy();

    const members = await db
      .select()
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, p.userId));
    expect(members.some((m) => m.tenantId === data.tenantId)).toBe(true);
  });
});
