-- 0042_external_conversions_occurred_index.sql
-- docs/155 P3-3：ROI 仪表盘查询 WHERE tenant_id=? AND occurred_at>=? 此前 occurred_at 不在索引中
-- 需回表过滤；此索引把 O(N) 降到 O(log N)，覆盖 dashboard_roi_days 窗口聚合与 conversionType 分组。

-- UP
CREATE INDEX IF NOT EXISTS idx_external_conversions_occurred
ON external_conversions(tenant_id, occurred_at);

-- DOWN
DROP INDEX IF EXISTS idx_external_conversions_occurred;