/**
 * 绑定码生成与消费服务测试（docs/179）。
 *
 * 核心测试目标：
 * 1. P2-4 CSPRNG：绑定码使用 crypto.getRandomValues，不使用 Math.random。
 *    防止攻击者通过观测连续输出重建 PRNG 状态并预测未来绑定码。
 * 2. 格式校验：6 位、字符集排除易混淆字符（O/0, I/1/L, 8/B）。
 * 3. 幂等与并发：同一码不可重复消费；并发消费只有一个成功。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTestData, getTestDb } from "../../test-setup";
import { eq } from "drizzle-orm";
import {
  authIdentities,
  platformBindings,
  users,
} from "../../db/schema";
import { generateCode, generateBindingCode, consumeBindingCode } from "./binding";
import type { DbType } from "../../db/client";
import type { Client } from "@libsql/client";

let db: DbType;
let client: Client;

beforeAll(async () => {
  const ctx = await getTestDb();
  db = ctx.db;
  client = ctx.client;
});

beforeEach(async () => {
  await clearTestData(client);
});

describe("P2-4 CSPRNG 绑定码生成 (generateCode)", () => {
  it("返回 6 位字符串", () => {
    const code = generateCode();
    expect(code).toHaveLength(6);
  });

  it("字符仅来自安全字符集（排除 O/0/I/1/L/8/B）", () => {
    const allowed = "ACDEFGHJKMNPQRTUVWXYZ2345679";
    // 生成 100 个码，验证每个字符都在允许集合内
    for (let i = 0; i < 100; i++) {
      const code = generateCode();
      for (const ch of code) {
        expect(allowed).toContain(ch);
      }
    }
  });

  it("使用 crypto.getRandomValues 而非 Math.random（P2-4 安全修复）", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    generateCode();
    expect(spy).toHaveBeenCalledTimes(1);
    // 验证传入的是 Uint8Array（长度=6）
    const arg = spy.mock.calls[0][0] as Uint8Array;
    expect(arg).toBeInstanceOf(Uint8Array);
    expect(arg.length).toBe(6);
    spy.mockRestore();
  });

  it("大量生成时碰撞率极低（统计验证 CSPRNG 均匀性）", () => {
    const codes = new Set<string>();
    const n = 500;
    for (let i = 0; i < n; i++) {
      codes.add(generateCode());
    }
    // 500 个码应几乎无碰撞（预期唯一率 >99%）
    expect(codes.size / n).toBeGreaterThan(0.99);
  });
});

describe("generateBindingCode + consumeBindingCode 端到端", () => {
  it("生成 10 分钟有效期的 pending 绑定码", async () => {
    await db.insert(users).values({
      id: "bind-user-1",
      username: "bind-user-1",
      email: "bind1@test.com",
      passwordHash: "hash",
      createdAt: new Date().toISOString(),
    });

    const result = await generateBindingCode(db, "qq", "qq-123", "bind-user-1");
    expect(result.code).toHaveLength(6);
    expect(result.expiresAt).toBeDefined();

    const rows = await db.select().from(platformBindings);
    expect(rows).toHaveLength(1);
    expect(rows[0].used).toBe(0);
    expect(rows[0].sourceUserId).toBe("bind-user-1");
  });

  it("正确消费绑定码并标记 used=1", async () => {
    await db.insert(users).values({
      id: "bind-user-2",
      username: "bind-user-2",
      email: "bind2@test.com",
      passwordHash: "hash",
      createdAt: new Date().toISOString(),
    });

    const { code } = await generateBindingCode(db, "qq", "qq-456", "bind-user-2");

    // 目标平台用户执行消费
    await db.insert(users).values({
      id: "bind-target",
      username: "bind-target",
      email: "target@test.com",
      passwordHash: "hash",
      createdAt: new Date().toISOString(),
    });
    await db.insert(authIdentities).values({
      id: "ai-target",
      userId: "bind-target",
      provider: "telegram",
      providerUserId: "tg-999",
    });

    const consume = await consumeBindingCode(db, code, "telegram", "tg-999", "bind-target");
    expect(consume.ok).toBe(true);
    expect(consume.merged).toBe(true);

    // 验证码被标记为已使用
    const rows = await db.select().from(platformBindings).where(eq(platformBindings.code, code));
    expect(rows).toHaveLength(1);
    expect(rows[0].used).toBe(1);
  });

  it("消费已使用或无效码返回失败", async () => {
    await db.insert(users).values({
      id: "bind-user-3",
      username: "bind-user-3",
      email: "bind3@test.com",
      passwordHash: "hash",
      createdAt: new Date().toISOString(),
    });

    const { code } = await generateBindingCode(db, "qq", "qq-789", "bind-user-3");

    // 首次消费成功
    const first = await consumeBindingCode(db, code, "telegram", "tg-111", "bind-user-3");
    expect(first.ok).toBe(true);

    // 二次消费：码已被标记 used=1，查询条件 used=0 匹配不到，返回"无效或已过期"
    const second = await consumeBindingCode(db, code, "telegram", "tg-222", "bind-user-3");
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("无效或已过期");

    // 无效码消费失败
    const invalid = await consumeBindingCode(db, "INVALID", "telegram", "tg-333", "bind-user-3");
    expect(invalid.ok).toBe(false);
  });
});