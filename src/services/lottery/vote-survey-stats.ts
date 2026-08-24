/**
 * 投票/问卷结果统计服务（docs/267 P0）
 *
 * 从 activity_submissions 表读取 payloadJson，按字段/选项聚合统计。
 * 只读操作，不影响业务逻辑。
 *
 * 支持两种活动类型：
 * - vote（投票）：统计每个选项的投票数 + 百分比
 * - survey（问卷）：统计每个字段的答案分布
 */
import type { DbType } from "../../db/client";
import { eq, and } from "drizzle-orm";
import { activitySubmissions, lotteryDraws } from "../../db/schema";

/** 单个选项的统计结果 */
export interface OptionStat {
  /** 选项值（用户提交的答案） */
  option: string;
  /** 该选项的提交次数 */
  count: number;
  /** 该选项的百分比（0-100） */
  percentage: number;
}

/** 单个字段的统计结果 */
export interface FieldStat {
  /** 字段名（对应 activityConfig.fields 中的 key） */
  fieldName: string;
  /** 该字段的答案分布 */
  options: OptionStat[];
  /** 该字段的总提交数（含未填写） */
  totalResponses: number;
}

/** 投票/问卷统计的完整结果 */
export interface VoteSurveyStatsResult {
  /** 活动 ID */
  drawId: string;
  /** 活动类型：vote 或 survey */
  activityKind: "vote" | "survey";
  /** 总提交数 */
  totalSubmissions: number;
  /** 投票结果（vote 类型） */
  voteResults?: OptionStat[];
  /** 问卷结果（survey 类型）：按字段分组 */
  fieldResults?: FieldStat[];
  /** 原始提交数据（最近 N 条，用于管理端预览） */
  recentSubmissions?: Array<{
    entryId: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}

/**
 * 查询投票/问卷活动的结果统计。
 *
 * @param db - 数据库实例
 * @param tenantId - 租户 ID
 * @param drawId - 活动 ID
 * @param options.limit - 最近提交数限制（默认 20，最大 100）
 */
export async function getVoteSurveyStats(
  db: DbType,
  tenantId: string,
  drawId: string,
  options?: { limit?: number },
): Promise<VoteSurveyStatsResult> {
  // 1. 验证活动存在且类型正确
  const [draw] = await db
    .select({ activityKind: lotteryDraws.activityKind })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) {
    throw new Error("活动不存在");
  }

  const activityKind = draw.activityKind as "vote" | "survey";
  if (activityKind !== "vote" && activityKind !== "survey") {
    throw new Error("此活动不是投票或问卷类型");
  }

  // 2. 查询所有提交记录
  const submissions = await db
    .select({
      entryId: activitySubmissions.entryId,
      payloadJson: activitySubmissions.payloadJson,
      createdAt: activitySubmissions.createdAt,
    })
    .from(activitySubmissions)
    .where(and(
      eq(activitySubmissions.tenantId, tenantId),
      eq(activitySubmissions.drawId, drawId),
    ));

  const totalSubmissions = submissions.length;

  // 3. 解析 payloadJson 并聚合
  // vote 模式：answerCounts 直接存选项→次数
  // survey 模式：answerCounts 存 _field_xxx→JSON(Map 条目数组)
  const answerCounts = new Map<string, number | string>();

  for (const sub of submissions) {
    try {
      const payload = JSON.parse(sub.payloadJson || "{}");

      if (activityKind === "vote") {
        // 投票：payload 中第一个字段的值就是投票选项
        const values = Object.values(payload);
        if (values.length > 0) {
          const answer = String(values[0] || "").trim();
          if (answer) {
            answerCounts.set(answer, (Number(answerCounts.get(answer) || 0)) + 1);
          }
        }
      } else {
        // 问卷：按字段名分别统计
        for (const [key, value] of Object.entries(payload)) {
          const fieldKey = `_field_${key}`;
          const answer = String(value || "").trim();
          if (answer) {
            const existing = answerCounts.get(fieldKey);
            const fieldMap = new Map<string, number>(
              typeof existing === "string" ? JSON.parse(existing as string) : [],
            );
            fieldMap.set(answer, (fieldMap.get(answer) || 0) + 1);
            answerCounts.set(fieldKey, JSON.stringify([...fieldMap.entries()]));
          }
        }
      }
    } catch {
      // JSON 解析失败跳过该条记录
    }
  }

  // 4. 构建结果
  const recentLimit = Math.min(options?.limit ?? 20, 100);
  const recentSubmissions = submissions.slice(-recentLimit).map((sub) => ({
    entryId: sub.entryId,
    payload: (() => {
      try { return JSON.parse(sub.payloadJson || "{}"); } catch { return {}; }
    })(),
    createdAt: sub.createdAt,
  }));

  if (activityKind === "vote") {
    const voteResults = buildOptionStats(answerCounts, totalSubmissions);
    return {
      drawId,
      activityKind,
      totalSubmissions,
      voteResults,
      recentSubmissions,
    };
  } else {
    // survey：按字段分组
    const fieldResults: FieldStat[] = [];
    for (const [key, value] of answerCounts.entries()) {
      if (!key.startsWith("_field_")) continue;
      const fieldName = key.slice(7); // 去掉 "_field_" 前缀
      const entries: [string, number][] = JSON.parse(String(value || "[]"));
      const fieldMap = new Map(entries);
      const options = buildOptionStats(fieldMap, totalSubmissions);
      fieldResults.push({
        fieldName,
        options,
        totalResponses: entries.reduce((sum, [, count]) => sum + count, 0),
      });
    }
    return {
      drawId,
      activityKind,
      totalSubmissions,
      fieldResults,
      recentSubmissions,
    };
  }
}

/** 将 answerCounts Map 转换为 OptionStat 数组（按 count 降序） */
function buildOptionStats(
  counts: Map<string, number | string>,
  total: number,
): OptionStat[] {
  const stats: OptionStat[] = [];
  for (const [option, value] of counts) {
    const count = typeof value === "number" ? value : 0;
    stats.push({
      option,
      count,
      percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    });
  }
  stats.sort((a, b) => b.count - a.count);
  return stats;
}
