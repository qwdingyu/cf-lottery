-- 0030_baseline.sql
-- 基线:完整 schema(由 0001-0029 全部迁移合并,2026-08-07 基线化)
-- 幂等:CREATE TABLE/INDEX 均带 IF NOT EXISTS;已存在的表/索引跳过
-- 未来增量迁移从 0031 开始;历史迁移见 migrations/legacy/

-- UP
CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  medium TEXT NOT NULL DEFAULT '',
  campaign TEXT NOT NULL DEFAULT '',
  ref_code TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip_hash TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_outcomes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  outcome_type TEXT NOT NULL DEFAULT 'assignment',
  status TEXT NOT NULL DEFAULT 'assigned',
  sequence_no INTEGER NOT NULL,
  assignment_no INTEGER,
  result_key TEXT NOT NULL DEFAULT '',
  result_label TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, draw_id, outcome_type, entry_id),
  UNIQUE(tenant_id, draw_id, outcome_type, sequence_no),
  UNIQUE(tenant_id, draw_id, outcome_type, assignment_no)
);

CREATE TABLE IF NOT EXISTS activity_submissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target_type TEXT DEFAULT '' NOT NULL,
  target_id TEXT DEFAULT '' NOT NULL,
  metadata_json TEXT DEFAULT '{}' NOT NULL,
  ip_hash TEXT DEFAULT '' NOT NULL,
  created_at TEXT DEFAULT '' NOT NULL,
  tenant_id TEXT,
  actor_user_id TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coupon_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT,
  code TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available',
  recipient_email TEXT,
  redeemed_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_access_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS external_conversions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL DEFAULT '',
  external_event_id TEXT NOT NULL,
  conversion_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  ref_code TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER,
  currency TEXT NOT NULL DEFAULT '',
  identity_type TEXT NOT NULL DEFAULT '',
  identity_value TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lottery_blacklist (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lottery_draws (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  public_slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  participation_mode TEXT NOT NULL DEFAULT 'open',
  draw_trigger TEXT NOT NULL DEFAULT 'manual',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  draw_at TEXT,
  access_password TEXT NOT NULL DEFAULT '',
  max_participants INTEGER,
  winner_count INTEGER NOT NULL DEFAULT 1,
  show_participant_count INTEGER NOT NULL DEFAULT 1,
  show_winner_count INTEGER NOT NULL DEFAULT 1,
  show_winner_list INTEGER NOT NULL DEFAULT 0,
  drawn_at TEXT,
  failure_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, draw_seed_hash TEXT NOT NULL DEFAULT '', algorithm_version TEXT NOT NULL DEFAULT 'uniform_v1', draw_seed TEXT NOT NULL DEFAULT '', product_link TEXT NOT NULL DEFAULT '{}', activity_kind TEXT NOT NULL DEFAULT 'lottery', experience_type TEXT NOT NULL DEFAULT 'wheel', result_mode TEXT NOT NULL DEFAULT 'manual', policy_version INTEGER NOT NULL DEFAULT 1, promotion_config TEXT NOT NULL DEFAULT '{}', allocation_policy TEXT NOT NULL DEFAULT 'capacity', activity_config TEXT NOT NULL DEFAULT '{}', visible INTEGER NOT NULL DEFAULT 1, max_spins_per_entry INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS lottery_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  identity_type TEXT NOT NULL DEFAULT 'email',
  identity_value TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL DEFAULT (datetime('now')), invite_code_id TEXT NOT NULL DEFAULT '', spins_left INTEGER NOT NULL DEFAULT 0, spins_total_granted INTEGER NOT NULL DEFAULT 0, spins_viral_earned INTEGER NOT NULL DEFAULT 0,
  UNIQUE(tenant_id, draw_id, identity_type, identity_value)
);

CREATE TABLE IF NOT EXISTS lottery_invite_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  code TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, draw_id, code)
);

CREATE TABLE IF NOT EXISTS lottery_prize_tiers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  prize_id TEXT NOT NULL,
  tier_name TEXT NOT NULL DEFAULT '中奖',
  winner_count INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100
, weight INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS lottery_roster_members (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  identity_type TEXT NOT NULL DEFAULT 'email',
  identity_value TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, draw_id, identity_type, identity_value)
);

