-- 0059_audit_logs_created_at_index.sql
-- H1: audit_logs 表加 createdAt 索引
-- 背景：runRetentionCleanup 按 createdAt 批量删除，无索引时全表扫描随审计日志增长变慢。
-- 索引名：idx_audit_logs_created

-- UP
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

-- DOWN
-- DROP INDEX IF EXISTS idx_audit_logs_created;