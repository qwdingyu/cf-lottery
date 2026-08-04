import { describe, expect, it } from "vitest";
import {
  buildPublicSharePath,
  computeViralDrawWeight,
  computeViralExtraEntries,
  normalizeViralWeightNumbers,
} from "./viral-weight";

describe("viral-weight 同场额外次数 / 开奖加权", () => {
  it("extra = min(invited × perInvite, max)，默认 per=1 时与旧行为兼容", () => {
    expect(computeViralExtraEntries(0, 1, 10)).toBe(0);
    expect(computeViralExtraEntries(3, 1, 10)).toBe(3);
    expect(computeViralExtraEntries(15, 1, 10)).toBe(10);
  });

  it("perInvite>1 时按倍数累加再封顶", () => {
    // 邀请 2 人 × 每邀 3 次 = 6，上限 10 → 6
    expect(computeViralExtraEntries(2, 3, 10)).toBe(6);
    // 邀请 5 人 × 2 = 10，上限 8 → 8
    expect(computeViralExtraEntries(5, 2, 8)).toBe(8);
    // 邀请 1 人 × 5，上限 3 → 3
    expect(computeViralExtraEntries(1, 5, 3)).toBe(3);
  });

  it("开奖权重 = 1 + extra（无人邀请仍为 1）", () => {
    expect(computeViralDrawWeight(0, 2, 10)).toBe(1);
    expect(computeViralDrawWeight(2, 2, 10)).toBe(5); // 1 + 4
    expect(computeViralDrawWeight(100, 2, 3)).toBe(4); // 1 + 3
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
