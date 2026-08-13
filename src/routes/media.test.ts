/**
 * 媒体路由回归测试。
 *
 * 奖品图片是低频后台运营能力，但公开读取会经过 /api/media 并计入 Worker 请求。
 * 这组测试锁住 Free 层最重要的边界：权限、R2 缺失、文件签名、路径受控和缓存头。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { auditLogs, tenantMembers, tenants, users } from "../db/schema";
import { signJwt } from "../middleware/auth";
import { adminMediaRoute, mediaRoute } from "./media";
import { clearTestData, getTestDb } from "../test-setup";

let db: ReturnType<typeof import("../db/client").createDb>;
let client: Awaited<ReturnType<typeof getTestDb>>["client"];

const JWT_SECRET = "test-media-secret-0123456789abcdef";
const TENANT_ID = "tenant-media";
const OWNER_ID = "user-media-owner";
const VIEWER_ID = "user-media-viewer";
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

  it("未绑定 R2 时上传走本地磁盘存储（data/media/）并可公开读取（VPS 模式，2026-08 上线补充）", async () => {
    await seedMembers();
    const app = createTestApp();
    // 测试隔离：媒体目录指向临时目录，避免污染工作区 data/media/
    const tmpMediaDir = `/tmp/cf-lottery-media-test-${crypto.randomUUID()}`;
    process.env.LOCAL_MEDIA_DIR = tmpMediaDir;
    try {
      const uploadRes = await app.request("/api/admin/media/images", {
        method: "POST",
        headers: await authHeader(OWNER_ID),
        body: imageForm(new File([PNG_BYTES], "prize.png", { type: "image/png" })),
      }, BASE_ENV);
      expect(uploadRes.status).toBe(200);
      const uploaded = await uploadRes.json() as { key: string; url: string };

      const readRes = await app.request(uploaded.url, {}, BASE_ENV);
      expect(readRes.status).toBe(200);
      expect(readRes.headers.get("Content-Type")).toContain("image/png");
      const body = new Uint8Array(await readRes.arrayBuffer());
      expect(body.length).toBeGreaterThanOrEqual(PNG_BYTES.length);

      // 不存在的 key → 404
      const missingRes = await app.request("/api/media/images/00000000-0000-4000-8000-000000000000.png", {}, BASE_ENV);
      expect(missingRes.status).toBe(404);
    } finally {
      delete process.env.LOCAL_MEDIA_DIR;
      const fs = await import("node:fs");
      try { fs.rmSync(tmpMediaDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
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
