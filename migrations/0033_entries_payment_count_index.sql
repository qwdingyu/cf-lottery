-- 0033_entries_payment_count_index.sql
-- docs/134：秒杀直付高并发优化
-- 为参与截单 COUNT 和公开秒杀进度提供 tenant + draw + payment_status 复合索引。
-- 0032 已有 draw_id + payment_status 索引；本索引补齐租户维度，匹配热路径 WHERE tenant_id + draw_id。

-- UP
CREATE INDEX IF NOT EXISTS idx_entries_tenant_draw_payment_status
  ON lottery_entries(tenant_id, draw_id, payment_status);

-- DOWN
DROP INDEX IF EXISTS idx_entries_tenant_draw_payment_status;
