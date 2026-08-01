/**
 * 媒体路由回归测试。
 *
 * 奖品图片是低频后台运营能力，但公开读取会经过 /api/media 并计入 Worker 请求。
 * 这组测试锁住 Free 层最重要的边界：权限、R2 缺失、文件签名、路径受控和缓存头。
 */
import { createClient, type Client } from "@libsql/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createDb, type DbType } from "../db/client";
import { auditLogs, tenantMembers, tenants, users } from "../db/schema";
import { signJwt } from "../middleware/auth";
import { adminMediaRoute, mediaRoute } from "./media";

let client: Client;
let db: DbType;

const JWT_SECRET = "test-media-secret-0123456789abcdef";
const TENANT_ID = "tenant-media";
const OWNER_ID = "user-media-owner";
const VIEWER_ID = "user-media-viewer";
const DB_URL = `file:test-media-${crypto.randomUUID()}.db`;

const BASE_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET,
};

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

function createMemoryR2Bucket(): R2Bucket {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string; etag: string }>();
  return {
    put: async (key: string, value: ArrayBuffer | ArrayBufferView | string | ReadableStream, options?: R2PutOptions) => {
      const bytes = value instanceof Uint8Array
        ? value
        : typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array();
      const metadata = options?.httpMetadata;
      const contentType = metadata instanceof Headers
        ? metadata.get("Content-Type") || "application/octet-stream"
        : metadata?.contentType || "application/octet-stream";
      objects.set(key, {
        bytes,
        contentType,
        etag: `"${key}"`,
      });
      return { key } as unknown as R2Object;
    },
    get: async (key: string) => {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        key,
        httpEtag: stored.etag,
        body: new Response(stored.bytes).body,
        writeHttpMetadata(headers: Headers) {
          headers.set("Content-Type", stored.contentType);
        },
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

beforeAll(async () => {
  client = createClient({ url: DB_URL });
  db = createDb(client);
  await client.execute(`CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active', brand_config TEXT NOT NULL DEFAULT '{}', extra_activity_quota INTEGER NOT NULL DEFAULT 0, extra_participant_quota INTEGER NOT NULL DEFAULT 0, extra_quota_expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await client.execute(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '', email_verified INTEGER NOT NULL DEFAULT 0, password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await client.execute(`CREATE TABLE IF NOT EXISTS tenant_members (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (tenant_id, user_id))`);
  await client.execute(`CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
});

afterAll(async () => {
  await client.close();
});

afterEach(async () => {
  for (const table of ["audit_logs", "tenant_members", "users", "tenants"]) {
    await client.execute(`DELETE FROM ${table}`);
  }
});

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api", mediaRoute);
  app.route("/api/admin/media", adminMediaRoute);
  return app;
}

async function seedMembers() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "媒体测试租户" });
  await db.insert(users).values([
    { id: OWNER_ID, username: "media-owner", email: "owner@test.com", emailVerified: 1, passwordHash: "hash" },
    { id: VIEWER_ID, username: "media-viewer", email: "viewer@test.com", emailVerified: 1, passwordHash: "hash" },
  ]);
  await db.insert(tenantMembers).values([
    { tenantId: TENANT_ID, userId: OWNER_ID, role: "owner" },
    { tenantId: TENANT_ID, userId: VIEWER_ID, role: "viewer" },
  ]);
}

async function authHeader(userId: string) {
  const token = await signJwt({ sub: userId, tenantId: TENANT_ID }, JWT_SECRET, 3600);
  return { Authorization: `Bearer ${token}` };
}

function imageForm(file: File): FormData {
  const form = new FormData();
  form.set("file", file);
  return form;
}

describe("媒体上传和公开读取", () => {
  it("owner 上传合法 PNG 后可通过公开媒体路由读取，并写入租户审计", async () => {
    await seedMembers();
    const app = createTestApp();
    const bucket = createMemoryR2Bucket();

    const uploadRes = await app.request("/api/admin/media/images", {
      method: "POST",
      headers: await authHeader(OWNER_ID),
      body: imageForm(new File([PNG_BYTES], "prize.png", { type: "image/png" })),
    }, { ...BASE_ENV, LOTTERY_MEDIA: bucket });

    expect(uploadRes.status).toBe(200);
    const uploaded = await uploadRes.json() as { ok: boolean; url: string; contentType: string };
    expect(uploaded.ok).toBe(true);
    expect(uploaded.contentType).toBe("image/png");
    expect(uploaded.url).toMatch(/^\/api\/media\/images\/[0-9a-f-]+\.png$/);

    const readRes = await app.request(uploaded.url, {}, { ...BASE_ENV, LOTTERY_MEDIA: bucket });
    expect(readRes.status).toBe(200);
    expect(readRes.headers.get("Content-Type")).toBe("image/png");
    expect(readRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(readRes.headers.get("Cache-Control")).toContain("immutable");

    const logs = await db.select().from(auditLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.action).toBe("upload_media_image");
  });

  it("viewer 不能上传媒体图片", async () => {
    await seedMembers();
    const app = createTestApp();

    const res = await app.request("/api/admin/media/images", {
      method: "POST",
      headers: await authHeader(VIEWER_ID),
      body: imageForm(new File([PNG_BYTES], "prize.png", { type: "image/png" })),
    }, { ...BASE_ENV, LOTTERY_MEDIA: createMemoryR2Bucket() });

    expect(res.status).toBe(403);
  });

  it("未绑定 R2 时上传和公开读取都返回明确 503", async () => {
    await seedMembers();
    const app = createTestApp();

    const uploadRes = await app.request("/api/admin/media/images", {
      method: "POST",
      headers: await authHeader(OWNER_ID),
      body: imageForm(new File([PNG_BYTES], "prize.png", { type: "image/png" })),
    }, BASE_ENV);
    expect(uploadRes.status).toBe(503);

    const readRes = await app.request("/api/media/images/00000000-0000-4000-8000-000000000000.png", {}, BASE_ENV);
    expect(readRes.status).toBe(503);
  });

  it("MIME 声明和文件签名不一致时拒绝上传且不写审计", async () => {
    await seedMembers();
    const app = createTestApp();

    const res = await app.request("/api/admin/media/images", {
      method: "POST",
      headers: await authHeader(OWNER_ID),
      body: imageForm(new File([PNG_BYTES], "fake.jpg", { type: "image/jpeg" })),
    }, { ...BASE_ENV, LOTTERY_MEDIA: createMemoryR2Bucket() });

    expect(res.status).toBe(400);
    const logs = await db.select().from(auditLogs);
    expect(logs).toHaveLength(0);
  });

  it("公开读取只允许受控 images key，路径穿越和伪文件名不会访问 R2", async () => {
    const app = createTestApp();
    const bucket = createMemoryR2Bucket();

    const res = await app.request("/api/media/images/%2e%2e%2fsecret.png", {}, { ...BASE_ENV, LOTTERY_MEDIA: bucket });

    expect(res.status).toBe(404);
  });
});
