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
 * 同一人仍只能中一次（performDraw 内 seenEntryIds 去重）。
 */
export function computeViralDrawWeight(
  invitedCount: number,
  extraEntriesPerInvite: number,
  maxExtraEntries: number,
): number {
  return 1 + computeViralExtraEntries(invitedCount, extraEntriesPerInvite, maxExtraEntries);
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
