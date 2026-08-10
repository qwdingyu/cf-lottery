/**
 * 维护任务回归测试。
 *
 * 这些测试锁定 cron/maintenance 的数据清理边界，避免为了节省存储把业务计数凭证误删。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { cleanRateLimitLogsSafely } from "./index";
import { rateLimitLog } from "./db/schema";
import { clearTestData, getTestDb } from "./test-setup";
import type { DbType } from "./db/client";
import type { Client } from "@libsql/client";

let client: Client;
let db: DbType;

beforeAll(async () => {
  const setup = await getTestDb();
  client = setup.client;
  db = setup.db;
});

beforeEach(async () => {
  await clearTestData(client);
});

describe("cleanRateLimitLogsSafely", () => {
  it("保留 24 小时内的 reward 配额记录，同时清理普通短窗口旧记录", async () => {
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 3600 * 1000).toISOString();
    const twentyFiveHoursAgo = new Date(now - 25 * 3600 * 1000).toISOString();
    const recent = new Date(now - 5 * 60 * 1000).toISOString();

    await db.insert(rateLimitLog).values([
      {
        id: "rl-normal-old",
        key: "login:ip_hash",
        action: "login",
        createdAt: twoHoursAgo,
      },
      {
        id: "rl-normal-recent",
        key: "verify:email_hash",
        action: "verify",
        createdAt: recent,
      },
      {
        id: "rl-reward-window",
        key: "reward:draw-a:entry-a",
        action: "reward",
        createdAt: twoHoursAgo,
      },
      {
        id: "rl-reward-expired",
        key: "reward:global:draw-a",
        action: "reward",
        createdAt: twentyFiveHoursAgo,
      },
    ]);

    const deleted = await cleanRateLimitLogsSafely(db);

    expect(deleted).toBe(2);
    const rows = await db.select({ id: rateLimitLog.id }).from(rateLimitLog);
    expect(rows.map((row) => row.id).sort()).toEqual(["rl-normal-recent", "rl-reward-window"]);

    const [rewardWindow] = await db
      .select()
      .from(rateLimitLog)
      .where(eq(rateLimitLog.id, "rl-reward-window"))
      .limit(1);
    expect(rewardWindow?.key).toBe("reward:draw-a:entry-a");
  });
});
