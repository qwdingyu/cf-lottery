/// <reference types="node" />
/**
 * 共享测试数据库工具。
 *
 * 目标：
 * - 全仓库只维护一份测试数据库入口，避免每个测试文件重复建库/复制 DDL。
 * - 测试库直接跑项目 migrations，和生产 schema 同源。
 * - 所有测试共享同一个进程级 libSQL 数据库，但通过串行执行和清表保持隔离。
 * - 数据库文件放到系统临时目录并按进程隔离，避免项目根目录 test-*.db 泛滥。
 */
import { createClient, type Client } from "@libsql/client";
import { createDb } from "./db/client";
import type { DbType } from "./db/client";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_DB_PATH = join(tmpdir(), `cf-lottery-vitest-${process.pid}.db`);
const TEST_DB_URL = process.env.CF_LOTTERY_TEST_DB_URL || `file:${TEST_DB_PATH}`;

/**
 * 单测在 Node 内模拟多 IP 限流时依赖 CF-Connecting-IP。
 * 生产 Node 默认不信任该头；测试显式打开（与 docs/070 HIGH #2 对齐）。
 */
if (!process.env.TRUST_CF_CONNECTING_IP) {
  process.env.TRUST_CF_CONNECTING_IP = "true";
}
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const DEFAULT_SYSTEM_CONFIGS: Array<[string, string]> = [
  ["plan_free_max_activities", "10"],
  ["plan_free_max_participants_per_activity", "200"],
  ["plan_pro_max_activities", "200"],
  ["plan_pro_max_participants_per_activity", "5000"],
  ["plan_team_max_activities", "1000"],
  ["plan_team_max_participants_per_activity", "20000"],
  ["plan_enterprise_max_activities", "0"],
  ["plan_enterprise_max_participants_per_activity", "100000"],
];

let _client: Client | null = null;
let _db: DbType | null = null;
let _initPromise: Promise<{ client: Client; db: DbType }> | null = null;
let cleanupRegistered = false;

function registerTempDbCleanup() {
  if (cleanupRegistered || process.env.CF_LOTTERY_TEST_DB_URL) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        unlinkSync(`${TEST_DB_PATH}${suffix}`);
      } catch {
        /* 测试库可能尚未创建对应旁路文件；忽略即可。 */
      }
    }
  });
}

function parseMigrationStatements(content: string): string[] {
  const upMatch = content.match(/--\s*UP\s*\n([\s\S]*?)(?=--\s*DOWN|$)/);
  const raw = upMatch ? upMatch[1] : content;
  return raw
    .split(";")
    .map((stmt) => stmt.trim())
    .map((stmt) => {
      const lines = stmt.split("\n");
      while (lines.length > 0 && lines[0].trim().startsWith("--")) lines.shift();
      return lines.join("\n").trim();
    })
    .filter(Boolean);
}

async function ensureMigrationTable(client: Client) {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      executed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

async function getExecutedMigrations(client: Client): Promise<Set<string>> {
  await ensureMigrationTable(client);
  const result = await client.execute(`SELECT version FROM schema_migrations ORDER BY version ASC`);
  return new Set(result.rows.map((row) => String(row.version)));
}

async function recordMigration(client: Client, version: string, name: string) {
  await ensureMigrationTable(client);
  await client.execute({
    sql: `
      INSERT INTO schema_migrations (version, name, executed_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT (version) DO NOTHING
    `,
    args: [version, name],
  });
}

async function applyMigrations(client: Client) {
  // WAL 模式防止并发读写时的 "database is locked" 错误
  await client.execute("PRAGMA journal_mode = WAL");
  const executed = await getExecutedMigrations(client);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.split("_")[0] || "";
    if (!version || executed.has(version)) continue;

    const statements = parseMigrationStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
    for (const statement of statements) {
      try {
        await client.execute(statement);
      } catch (err) {
        const message = String((err as Error).message || err);
        if (
          message.includes("already exists") ||
          message.includes("duplicate column") ||
          message.includes("duplicate index")
        ) {
          continue;
        }
        throw err;
      }
    }

    const name = file.replace(/^\d+_/, "").replace(/\.sql$/, "");
    await recordMigration(client, version, name);
  }
}

async function seedSystemConfigDefaults(client: Client) {
  for (const [key, value] of DEFAULT_SYSTEM_CONFIGS) {
    await client.execute({ sql: "INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)", args: [key, value] });
  }
}

async function initializeTestDb(): Promise<{ client: Client; db: DbType }> {
  registerTempDbCleanup();
  const client = createClient({ url: TEST_DB_URL });
  const db = createDb(client);
  await applyMigrations(client);
  await clearTestData(client);
  return { client, db };
}

/** 获取或创建共享测试数据库。 */
export async function getTestDb(): Promise<{ client: Client; db: DbType }> {
  if (_client && _db) return { client: _client, db: _db };
  if (_initPromise) return _initPromise;

  _initPromise = initializeTestDb().then(async ({ client, db }) => {
    _client = client;
    _db = db;
    return { client, db };
  }).finally(() => {
    _initPromise = null;
  });

  return _initPromise;
}

/** 清空测试数据库中的业务数据，并恢复默认系统配置。 */
export async function clearTestData(client: Client) {
  const tables = [
    "activity_submissions",
    "activity_events",
    "activity_outcomes",
    "external_conversions",
    "share_records",
    "webhook_deliveries",
    "webhook_configs",
    "api_keys",
    "coupon_codes",
    "redemption_records",
    "redemption_codes",
    "tenant_usage_snapshots",
    "platform_audit_logs",
    "admin_audit_logs",
    "platform_members",
    "auth_identities",
    "rate_limit_log",
    "lottery_blacklist",
    "lottery_invite_codes",
    "lottery_roster_members",
    "lottery_prize_tiers",
    "lottery_spins",
    "lottery_winners",
    "lottery_entries",
    "email_access_codes",
    "prize_codes",
    "prizes",
    "payment_orders",
    "tenant_configs",
    "lottery_draws",
    "audit_logs",
    "system_config",
    "tenant_members",
    "users",
    "tenants",
  ];

  for (const table of tables) {
    await client.execute({ sql: `DELETE FROM ${table}`, args: [] });
  }
  await seedSystemConfigDefaults(client);
}

/** 关闭测试数据库连接。仅在需要显式释放资源时调用。 */
export async function closeTestDb() {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
  }
}
