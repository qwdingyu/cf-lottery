/**
 * 同场裂变：额外次数与开奖加权（纯函数）
 *
 * 产品语义（docs/041 / docs/108）：
 * - extraEntriesPerInvite：每成功邀请 1 人，分享者在本场获得的额外加权票数
 * - maxExtraEntries：额外票数上限（不含基础 1 票）
 * - 开奖权重 = 1（基础参与）+ min(invited × perInvite, maxExtra)
 * - 不写入额外 lottery_entries：不占 maxParticipants，仅扩大 randomSelect 候选袋
 *
 * 为何抽成纯函数：开奖、my-viral-stats、发布预检、单测必须同一公式，
 * 避免「管理端配 2 次/人、开奖仍按 1 次/人」的静默不一致。
 */

export type ViralWeightConfig = {
  enabled?: boolean;
  extraEntriesPerInvite?: number;
  maxExtraEntries?: number;
  leaderboardEnabled?: boolean;
};

/**
 * 裂变是否启用（严格判定，P2 审查项）。
 *
 * 统一全项目对 viral.enabled 的判定：必须严格 === true 才视为启用。
 * 旧实现散落 truthy（"true"/1 字符串会被当成启用）与严格两种，行为不一致：
 * - grantViralSpinsToSharer / publish-check 用 truthy → enabled="true" 时裂变加次生效；
 * - isViralLeaderboardEnabled 严格 === true → 同一配置排行榜关闭（互相矛盾）。
 * 前端表单写入 boolean；手工 JSON 写字符串 "true" 属脏数据，统一按未启用处理，
 * 与 publish-check 的 enabled 幻值收敛（docs/220）同策略。
 */
export function isViralEnabled(viral?: { enabled?: unknown } | null): boolean {
  return viral?.enabled === true;
}

/** 归一化裂变数字配置（非法/缺省时给出安全默认，enabled 不在此改写） */
export function normalizeViralWeightNumbers(viral?: ViralWeightConfig | null): {
  extraEntriesPerInvite: number;
  maxExtraEntries: number;
} {
  const rawPer = Number(viral?.extraEntriesPerInvite);
  const rawMax = Number(viral?.maxExtraEntries);
  // 与 publish-check 一致：运营期望至少 1；运行时兜底避免 0/NaN 把权重算成 1 却无上限
  const extraEntriesPerInvite = Number.isFinite(rawPer) && rawPer > 0 ? Math.floor(rawPer) : 1;
  const maxExtraEntries = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 10;
  return { extraEntriesPerInvite, maxExtraEntries };
}

/**
 * 已赚取的「额外」加权票数（不含基础 1）。
 * invitedCount：有效邀请人数（shareRecords.joinedCount 聚合，非点击）。
 */
export function computeViralExtraEntries(
  invitedCount: number,
  extraEntriesPerInvite: number,
  maxExtraEntries: number,
): number {
  const invited = Math.max(0, Math.floor(Number(invitedCount) || 0));
  const per = Math.max(0, Math.floor(Number(extraEntriesPerInvite) || 0));
  const max = Math.max(0, Math.floor(Number(maxExtraEntries) || 0));
  if (invited <= 0 || per <= 0 || max <= 0) return 0;
  return Math.min(invited * per, max);
}

/**
 * 开奖袋中该参与者出现次数 = 1 + 额外票。
 * 同一人仍只能中一次（加权无放回抽样，见 weightedSampleUnique）。
 */
export function computeViralDrawWeight(
  invitedCount: number,
  extraEntriesPerInvite: number,
  maxExtraEntries: number,
): number {
  return 1 + computeViralExtraEntries(invitedCount, extraEntriesPerInvite, maxExtraEntries);
}

/**
 * 按权重无放回抽取唯一中奖者（docs/109）。
 *
 * 为何不用「扩袋 + randomSelect(n) 再去重」：
 * 扩袋后若只抽 n 个位置，高权重者可能占满 n 个槽，去重后名额不足
 * （例：2 人抽 2 奖，A 权重 10、B 权重 1 → 可能抽到 [A,A] → 只中 1 人）。
 *
 * 算法：每轮按当前剩余权重比例抽 1 人，抽中后移出池，直到满员或池空。
 * 公平性：权重 w 的相对中奖优势在「仍在池中」时保持 w 比例。
 *
 * @param items 候选（id 唯一）；weight 已含基础 1
 * @param count 需要的唯一中奖人数
 * @param random01 返回 [0,1) 的 CSPRNG 封装，便于单测注入
 */
