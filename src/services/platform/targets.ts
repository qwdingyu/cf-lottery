/**
 * 平台目标绑定读取（docs/167）。
 *
 * 入站消息先通过 platform + targetId 找到租户与当前活动，再进入内置命令服务。
 * 未绑定目标不写业务表，避免脏数据进入参与/分享/开奖模型。
 */
import { and, eq } from "drizzle-orm";
import type { DbType } from "../../db/client";
import { platformTargets } from "../../db/schema";
import { parseStoredCheckinPolicy } from "./checkin-reward";
import {
  DEFAULT_BUILTIN_COMMANDS,
  type AdapterDeploymentMode,
  type BuiltinCommandConfig,
  type PlatformTargetBinding,
  type PlatformType,
} from "./types";

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === "0") return false;
  if (value === 1 || value === "1") return true;
  return fallback;
}

export function parseBuiltinCommandConfig(raw: string | null | undefined): BuiltinCommandConfig {
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object") parsed = value as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  const purchase = parsed.purchaseConfig && typeof parsed.purchaseConfig === "object"
    ? parsed.purchaseConfig as Record<string, unknown>
    : undefined;

  return {
    checkinEnabled: asBoolean(parsed.checkinEnabled, DEFAULT_BUILTIN_COMMANDS.checkinEnabled),
    spinEnabled: asBoolean(parsed.spinEnabled, DEFAULT_BUILTIN_COMMANDS.spinEnabled),
    shareEnabled: asBoolean(parsed.shareEnabled, DEFAULT_BUILTIN_COMMANDS.shareEnabled),
    leaderboardEnabled: asBoolean(parsed.leaderboardEnabled, DEFAULT_BUILTIN_COMMANDS.leaderboardEnabled),
    myPrizeEnabled: asBoolean(parsed.myPrizeEnabled, DEFAULT_BUILTIN_COMMANDS.myPrizeEnabled),
    myCardCodeEnabled: asBoolean(parsed.myCardCodeEnabled, DEFAULT_BUILTIN_COMMANDS.myCardCodeEnabled),
    helpEnabled: asBoolean(parsed.helpEnabled, DEFAULT_BUILTIN_COMMANDS.helpEnabled),
    flashEnabled: asBoolean(parsed.flashEnabled, DEFAULT_BUILTIN_COMMANDS.flashEnabled),
    // 签到奖励配置：使用 checkin-reward 的 parseStoredCheckinPolicy 统一解析
    ...(parsed.dailyCheckinPolicy && typeof parsed.dailyCheckinPolicy === "object"
      ? (() => {
          const policy = parseStoredCheckinPolicy(parsed.dailyCheckinPolicy);
          return policy ? { dailyCheckinPolicy: policy } : {};
        })()
      : {}),
    ...(parsed.replyOverrides && typeof parsed.replyOverrides === "object"
      ? { replyOverrides: parsed.replyOverrides as Record<string, string> }
      : {}),
    ...(purchase && typeof purchase.url === "string" && purchase.url.trim()
      ? {
        purchaseConfig: {
          url: String(purchase.url).trim(),
          // label 清洗：null/undefined/空串/纯空白 → 回退默认文案「立即购买」。
          // 与 admin API parseBuiltinCommandsInput 的语义一致，防止直接写库时 label 恒为空串。
          label: String(purchase.label || "").trim() || "立即购买",
        },
      }
      : {}),
  };
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeDeploymentMode(value: string): AdapterDeploymentMode {
  return value === "managed" ? "managed" : "tenant_hosted";
}

export async function getActivePlatformTarget(
  db: DbType,
  input: { platform: PlatformType; targetId: string },
): Promise<PlatformTargetBinding | null> {
  const [row] = await db
    .select()
    .from(platformTargets)
    .where(and(
      eq(platformTargets.platform, input.platform),
      eq(platformTargets.targetId, input.targetId),
    ))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    platform: row.platform as PlatformType,
    targetId: row.targetId,
    targetName: row.targetName,
    activeDrawId: row.activeDrawId,
    activePublicSlug: row.activePublicSlug,
    assistantEnabled: row.assistantEnabled === 1,
    adapterDeploymentMode: normalizeDeploymentMode(row.adapterDeploymentMode),
    // 适配器提供方：QQ 目标存储 "napcat"，Telegram 等平台可不设置或存储其他值
    // 业务逻辑使用 platform 字段选择适配器，adapterProvider 仅用于配置展示
    adapterProvider: row.adapterProvider || "",
    adapterConfig: parseJsonObject(row.adapterConfigJson),
    inboundSecretHash: row.inboundSecretHash || "",
    builtinCommands: parseBuiltinCommandConfig(row.builtinCommandsJson),
  };
}
