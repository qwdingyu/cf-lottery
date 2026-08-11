/**
 * Admin 服务层 — 系统配置读写（G18/G19/G20）。
 *
 * 由 admin-service.ts 按域抽出；admin-service.ts 以 barrel 再导出，
 * 因此 routes / 测试 / 门禁的引用路径均不受影响。
 *
 * 边界：只做 system_config 表的读取/写入/删除与敏感项加解密；
 * 配置项的定义与默认值归 lib/system-config-registry。
 */
import { eq, inArray, desc } from "drizzle-orm";
import type { DbType, DbWriteScope } from "../../db/client";
import { systemConfig, systemConfigVersions } from "../../db/schema";
import {
  decryptSecretConfigValueObserved,
  encryptSecretConfigValue,
  type SecretDecryptObserveEvent,
} from "../../lib/secret-config";
import {
  SYSTEM_CONFIG_KEYS,
  buildSystemConfigMap,
  getSystemConfigDefinition,
  isSensitiveSystemConfigKey,
} from "../../lib/system-config-registry";

function logSecretDecryptFailure(configKey: string, event: SecretDecryptObserveEvent): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "secret_config_decrypt_failed",
      configKey,
      reason: event.reason,
      encrypted: event.encrypted,
    }),
  );
}

type SystemConfigChangeType = "update" | "delete" | "rollback";

export type SystemConfigVersionRow = {
  revision: number;
  key: string;
  beforeValue: string;
  afterValue: string;
  changeType: SystemConfigChangeType;
  actorUserId: string;
  actorRole: string;
  createdAt: string;
};

async function encryptSystemConfigValue(key: string, value: string, encryptionKey?: string): Promise<string> {
  return isSensitiveSystemConfigKey(key)
    ? encryptSecretConfigValue(value, encryptionKey || "")
    : value;
}

export async function getSystemConfigStoredValue(db: DbType | DbWriteScope, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, key))
    .limit(1);
  return row?.value ?? null;
}

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
      config[key] = await decryptSecretConfigValueObserved(config[key], encryptionKey, (e) =>
        logSecretDecryptFailure(key, e),
      );
    }
  }
  return config;
}

// ── G19: 更新系统配置 ──────────────────────────────

export async function upsertSystemConfig(
  db: DbType | DbWriteScope,
  key: string,
  value: string,
  encryptionKey?: string,
): Promise<string> {
  const updatedAt = new Date().toISOString();
  const storedValue = await encryptSystemConfigValue(key, value, encryptionKey);
  await db
    .insert(systemConfig)
    .values({ key, value: storedValue, updatedAt })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value: storedValue, updatedAt },
    });
  return storedValue;
}

export async function upsertSystemConfigStoredValue(
  db: DbType | DbWriteScope,
  key: string,
  storedValue: string,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await db
    .insert(systemConfig)
    .values({ key, value: storedValue, updatedAt })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value: storedValue, updatedAt },
    });
}

export async function recordSystemConfigVersion(
  db: DbType | DbWriteScope,
  input: {
    key: string;
    beforeValue: string;
    afterValue: string;
    changeType: SystemConfigChangeType;
    actorUserId: string;
    actorRole: string;
  },
): Promise<void> {
  await db.insert(systemConfigVersions).values({
    key: input.key,
    beforeValue: input.beforeValue,
    afterValue: input.afterValue,
    changeType: input.changeType,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
  });
}

export async function getSystemConfigHistory(
  db: DbType,
  key: string,
  encryptionKey?: string,
  limit = 10,
): Promise<Array<SystemConfigVersionRow>> {
  const rows = await db
    .select()
    .from(systemConfigVersions)
    .where(eq(systemConfigVersions.key, key))
    .orderBy(desc(systemConfigVersions.revision))
    .limit(limit);

  const sensitive = isSensitiveSystemConfigKey(key);
  const decrypt = async (value: string) => {
    if (!sensitive || !value) return value;
    return decryptSecretConfigValueObserved(value, encryptionKey, (e) =>
      logSecretDecryptFailure(key, e),
    );
  };

  const history: Array<SystemConfigVersionRow> = [];
  for (const row of rows) {
    history.push({
      revision: Number(row.revision),
      key: row.key,
      beforeValue: await decrypt(row.beforeValue),
      afterValue: await decrypt(row.afterValue),
      changeType: row.changeType as SystemConfigChangeType,
      actorUserId: row.actorUserId,
      actorRole: row.actorRole,
      createdAt: row.createdAt,
    });
  }
  return history;
}

export async function getSystemConfigDefinitionDefaultValue(key: string): Promise<string> {
  return getSystemConfigDefinition(key)?.defaultValue ?? "";
}

// ── G19.5: 读取单个整数配置（带默认值） ──────────────

/**
 * 读取单个系统配置的整数值，未配置时返回 defaultValue。
 * 用于 Dashboard 等需要快速读取单个配置的场景。
 */
export async function readSystemConfigNumber(
  db: DbType,
  key: string,
  defaultValue: number,
): Promise<number> {
  const [row] = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, key))
    .limit(1);
  if (!row) return defaultValue;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

// ── G20: 删除系统配置 ──────────────────────────────

export async function deleteSystemConfig(
  db: DbType | DbWriteScope,
  key: string,
): Promise<void> {
  await db.delete(systemConfig).where(eq(systemConfig.key, key));
}
