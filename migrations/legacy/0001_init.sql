-- UP
-- SaaS 多租户
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tenant_members (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id)
);

-- 奖品与码池
CREATE TABLE prizes (
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
);

CREATE TABLE prize_codes (
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
);

CREATE INDEX idx_prize_codes_prize_status ON prize_codes(tenant_id, prize_id, status, created_at);

-- 抽奖活动
CREATE TABLE lottery_draws (
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
);

CREATE INDEX idx_draws_tenant_status ON lottery_draws(tenant_id, status, created_at DESC);
CREATE INDEX idx_draws_due ON lottery_draws(status, draw_at);

-- 候选池与中奖记录
CREATE TABLE lottery_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  identity_type TEXT NOT NULL DEFAULT 'email',
  identity_value TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, draw_id, identity_type, identity_value)
);

CREATE TABLE lottery_winners (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  prize_code_id TEXT DEFAULT '',
  drawn_at TEXT NOT NULL DEFAULT (datetime('now')),
  notification_status TEXT NOT NULL DEFAULT 'pending',
  notification_error TEXT NOT NULL DEFAULT '',
  UNIQUE(tenant_id, draw_id, entry_id)
);

-- 审计日志
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- DOWN
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS lottery_winners;
DROP TABLE IF EXISTS lottery_entries;
DROP TABLE IF EXISTS lottery_draws;
DROP TABLE IF EXISTS prize_codes;
DROP TABLE IF EXISTS prizes;
DROP TABLE IF EXISTS tenant_members;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;
