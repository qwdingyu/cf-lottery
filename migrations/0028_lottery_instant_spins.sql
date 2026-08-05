-- UP
-- docs/116 / docs/117：lottery×instant 结果机 schema
-- 1) lottery_spins：每次 spin 一行（含未中），幂等键唯一
-- 2) lottery_winners：支持一人多奖（按 spin_id 唯一；旧行 spin_id=自身 id）
-- 3) lottery_entries：spins_left / spins_total_granted / spins_viral_earned
-- 4) lottery_draws.max_spins_per_entry：活动级抽奖次数硬顶（≥1 时 instant 生效；0=未配置）
-- 5) lottery_prize_tiers.weight：即时加权（0=不参与即时抽样，delayed 忽略）

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_spins_idempotency
  ON lottery_spins(tenant_id, draw_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_spins_entry
  ON lottery_spins(tenant_id, draw_id, entry_id, created_at);

CREATE INDEX IF NOT EXISTS idx_spins_draw
  ON lottery_spins(tenant_id, draw_id, created_at);

-- 重建 winners：去掉「每 entry 一条」表级 UNIQUE，改为按 spin_id 唯一（多奖）
-- 旧数据 spin_id 填 winner.id，保证唯一且可追溯
CREATE TABLE lottery_winners__instant_mig (
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

INSERT INTO lottery_winners__instant_mig (
  id, tenant_id, draw_id, tier_id, entry_id, spin_id,
  identity_type, identity_value, prize_code_id, drawn_at,
  notification_status, notification_error
)
SELECT
  id, tenant_id, draw_id, COALESCE(tier_id, ''), entry_id, id,
  identity_type, identity_value, prize_code_id, drawn_at,
  notification_status, notification_error
FROM lottery_winners;

DROP TABLE lottery_winners;

ALTER TABLE lottery_winners__instant_mig RENAME TO lottery_winners;

CREATE UNIQUE INDEX IF NOT EXISTS idx_winners_spin_unique
  ON lottery_winners(tenant_id, draw_id, spin_id);

CREATE INDEX IF NOT EXISTS idx_winners_entry
  ON lottery_winners(tenant_id, draw_id, entry_id);

CREATE INDEX IF NOT EXISTS idx_winners_draw
  ON lottery_winners(tenant_id, draw_id, drawn_at);

ALTER TABLE lottery_entries ADD COLUMN spins_left INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lottery_entries ADD COLUMN spins_total_granted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lottery_entries ADD COLUMN spins_viral_earned INTEGER NOT NULL DEFAULT 0;

-- 0 = 未配置 instant 次数（delayed 默认）；instant 发布预检要求 ≥1
ALTER TABLE lottery_draws ADD COLUMN max_spins_per_entry INTEGER NOT NULL DEFAULT 0;

ALTER TABLE lottery_prize_tiers ADD COLUMN weight INTEGER NOT NULL DEFAULT 0;

-- DOWN
DROP INDEX IF EXISTS idx_spins_draw;
DROP INDEX IF EXISTS idx_spins_entry;
DROP INDEX IF EXISTS idx_spins_idempotency;
DROP TABLE IF EXISTS lottery_spins;

-- 回滚 winners 较重：保留多奖数据时无法无损恢复 entry 唯一；仅文档占位
-- ALTER 列在 SQLite 旧版不可随意 DROP，生产回滚需备份恢复
