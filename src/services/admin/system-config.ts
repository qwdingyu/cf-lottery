/**
 * Admin 服务层 — 系统配置读写（G18/G19/G20）。
 *
 * 由 admin-service.ts 按域抽出；admin-service.ts 以 barrel 再导出，
 * 因此 routes / 测试 / 门禁的引用路径均不受影响。
 *
 * 边界：只做 system_config 表的读取/写入/删除与敏感项加解密；
 * 配置项的定义与默认值归 lib/system-config-registry。
 */
import { eq, inArray } from "drizzle-orm";
import type { DbType } from "../../db/client";
import { systemConfig } from "../../db/schema";
import { decryptSecretConfigValue, encryptSecretConfigValue } from "../../lib/secret-config";
import {
  SYSTEM_CONFIG_KEYS,
  buildSystemConfigMap,
  isSensitiveSystemConfigKey,
} from "../../lib/system-config-registry";

// ── G18: 读取系统配置 ──────────────────────────────

export async function getSystemConfig(
  db: DbType,
  encryptionKey?: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(inArray(systemConfig.key, SYSTEM_CONFIG_KEYS));

  const config = buildSystemConfigMap(rows);
  for (const key of SYSTEM_CONFIG_KEYS) {
    if (isSensitiveSystemConfigKey(key) && config[key]) {
      config[key] = await decryptSecretConfigValue(config[key], encryptionKey);
    }
  }
  return config;
}

// ── G19: 更新系统配置 ──────────────────────────────

export async function upsertSystemConfig(
  db: DbType,
  key: string,
  value: string,
  encryptionKey?: string,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const storedValue = isSensitiveSystemConfigKey(key)
    ? await encryptSecretConfigValue(value, encryptionKey || "")
    : value;
  await db
    .insert(systemConfig)
    .values({ key, value: storedValue, updatedAt })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value: storedValue, updatedAt },
    });
}

// ── G20: 删除系统配置 ──────────────────────────────

export async function deleteSystemConfig(
  db: DbType,
  key: string,
): Promise<void> {
  await db.delete(systemConfig).where(eq(systemConfig.key, key));
}

