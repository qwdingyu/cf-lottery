#!/usr/bin/env node
/**
 * 一键导出 Turso 数据库 → 本地 SQLite 文件。
 *
 * 用法：npm run db:export
 * 前提：.env 中 TURSO_URL 指向 Turso
 * 输出：data/local.db
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";

config();
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const LOCAL_DB = "file:./data/local.db";

if (!TURSO_URL || !TURSO_URL.startsWith("libsql://")) {
  console.error("❌ 请先配置 .env 中的 TURSO_URL");
  process.exit(1);
}

console.log(`📡 ${TURSO_URL} → 💾 ${LOCAL_DB}`);

const remote = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
const local = createClient({ url: LOCAL_DB });

const TABLE_ORDER = [
  "tenants", "users", "system_config", "rate_limit_log", "redemption_codes",
  "tenant_usage_snapshots", "tenant_members", "platform_members",
  "platform_audit_logs", "lottery_draws", "lottery_entries", "lottery_winners",
  "lottery_prize_tiers", "lottery_roster_members", "lottery_invite_codes",
  "lottery_blacklist", "prizes", "prize_codes", "activity_outcomes",
  "activity_events", "activity_submissions", "api_keys", "webhook_configs",
  "webhook_deliveries", "coupon_codes", "redemption_records", "share_records",
  "external_conversions", "audit_logs", "email_access_codes",
];

async function main() {
  console.log("\n📋 DDL...");
  const master = await remote.execute(
    "SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT LIKE 'libsql_%' ORDER BY type DESC, name"
  );

  const tables = new Set();
  const ddls = [];
  for (const row of master.rows) {
    const name = row[0], sql = row[1];
    if (!sql) continue;
    if (sql.includes("CREATE TABLE")) tables.add(name);
    if (sql.includes("CREATE INDEX") && sql.includes("sqlite_autoindex")) continue;
    ddls.push(sql);
  }
  console.log("   " + tables.size + " 个表, " + ddls.length + " 条 DDL");

  console.log("\n🔨 建表...");
  await local.execute("PRAGMA foreign_keys = OFF; PRAGMA journal_mode = WAL");
  for (const sql of ddls) {
    try { await local.execute(sql); } catch (e) {
      console.warn("   ⚠️ " + sql.slice(0, 50) + "...");
    }
  }

  console.log("\n📦 复制数据...");
  let total = 0;
  for (const table of TABLE_ORDER) {
    if (!tables.has(table)) continue;
    try {
      const result = await remote.execute("SELECT * FROM " + table);
      if (result.rows.length === 0) continue;

      const cols = result.columns;
      const ph = cols.map(() => "?").join(",");
      const stmt = "INSERT OR REPLACE INTO " + table + " (" + cols.join(",") + ") VALUES (" + ph + ")";

      for (const row of result.rows) {
        try { await local.execute({ sql: stmt, args: Array.isArray(row) ? row : Object.values(row) }); } catch { }
      }

      console.log("   " + table + ": " + result.rows.length + " 行");
      total += result.rows.length;
    } catch (e) {
      console.warn("   ⚠️ " + table + ": " + (e && e.message ? String(e.message).slice(0, 50) : ""));
    }
  }

  await local.execute("PRAGMA foreign_keys = ON");
  console.log("\n✅ " + total + " 行导入完成");

  console.log("\n📊 本地验证:");
  for (const table of TABLE_ORDER) {
    if (!tables.has(table)) continue;
    try {
      const r = await local.execute("SELECT COUNT(*) FROM " + table);
      const c = Number(r.rows[0]?.[0] || 0);
      if (c > 0) console.log("   " + table + ": " + c + " 行");
    } catch { }
  }

  await remote.close();
  await local.close();
  console.log("\n🎉 " + LOCAL_DB + " 就绪");
  console.log("   设置 TURSO_URL=file:./data/local.db 即可使用本地库");
}

main().catch(err => {
  console.error("\n❌", err && err.message ? String(err.message) : String(err));
  process.exit(1);
});
