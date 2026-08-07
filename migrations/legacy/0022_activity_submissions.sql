-- 活动提交表（问卷答案、投票选项、资料领取请求等动态表单 payload）。
-- 033 基线要求：所有玩法的动态表单答案统一走 activity_submissions，
-- 不做独立的 forms / votes / claims 表。
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

-- 一个 entry 最多一条提交；join 同事务写入时利用此约束防重复
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_submissions_entry
  ON activity_submissions(tenant_id, draw_id, entry_id);

-- 后台查询某个活动下所有提交记录
CREATE INDEX IF NOT EXISTS idx_activity_submissions_draw
  ON activity_submissions(tenant_id, draw_id, created_at);

-- 幂等键索引（P2 阶段启用）
CREATE INDEX IF NOT EXISTS idx_activity_submissions_idempotency
  ON activity_submissions(tenant_id, draw_id, idempotency_key);
