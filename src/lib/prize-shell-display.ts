/**
 * 公开游戏壳奖品展示策略（docs/128）
 *
 * 行业与项目铁律：
 * - 体验壳 ≠ 结果机（docs/115）：delayed 随机停格不得暗示「中了该奖」
 * - instant 必须能用真奖名/图对准 prizeIndex（docs/116）
 * - 个人中奖结果：delayed 开奖前不可知；奖池目录是否公示是运营策略
 *
 * 默认（最佳实践）：
 * - instant → 壳用真实奖品（full_on_shell）
 * - manual/scheduled → 壳用仪式短语（shell_ritual），奖池条仍可 full 公示目录
 *
 * 配置落在 promotion_config.experience，不新增列，避免迁移风险。
 */

export type PrizePanelMode =
  | "auto"
  | "full_on_shell"
  | "shell_ritual_pool_full"
  | "shell_ritual_pool_summary"
  | "ritual_only";

export type ResolvedPrizePanelMode =
  | "full_on_shell"
  | "shell_ritual_pool_full"
  | "shell_ritual_pool_summary"
  | "ritual_only";

/**
 * 默认中性四字/短语：互动氛围，禁止默认成「中奖/一等奖」。
 * 与 frontend/src/views/lottery/prize-shell-display.ts 同步的副本——修改需两处一起改。
 */
export const DEFAULT_RITUAL_PHRASES: readonly string[] = [
  "好运连连",
  "感谢参与",
  "期待开奖",
  "好运加持",
  "参与有礼",
  "开奖见分晓",
  "幸运星",
  "再接再厉",
] as const;

const MAX_PHRASE_LEN = 8;
const MAX_PHRASE_COUNT = 16;

/**
 * 明显像「已中奖/奖档」的词，拒绝写入仪式短语（防运营误配造成语义灾难）。
 * 三份同步副本：src/lib（本文件）/ frontend/src/views/lottery 副本 /
 * growth-config.ts 管理端保存前清洗。修改必须三处一起改——单测各自锁副本，无法发现漂移。
 */
const FORBIDDEN_RITUAL_SUBSTRINGS = [
  "中奖",
  "一等奖",
  "二等奖",
  "三等奖",
  "特等奖",
  "大奖",
  "奖品是",
  "已中",
  "恭喜获得",
];

export function isInstantLotteryResultMode(resultMode: string | null | undefined): boolean {
  return (
    String(resultMode || "")
      .trim()
      .toLowerCase() === "instant"
  );
}

/**
 * 清洗运营配置的仪式短语：去空白、截断、去重、拒收危险语义。
 * 全部非法时返回 []（调用方用 DEFAULT_RITUAL_PHRASES）。
 */
export function sanitizeRitualPhrases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_PHRASE_COUNT) break;
    const s = String(item ?? "")
      .replace(/\s+/g, "")
      .trim();
    if (!s) continue;
    const clipped = s.slice(0, MAX_PHRASE_LEN);
    if (seen.has(clipped)) continue;
    if (FORBIDDEN_RITUAL_SUBSTRINGS.some((bad) => clipped.includes(bad))) continue;
    seen.add(clipped);
    out.push(clipped);
  }
  return out;
}

export function parseExperienceShellConfig(promotionConfig: unknown): {
  prizePanelMode: PrizePanelMode;
  ritualPhrases: string[];
} {
  let root: Record<string, unknown> | null = null;
  if (promotionConfig && typeof promotionConfig === "object" && !Array.isArray(promotionConfig)) {
    root = promotionConfig as Record<string, unknown>;
  } else if (typeof promotionConfig === "string" && promotionConfig.trim() && promotionConfig !== "{}") {
    try {
      const parsed = JSON.parse(promotionConfig) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      root = null;
    }
  }

  const experience =
    root?.experience && typeof root.experience === "object" && !Array.isArray(root.experience)
      ? (root.experience as Record<string, unknown>)
      : null;

  const modeRaw = String(experience?.prizePanelMode || experience?.prize_panel_mode || "auto")
    .trim()
    .toLowerCase();
  const allowed: PrizePanelMode[] = [
    "auto",
    "full_on_shell",
    "shell_ritual_pool_full",
    "shell_ritual_pool_summary",
    "ritual_only",
  ];
  const prizePanelMode = (allowed.includes(modeRaw as PrizePanelMode)
    ? modeRaw
    : "auto") as PrizePanelMode;

  return {
    prizePanelMode,
    ritualPhrases: sanitizeRitualPhrases(experience?.ritualPhrases ?? experience?.ritual_phrases),
  };
}

