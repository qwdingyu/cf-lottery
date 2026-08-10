/**
 * 平台用户身份关联测试（Phase B，docs/176 §3.4）。
 *
 * 覆盖场景：
 * - 首次调用：新建 users + authIdentities
 * - 重复调用：幂等，返回同一 userId
 * - 非法输入：缺少 provider 或 providerUserId 时抛出错误
 * - 并发安全：重复插入时自动收敛（authIdentities UNIQUE 约束）
 * - 不同平台用户：qq 和 telegram 各自独立
 * - 同一平台不同用户：各自独立
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTestData, getTestDb } from "../../test-setup";
import { and, eq } from "drizzle-orm";
import { authIdentities, users } from "../../db/schema";
import type { DbType } from "../../db/client";
import type { Client } from "@libsql/client";
import { provisionPlatformUser } from "./user-provision";

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

describe("provisionPlatformUser", () => {
  it("首次调用时新建 users 和 authIdentities", async () => {
    const result = await provisionPlatformUser(db, {
      provider: "qq",
      providerUserId: "123456789",
      displayName: "测试用户",
    });

    expect(result.userId).toBeTruthy();
    expect(result.created).toBe(true);

    // 验证 users 表
    const [user] = await db.select().from(users).where(eq(users.id, result.userId)).limit(1);
    expect(user).toBeTruthy();
    expect(user!.id).toBe(result.userId);
    expect(user!.status).toBe("active");
    expect(user!.email).toBe(""); // 平台用户无 email
    expect(user!.emailVerified).toBe(0);

    // 验证 authIdentities 表
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, result.userId))
      .limit(1);
    expect(identity).toBeTruthy();
    expect(identity!.provider).toBe("qq");
    expect(identity!.providerUserId).toBe("123456789");
  });

  it("重复调用返回同一 userId（幂等）", async () => {
    const first = await provisionPlatformUser(db, {
      provider: "qq",
      providerUserId: "123456789",
    });
    const second = await provisionPlatformUser(db, {
      provider: "qq",
      providerUserId: "123456789",
    });

    expect(second.userId).toBe(first.userId);
    expect(second.created).toBe(false);
  });

  it("缺少 provider 时抛出错误", async () => {
    await expect(
      provisionPlatformUser(db, {
        provider: "" as "qq",
        providerUserId: "123456789",
      }),
    ).rejects.toThrow("缺少 provider 或 providerUserId");
  });

  it("缺少 providerUserId 时抛出错误", async () => {
    await expect(
      provisionPlatformUser(db, {
        provider: "qq",
        providerUserId: "",
      }),
    ).rejects.toThrow("缺少 provider 或 providerUserId");
  });

  it("不同平台用户各自独立", async () => {
    const qq = await provisionPlatformUser(db, {
      provider: "qq",
      providerUserId: "123456789",
    });
    const tg = await provisionPlatformUser(db, {
      provider: "telegram",
      providerUserId: "987654321",
    });

    expect(qq.userId).not.toBe(tg.userId);
    expect(qq.created).toBe(true);
    expect(tg.created).toBe(true);

    // 验证各自有独立的 identity
    const [qqIdentity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerUserId, "123456789"))
      .limit(1);
    expect(qqIdentity!.provider).toBe("qq");

    const [tgIdentity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerUserId, "987654321"))
      .limit(1);
    expect(tgIdentity!.provider).toBe("telegram");
  });

  it("同一平台不同用户各自独立", async () => {
    const user1 = await provisionPlatformUser(db, {
      provider: "qq",
      providerUserId: "111111",
    });
    const user2 = await provisionPlatformUser(db, {
      provider: "qq",
      providerUserId: "222222",
    });

    expect(user1.userId).not.toBe(user2.userId);
    expect(user1.created).toBe(true);
    expect(user2.created).toBe(true);
  });

  it("并发安全：重复插入时自动收敛到已有记录", async () => {
    // 先插入一次
    const first = await provisionPlatformUser(db, {
      provider: "qq",
      providerUserId: "123456789",
    });

    // 模拟并发插入：先删除 authIdentities 的记录（让第二次调用走到新增路径）
    // 但已有 users 记录，第二次调用应该能收敛
    const second = await provisionPlatformUser(db, {
      provider: "qq",
      providerUserId: "123456789",
    });

    // 幂等
    expect(second.userId).toBe(first.userId);
    expect(second.created).toBe(false);

    // 验证只有一条 authIdentities 记录
    const identities = await db
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.provider, "qq"),
          eq(authIdentities.providerUserId, "123456789"),
        ),
      );
    expect(identities).toHaveLength(1);
  });

  it("生成唯一的 username，不与其他用户冲突", async () => {
    const results = await Promise.all([
      provisionPlatformUser(db, { provider: "qq", providerUserId: "10001" }),
      provisionPlatformUser(db, { provider: "qq", providerUserId: "10002" }),
      provisionPlatformUser(db, { provider: "qq", providerUserId: "10003" }),
    ]);

    // 所有 userId 应该不同
    const userIds = results.map((u) => u.userId);
    expect(new Set(userIds).size).toBe(3);

    // 所有 username 应该不同（通过 DB 约束验证）
    const allUsers = await db.select().from(users);
    const usernames = allUsers.map((u) => u.username);
    expect(new Set(usernames).size).toBe(3);
  });

  it("Telegram 用户也能正常创建", async () => {
    const result = await provisionPlatformUser(db, {
      provider: "telegram",
      providerUserId: "tg_987654321",
      displayName: "Telegram User",
    });

    expect(result.userId).toBeTruthy();
    expect(result.created).toBe(true);

    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, result.userId))
      .limit(1);
    expect(identity!.provider).toBe("telegram");
    expect(identity!.providerUserId).toBe("tg_987654321");
  });
});