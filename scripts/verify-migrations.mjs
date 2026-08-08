/**
 * 迁移验证脚本
 *
 * 验证所有迁移文件在空数据库上可正确执行。
 * 用法：node scripts/verify-migrations.mjs
 */
import { createClient } from "@libsql/client";
import { readFileSync, readdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

const DB_PATH = "test-migration.db";
const MIGRATIONS_DIR = new URL("../migrations", import.meta.url).pathname;

function isExpectedRepeatError(message) {
  return message.includes("duplicate column")
    || message.includes("already exists");
}

/**
 * 与 scripts/migrate.mjs / src/db/apply-migrations.ts 保持同一拆分规则：
 * 分号后的纯注释块不是可执行 SQL，必须在验证阶段过滤，否则会把有效迁移误报为失败。
 */
function parseStatements(sql) {
  return sql
    .split(";")
    .map((statement) => {
      const lines = statement.trim().split("\n");
      while (lines.length > 0 && lines[0].trim().startsWith("--")) {
        lines.shift();
      }
      return lines.join("\n").trim();
    })
    .filter(Boolean);
}

function extractUpSql(sql) {
  return sql.includes("-- UP")
    ? sql.split("-- UP")[1].split("-- DOWN")[0].trim()
    : sql;
}

function assertUniqueMigrationVersions(files) {
  const filenamesByVersion = new Map();
  for (const file of files) {
    const version = file.split("_")[0] || "";
    if (!version) throw new Error(`迁移文件缺少版本前缀: ${file}`);
    const previous = filenamesByVersion.get(version);
    if (previous) {
      throw new Error(`迁移版本重复: ${version} 同时用于 ${previous} 和 ${file}`);
    }
    filenamesByVersion.set(version, file);
  }
}

async function main() {
  // 清理旧测试数据库
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(DB_PATH + suffix); } catch {}
  }

  console.log("🚀 迁移验证开始\n");

  // 1. 空库初始化
  console.log("📋 测试 1: 空库初始化");
  const client = createClient({ url: `file:${DB_PATH}` });
  
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort();
  assertUniqueMigrationVersions(files);

  console.log(`   发现 ${files.length} 个迁移文件`);

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8").trim();
    const statements = parseStatements(extractUpSql(sql));
    for (const stmt of statements) {
      try {
        await client.execute(stmt);
        console.log(`  ✅ ${file}: ${stmt.slice(0, 60)}...`);
      } catch (err) {
        console.error(`  ❌ ${file}: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // 2. 验证表存在
  console.log("\n📋 测试 2: 验证表结构");
  const tables = [
    "tenants", "users", "tenant_members",
    "platform_members", "platform_audit_logs",
    "prizes", "prize_codes",
    "lottery_draws", "lottery_prize_tiers", "lottery_entries",
    "lottery_winners", "lottery_spins", "lottery_roster_members", "lottery_invite_codes",
    "email_access_codes", "audit_logs", "system_config",
    "activity_events", "webhook_deliveries", "redemption_codes", "redemption_records",
    "external_conversions", "rate_limit_log", "tenant_usage_snapshots", "activity_submissions",
    "tenant_configs", "payment_orders", "payment_order_attempts",
  ];
  for (const table of tables) {
    try {
      await client.execute(`SELECT 1 FROM ${table} LIMIT 1`);
      console.log(`  ✅ ${table}`);
    } catch {
      console.error(`  ❌ ${table} 不存在`);
      process.exit(1);
    }
  }

  // 3. 验证 lottery_draws 列
  console.log("\n📋 测试 3: 验证 lottery_draws 列");
  const columns = [
    "activity_kind", "experience_type", "result_mode", "policy_version",
    "promotion_config", "activity_config", "product_link", "draw_seed_hash", "draw_seed",
  ];
  for (const col of columns) {
    try {
      await client.execute(`SELECT ${col} FROM lottery_draws LIMIT 1`);
      console.log(`  ✅ ${col}`);
    } catch {
      console.error(`  ❌ ${col} 缺失`);
      process.exit(1);
    }
  }

  // 4. 验证平台审计表列
  console.log("\n📋 测试 4: 验证 platform_audit_logs 列");
  const platformAuditColumns = [
    "actor_user_id", "actor_role", "action", "target_type",
    "target_id", "tenant_id", "metadata_json", "created_at",
  ];
  for (const col of platformAuditColumns) {
    try {
      await client.execute(`SELECT ${col} FROM platform_audit_logs LIMIT 1`);
      console.log(`  ✅ ${col}`);
    } catch {
      console.error(`  ❌ ${col} 缺失`);
      process.exit(1);
    }
  }

  // 5. 支付关键索引：迁移存在不代表高并发查询和重复流水保护已实际生效。
  console.log("\n📋 测试 5: 验证支付关键索引");
  const paymentIndexes = [
    "idx_payment_orders_tenant_status_created",
    "idx_lottery_entries_tenant_payment_joined",
    "idx_payment_orders_provider_trade_no",
    "idx_payment_order_attempts_provider_trade_no",
  ];
  for (const index of paymentIndexes) {
    const result = await client.execute({
      sql: "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1",
      args: [index],
    });
    if (result.rows.length === 0) {
      console.error(`  ❌ ${index} 缺失`);
      process.exit(1);
    }
    console.log(`  ✅ ${index}`);
  }

  // 6. 重复执行验证
  console.log("\n📋 测试 6: 重复执行迁移（已存在容错）");
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8").trim();
    const statements = parseStatements(extractUpSql(sql));
    for (const stmt of statements) {
      try {
        await client.execute(stmt);
        console.log(`  ✅ ${file}: 重复执行可通过`);
      } catch (err) {
        if (isExpectedRepeatError(err.message)) {
          console.log(`  ✅ ${file}: 已存在，符合重复执行容错预期`);
        } else {
          console.error(`  ❌ ${file}: ${err.message}`);
          process.exit(1);
        }
      }
    }
  }

  // 清理
  await client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(DB_PATH + suffix); } catch {}
  }

  console.log("\n✅ 迁移验证全部通过");
}

main().catch(err => {
  console.error(`\n❌ 验证失败: ${err.message}`);
  process.exit(1);
});
