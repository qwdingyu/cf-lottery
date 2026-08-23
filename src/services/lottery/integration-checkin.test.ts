/**
 * recordActivityEvent / recordSpinLog 签到场景集成测试（docs/268）
 *
 * 覆盖：
 * 1. recordActivityEvent eventType 白名单拒绝
 * 2. recordActivityEvent 字段截断
 * 3. recordSpinLog 写入 + reason 枚举
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import type { DbType } from "../../db/client";
import {
  activityEvents,
  spinsLog,
  lotteryDraws,
  lotteryEntries,
  tenants,
} from "../../db/schema";
import { clearTestData, getTestDb } from "../../test-setup";
import { recordActivityEvent, getActivityEventSummary } from "./integration";
import { recordSpinLog } from "./spins-log";

let client: Client;
let db: DbType;

const TENANT_ID = "tenant-integration-test";
const DRAW_ID = "draw-integration-test";

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

async function seedBase() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "integration-test" });
  await db.insert(lotteryDraws).values({
    id: DRAW_ID,
    tenantId: TENANT_ID,
    publicSlug: "integration-slug",
    title: "集成测试活动",
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    resultMode: "instant",
    startAt: new Date(Date.now() - 86_400_000).toISOString(),
    endAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

describe("recordActivityEvent 白名单校验", () => {
  it("合法 eventType 写入成功", async () => {
    await seedBase();
    const result = await recordActivityEvent(db, {
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      entryId: "entry-1",
      eventType: "daily_checkin",
      source: "public_web",
    });
    expect(result.id).toBeDefined();

    const [row] = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.id, result.id))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.eventType).toBe("daily_checkin");
  });

  it("非法 eventType 抛出异常", async () => {
    await seedBase();
    await expect(
      recordActivityEvent(db, {
        tenantId: TENANT_ID,
        drawId: DRAW_ID,
        entryId: "entry-1",
        eventType: "invalid_type" as any,
      }),
    ).rejects.toThrow("活动事件类型无效");
  });

  it("字段超长时截断", async () => {
    await seedBase();
    const longSource = "a".repeat(200); // 超过 100 字符限制
    const result = await recordActivityEvent(db, {
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      entryId: "entry-1",
      eventType: "page_view",
      source: longSource,
    });
    const [row] = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.id, result.id))
      .limit(1);
    expect(row!.source.length).toBeLessThanOrEqual(100);
  });
});

describe("getActivityEventSummary 聚合", () => {
  it("按 eventType 分组统计", async () => {
    await seedBase();
    // 写入 2 个 page_view + 1 个 daily_checkin
    await recordActivityEvent(db, {
      tenantId: TENANT_ID, drawId: DRAW_ID, entryId: "e1",
      eventType: "page_view",
    });
    await recordActivityEvent(db, {
      tenantId: TENANT_ID, drawId: DRAW_ID, entryId: "e2",
      eventType: "page_view",
    });
    await recordActivityEvent(db, {
      tenantId: TENANT_ID, drawId: DRAW_ID, entryId: "e3",
      eventType: "daily_checkin",
    });

    const summary = await getActivityEventSummary(db, TENANT_ID, DRAW_ID);
    // 返回 { totals: Record<string, number>, ... }
    expect(summary.totals.page_view).toBe(2);
    expect(summary.totals.daily_checkin).toBe(1);
  });
});

describe("recordSpinLog 签到场景", () => {
  it("签到 reason 写入流水", async () => {
    await seedBase();
    // 播种一条 entry
    await db.insert(lotteryEntries).values({
      id: "entry-spin-log",
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "email",
      identityValue: "spinlog@test.com",
      displayName: "tester",
    });

    await recordSpinLog(db, {
      tenantId: TENANT_ID,
      entryId: "entry-spin-log",
      userId: "spinlog@test.com",
      delta: 3,
      balanceAfter: 3,
      reason: "checkin",
    });

    const logs = await db
      .select()
      .from(spinsLog)
      .where(eq(spinsLog.entryId, "entry-spin-log"));
    expect(logs.length).toBe(1);
    expect(logs[0].delta).toBe(3);
    expect(logs[0].reason).toBe("checkin");
    expect(logs[0].balanceAfter).toBe(3);
  });

  it("多条流水累加", async () => {
    await seedBase();
    await db.insert(lotteryEntries).values({
      id: "entry-multi-spin",
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "email",
      identityValue: "multi@test.com",
      displayName: "tester",
    });

    await recordSpinLog(db, {
      tenantId: TENANT_ID, entryId: "entry-multi-spin",
      userId: "multi@test.com", delta: 2, balanceAfter: 2, reason: "checkin",
    });
    await recordSpinLog(db, {
      tenantId: TENANT_ID, entryId: "entry-multi-spin",
      userId: "multi@test.com", delta: -1, balanceAfter: 1, reason: "spin",
    });

    const logs = await db
      .select()
      .from(spinsLog)
      .where(eq(spinsLog.entryId, "entry-multi-spin"));
    expect(logs.length).toBe(2);
    expect(logs[0].delta).toBe(2);
    expect(logs[0].reason).toBe("checkin");
    expect(logs[1].delta).toBe(-1);
    expect(logs[1].reason).toBe("spin");
  });
});
