-- UP
-- 连续签到天数（docs/172）：用于连续签到递增奖励计算
ALTER TABLE lottery_entries ADD COLUMN checkin_streak INTEGER NOT NULL DEFAULT 0;

-- DOWN
-- ALTER TABLE lottery_entries DROP COLUMN checkin_streak;