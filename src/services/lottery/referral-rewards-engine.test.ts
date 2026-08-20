/**
 * engine-powered 推荐奖励集成测（docs/250）
 *
 * 覆盖：配置解析、bonus_spin 发放、bonus_coupon 发券、幂等性、
 * 无配置跳过、maxSpins 裁剪、码池耗尽。
 *
 * 使用真实数据库（getTestDb），与生产 schema 同源。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, clearTestData } from "../../test-setup";
import type { DbType } from "../../db/client";
import type { Client } from "@libsql/client";
import {
  lotteryDraws,
  lotteryEntries,
  shareRecords,
  couponCodes,
  spinsLog,
} from "../../db/schema";
import {
  processReferralRewardsEngine,
  normalizeReferralRewardDefs,
  collectReferralRewardDefIssues,
} from "./referral-rewards-engine";

const TENANT = "tenant-referral-engine";

async function seedDraw(
  db: DbType,
  opts?: {
    promotionConfig?: string;
    maxSpins?: number;
    activityKind?: string;
  },
) {
  const id = crypto.randomUUID();
  const slug = `re${id.slice(0, 6)}`;
  const now = new Date();
  const startAt = new Date(now.getTime() - 3600_000).toISOString();
  const endAt = new Date(now.getTime() + 86400_000 * 7).toISOString();

  await db.insert(lotteryDraws).values({
    id,
    tenantId: TENANT,
    publicSlug: slug,
    title: "referral engine test",
    description: "",
    status: "open",
    activityKind: opts?.activityKind ?? "lottery",
    participationMode: "open",
    experienceType: "wheel",
    drawTrigger: "manual",
    resultMode: "instant",
    startAt,
    endAt,
    winnerCount: 1,
    maxSpinsPerEntry: opts?.maxSpins ?? 10,
    promotionConfig: opts?.promotionConfig ?? "{}",
  });
  return id;
}

async function seedSharer(
  db: DbType,
  drawId: string,
  opts?: { joinedCount?: number; spinsLeft?: number; spinsTotalGranted?: number },
) {
  const entryId = crypto.randomUUID();
  await db.insert(lotteryEntries).values({
    id: entryId,
    tenantId: TENANT,
    drawId,
    identityType: "email",
    identityValue: `sharer-${entryId.slice(0, 6)}@test.com`,
    spinsLeft: opts?.spinsLeft ?? 0,
    spinsTotalGranted: opts?.spinsTotalGranted ?? 0,
    spinsViralEarned: 0,
  });

  const shareRecordId = crypto.randomUUID();
  await db.insert(shareRecords).values({
    id: shareRecordId,
    tenantId: TENANT,
    drawId,
    sharerEntryId: entryId,
    shareCode: `sc${shareRecordId.slice(0, 8)}`,
    clickedCount: 0,
    joinedCount: opts?.joinedCount ?? 1,
    rewardMilestonesGranted: "[]",
    leaderboardRewardedAt: "",
  });

  return { entryId, shareRecordId };
}

async function seedCoupon(db: DbType, drawId: string, label = "invite") {
  const id = crypto.randomUUID();
  await db.insert(couponCodes).values({
    id,
    tenantId: TENANT,
    drawId,
    code: `CP-${id.slice(0, 8)}`,
    label,
    status: "available",
  });
  return id;
}

describe("normalizeReferralRewardDefs", () => {
  it("空/非数组 → 空数组", () => {
    expect(normalizeReferralRewardDefs(null)).toEqual([]);
    expect(normalizeReferralRewardDefs(undefined)).toEqual([]);
    expect(normalizeReferralRewardDefs("not-array")).toEqual([]);
    expect(normalizeReferralRewardDefs([])).toEqual([]);
  });

  it("合法条目保留", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
    ]);
    expect(defs.length).toBe(1);
    expect(defs[0]!.rewardId).toBe("m1");
  });

  it("缺 rewardId/type/target → 剔除", () => {
    const defs = normalizeReferralRewardDefs([
      { type: "FIXED", target: "SOURCE", fixedAmount: "2" }, // 缺 rewardId
      { rewardId: "m2", target: "SOURCE", fixedAmount: "2" }, // 缺 type
      { rewardId: "m3", type: "FIXED", fixedAmount: "2" }, // 缺 target
      { rewardId: "m4", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } }, // 合法
    ]);
    expect(defs.length).toBe(1);
    expect(defs[0]!.rewardId).toBe("m4");
  });

  it("未知 rewardExit → 剔除", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "unknown_exit" } },
    ]);
    expect(defs.length).toBe(0);
  });

  it("缺 metadata.rewardExit → 默认 bonus_spin 保留", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2" },
    ]);
    expect(defs.length).toBe(1);
  });

  it("非法 type → 剔除（docs/254 校验）", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "INVALID", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      { rewardId: "m2", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } }, // 合法
    ]);
    expect(defs.length).toBe(1);
    expect(defs[0]!.rewardId).toBe("m2");
  });

  it("非法 target → 剔除（docs/254 校验）", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "INVALID", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
    ]);
    expect(defs.length).toBe(0);
  });

  it("FIXED 缺 fixedAmount 或 <=0 → 剔除（docs/254 校验）", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "SOURCE", metadata: { rewardExit: "bonus_spin" } }, // 缺 fixedAmount
      { rewardId: "m2", type: "FIXED", target: "SOURCE", fixedAmount: "0", metadata: { rewardExit: "bonus_spin" } }, // 0
      { rewardId: "m3", type: "FIXED", target: "SOURCE", fixedAmount: "-1", metadata: { rewardExit: "bonus_spin" } }, // 负
      { rewardId: "m4", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } }, // 合法
    ]);
    expect(defs.length).toBe(1);
    expect(defs[0]!.rewardId).toBe("m4");
  });

  it("重复 rewardId → 剔除（docs/254 校验）", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "5", metadata: { rewardExit: "bonus_spin" } }, // 重复
    ]);
    expect(defs.length).toBe(1);
    expect(defs[0]!.fixedAmount).toBe("2");
  });

  // ── docs/255 §六（P1-3）：conditions 校验，根除引擎 fail-open ──

  it("conditions 缺省或空数组 → 保留（无条件档，语义合法）", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "c0", type: "FIXED", target: "SOURCE", fixedAmount: "2" },
    ]).length).toBe(1);
    expect(normalizeReferralRewardDefs([
      { rewardId: "c0b", type: "FIXED", target: "SOURCE", fixedAmount: "2", conditions: [] },
    ]).length).toBe(1);
  });

  it("conditions 不是数组 → 剔除（引擎 _meetsRewardCondition 会 fail-open 放行）", () => {
    const defs = normalizeReferralRewardDefs([
      {
        rewardId: "invite_3", type: "FIXED", target: "SOURCE", fixedAmount: "2",
        // 运营/API 直写成对象而非数组：引擎 !Array.isArray(conditions) → return true → 首次邀请即发 3 人档奖
        conditions: { type: "COMPARE", field: "totalJoinedCount", operator: "GTE", value: "3" },
      },
    ]);
    expect(defs.length).toBe(0);
  });

  it("合法 conditions（COMPARE / AND / OR / NOT 树）→ 保留", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "2", conditions: [{ type: "COMPARE", field: "totalJoinedCount", operator: "GTE", value: "3" }] },
      { rewardId: "c2", type: "FIXED", target: "SOURCE", fixedAmount: "2", conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "3" }] },
      {
        rewardId: "c3", type: "FIXED", target: "SOURCE", fixedAmount: "2",
        conditions: [{
          type: "AND",
          children: [
            { type: "COMPARE", field: "totalJoinedCount", operator: "GTE", value: "3" },
            { type: "NOT", children: [{ type: "COMPARE", field: "activityKind", operator: "NE", value: "lottery" }] },
          ],
        }],
      },
    ]);
    expect(defs.map((d) => d.rewardId)).toEqual(["c1", "c2", "c3"]);
  });

  it("conditions 字段名不在白名单 → 剔除（引擎 _resolveField 缺失字段返回 0 → 永久不发）", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "typo", type: "FIXED", target: "SOURCE", fixedAmount: "2", conditions: [{ field: "joinedCount", operator: "GTE", value: "3" }] },
    ]);
    expect(defs.length).toBe(0);
  });

  it("conditions 算子非法 / 排序算子比较值非数值 → 剔除", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "op1", type: "FIXED", target: "SOURCE", fixedAmount: "2", conditions: [{ field: "totalJoinedCount", operator: "BETWEEN", value: "3" }] },
    ]).length).toBe(0);
    expect(normalizeReferralRewardDefs([
      { rewardId: "op2", type: "FIXED", target: "SOURCE", fixedAmount: "2", conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "三" }] },
    ]).length).toBe(0);
    // EQ/NE 允许非数值（字符串枚举比较）
    expect(normalizeReferralRewardDefs([
      { rewardId: "op3", type: "FIXED", target: "SOURCE", fixedAmount: "2", conditions: [{ field: "activityKind", operator: "EQ", value: "lottery" }] },
    ]).length).toBe(1);
  });

  it("conditions 逻辑节点缺 children / 未知节点类型 → 剔除", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "n1", type: "FIXED", target: "SOURCE", fixedAmount: "2", conditions: [{ type: "AND", children: [] }] },
    ]).length).toBe(0);
    expect(normalizeReferralRewardDefs([
      { rewardId: "n2", type: "FIXED", target: "SOURCE", fixedAmount: "2", conditions: [{ type: "XOR", children: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }] }] },
    ]).length).toBe(0);
  });

  it("conditions 嵌套子节点缺 type → 剔除（顶层免 type 由 _meetsRewardCondition 包装，子节点不会）", () => {
    // 引擎 evaluateCondition：`if (!condition || !condition.type) return false`
    // 顶层数组元素会被 _meetsRewardCondition 补成 COMPARE，但 AND/OR/NOT 的 children 不会 → 永久 false
    const defs = normalizeReferralRewardDefs([
      {
        rewardId: "nested_notype", type: "FIXED", target: "SOURCE", fixedAmount: "2",
        conditions: [{ type: "AND", children: [{ field: "totalJoinedCount", operator: "GTE", value: "3" }] }],
      },
    ]);
    expect(defs.length).toBe(0);
  });

  it("conditions 嵌套子节点字段非法 → 剔除（递归校验，不只看顶层）", () => {
    const defs = normalizeReferralRewardDefs([
      {
        rewardId: "nested_typo", type: "FIXED", target: "SOURCE", fixedAmount: "2",
        conditions: [{
          type: "OR",
          children: [
            { type: "COMPARE", field: "totalJoinedCount", operator: "GTE", value: "3" },
            { type: "COMPARE", field: "inviteCount", operator: "GTE", value: "5" }, // 字段不存在 → _resolveField 返回 0
          ],
        }],
      },
    ]);
    expect(defs.length).toBe(0);
  });

  it("conditions 嵌套过深（>5 层）→ 剔除（防深树 DoS）", () => {
    let node: Record<string, unknown> = { type: "COMPARE", field: "totalJoinedCount", operator: "GTE", value: "1" };
    for (let i = 0; i < 6; i++) node = { type: "NOT", children: [node] };
    expect(normalizeReferralRewardDefs([
      { rewardId: "deep", type: "FIXED", target: "SOURCE", fixedAmount: "2", conditions: [node] },
    ]).length).toBe(0);
  });

  it("LEVEL / *|PARENT 组合 → 剔除（cf-lottery 恒传 ancestors=[] / directParent=null，数学上永不发放）", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "lv", type: "LEVEL", target: "SOURCE", fixedAmount: "2" },
      { rewardId: "pa", type: "DIRECT", target: "PARENT", rate: "100" },
      { rewardId: "ok", type: "DIRECT", target: "SOURCE", rate: "100" },
      // CUSTOM 必须能解析出金额（amount 或 amountFrom），否则 resolveCustomAmount 返回 null
      { rewardId: "ok2", type: "CUSTOM", target: "SOURCE", amount: "2", metadata: { rewardExit: "bonus_spin" } },
    ]);
    expect(defs.map((d) => d.rewardId)).toEqual(["ok", "ok2"]);
  });

  // ── docs/255 二次审查 B1：非数值金额会让引擎抛 DecimalError ──
  // Decimal 拒绝带空格/布尔/百分号，而校验用的 Number() 接受 " 5 " 与 true。
  // 异常从 distributeByDefs 抛出后被 maybeTriggerReward 的 try/catch 吞掉，
  // 该分享者整批推荐奖励静默丢失（join 不回滚、用户无感）。
  it("FIXED fixedAmount 带空格 → 剔除（Decimal 会抛 DecimalError，Number 却接受）", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "ws", type: "FIXED", target: "SOURCE", fixedAmount: " 5 " },
    ]).length).toBe(0);
  });

  it("FIXED fixedAmount 为布尔/百分号/科学计数 → 剔除", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "b", type: "FIXED", target: "SOURCE", fixedAmount: true },
      { rewardId: "p", type: "FIXED", target: "SOURCE", fixedAmount: "5%" },
      { rewardId: "e", type: "FIXED", target: "SOURCE", fixedAmount: "1e3" },
    ]).length).toBe(0);
  });

  it("FIXED fixedAmount 为纯数字字符串/数字 → 保留", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "s", type: "FIXED", target: "SOURCE", fixedAmount: "5" },
      { rewardId: "n", type: "FIXED", target: "SOURCE", fixedAmount: 3 },
      { rewardId: "d", type: "FIXED", target: "SOURCE", fixedAmount: "2.5" },
    ]).map((d) => d.rewardId)).toEqual(["s", "n", "d"]);
  });

  // ── docs/255 二次审查 B2：死配置 / 抛异常配置的对称校验 ──
  it("DIRECT 缺 rate 或 rate 非数值 → 剔除（缺 rate 恒不发；'50%' 会抛 DecimalError）", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "norate", type: "DIRECT", target: "SOURCE" },
      { rewardId: "pct", type: "DIRECT", target: "SOURCE", rate: "50%" },
      { rewardId: "zero", type: "DIRECT", target: "SOURCE", rate: "0" },
    ]).length).toBe(0);
  });

  it("CUSTOM 无 amount 且无 amountFrom → 剔除（resolveCustomAmount 返回 null，恒不发）", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "noamt", type: "CUSTOM", target: "SOURCE" },
      { rewardId: "empty", type: "CUSTOM", target: "SOURCE", amount: "" },
      { rewardId: "zero", type: "CUSTOM", target: "SOURCE", amount: "0" },
    ]).length).toBe(0);
  });

  it("CUSTOM amountFrom 指向非数值字段 → 剔除（Decimal.gt('lottery','0') 会抛 DecimalError）", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "kind", type: "CUSTOM", target: "SOURCE", amountFrom: "event.attrs.activityKind" },
      { rewardId: "unknown", type: "CUSTOM", target: "SOURCE", amountFrom: "event.attrs.notExist" },
      { rewardId: "bad", type: "CUSTOM", target: "SOURCE", amountFrom: "whatever" },
    ]).length).toBe(0);
  });

  it("CUSTOM amountFrom 指向数值字段 → 保留（eventValue / totalJoinedCount）", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "ev", type: "CUSTOM", target: "SOURCE", amountFrom: "eventValue" },
      { rewardId: "tj", type: "CUSTOM", target: "SOURCE", amountFrom: "event.attrs.totalJoinedCount" },
    ]).map((d) => d.rewardId)).toEqual(["ev", "tj"]);
  });

  it("排序算子 value 为数字 → 保留（引擎 _toComparable 会 String 化，不该误杀可用配置）", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "num", type: "FIXED", target: "SOURCE", fixedAmount: "2",
        conditions: [{ field: "totalJoinedCount", operator: "GTE", value: 3 }] },
    ]).map((d) => d.rewardId)).toEqual(["num"]);
  });

  it("EQ/NE 缺 value → 剔除（NE 缺 value 时引擎恒 true，等于无条件超发）", () => {
    expect(normalizeReferralRewardDefs([
      { rewardId: "eq", type: "FIXED", target: "SOURCE", fixedAmount: "2",
        conditions: [{ field: "totalJoinedCount", operator: "EQ" }] },
      { rewardId: "ne", type: "FIXED", target: "SOURCE", fixedAmount: "2",
        conditions: [{ field: "totalJoinedCount", operator: "NE" }] },
    ]).length).toBe(0);
  });
});

describe("collectReferralRewardDefIssues（发布预检逐条报错，docs/255 B5）", () => {
  /**
   * 单一真相不变式：预检与运行时必须对同一份配置给出一致结论，
   * 否则会出现"预检说合法但运行时剔除"（运营配了没生效）或
   * "预检报错但运行时会发"（无法发布却已在发奖）的漂移。
   * 不变式：normalize 保留数 + collect 报错数 === 输入条目数。
   */
  const SAMPLES: unknown[] = [
    { rewardId: "ok", type: "FIXED", target: "SOURCE", fixedAmount: "2" },
    { rewardId: "ok", type: "FIXED", target: "SOURCE", fixedAmount: "2" }, // 重复 rewardId
    { rewardId: "", type: "FIXED", target: "SOURCE", fixedAmount: "2" },
    null,
    { rewardId: "lv", type: "LEVEL", target: "SOURCE", fixedAmount: "2" },
    { rewardId: "pa", type: "FIXED", target: "PARENT", fixedAmount: "2" },
    { rewardId: "amt", type: "FIXED", target: "SOURCE", fixedAmount: " 5 " },
    { rewardId: "rate", type: "DIRECT", target: "SOURCE", rate: "50%" },
    { rewardId: "cust", type: "CUSTOM", target: "SOURCE" },
    { rewardId: "custok", type: "CUSTOM", target: "SOURCE", amountFrom: "eventValue" },
    { rewardId: "exit", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "wire_transfer" } },
    { rewardId: "cond", type: "FIXED", target: "SOURCE", fixedAmount: "2", conditions: { field: "x" } },
    { rewardId: "condok", type: "FIXED", target: "SOURCE", fixedAmount: "2",
      conditions: [{ field: "totalJoinedCount", operator: "GTE", value: 3 }] },
  ];

  it("normalize 保留数 + collect 报错数 === 输入条目数（预检与运行时同源）", () => {
    const kept = normalizeReferralRewardDefs(SAMPLES).length;
    const issues = collectReferralRewardDefIssues(SAMPLES).length;
    expect(kept + issues).toBe(SAMPLES.length);
    expect(kept).toBe(3); // ok / custok / condok
  });

  it("每个非法条目都带可读原因，且 rewardId 可定位", () => {
    const issues = collectReferralRewardDefIssues(SAMPLES);
    expect(issues.every((i) => i.reason.length > 0)).toBe(true);
    expect(issues.map((i) => i.rewardId)).toContain("amt");
    expect(issues.find((i) => i.rewardId === "amt")?.reason).toContain("fixedAmount");
  });

  it("全部合法 → 返回空数组（不产生噪音 error）", () => {
    expect(collectReferralRewardDefIssues([
      { rewardId: "a", type: "FIXED", target: "SOURCE", fixedAmount: "1" },
      { rewardId: "b", type: "FIXED", target: "SOURCE", fixedAmount: "2",
        metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
    ])).toEqual([]);
  });
});

