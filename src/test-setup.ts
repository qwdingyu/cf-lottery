/**
 * 测试工具集：统一管理所有测试文件的数据库创建和清理。
 *
 * 为什么需要这个文件：
 * - 避免每个测试文件各自执行 CREATE TABLE（建表脚本泛滥）
 * - 共享数据库 URL 确保同一进程内复用连接
 * - 一次建表、多次复用，减少测试启动开销
 * - 当 schema 变更（如新增 activity_config 列）时，只需改这一处
 */
import { createClient, type Client } from "@libsql/client";
import { createDb } from "./db/client";
import type { DbType } from "./db/client";

/** 测试数据库文件名，同一进程内共享 */
const TEST_DB_URL = "file:test-shared.db";

let _client: Client | null = null;
let _db: DbType | null = null;
let _initialized = false;

/**
 * 获取或创建共享的测试数据库连接。
 * 首次调用时创建表结构，后续调用直接返回已有实例。
 */
export async function getTestDb(): Promise<{ client: Client; db: DbType }> {
  if (_initialized && _client && _db) return { client: _client, db: _db };

  _client = createClient({ url: TEST_DB_URL });
  _db = createDb(_client);

  // ═══════════════════════════════════════════════════════════
  // 统一的建表脚本（所有测试文件复用此结构）
  // 当 migration 新增列时，在此处同步追加
  // ═══════════════════════════════════════════════════════════

  await _client.execute(`CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active', brand_config TEXT NOT NULL DEFAULT '{}',
    extra_activity_quota INTEGER NOT NULL DEFAULT 0,
    extra_participant_quota INTEGER NOT NULL DEFAULT 0,
    extra_quota_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '',
    email_verified INTEGER NOT NULL DEFAULT 0, password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS tenant_members (
    tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (tenant_id, user_id)
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS platform_members (
    user_id TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS platform_audit_logs (
    id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, actor_role TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL DEFAULT '',
    tenant_id TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS rate_limit_log (
    id TEXT PRIMARY KEY, key TEXT NOT NULL, action TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS lottery_draws (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, public_slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft', activity_kind TEXT NOT NULL DEFAULT 'lottery',
    participation_mode TEXT NOT NULL DEFAULT 'open', experience_type TEXT NOT NULL DEFAULT 'wheel',
    draw_trigger TEXT NOT NULL DEFAULT 'manual', result_mode TEXT NOT NULL DEFAULT 'manual',
    allocation_policy TEXT NOT NULL DEFAULT 'capacity', policy_version INTEGER NOT NULL DEFAULT 1,
    start_at TEXT NOT NULL DEFAULT '', end_at TEXT NOT NULL DEFAULT '', draw_at TEXT,
    access_password TEXT NOT NULL DEFAULT '', max_participants INTEGER,
    winner_count INTEGER NOT NULL DEFAULT 1,
    show_participant_count INTEGER NOT NULL DEFAULT 1,
    show_winner_count INTEGER NOT NULL DEFAULT 1, show_winner_list INTEGER NOT NULL DEFAULT 0,
    drawn_at TEXT, failure_reason TEXT NOT NULL DEFAULT '',
    draw_seed_hash TEXT NOT NULL DEFAULT '', draw_seed TEXT NOT NULL DEFAULT '',
    algorithm_version TEXT NOT NULL DEFAULT 'uniform_v1',
    product_link TEXT NOT NULL DEFAULT '{}', promotion_config TEXT NOT NULL DEFAULT '{}',
    activity_config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS lottery_entries (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    identity_type TEXT NOT NULL DEFAULT 'email', identity_value TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '', invite_code_id TEXT DEFAULT '',
    ip_hash TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL,
    UNIQUE(tenant_id, draw_id, identity_type, identity_value)
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS lottery_winners (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    tier_id TEXT NOT NULL, entry_id TEXT NOT NULL, identity_type TEXT NOT NULL,
    identity_value TEXT NOT NULL, prize_code_id TEXT DEFAULT '', drawn_at TEXT NOT NULL,
    notification_status TEXT NOT NULL DEFAULT 'pending', notification_error TEXT NOT NULL DEFAULT '',
    UNIQUE(tenant_id, draw_id, entry_id)
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS lottery_prize_tiers (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    prize_id TEXT NOT NULL, tier_name TEXT NOT NULL DEFAULT '中奖',
    winner_count INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 100
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS lottery_roster_members (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    identity_value TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT ''
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS lottery_invite_codes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    code TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 1
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS lottery_blacklist (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, identity_value TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, identity_value)
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS email_access_codes (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, draw_id TEXT NOT NULL,
    code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS prizes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '',
    value_text TEXT NOT NULL DEFAULT '', prize_type TEXT NOT NULL DEFAULT 'code',
    fulfillment_note TEXT NOT NULL DEFAULT '', total_count INTEGER NOT NULL DEFAULT 0,
    used_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS prize_codes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, prize_id TEXT NOT NULL,
    code TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'available',
    winner_id TEXT, issued_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS activity_outcomes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    entry_id TEXT NOT NULL, outcome_type TEXT NOT NULL DEFAULT 'assignment',
    status TEXT NOT NULL DEFAULT 'assigned', sequence_no INTEGER NOT NULL,
    assignment_no INTEGER, result_key TEXT NOT NULL DEFAULT '',
    result_label TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}',
    decided_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS activity_events (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    entry_id TEXT NOT NULL DEFAULT '', event_type TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '',
    campaign TEXT NOT NULL DEFAULT '', ref_code TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}', ip_hash TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS activity_submissions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    entry_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}', user_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS webhook_configs (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '["draw.completed","prize.issued"]', active INTEGER NOT NULL DEFAULT 1,
    signing_secret TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await _client.execute(`ALTER TABLE webhook_configs ADD COLUMN events TEXT NOT NULL DEFAULT '["draw.completed","prize.issued"]'`).catch(() => undefined);

  await _client.execute(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, webhook_config_id TEXT NOT NULL,
    event_id TEXT NOT NULL, event_type TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}', signature TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT, response_status INTEGER, response_body TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS coupon_codes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '', expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, code)
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS share_records (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    ref_code TEXT NOT NULL, sharer_entry_id TEXT NOT NULL DEFAULT '',
    visitor_entry_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS external_conversions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL,
    entry_id TEXT NOT NULL DEFAULT '', conversion_type TEXT NOT NULL,
    ref_code TEXT NOT NULL DEFAULT '', amount_cents INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS redemption_codes (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    activity_quota INTEGER NOT NULL DEFAULT 0, participant_quota INTEGER NOT NULL DEFAULT 0,
    duration_days INTEGER NOT NULL DEFAULT 30, expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await _client.execute(`CREATE TABLE IF NOT EXISTS redemption_records (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code_id TEXT NOT NULL,
    redeemed_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  _initialized = true;
  return { client: _client, db: _db };
}

/**
 * 清理测试数据库中的所有数据（保留表结构）。
 * 在每个 describe 块结束后调用，确保测试隔离。
 */
export async function clearTestData(client: Client) {
  // 按外键依赖顺序清空（子表先清）
  const tables = [
    "activity_submissions", "activity_events", "activity_outcomes",
    "prize_codes", "lottery_prize_tiers",
    "lottery_winners", "lottery_entries", "lottery_roster_members",
    "lottery_invite_codes", "lottery_blacklist",
    "email_access_codes", "audit_logs", "platform_audit_logs",
    "webhook_deliveries", "webhook_configs", "api_keys",
    "coupon_codes", "share_records", "external_conversions",
    "redemption_records", "redemption_codes",
    "prizes", "lottery_draws", "system_config",
    "tenant_members", "platform_members",
    "users", "tenants", "rate_limit_log",
  ];
  for (const table of tables) {
    await client.execute({ sql: `DELETE FROM ${table}`, args: [] });
  }
}

/** 关闭测试数据库连接 */
export function closeTestDb() {
  if (_client) { _client.close(); _client = null; _db = null; _initialized = false; }
}
