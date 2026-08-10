/**
 * DB client 进程级缓存单元测试（docs/191 §5.1 修复）
 *
 * 覆盖：
 * 1. getCachedDbClient 缓存语义（同 key 同实例 / 不同 key 不同实例 / 并发防抖 / token 隔离）
 * 2. DB 中间件回归保护（配置 TURSO_URL 时 db:true；未配置时 db:false 保持原语义）
 *
 * 背景：本地 SQLite 生产形态下每请求 createClient 是最大开销（35.6× 于连接复用），
 * 修复后 client 按 (url, token) 键进程级复用；本测试防止缓存语义被后续改动破坏。
 */
import { afterAll, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { getCachedDbClient, app } from "./index";
import type { Bindings } from "./bindings";

/** 记录本测试创建的临时库文件（afterAll 统一清理，含 WAL 旁路文件） */
const createdFiles = new Set<string>();
function tempDbUrl(prefix: string): string {
  const path = join(tmpdir(), `${prefix}-${randomUUID()}.db`);
  createdFiles.add(path);
  return `file:${path}`;
}

afterAll(() => {
  for (const path of createdFiles) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${path}${suffix}`;
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          /* 忽略清理失败（文件可能仍被连接占用） */
        }
      }
    }
  }
});

/** health 测试所需的最小 Bindings（ASSETS 为类型必填，health 路径不触发） */
function healthEnv(url: string): Bindings {
  return {
    TURSO_URL: url,
    TURSO_TOKEN: "",
    ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  };
}

describe("getCachedDbClient（docs/191 §5.1 client 缓存）", () => {
  it("相同 (url, token) 返回同一实例（缓存命中）", async () => {
    const url = tempDbUrl("cache-same");
    const a = await getCachedDbClient(url);
    const b = await getCachedDbClient(url);
    expect(a).toBe(b);
  });

  it("不同 url 返回不同实例（互不污染）", async () => {
    const a = await getCachedDbClient(tempDbUrl("cache-a"));
    const b = await getCachedDbClient(tempDbUrl("cache-b"));
    expect(a).not.toBe(b);
  });

  it("并发首请求只创建一次连接（pending 防抖）", async () => {
    const url = tempDbUrl("cache-conc");
    const [a, b, c] = await Promise.all([
      getCachedDbClient(url),
      getCachedDbClient(url),
      getCachedDbClient(url),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("token 不同视为不同连接（多凭据隔离）", async () => {
    const url = "libsql://example.invalid/db"; // 懒连接，不会真正发起网络请求
    const a = await getCachedDbClient(url, "token-a");
    const b = await getCachedDbClient(url, "token-b");
    expect(a).not.toBe(b);
  });
});

describe("DB 中间件回归保护", () => {
  it("配置 TURSO_URL 时 health 返回 db:true（连接可复用）", async () => {
    const url = tempDbUrl("cache-health");
    const res = await app.request("/api/health", {}, healthEnv(url));
    const body = await res.json<{ ok: boolean; db: boolean; dbError: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.db).toBe(true);
    expect(body.dbError).toBe(false);
  });

  it("未配置 TURSO_URL 时 health 返回 db:false（保持原语义）", async () => {
    const res = await app.request("/api/health", {}, healthEnv(""));
    const body = await res.json<{ ok: boolean; db: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.db).toBe(false);
  });

  it("重复请求复用同一 client 后功能正常（连续两次 health）", async () => {
    const url = tempDbUrl("cache-twice");
    const env = healthEnv(url);
    const r1 = await app.request("/api/health", {}, env);
    const r2 = await app.request("/api/health", {}, env);
    expect((await r1.json<{ db: boolean }>()).db).toBe(true);
    expect((await r2.json<{ db: boolean }>()).db).toBe(true);
  });
});
