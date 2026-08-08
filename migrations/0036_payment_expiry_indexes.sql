-- 0036_payment_expiry_indexes.sql
-- 支付超时懒清理按租户、状态和创建时间筛选；补齐高并发下的索引路径。

-- UP
CREATE INDEX IF NOT EXISTS idx_payment_orders_tenant_status_created
  ON payment_orders(tenant_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_lottery_entries_tenant_payment_joined
  ON lottery_entries(tenant_id, payment_status, joined_at);

-- DOWN
DROP INDEX IF EXISTS idx_lottery_entries_tenant_payment_joined;
DROP INDEX IF EXISTS idx_payment_orders_tenant_status_created;
