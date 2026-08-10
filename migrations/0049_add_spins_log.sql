-- UP
-- spins 流水日志（docs/172 §5.5 P1）：审计 spins 每次变动，支持 reason 和 refId 关联。
CREATE TABLE spins_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 按租户+entry 查流水
CREATE INDEX idx_spins_log_entry ON spins_log(tenant_id, entry_id);
-- 按租户+用户查流水
CREATE INDEX idx_spins_log_user ON spins_log(tenant_id, user_id);
-- 按租户+原因+时间查流水（如 audit：查某段时间内的签到奖励发放）
CREATE INDEX idx_spins_log_reason ON spins_log(tenant_id, reason, created_at);

-- DOWN
DROP INDEX IF EXISTS idx_spins_log_reason;
DROP INDEX IF EXISTS idx_spins_log_user;
DROP INDEX IF EXISTS idx_spins_log_entry;
DROP TABLE IF EXISTS spins_log;