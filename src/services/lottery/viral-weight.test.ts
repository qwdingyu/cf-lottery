import { describe, expect, it } from "vitest";
import {
  buildPublicSharePath,
  buildViralLeaderboardRanking,
  computeViralDrawWeight,
  computeViralExtraEntries,
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
});
