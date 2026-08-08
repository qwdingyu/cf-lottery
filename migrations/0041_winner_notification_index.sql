-- 0041_winner_notification_index.sql
-- 卡密库存预警闭环：lotteryWinners 通知状态索引 + 重试计数

-- UP
CREATE INDEX IF NOT EXISTS idx_winners_notification_status 
ON lottery_winners(tenant_id, notification_status);

ALTER TABLE lottery_winners ADD COLUMN notification_retry_count INTEGER NOT NULL DEFAULT 0;

-- DOWN
DROP INDEX IF EXISTS idx_winners_notification_status;
ALTER TABLE lottery_winners DROP COLUMN notification_retry_count;