CREATE TABLE IF NOT EXISTS lottery_spins (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  won INTEGER NOT NULL DEFAULT 0,
  tier_id TEXT NOT NULL DEFAULT '',
  prize_code_id TEXT NOT NULL DEFAULT '',
  prize_index INTEGER NOT NULL DEFAULT -1,
  algorithm_version TEXT NOT NULL DEFAULT 'instant_weight_v1',
  ip_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "lottery_winners" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  tier_id TEXT NOT NULL DEFAULT '',
  entry_id TEXT NOT NULL,
  spin_id TEXT NOT NULL DEFAULT '',
  identity_type TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  prize_code_id TEXT DEFAULT '',
  drawn_at TEXT NOT NULL DEFAULT (datetime('now')),
  notification_status TEXT NOT NULL DEFAULT 'pending',
  notification_error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  actor_role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  tenant_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_members (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prize_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  prize_id TEXT NOT NULL,
  code TEXT NOT NULL,
  secret TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available',
  winner_id TEXT DEFAULT '',
  issued_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, expires_at TEXT);

CREATE TABLE IF NOT EXISTS prizes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  prize_type TEXT NOT NULL DEFAULT 'code',
  total_count INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, fulfillment_note TEXT NOT NULL DEFAULT '', value_text TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS rate_limit_log (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS redemption_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'custom',
  activity_quota INTEGER NOT NULL DEFAULT 0,
  participant_quota INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 30,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS redemption_records (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL,
  code TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tenant_name TEXT NOT NULL DEFAULT '',
  activity_quota_granted INTEGER NOT NULL DEFAULT 0,
  participant_quota_granted INTEGER NOT NULL DEFAULT 0,
  duration_days_granted INTEGER NOT NULL DEFAULT 30,
  expires_at TEXT,
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS share_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  sharer_entry_id TEXT NOT NULL,
  share_code TEXT NOT NULL UNIQUE,
  clicked_count INTEGER NOT NULL DEFAULT 0,
  joined_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS tenant_usage_snapshots (
  tenant_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  activity_count INTEGER NOT NULL DEFAULT 0,
  participant_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  winner_count INTEGER NOT NULL DEFAULT 0,
  webhook_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, brand_config TEXT NOT NULL DEFAULT '{}', extra_activity_quota INTEGER NOT NULL DEFAULT 0, extra_participant_quota INTEGER NOT NULL DEFAULT 0, extra_quota_expires_at TEXT);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, email_verified INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS webhook_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["draw.completed","prize.issued"]',
  active INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, signing_secret TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  webhook_config_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  response_status INTEGER,
  response_body TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  UNIQUE(webhook_config_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_activity_events_draw_event
  ON activity_events(tenant_id, draw_id, event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_activity_events_entry
  ON activity_events(tenant_id, draw_id, entry_id, created_at);

CREATE INDEX IF NOT EXISTS idx_activity_events_ref
  ON activity_events(tenant_id, draw_id, ref_code, created_at);

CREATE INDEX IF NOT EXISTS idx_activity_outcomes_draw_status
  ON activity_outcomes(tenant_id, draw_id, outcome_type, status, sequence_no);

CREATE INDEX IF NOT EXISTS idx_activity_submissions_draw
  ON activity_submissions(tenant_id, draw_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_submissions_entry
  ON activity_submissions(tenant_id, draw_id, entry_id);

CREATE INDEX IF NOT EXISTS idx_activity_submissions_idempotency
  ON activity_submissions(tenant_id, draw_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_logs(action, created_at);

CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_logs(actor_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_admin_audit_tenant ON admin_audit_logs(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_api_key_tenant ON api_keys(tenant_id, active, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_provider_sub
  ON auth_identities (provider, provider_user_id);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user
  ON auth_identities (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blacklist_value ON lottery_blacklist(tenant_id, identity_value);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_code ON coupon_codes(tenant_id, code);

CREATE INDEX IF NOT EXISTS idx_coupon_tenant ON coupon_codes(tenant_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_draws_due
  ON lottery_draws(status, draw_at);

CREATE INDEX IF NOT EXISTS idx_draws_tenant_status
  ON lottery_draws(tenant_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_code_active
  ON email_access_codes(email, draw_id)
  WHERE used = 0;

CREATE INDEX IF NOT EXISTS idx_external_conversions_draw
  ON external_conversions(tenant_id, draw_id, conversion_type, created_at);

CREATE INDEX IF NOT EXISTS idx_external_conversions_entry
  ON external_conversions(tenant_id, draw_id, entry_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_external_conversions_event
  ON external_conversions(tenant_id, source, external_event_id);

CREATE INDEX IF NOT EXISTS idx_external_conversions_ref
  ON external_conversions(tenant_id, draw_id, ref_code, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_audit_action
  ON platform_audit_logs(action, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_audit_actor
  ON platform_audit_logs(actor_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_audit_created
  ON platform_audit_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_platform_audit_target
  ON platform_audit_logs(target_type, target_id, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_audit_tenant
  ON platform_audit_logs(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_members_status
  ON platform_members(status, role);

CREATE INDEX IF NOT EXISTS idx_prize_codes_prize_status
  ON prize_codes(tenant_id, prize_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_rate_limit_key_action
  ON rate_limit_log(key, action, created_at);

CREATE INDEX IF NOT EXISTS idx_redemption_code_status ON redemption_codes(status, expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_redemption_record_code ON redemption_records(code_id, redeemed_at);

CREATE INDEX IF NOT EXISTS idx_redemption_record_tenant ON redemption_records(tenant_id, redeemed_at);

CREATE INDEX IF NOT EXISTS idx_share_draw ON share_records(tenant_id, draw_id, created_at);

CREATE INDEX IF NOT EXISTS idx_spins_draw
  ON lottery_spins(tenant_id, draw_id, created_at);

CREATE INDEX IF NOT EXISTS idx_spins_entry
  ON lottery_spins(tenant_id, draw_id, entry_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_spins_idempotency
  ON lottery_spins(tenant_id, draw_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_tenant_usage_snapshots_date
  ON tenant_usage_snapshots(snapshot_date, tenant_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant
  ON webhook_deliveries(tenant_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_tenant ON webhook_configs(tenant_id, active, created_at);

CREATE INDEX IF NOT EXISTS idx_winners_draw
  ON lottery_winners(tenant_id, draw_id, drawn_at);

CREATE INDEX IF NOT EXISTS idx_winners_entry
  ON lottery_winners(tenant_id, draw_id, entry_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_winners_spin_unique
  ON lottery_winners(tenant_id, draw_id, spin_id);

-- DOWN
-- 基线不可回滚(回滚需手动 DROP 全部业务表)
