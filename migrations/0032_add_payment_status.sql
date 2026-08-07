-- 0032_add_payment_status.sql
-- docs/131 §8：软释放 - 名额释放（支付超时后不占 claimed 统计）
-- 新增 lottery_entries.payment_status 字段，奠定软释放基础

-- UP
ALTER TABLE lottery_entries ADD COLUMN payment_status TEXT NOT NULL DEFAULT '';

-- 索引：秒杀活动统计 claimed 时需按 drawId + payment_status 过滤
CREATE INDEX IF NOT EXISTS idx_entries_payment_status ON lottery_entries(draw_id, payment_status);

-- DOWN
DROP INDEX IF EXISTS idx_entries_payment_status;
-- SQLite 不支持直接 DROP COLUMN，保留此列（无默认值，无影响）