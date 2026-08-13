import { describe, expect, it } from "vitest";
import {
  aggregateViralInviteCounts,
  buildPublicSharePath,
  buildViralLeaderboardRanking,
  computeViralDrawWeight,
  computeViralExtraEntries,
  isViralEnabled,
  isViralLeaderboardEnabled,
  normalizeViralWeightNumbers,
  weightedSampleUnique,
} from "./viral-weight";

describe("viral-weight 同场额外次数 / 开奖加权", () => {
  it("extra = min(invited × perInvite, max)，默认 per=1 时与旧行为兼容", () => {
    expect(computeViralExtraEntries(0, 1, 10)).toBe(0);
    expect(computeViralExtraEntries(3, 1, 10)).toBe(3);
    expect(computeViralExtraEntries(15, 1, 10)).toBe(10);
  });

  it("perInvite>1 时按倍数累加再封顶", () => {
    expect(computeViralExtraEntries(2, 3, 10)).toBe(6);
    expect(computeViralExtraEntries(5, 2, 8)).toBe(8);
    expect(computeViralExtraEntries(1, 5, 3)).toBe(3);
  });

  it("开奖权重 = 1 + extra（无人邀请仍为 1）", () => {
    expect(computeViralDrawWeight(0, 2, 10)).toBe(1);
    expect(computeViralDrawWeight(2, 2, 10)).toBe(5);
    expect(computeViralDrawWeight(100, 2, 3)).toBe(4);
  });

  it("非法输入安全归零 extra，不抛错", () => {
    expect(computeViralExtraEntries(NaN, 1, 10)).toBe(0);
    expect(computeViralExtraEntries(2, 0, 10)).toBe(0);
    expect(computeViralExtraEntries(2, 1, 0)).toBe(0);
    expect(computeViralExtraEntries(-1, 2, 10)).toBe(0);
  });

  it("normalize 缺省与非法值", () => {
    expect(normalizeViralWeightNumbers(undefined)).toEqual({
      extraEntriesPerInvite: 1,
      maxExtraEntries: 10,
    });
    expect(normalizeViralWeightNumbers({ extraEntriesPerInvite: 0, maxExtraEntries: -5 })).toEqual({
      extraEntriesPerInvite: 1,
      maxExtraEntries: 10,
    });
    expect(normalizeViralWeightNumbers({ extraEntriesPerInvite: 2.9, maxExtraEntries: 7.1 })).toEqual({
      extraEntriesPerInvite: 2,
      maxExtraEntries: 7,
    });
  });

  it("分享路径统一 /lottery/slug?ref=code", () => {
    expect(buildPublicSharePath("abc", "ref01")).toBe("/lottery/abc?ref=ref01");
    expect(buildPublicSharePath("", "x")).toBe("");
    expect(buildPublicSharePath("s", "")).toBe("");
  });
});

describe("weightedSampleUnique 无放回加权（docs/109）", () => {
  it("高权重一人时仍能抽满名额（不会扩袋去重后只中 1 人）", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    // 确定性：始终落在第一段 → 先抽 A；第二轮只剩 B
    let calls = 0;
    const random01 = () => {
      calls += 1;
      return 0; // 总是选池中第一个
    };
    const picked = weightedSampleUnique(
      [
        { item: a, weight: 10 },
        { item: b, weight: 1 },
      ],
      2,
      random01,
    );
    expect(picked).toHaveLength(2);
    expect(new Set(picked.map((p) => p.id)).size).toBe(2);
    expect(calls).toBe(2);
  });

  it("count 大于候选人数时返回全部唯一 id", () => {
    const items = [
      { item: { id: "1" }, weight: 1 },
      { item: { id: "2" }, weight: 1 },
    ];
    const picked = weightedSampleUnique(items, 99, () => 0.5);
    expect(picked).toHaveLength(2);
    expect(new Set(picked.map((p) => p.id)).size).toBe(2);
  });

  it("空池或 count=0 返回 []", () => {
    expect(weightedSampleUnique([], 3, () => 0.1)).toEqual([]);
    expect(weightedSampleUnique([{ item: { id: "x" }, weight: 1 }], 0, () => 0.1)).toEqual([]);
  });
});

describe("isViralLeaderboardEnabled 门禁（docs/114）", () => {
  it("enabled 未开 → 关", () => {
    expect(isViralLeaderboardEnabled(undefined)).toBe(false);
    expect(isViralLeaderboardEnabled(null)).toBe(false);
    expect(isViralLeaderboardEnabled({ enabled: false, leaderboardEnabled: true })).toBe(false);
    expect(isViralLeaderboardEnabled({ leaderboardEnabled: true })).toBe(false);
  });

  it("enabled 开 + leaderboard 缺省 / true → 开；显式 false → 关", () => {
    expect(isViralLeaderboardEnabled({ enabled: true })).toBe(true);
    expect(isViralLeaderboardEnabled({ enabled: true, leaderboardEnabled: true })).toBe(true);
    expect(isViralLeaderboardEnabled({ enabled: true, leaderboardEnabled: false })).toBe(false);
  });
});

