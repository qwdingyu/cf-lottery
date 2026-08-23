/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateViralInviteCounts,
  buildPublicSharePath,
  buildViralLeaderboardRanking,
  compareViralLeaderboard,
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

/**
 * docs/255 §8 P2-4 守卫：`viral.enabled` 的判定必须只有一份实现。
 *
 * 该项在 docs/255 §12 里被标记为已完成，但实际只收敛了 publish-check 一处，
 * draw-execution / my-viral-stats 仍是 truthy、platform/commands 另有一份本地副本，
 * 结果同一份 `promotionConfig`（`enabled: "true"`）在开奖、统计、排行榜之间行为不一致。
 * 单测无法覆盖「未来新增的第 N 处调用点」，因此用源码扫描把规则钉住。
 */
describe("viral.enabled 单一入口守卫（源码扫描）", () => {
  const SRC_DIR = join(process.cwd(), "src");
  const OWNER_FILE = join("src", "services", "lottery", "viral-weight.ts");

  function listSourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const fullPath = join(dir, name);
      if (statSync(fullPath).isDirectory()) {
        listSourceFiles(fullPath, out);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".d.ts") || name.includes(".test.")) continue;
      out.push(fullPath);
    }
    return out;
  }

  /** 去掉行注释/块注释与字符串，避免文档说明里的 `viral.enabled` 被误判 */
  function stripCommentsAndStrings(content: string): string {
    return content
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  }

  it("除 viral-weight.ts 外，不得出现 viral.enabled 的 truthy 判定", () => {
    // 允许 `=== true` / `!== true`（与公共实现同义的显式比较）；
    // 其余形态（`if (viral?.enabled)`、`Boolean(viral.enabled)`、`!viral?.enabled`）一律违规。
    const truthyUse = /viral\??\.enabled(?!\s*(?:===|!==)\s*true)/;
    const violations: string[] = [];

    for (const file of listSourceFiles(SRC_DIR)) {
      const rel = relative(process.cwd(), file);
      if (rel === OWNER_FILE) continue;
      const code = stripCommentsAndStrings(readFileSync(file, "utf-8"));
      for (const line of code.split("\n")) {
        if (truthyUse.test(line)) violations.push(`${rel}: ${line.trim()}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("除 viral-weight.ts 外，不得重复定义 isViralEnabled / isViralLeaderboardEnabled", () => {
    const redefinition = /(?:function|const)\s+(?:isViralEnabled|isViralLeaderboardEnabled)\b/;
    const violations: string[] = [];

    for (const file of listSourceFiles(SRC_DIR)) {
      const rel = relative(process.cwd(), file);
      if (rel === OWNER_FILE) continue;
      const code = stripCommentsAndStrings(readFileSync(file, "utf-8"));
      if (redefinition.test(code)) violations.push(rel);
    }

    expect(violations).toEqual([]);
  });
});

describe("compareViralLeaderboard tie-break 统一（P0 修复 2026-08-23）", () => {
  it("邀请人数不同时，高邀请者排前面", () => {
    expect(compareViralLeaderboard(5, 3)).toBeLessThan(0);
    expect(compareViralLeaderboard(3, 5)).toBeGreaterThan(0);
  });

  it("同票时先到先得（firstSharedAt 升序）", () => {
    // A 先分享（时间早），B 后分享 → A 排前面（返回负数表示 A 在 B 前）
    expect(compareViralLeaderboard(3, 3, "2026-01-01T10:00:00Z", "2026-01-02T10:00:00Z")).toBeLessThan(0);
    // 反过来
    expect(compareViralLeaderboard(3, 3, "2026-01-02T10:00:00Z", "2026-01-01T10:00:00Z")).toBeGreaterThan(0);
    // 同时分享 → tie-break 退回到 entryId 字典序
    expect(compareViralLeaderboard(3, 3, "2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z", "entry-b", "entry-a")).toBeGreaterThan(0);
  });

  it("firstSharedAt 缺省时退回 entryId 字典序兜底", () => {
    expect(compareViralLeaderboard(3, 3, undefined, undefined, "entry-a", "entry-b")).toBeLessThan(0);
    expect(compareViralLeaderboard(3, 3, "", "", "entry-z", "entry-a")).toBeGreaterThan(0);
  });

  it("完全相同时返回 0", () => {
    expect(compareViralLeaderboard(5, 5, "2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z", "x", "x")).toBe(0);
  });
});
