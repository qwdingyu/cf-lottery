/**
 * 限量领取（claim）功能端到端集成测试（docs/267 P0）
 *
 * 验证 claim 活动的完整流程：
 * - 创建 claim 活动（默认 experienceType=reveal, resultMode=instant）
 * - 用户领取（joinDraw）→ 创建 entry + 发放 initial spins
 * - 容量控制（maxParticipants 限制）
 * - UNIQUE 约束防止同一用户重复领取
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import type { DbType } from "../../db/client";
import {
  lotteryDraws,
  lotteryEntries,
  tenants,
} from "../../db/schema";
import { clearTestData, getTestDb } from "../../test-setup";
import { joinDraw } from "./participation";
import { defaultExperienceForActivity, defaultResultModeForActivity } from "../../lib/activity-utils";

let client: Client;
let db: DbType;

const TENANT_ID = "tenant-claim-test";

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

async function seedClaimActivity(opts?: { maxParticipants?: number }) {
  await db.insert(tenants).values({ id: TENANT_ID, name: "claim-test" });
  const drawId = `draw-claim-${Date.now()}`;
  await db.insert(lotteryDraws).values({
    id: drawId,
    tenantId: TENANT_ID,
    publicSlug: `claim-slug-${Date.now()}`,
    title: "限量领取测试",
    status: "open",
    activityKind: "claim",
    participationMode: "open",
    experienceType: "reveal",
    resultMode: "instant",
    maxParticipants: opts?.maxParticipants ?? null,
    startAt: new Date(Date.now() - 86_400_000).toISOString(),
    endAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
  });
  return drawId;
}

describe("claim 活动默认配置映射", () => {
  it("claim → experienceType=reveal, resultMode=instant", () => {
    expect(defaultExperienceForActivity("claim", "open")).toBe("reveal");
    expect(defaultResultModeForActivity("claim", "manual")).toBe("instant");
  });
});

describe("claim 领取流程端到端测试", () => {
  it("用户领取成功：创建 entry", async () => {
    const drawId = await seedClaimActivity();
    const [draw] = await db
      .select({ publicSlug: lotteryDraws.publicSlug })
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId))
      .limit(1);

    const result = await joinDraw(db, draw!.publicSlug!, "claim-user@example.com");
    expect(result.joined).toBe(true);
    expect(result.activityKind).toBe("claim");

    // 验证 entry 已创建
    const [entry] = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.id, result.entryId!))
      .limit(1);
    expect(entry).toBeDefined();
    expect(entry!.identityValue).toBe("claim-user@example.com");
    // claim 活动不使用 spins 机制（maxSpinsPerEntry=0），直接领取
    expect(entry!.spinsLeft).toBe(0);
  });

  it("同一用户重复领取被拒绝", async () => {
    const drawId = await seedClaimActivity();
    const [draw] = await db
      .select({ publicSlug: lotteryDraws.publicSlug })
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId))
      .limit(1);

    const r1 = await joinDraw(db, draw!.publicSlug!, "claim-once@example.com");
    expect(r1.joined).toBe(true);

    const r2 = await joinDraw(db, draw!.publicSlug!, "claim-once@example.com");
    expect(r2.joined).toBe(false);
  });

  it("容量控制：达到 maxParticipants 后拒绝新领取", async () => {
    const drawId = await seedClaimActivity({ maxParticipants: 2 });
    const [draw] = await db
      .select({ publicSlug: lotteryDraws.publicSlug })
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId))
      .limit(1);

    const r1 = await joinDraw(db, draw!.publicSlug!, "user-a@test.com");
    const r2 = await joinDraw(db, draw!.publicSlug!, "user-b@test.com");
    expect(r1.joined).toBe(true);
    expect(r2.joined).toBe(true);

    // 第 3 个用户应被拒绝
    const r3 = await joinDraw(db, draw!.publicSlug!, "user-c@test.com");
    expect(r3.joined).toBe(false);
  });

  it("不同用户可独立领取", async () => {
    const drawId = await seedClaimActivity();
    const [draw] = await db
      .select({ publicSlug: lotteryDraws.publicSlug })
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId))
      .limit(1);

    const r1 = await joinDraw(db, draw!.publicSlug!, "user-1@test.com");
    const r2 = await joinDraw(db, draw!.publicSlug!, "user-2@test.com");
    const r3 = await joinDraw(db, draw!.publicSlug!, "user-3@test.com");

    expect(r1.joined).toBe(true);
    expect(r2.joined).toBe(true);
    expect(r3.joined).toBe(true);

    // 验证 3 条独立 entry
    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.drawId, drawId));
    expect(entries.length).toBe(3);
  });
});
