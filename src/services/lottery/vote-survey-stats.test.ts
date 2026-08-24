/**
 * 投票/问卷结果统计集成测试（docs/267 P0）
 *
 * 覆盖：
 * 1. 投票（vote）：选项统计 + 百分比计算
 * 2. 问卷（survey）：字段级答案分布
 * 3. 空数据返回
 * 4. 非投票/问卷活动拒绝
 * 5. 最近提交限制
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import type { Client } from "@libsql/client";
import type { DbType } from "../../db/client";
import {
  lotteryDraws,
  activitySubmissions,
  tenants,
} from "../../db/schema";
import { clearTestData, getTestDb } from "../../test-setup";
import { getVoteSurveyStats } from "./vote-survey-stats";

let client: Client;
let db: DbType;

const TENANT_ID = "tenant-vote-survey";

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

async function seedVoteActivity() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "vote-test" });
  const drawId = `draw-vote-${Date.now()}`;
  await db.insert(lotteryDraws).values({
    id: drawId,
    tenantId: TENANT_ID,
    publicSlug: `vote-slug-${Date.now()}`,
    title: "投票测试",
    status: "open",
    activityKind: "vote",
    participationMode: "open",
    experienceType: "ballot",
    resultMode: "vote_tally",
    startAt: new Date(Date.now() - 86_400_000).toISOString(),
    endAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  return drawId;
}

async function seedSurveyActivity() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "survey-test" });
  const drawId = `draw-survey-${Date.now()}`;
  await db.insert(lotteryDraws).values({
    id: drawId,
    tenantId: TENANT_ID,
    publicSlug: `survey-slug-${Date.now()}`,
    title: "问卷测试",
    status: "open",
    activityKind: "survey",
    participationMode: "open",
    experienceType: "form",
    resultMode: "no_result",
    startAt: new Date(Date.now() - 86_400_000).toISOString(),
    endAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  return drawId;
}

async function insertSubmission(drawId: string, entryId: string, payload: Record<string, unknown>) {
  await db.insert(activitySubmissions).values({
    id: `sub-${entryId}`,
    tenantId: TENANT_ID,
    drawId,
    entryId,
    payloadJson: JSON.stringify(payload),
    idempotencyKey: "",
  });
}

describe("投票统计", () => {
  it("统计选项分布 + 百分比", async () => {
    const drawId = await seedVoteActivity();
    await insertSubmission(drawId, "e1", { option: "选项A" });
    await insertSubmission(drawId, "e2", { option: "选项B" });
    await insertSubmission(drawId, "e3", { option: "选项A" });
    await insertSubmission(drawId, "e4", { option: "选项A" });

    const stats = await getVoteSurveyStats(db, TENANT_ID, drawId);
    expect(stats.activityKind).toBe("vote");
    expect(stats.totalSubmissions).toBe(4);
    expect(stats.voteResults).toBeDefined();
    expect(stats.voteResults!.length).toBe(2);

    // 选项A: 3 票 (75%), 选项B: 1 票 (25%)
    const optA = stats.voteResults!.find((r) => r.option === "选项A");
    const optB = stats.voteResults!.find((r) => r.option === "选项B");
    expect(optA?.count).toBe(3);
    expect(optA?.percentage).toBe(75);
    expect(optB?.count).toBe(1);
    expect(optB?.percentage).toBe(25);
  });

  it("空数据返回空结果", async () => {
    const drawId = await seedVoteActivity();
    const stats = await getVoteSurveyStats(db, TENANT_ID, drawId);
    expect(stats.totalSubmissions).toBe(0);
    expect(stats.voteResults).toEqual([]);
  });

  it("最近提交限制", async () => {
    const drawId = await seedVoteActivity();
    for (let i = 0; i < 5; i++) {
      await insertSubmission(drawId, `e${i}`, { option: "选项A" });
    }

    const stats = await getVoteSurveyStats(db, TENANT_ID, drawId, { limit: 3 });
    expect(stats.totalSubmissions).toBe(5); // 总数不变
    expect(stats.recentSubmissions!.length).toBe(3); // 最近 3 条
  });
});

describe("问卷统计", () => {
  it("按字段分组统计答案分布", async () => {
    const drawId = await seedSurveyActivity();
    await insertSubmission(drawId, "e1", { 满意度: "非常满意", 建议: "很好" });
    await insertSubmission(drawId, "e2", { 满意度: "满意", 建议: "一般" });
    await insertSubmission(drawId, "e3", { 满意度: "非常满意", 建议: "很好" });

    const stats = await getVoteSurveyStats(db, TENANT_ID, drawId);
    expect(stats.activityKind).toBe("survey");
    expect(stats.totalSubmissions).toBe(3);
    expect(stats.fieldResults).toBeDefined();
    expect(stats.fieldResults!.length).toBe(2);

    const satisfaction = stats.fieldResults!.find((f) => f.fieldName === "满意度");
    expect(satisfaction).toBeDefined();
    expect(satisfaction!.totalResponses).toBe(3);
    expect(satisfaction!.options.length).toBe(2);

    const verySatisfied = satisfaction!.options.find((o) => o.option === "非常满意");
    expect(verySatisfied?.count).toBe(2);
  });
});

describe("活动类型校验", () => {
  it("非投票/问卷活动抛出异常", async () => {
    await db.insert(tenants).values({ id: TENANT_ID, name: "lottery-test" });
    const drawId = `draw-lottery-${Date.now()}`;
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT_ID,
      publicSlug: `lottery-slug-${Date.now()}`,
      title: "抽奖活动",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "wheel",
      resultMode: "instant",
      startAt: new Date(Date.now() - 86_400_000).toISOString(),
      endAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    await expect(getVoteSurveyStats(db, TENANT_ID, drawId)).rejects.toThrow("此活动不是投票或问卷类型");
  });

  it("活动不存在抛出异常", async () => {
    await expect(getVoteSurveyStats(db, TENANT_ID, "nonexistent")).rejects.toThrow("活动不存在");
  });
});
