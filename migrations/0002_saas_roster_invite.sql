-- UP
-- 补齐 084 文档要求的 SaaS 表结构

-- 多奖项支持
CREATE TABLE lottery_prize_tiers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  prize_id TEXT NOT NULL,
  tier_name TEXT NOT NULL DEFAULT '中奖',
  winner_count INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100
);

-- 限定名单模式
CREATE TABLE lottery_roster_members (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  identity_type TEXT NOT NULL DEFAULT 'email',
  identity_value TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, draw_id, identity_type, identity_value)
);

-- 邀请码模式
CREATE TABLE lottery_invite_codes (
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

-- 抽奖活动增加公平性字段
ALTER TABLE lottery_draws ADD COLUMN draw_seed_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE lottery_draws ADD COLUMN algorithm_version TEXT NOT NULL DEFAULT 'uniform_v1';

-- 中奖记录增加多奖项关联
ALTER TABLE lottery_winners ADD COLUMN tier_id TEXT NOT NULL DEFAULT '';

-- 奖品增加履约说明
ALTER TABLE prizes ADD COLUMN fulfillment_note TEXT NOT NULL DEFAULT '';

-- 候选池增加邀请码关联
ALTER TABLE lottery_entries ADD COLUMN invite_code_id TEXT NOT NULL DEFAULT '';

-- DOWN
ALTER TABLE lottery_entries DROP COLUMN invite_code_id;
ALTER TABLE prizes DROP COLUMN fulfillment_note;
ALTER TABLE lottery_winners DROP COLUMN tier_id;
ALTER TABLE lottery_draws DROP COLUMN algorithm_version;
ALTER TABLE lottery_draws DROP COLUMN draw_seed_hash;
DROP TABLE IF EXISTS lottery_invite_codes;
DROP TABLE IF EXISTS lottery_roster_members;
DROP TABLE IF EXISTS lottery_prize_tiers;