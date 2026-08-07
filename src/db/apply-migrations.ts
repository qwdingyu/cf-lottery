/**
 * 应用启动时自动迁移（VPS 本地 SQLite / Turso 双模式）。
 *
 * 设计意图（docs/130 迁移基线化 + cf-auth 启动自动迁移模式）：
 * - 与 scripts/migrate.mjs 共享相同的解析规则（-- UP/-- DOWN、循环移除开头注释行）
 * - 用 schema_migrations 表跟踪已应用版本，增量执行未应用的迁移
 * - 0030_baseline.sql 是幂等基线（CREATE TABLE/INDEX IF NOT EXISTS），
 *   旧库已存在的表/索引自动跳过；未来增量从 0031 开始
 * - 迁移失败会抛出异常，由调用方（server.ts）决定是否阻止启动
 *   （迁移失败而应用继续启动 = schema 与代码不匹配，属灾难性风险）
 */
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";

// migrations 目录定位：src/db/apply-migrations.ts（tsx 开发）与 dist/db/apply-migrations.js
// （VPS 生产）相对项目根的层级一致，均为 ../../migrations
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** 确保 data/ 目录存在（本地 SQLite 文件模式所需，借鉴 cf-auth migrate.mjs）。 */
export function ensureDataDir(dbUrl: string): void {
  if (dbUrl.startsWith("file:")) {
    const filePath = dbUrl.replace(/^file:/, "");
    const abs = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);
    mkdirSync(dirname(abs), { recursive: true });
  }
}

/** 与 migrate.mjs 一致的语句解析：按 ; 拆分，循环移除语句开头的注释行。 */
function parseStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => {
      const lines = s.trim().split("\n");
      while (lines.length > 0 && lines[0].trim().startsWith("--")) lines.shift();
      return lines.join("\n").trim();
    })
    .filter((s) => s.length > 0);
}

/** 提取迁移文件的 UP 段；无 UP 标记则整个文件视为 UP。 */
function extractUp(content: string): string {
  const upMatch = content.match(/--\s*UP\s*\n([\s\S]*?)(?=--\s*DOWN|$)/);
  return upMatch ? upMatch[1] : content;
}

/**
 * 应用所有未执行的迁移，返回本次应用的迁移数。
 * @param client 已连接的 libsql client（本地 SQLite 或 Turso）
 */
export async function applyPendingMigrations(client: Client): Promise<number> {
  // pm2 cluster 下多实例并发启动迁移：设 busy_timeout 让 SQLite 等待写锁而非立即
  // 报 SQLITE_BUSY（@libsql/client 不自动重试 BUSY）。5s 足够覆盖首个实例建表耗时。
  try {
    await client.execute({ sql: "PRAGMA busy_timeout = 5000", args: [] });
  } catch {
    // 远程 Turso 可能不允许 PRAGMA busy_timeout，忽略
  }

  // 1. 确保版本跟踪表存在
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      executed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // 2. 读取已应用的版本
  const executed = new Set<string>();
  try {
    const { rows } = await client.execute("SELECT version FROM schema_migrations");
    for (const row of rows) executed.add(String(row.version));
  } catch {
    // 表刚创建，无需处理
  }

  // 3. 读取根目录迁移文件（legacy/ 子目录不被扫描——历史迁移已归档，见 docs/130）
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let applied = 0;
  for (const file of files) {
    const version = file.split("_")[0] || "";
    if (!version || executed.has(version)) continue;

    const content = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    for (const stmt of parseStatements(extractUp(content))) {
      try {
        await client.execute(stmt);
      } catch (err) {
        const msg = String((err as Error).message || err);
        // 幂等容错：已存在的表/列/索引跳过（0030 基线对旧库的安全保证）
        if (
          msg.includes("already exists") ||
          msg.includes("duplicate column") ||
          msg.includes("duplicate index")
        ) {
          continue;
        }
        throw err;
      }
    }

    const name = file.replace(/^\d+_/, "").replace(/\.sql$/, "");
    // INSERT OR IGNORE：防多进程并发启动时同一迁移被重复记录（UNIQUE 冲突）
    await client.execute({
      sql: "INSERT OR IGNORE INTO schema_migrations (version, name, executed_at) VALUES (?, ?, datetime('now'))",
      args: [version, name],
    });
    applied++;
  }

  return applied;
}
