/**
 * 维护任务回归测试。
 *
 * 这些测试锁定 cron/maintenance 的数据清理边界，避免为了节省存储把业务计数凭证误删。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { cleanRateLimitLogsSafely } from "./index";
import { processDueDraws } from "./services/lottery-service";
import { rateLimitLog, lotteryDraws } from "./db/schema";
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

describe("processDueDraws 到期关闭（docs/244）", () => {
  it("非 lottery 活动过 endAt 后自动置为 drawn", async () => {
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 3600000).toISOString(); // 1 小时前
    const future = new Date(Date.now() + 3600000).toISOString();

    // claim + flash_sale + instant，已过 endAt
    await db.insert(lotteryDraws).values({
      id: "expired-claim",
      tenantId: "t-expire",
      publicSlug: "expired-claim",
      title: "过期秒杀",
      status: "open",
      activityKind: "claim",
      participationMode: "open",
      experienceType: "flash_sale",
      resultMode: "instant",
      drawTrigger: "manual",
      winnerCount: 0,
      startAt: past,
      endAt: past, // 已过期
      createdAt: now,
      updatedAt: now,
    });
    // 未过期的 claim 不应被关闭
    await db.insert(lotteryDraws).values({
      id: "active-claim",
      tenantId: "t-expire",
      publicSlug: "active-claim",
      title: "进行中秒杀",
      status: "open",
      activityKind: "claim",
      participationMode: "open",
      experienceType: "flash_sale",
      resultMode: "instant",
      drawTrigger: "manual",
      winnerCount: 0,
      startAt: past,
      endAt: future, // 未过期
      createdAt: now,
      updatedAt: now,
    });

    await processDueDraws(db, { limit: 10 });

    const [expired] = await db
      .select({ status: lotteryDraws.status })
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, "expired-claim"))
      .limit(1);
    expect(expired?.status).toBe("drawn"); // 过期 → 自动关闭

    const [active] = await db
      .select({ status: lotteryDraws.status })
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, "active-claim"))
      .limit(1);
    expect(active?.status).toBe("open"); // 未过期 → 保持
  });
});
