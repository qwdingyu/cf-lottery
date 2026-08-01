import { inArray } from "drizzle-orm";
import type { DbType } from "../db/client";
import { systemConfig } from "../db/schema";
import definitions from "./system-config-definitions.json";

export type SystemConfigValueType = "string" | "integer" | "boolean";

/** integer 存储单位；cents 表示后台 UI 按「元」编辑、库内仍是分 */
export type SystemConfigIntegerUnit = "cents" | "count";

export type SystemConfigDefinition = {
  key: string;
  label: string;
  description: string;
  effect: string;
  scope: "public" | "admin";
  type: SystemConfigValueType;
  /** 仅 type=integer：cents=金额（分存储，Admin 按元展示）；count/缺省=纯整数 */
  unit?: SystemConfigIntegerUnit;
  sensitive?: boolean;
  configured?: boolean;
  defaultValue: string;
  format?: "email";
  maxLength?: number;
  /** type=integer 时与存储单位一致（cents 时为分） */
  min?: number;
  max?: number;
  group?: string;
  order?: number;
};

export const SYSTEM_CONFIG_DEFINITIONS = definitions as readonly SystemConfigDefinition[];

export type SupportedSystemConfigKey = typeof SYSTEM_CONFIG_DEFINITIONS[number]["key"];

const definitionByKey = new Map<string, SystemConfigDefinition>(
  SYSTEM_CONFIG_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export const SYSTEM_CONFIG_KEYS = SYSTEM_CONFIG_DEFINITIONS.map((definition) => definition.key);
export const PUBLIC_SYSTEM_CONFIG_KEYS = SYSTEM_CONFIG_DEFINITIONS
  .filter((definition) => definition.scope === "public")
  .map((definition) => definition.key);
const systemConfigKeySet = new Set<string>(SYSTEM_CONFIG_KEYS);

export function getSystemConfigDefinition(key: string): SystemConfigDefinition | undefined {
  return definitionByKey.get(key);
}

export function isSupportedSystemConfigKey(key: string): key is SupportedSystemConfigKey {
  return definitionByKey.has(key);
}

export function isSensitiveSystemConfigKey(key: string): boolean {
  return Boolean(getSystemConfigDefinition(key)?.sensitive);
}

/** unit=cents 的 min/max 以分存储，错误提示按元展示（CNY 两位小数） */
function formatCentsBoundForMessage(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

export function normalizeSystemConfigValue(key: string, value: string): { ok: true; value: string } | { ok: false; message: string } {
  const definition = getSystemConfigDefinition(key);
  if (!definition) {
    return { ok: false, message: `系统参数 "${key}" 未注册，保存后不会被业务代码读取，已拒绝写入` };
  }

  const trimmed = value.trim();
  if (definition.type === "boolean") {
    if (trimmed !== "true" && trimmed !== "false") {
      return { ok: false, message: `${definition.label} 只能填写 true 或 false` };
    }
    return { ok: true, value: trimmed };
  }

  if (definition.type === "integer") {
    if (!/^-?\d+$/.test(trimmed)) {
      // unit=cents：API/库仍是分整数；Admin UI 已按元转换后再提交
      return {
        ok: false,
        message: definition.unit === "cents"
          ? `${definition.label} 必须是整数（库内以分为单位存储）`
          : `${definition.label} 必须是整数`,
      };
    }
    const parsed = Number(trimmed);
    if (definition.min !== undefined && parsed < definition.min) {
      return {
        ok: false,
        message: definition.unit === "cents"
          ? `${definition.label} 不能小于 ${formatCentsBoundForMessage(definition.min)} 元`
          : `${definition.label} 不能小于 ${definition.min}`,
      };
    }
    if (definition.max !== undefined && parsed > definition.max) {
      return {
        ok: false,
        message: definition.unit === "cents"
          ? `${definition.label} 不能大于 ${formatCentsBoundForMessage(definition.max)} 元`
          : `${definition.label} 不能大于 ${definition.max}`,
      };
    }
    return { ok: true, value: String(parsed) };
  }

  if (definition.maxLength !== undefined && trimmed.length > definition.maxLength) {
    return { ok: false, message: `${definition.label} 不能超过 ${definition.maxLength} 个字符` };
  }
  if (definition.format === "email" && trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, message: `${definition.label} 必须是有效邮箱地址` };
  }
  // 邮箱域名白名单：保存时规范化 + 合法性校验（与运行时 parse 共用规则）。
  if (key === "email_domain_whitelist") {
    // 简化的域名白名单处理：按逗号/空格/换行分割，去空去重
    return {
      ok: true as const,
      value: trimmed
        .split(/[,;\s\n]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .join(","),
    };
  }
  return { ok: true, value: trimmed };
}

export function buildSystemConfigMap(rows: Array<{ key: string; value: string }>, keys = SYSTEM_CONFIG_KEYS): Record<string, string> {
  const config: Record<string, string> = {};
  for (const key of keys) {
    const definition = getSystemConfigDefinition(key);
    if (definition) config[key] = definition.defaultValue;
  }
  for (const row of rows) {
    if (systemConfigKeySet.has(row.key) && keys.some((key) => key === row.key)) {
      config[row.key] = row.value;
    }
  }
  return config;
}

export async function readSystemConfigMap(db: DbType, keys = SYSTEM_CONFIG_KEYS): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(inArray(systemConfig.key, keys));
  return buildSystemConfigMap(rows, keys);
}

export function adminSystemConfigDefinitions(): SystemConfigDefinition[] {
  return [...SYSTEM_CONFIG_DEFINITIONS];
}

;

;