/**
 * 解析最终面板模式（auto 按 result_mode 展开）。
 * drawn 后仍尊重 ritual_only / summary；不因 drawn 强行 full_on_shell（避免历史配置突变）。
 */
export function resolvePrizePanelMode(
  resultMode: string | null | undefined,
  configured: PrizePanelMode = "auto",
): ResolvedPrizePanelMode {
  if (configured !== "auto") return configured;
  if (isInstantLotteryResultMode(resultMode)) return "full_on_shell";
  // delayed 与其它非 instant：壳仪式 + 奖池条完整公示（信任）
  return "shell_ritual_pool_full";
}

export function shellUsesRealPrizes(mode: ResolvedPrizePanelMode): boolean {
  return mode === "full_on_shell";
}

export function showPrizePoolStrip(mode: ResolvedPrizePanelMode): "full" | "summary" | "hidden" {
  if (mode === "ritual_only") return "hidden";
  if (mode === "shell_ritual_pool_summary") return "summary";
  return "full";
}

/**
 * 生成壳上展示用标签（扇面/卷轴格）。
 * - full_on_shell：用奖品名
 * - 其余：仪式短语（配置优先，否则默认）
 *
 * 索引对齐不变量（docs/128）：调用方保证 prizeNames 与 prizes 数组一一对应——
 * tierName 保存时三级兜底（`奖项 N` → 公开 API `name || tierName`）恒非空，
 * full_on_shell 标签第 i 项 ↔ prizes[i]，与 instant spin.prizeIndex 停扇对齐（docs/116）。
 * 不要在此过滤空名后重新索引（会破坏扇区与奖的对应）。
 */
export function buildShellLabels(input: {
  mode: ResolvedPrizePanelMode;
  prizeNames: Array<string | null | undefined>;
  ritualPhrases?: string[];
  /** 至少几格（转盘扇区数）；0 表示按奖品数或短语数 */
  minSlots?: number;
}): string[] {
  const minSlots = Math.max(0, Math.floor(Number(input.minSlots) || 0));
  if (shellUsesRealPrizes(input.mode)) {
    const names = input.prizeNames
      .map((n) => String(n || "").trim())
      .filter(Boolean);
    if (names.length === 0) {
      // instant 无奖品时仍给中性占位，避免空白盘；不写「中奖」
      return padLabels(["谢谢参与"], Math.max(minSlots, 4));
    }
    return padLabels(names, minSlots);
  }

  const phrases =
    input.ritualPhrases && input.ritualPhrases.length > 0
      ? input.ritualPhrases
      : [...DEFAULT_RITUAL_PHRASES];
  const slotCount = Math.max(minSlots, input.prizeNames.filter((n) => String(n || "").trim()).length, phrases.length, 4);
  return padLabels(phrases, slotCount);
}

function padLabels(source: string[], minSlots: number): string[] {
  if (source.length === 0) return [...DEFAULT_RITUAL_PHRASES].slice(0, Math.max(minSlots, 4));
  if (minSlots <= source.length) return source.slice();
  const out: string[] = [];
  for (let i = 0; i < minSlots; i++) {
    out.push(source[i % source.length]!);
  }
  return out;
}

/**
 * 公开 API 组装：壳标签 + 是否真奖上壳 + 奖池条策略。
 * prizes 原列表仍返回（instant 停扇 / 管理信任）；壳展示以 shellLabels 为准。
 */
export function buildPublicPrizeShellPayload(input: {
  resultMode: string | null | undefined;
  promotionConfig: unknown;
  prizes: Array<{
    name?: string | null;
    tierName?: string | null;
    winnerCount?: number | null;
  }>;
}): {
  prizePanelMode: ResolvedPrizePanelMode;
  shellLabels: string[];
  shellUsesRealPrizes: boolean;
  prizePoolDisplay: "full" | "summary" | "hidden";
} {
  const cfg = parseExperienceShellConfig(input.promotionConfig);
  const mode = resolvePrizePanelMode(input.resultMode, cfg.prizePanelMode);
  const prizeNames = input.prizes.map((p) => p.name || p.tierName || "");
  const shellLabels = buildShellLabels({
    mode,
    prizeNames,
    ritualPhrases: cfg.ritualPhrases,
    minSlots: Math.max(prizeNames.filter(Boolean).length, 0),
  });
  return {
    prizePanelMode: mode,
    shellLabels,
    shellUsesRealPrizes: shellUsesRealPrizes(mode),
    prizePoolDisplay: showPrizePoolStrip(mode),
  };
}