describe("processReferralRewardsEngine", () => {
  let db: DbType;
  let client: Client;

  beforeEach(async () => {
    ({ db, client } = await getTestDb());
    await clearTestData(client);
  });

  afterEach(async () => {
    await clearTestData(client);
  });

  it("无 referralRewardDefs 配置 → 跳过，不报错", async () => {
    const drawId = await seedDraw(db, { promotionConfig: JSON.stringify({ viral: { enabled: true } }) });
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId,
      tenantId: TENANT,
      activityKind: "lottery",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({ viral: { enabled: true } }),
    }, shareRecordId);

    // 无 spins 变化
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(0);
  });

  it("bonus_spin 里程碑：邀请 1 人 → 发放 2 次", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId,
      tenantId: TENANT,
      activityKind: "lottery",
      maxSpinsPerEntry: 10,
      promotionConfig,
    }, shareRecordId);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(2);
    expect(Number(entry?.spinsTotalGranted ?? 0)).toBe(2);

    // 幂等标记已写入
    const [share] = await db.select().from(shareRecords).where(eq(shareRecords.id, shareRecordId));
    expect(JSON.parse(share?.rewardMilestonesGranted || "[]")).toContain("m1");
  });

  it("幂等性：同一 rewardId 二次触发不重复发放", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    // 第一次触发
    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    // 第二次触发（模拟再次归因）
    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    // 只发放一次
    expect(Number(entry?.spinsLeft ?? 0)).toBe(2);
  });

  it("maxSpins 裁剪：发放超过 maxSpins 时按实际可发额度", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "5", metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    // maxSpins=3，但奖励要发 5 次 → 只发 3 次
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 3 });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 3, promotionConfig,
    }, shareRecordId);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(3);
  });

  it("bonus_coupon 发券：邀请 1 人 → 发放优惠券", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    await seedCoupon(db, drawId, "invite");
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    // 优惠券已发放（status=issued）
    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.tenantId, TENANT));
    expect(coupon?.status).toBe("issued");
  });

  it("bonus_coupon 码池耗尽 → 跳过，不报错", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    // 不 seed 优惠券 → 码池为空
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    // 不报错，无优惠券发放
    const coupons = await db.select().from(couponCodes).where(eq(couponCodes.tenantId, TENANT));
    expect(coupons.length).toBe(0);
  });

  it("conditions 条件过滤：不满足条件不发放", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m5", type: "FIXED", target: "SOURCE", fixedAmount: "5", conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "5" }], metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    // joinedCount=1 < 5 → 不满足条件
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(0);
  });

  it("conditions 条件满足：joinedCount>=3 发放", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m3", type: "FIXED", target: "SOURCE", fixedAmount: "5", conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "3" }], metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 3 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(5);
  });

  it("spins_log 审计：发放后写入流水", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const logs = await db.select().from(spinsLog).where(eq(spinsLog.entryId, entryId));
    expect(logs.length).toBe(1);
    expect(logs[0]?.delta).toBe(2);
    expect(logs[0]?.reason).toBe("viral");
    expect(logs[0]?.refId).toBe("engine:m1");
  });

  it("非 lottery 类型 + bonus_spin 出口 → 跳过，不发放（docs/252 §2.2）", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    // activityKind = claim（非 lottery）
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10, activityKind: "claim" });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "claim", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    // spins 不增加（bonus_spin 对非 lottery 跳过）
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(0);
    // 不写 spins_log
    const logs = await db.select().from(spinsLog).where(eq(spinsLog.entryId, entryId));
    expect(logs.length).toBe(0);
  });

  it("bonus_coupon 发券填充 recipientEmail（docs/252 §2.3）", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    await seedCoupon(db, drawId, "invite");
    // email 身份分享者
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.tenantId, TENANT));
    expect(coupon?.status).toBe("issued");
    // recipientEmail 应填充为分享者邮箱（seedSharer 用 sharer-xxx@test.com）
    expect(coupon?.recipientEmail).toMatch(/@test\.com$/);
  });

  /**
   * docs/255 复审 A4：bonus_coupon 部分发放（码池不足）不得写"已发满"标记。
   *
   * 反例（修复前）：配置发 3 张、码池只有 1 张 → 发 1 张后写 rewardMilestonesGranted=["c1"]，
   * 运营补货后再也不会补发，运营承诺的 3 张永久只发出 1 张（静默少发）。
   *
   * 修复后：写部分标记 "c1:1"（已发张数），下次归因续发差额；
   * 发满 3 张后才写成整标记 "c1"，之后不再发放（不会超发）。
   */
  it("bonus_coupon 部分发放：码池不足时写部分标记，补货后续发差额且总量精确", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "3", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    await seedCoupon(db, drawId, "invite"); // 码池只有 1 张
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });
    const draw = { id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig };

    await processReferralRewardsEngine(db, draw, shareRecordId);

    // 只发出 1 张，标记为部分（不是整标记 "c1"）
    let issued = await db.select().from(couponCodes).where(eq(couponCodes.status, "issued"));
    expect(issued).toHaveLength(1);
    let [share] = await db.select().from(shareRecords).where(eq(shareRecords.id, shareRecordId));
    let marks = JSON.parse(share?.rewardMilestonesGranted || "[]") as string[];
    expect(marks).toContain("c1:1");
    expect(marks).not.toContain("c1");

    // 运营补 5 张货 → 下次归因只续发差额 2 张（总量 3，不超发）
    await seedCoupon(db, drawId, "invite");
    await seedCoupon(db, drawId, "invite");
    await seedCoupon(db, drawId, "invite");
    await seedCoupon(db, drawId, "invite");
    await seedCoupon(db, drawId, "invite");
    await processReferralRewardsEngine(db, draw, shareRecordId);

    issued = await db.select().from(couponCodes).where(eq(couponCodes.status, "issued"));
    expect(issued).toHaveLength(3);
    [share] = await db.select().from(shareRecords).where(eq(shareRecords.id, shareRecordId));
    marks = JSON.parse(share?.rewardMilestonesGranted || "[]") as string[];
    // 已发满 → 整标记，部分标记被替换
    expect(marks).toContain("c1");
    expect(marks).not.toContain("c1:3");

    // 第三次归因：已发满，不再发放
    await processReferralRewardsEngine(db, draw, shareRecordId);
    issued = await db.select().from(couponCodes).where(eq(couponCodes.status, "issued"));
    expect(issued).toHaveLength(3);
  });

  it("bonus_coupon 一次发满：直接写整标记，不留部分标记", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "c2", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    await seedCoupon(db, drawId, "invite");
    await seedCoupon(db, drawId, "invite");
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const issued = await db.select().from(couponCodes).where(eq(couponCodes.status, "issued"));
    expect(issued).toHaveLength(2);
    const [share] = await db.select().from(shareRecords).where(eq(shareRecords.id, shareRecordId));
    expect(JSON.parse(share?.rewardMilestonesGranted || "[]")).toEqual(["c2"]);
  });

  it("存量整标记（旧格式 rewardId）仍然生效：不因新增部分标记格式而重复发放", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "c3", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    await seedCoupon(db, drawId, "invite");
    await seedCoupon(db, drawId, "invite");
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });
    // 模拟存量数据：旧版本只写整标记
    await db.update(shareRecords)
      .set({ rewardMilestonesGranted: JSON.stringify(["c3"]) })
      .where(eq(shareRecords.id, shareRecordId));

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const issued = await db.select().from(couponCodes).where(eq(couponCodes.status, "issued"));
    expect(issued).toHaveLength(0);
  });

  it("码池全空：不写任何标记（保持可重试），补货后仍能足额发放", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "c4", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });
    const draw = { id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig };

    await processReferralRewardsEngine(db, draw, shareRecordId);
    const [share] = await db.select().from(shareRecords).where(eq(shareRecords.id, shareRecordId));
    expect(JSON.parse(share?.rewardMilestonesGranted || "[]")).toEqual([]);

    await seedCoupon(db, drawId, "invite");
    await seedCoupon(db, drawId, "invite");
    await processReferralRewardsEngine(db, draw, shareRecordId);
    const issued = await db.select().from(couponCodes).where(eq(couponCodes.status, "issued"));
    expect(issued).toHaveLength(2);
  });
});