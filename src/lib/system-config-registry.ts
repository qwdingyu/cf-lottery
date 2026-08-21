import { eq, inArray } from "drizzle-orm";
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
  /** difficulty 控制 UI 展示层级：basic=基础参数（默认展示），advanced=高级参数（折叠隐藏） */
  difficulty?: "basic" | "advanced";
  /**
   * 多选枚举（type=string）：合法 token 白名单。
   * 存储仍为逗号分隔字符串；Admin ConfigField 渲染为复选框网格。
   * 有 enum 时 normalize 会去重、拒非法值、拒空选（至少一项）。
   */
  enum?: string[];
  /** 枚举选项展示标签（中文等）；仅 UI，不影响存储值 */
  enumLabels?: Record<string, string>;
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
  // 多选枚举：逗号分隔 → 白名单校验 → 按 definition.enum 顺序稳定落库（与 ConfigField 勾选顺序无关）
  if (definition.enum && definition.enum.length > 0) {
    const allowed = new Set(definition.enum);
    const rawParts = trimmed
      .split(/[,;\s\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const unique = [...new Set(rawParts)];
    const invalid = unique.filter((part) => !allowed.has(part));
    if (invalid.length > 0) {
      return {
        ok: false,
        message: `${definition.label} 含有不支持的选项：${invalid.join(", ")}`,
      };
    }
    // 按定义顺序输出，保证「全选/半选」比较与 diff 稳定
    const ordered = definition.enum.filter((opt) => unique.includes(opt));
    if (ordered.length === 0) {
      return { ok: false, message: `${definition.label} 至少选择一项` };
    }
    return { ok: true, value: ordered.join(",") };
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
  // 自定义链接：只能包含字母数字和短横线，留空保存默认值
  if (key === "custom_shop_link") {
    if (trimmed && !/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(trimmed) && trimmed.length > 1) {
      // 单个字符允许（如 "a"），短横线不能在首尾
      if (trimmed.length === 1 && /^[a-zA-Z0-9]$/.test(trimmed)) {
        return { ok: true, value: trimmed.toLowerCase() };
      }
      return { ok: false, message: `${definition.label} 只能包含字母数字和短横线，且短横线不能在首尾` };
    }
    return { ok: true, value: trimmed.toLowerCase() };
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

/**
 * 读取布尔系统配置。
 *
 * 默认值来自 system-config-definitions.json，避免业务代码和后台参数定义各自写一份 fallback。
 * 仅显式 "true" 视为启用，其他异常值按定义默认值兜底，防止脏数据意外打开高风险能力。
 */
export async function readSystemConfigBoolean(db: Pick<DbType, "select">, key: string): Promise<boolean> {
  const definition = getSystemConfigDefinition(key);
  const defaultValue = definition?.type === "boolean" ? definition.defaultValue === "true" : false;
  const [row] = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, key))
    .limit(1);
  if (!row) return defaultValue;
  if (row.value === "true") return true;
  if (row.value === "false") return false;
  return defaultValue;
}

export function adminSystemConfigDefinitions(): SystemConfigDefinition[] {
  return [...SYSTEM_CONFIG_DEFINITIONS];
}

/**
 * 社群功能全局开关（docs/174）：
 * 读取 system_config 的 community_feature_enabled（默认 "true"）。
 * 未配置（无记录）或值为 "true" 时视为启用，仅显式 "false" 关闭。
 * 供 L2 后端路由（admin-lottery-platform.ts）和入站命令执行链路（inbound.ts）共用。
 */
export async function isCommunityFeatureEnabled(db: DbType): Promise<boolean> {
  return readSystemConfigBoolean(db, "community_feature_enabled");
}

/**
 * 店铺功能全局开关（docs/204）：
 * 读取 system_config 的 shop_feature_enabled（默认 "true"）。
 * 未配置或值为 "true" 时视为启用，仅显式 "false" 关闭。
 * 供 /api/admin/brand 与主页右上角「我的商铺」按钮共用。
 */
export async function isShopFeatureEnabled(db: DbType): Promise<boolean> {
  return readSystemConfigBoolean(db, "shop_feature_enabled");
}