describe("aggregateViralInviteCounts 多码 SUM（榜=开奖）", () => {
  it("同一 sharer 多条 share 行累加 joinedCount", () => {
    const map = aggregateViralInviteCounts([
      { sharerEntryId: "a", joinedCount: 2 },
      { sharerEntryId: "a", joinedCount: 3 },
      { sharerEntryId: "b", joinedCount: 1 },
    ]);
    expect(map.get("a")).toBe(5);
    expect(map.get("b")).toBe(1);
  });

  it("空 id / 非法 count 不污染", () => {
    const map = aggregateViralInviteCounts([
      { sharerEntryId: "", joinedCount: 9 },
      { sharerEntryId: "  ", joinedCount: 9 },
      { sharerEntryId: "c", joinedCount: null },
      { sharerEntryId: "c", joinedCount: -2 },
      { sharerEntryId: "c", joinedCount: 1.9 },
    ]);
    expect(map.has("")).toBe(false);
    expect(map.get("c")).toBe(1); // floor(1.9)+0+0
  });
});

describe("buildViralLeaderboardRanking 真实名次（docs/109）", () => {
  it("Top N 截断后 myRank 仍是全量名次而非恒 21", () => {
    const map = new Map<string, number>();
    for (let i = 1; i <= 25; i++) {
      map.set(`e${i}`, 100 - i); // e1 最高
    }
    const { entries, myRank } = buildViralLeaderboardRanking(map, {
      entryId: "e25",
      topN: 20,
    });
    expect(entries).toHaveLength(20);
    expect(entries[0]!.entryId).toBe("e1");
    expect(myRank).toEqual({ rank: 25, invitedCount: 75 });
  });

  it("0 邀请诚实 rank=0", () => {
    const map = new Map([["a", 3]]);
    const { myRank } = buildViralLeaderboardRanking(map, { entryId: "nobody" });
    expect(myRank).toEqual({ rank: 0, invitedCount: 0 });
  });

  it("无 entryId 时 myRank 为 null", () => {
    const { myRank } = buildViralLeaderboardRanking(new Map([["a", 1]]));
    expect(myRank).toBeNull();
  });

  it("joined=0 的 entry 不进 Top 列表", () => {
    const map = new Map([
      ["alive", 2],
      ["ghost", 0],
    ]);
    const { entries, myRank } = buildViralLeaderboardRanking(map, { entryId: "ghost" });
    expect(entries.map((e) => e.entryId)).toEqual(["alive"]);
    expect(myRank).toEqual({ rank: 0, invitedCount: 0 });
  });

  it("同票按 entryId 字典序稳定，刷新不乱跳", () => {
    const map = new Map([
      ["z-user", 5],
      ["a-user", 5],
      ["m-user", 5],
    ]);
    const { entries } = buildViralLeaderboardRanking(map, { topN: 10 });
    expect(entries.map((e) => e.entryId)).toEqual(["a-user", "m-user", "z-user"]);
    expect(entries.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it("支持 Record 输入且与 Map 结果一致", () => {
    const asMap = buildViralLeaderboardRanking(new Map([["x", 3], ["y", 1]]), { entryId: "x" });
    const asRec = buildViralLeaderboardRanking({ x: 3, y: 1 }, { entryId: "x" });
    expect(asRec).toEqual(asMap);
  });

  it("聚合后再排名：多码 SUM 后名次用合计", () => {
    const agg = aggregateViralInviteCounts([
      { sharerEntryId: "p1", joinedCount: 1 },
      { sharerEntryId: "p1", joinedCount: 4 },
      { sharerEntryId: "p2", joinedCount: 3 },
    ]);
    const { entries, myRank } = buildViralLeaderboardRanking(agg, { entryId: "p1", topN: 10 });
    expect(entries[0]).toEqual({ rank: 1, entryId: "p1", invitedCount: 5 });
    expect(entries[1]).toEqual({ rank: 2, entryId: "p2", invitedCount: 3 });
    expect(myRank).toEqual({ rank: 1, invitedCount: 5 });
  });

  it("空聚合 + 带 entryId → 空榜 + myRank rank=0（与 HTTP 空榜契约一致）", () => {
    const { entries, myRank } = buildViralLeaderboardRanking(new Map(), {
      entryId: "lonely",
      topN: 20,
    });
    expect(entries).toEqual([]);
    expect(myRank).toEqual({ rank: 0, invitedCount: 0 });
  });

  it("topN 非法时至少 1；密集名次无并列并列号", () => {
    const map = new Map([
      ["a", 10],
      ["b", 10],
    ]);
    const { entries } = buildViralLeaderboardRanking(map, { topN: 0 });
    // topN 被夹到 ≥1，同票按 entryId 序只保证稳定，名次为 1..n 密集
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.rank).toBe(1);
    const full = buildViralLeaderboardRanking(map, { topN: 10 });
    expect(full.entries.map((e) => e.rank)).toEqual([1, 2]);
    expect(full.entries.map((e) => e.entryId)).toEqual(["a", "b"]);
  });
});

// P2 审查项：viral.enabled 幻值统一（严格 ===true，字符串 "true" 不视为启用）
describe("isViralEnabled 严格判定（P2 审查修复）", () => {
  it("enabled===true 才启用；布尔 false / 缺省 / 字符串 'true' / 数字 1 均视为未启用", () => {
    expect(isViralEnabled({ enabled: true })).toBe(true);
    expect(isViralEnabled({ enabled: false })).toBe(false);
    expect(isViralEnabled({})).toBe(false);
    expect(isViralEnabled(undefined)).toBe(false);
    expect(isViralEnabled(null)).toBe(false);
    // 幻值：手工 JSON 写字符串/数字（前端表单写入 boolean，脏数据按未启用处理）
    expect(isViralEnabled({ enabled: "true" })).toBe(false);
    expect(isViralEnabled({ enabled: 1 })).toBe(false);
  });
});