export function weightedSampleUnique<T extends { id: string }>(
  items: Array<{ item: T; weight: number }>,
  count: number,
  random01: () => number,
): T[] {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n <= 0 || items.length === 0) return [];

  // 复制池；weight 至少 1，避免 0 权重永远抽不中也避免负权
  const pool = items
    .filter((row) => row?.item?.id)
    .map((row) => ({
      item: row.item,
      weight: Math.max(1, Math.floor(Number(row.weight) || 1)),
    }));

  const picked: T[] = [];
  const seen = new Set<string>();

  while (picked.length < n && pool.length > 0) {
    let total = 0;
    for (const row of pool) total += row.weight;
    if (total <= 0) break;

    // CSPRNG → [0, total)：用 total * u，u∈[0,1)
    let u = random01();
    if (!Number.isFinite(u) || u < 0) u = 0;
    if (u >= 1) u = 0.999999999999; // 避免边界卡在 total
    let r = u * total;

    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i]!.weight;
      if (r < 0) {
        idx = i;
        break;
      }
    }

    const chosen = pool[idx]!;
    pool.splice(idx, 1);
    if (seen.has(chosen.item.id)) continue;
    seen.add(chosen.item.id);
    picked.push(chosen.item);
  }

  return picked;
}

/**
 * 公开页分享链接路径（相对 origin）。
 * 统一 `/lottery/{slug}?ref=`，与前端 router path `/lottery/:slug` 一致；
 * 禁止 `/{slug}`（会落到非活动路由）或 ref 点击重定向丢参。
 */
export function buildPublicSharePath(slug: string, shareCode: string): string {
  const s = String(slug || "").trim();
  const code = String(shareCode || "").trim();
  if (!s || !code) return "";
  return `/lottery/${encodeURIComponent(s)}?ref=${encodeURIComponent(code)}`;
}

/**
 * 公开裂变排行榜是否应对外开放。
 *
 * 契约（docs/114，与管理端默认、ViralLeaderboard UI 对齐）：
 * - viral.enabled 必须为真，否则整段裂变关闭
 * - leaderboardEnabled 仅在显式 false 时关闭；缺省 / undefined 视为开启
 *
 * 禁止再用 `!viral.leaderboardEnabled`（会把缺省当成关，UI 请求 400）。
 */
export function isViralLeaderboardEnabled(viral?: ViralWeightConfig | null): boolean {
  if (!viral || viral.enabled !== true) return false;
  return viral.leaderboardEnabled !== false;
}

/**
 * 将 share_records 行聚合成 entryId → 有效邀请人数。
 * 同一 sharer 多条 shareCode 时 SUM(joinedCount)——与开奖 inviteMap、my-viral-stats 一致。
 * 不在此过滤 joined=0 行（聚合后为 0 的 entry 由 ranking 再丢弃）。
 */
export function aggregateViralInviteCounts(
  rows: ReadonlyArray<{ sharerEntryId: string; joinedCount: number | null | undefined }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const id = String(row?.sharerEntryId || "").trim();
    if (!id) continue;
    const n = Math.max(0, Math.floor(Number(row.joinedCount) || 0));
    map.set(id, (map.get(id) || 0) + n);
  }
  return map;
}

/**
 * 排行榜：由「entryId → 邀请人数」得到 Top N + 我的真实名次。
 * 名次必须在全量（invited>0）上计算，禁止在 slice(0,20) 后再找导致「未进 Top20 恒为 21」。
 */
export function buildViralLeaderboardRanking(
  inviteCounts: Map<string, number> | Record<string, number>,
  options?: { entryId?: string; topN?: number },
): {
  entries: Array<{ rank: number; entryId: string; invitedCount: number }>;
  myRank: { rank: number; invitedCount: number } | null;
} {
  const topN = Math.max(1, Math.floor(options?.topN ?? 20));
  const entryId = String(options?.entryId || "").trim();

  const pairs: Array<[string, number]> = [];
  if (inviteCounts instanceof Map) {
    for (const [id, count] of inviteCounts) {
      const c = Math.max(0, Math.floor(Number(count) || 0));
      if (c > 0) pairs.push([id, c]);
    }
  } else {
    for (const [id, count] of Object.entries(inviteCounts)) {
      const c = Math.max(0, Math.floor(Number(count) || 0));
      if (c > 0) pairs.push([id, c]);
    }
  }

  // 邀请人数降序；同票按 entryId 稳定排序，避免刷新乱跳
  pairs.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const entries = pairs.slice(0, topN).map(([id, count], index) => ({
    rank: index + 1,
    entryId: id,
    invitedCount: count,
  }));

  let myRank: { rank: number; invitedCount: number } | null = null;
  if (entryId) {
    const myCount = inviteCounts instanceof Map
      ? (inviteCounts.get(entryId) || 0)
      : (Number((inviteCounts as Record<string, number>)[entryId]) || 0);
    const invited = Math.max(0, Math.floor(Number(myCount) || 0));
    if (invited > 0) {
      const rankIndex = pairs.findIndex(([id]) => id === entryId);
      myRank = {
        rank: rankIndex >= 0 ? rankIndex + 1 : pairs.length + 1,
        invitedCount: invited,
      };
    } else {
      // 已参与但 0 邀请：诚实返回，前端展示「尚未上榜」而非隐藏
      myRank = { rank: 0, invitedCount: 0 };
    }
  }

  return { entries, myRank };
}
