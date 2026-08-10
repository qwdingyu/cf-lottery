-- 0056_export_and_large_table_indexes.sql
-- docs/187：导出和大表风险收口。
-- 参与名单的后台分页/CSV 分批导出按 tenant_id + draw_id + joined_at 读取；
-- 单靠 UNIQUE(tenant_id, draw_id, identity_type, identity_value) 不能覆盖时间排序。

-- UP
CREATE INDEX IF NOT EXISTS idx_entries_tenant_draw_joined
  ON lottery_entries (tenant_id, draw_id, joined_at);

-- DOWN
DROP INDEX IF EXISTS idx_entries_tenant_draw_joined;
