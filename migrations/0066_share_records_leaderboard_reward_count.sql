-- UP
-- 排行榜 bonus_coupon 已发张数（docs/270 P1 修复）：
-- 码池不足时部分发放后，按 rewardValue - rewardedCount 续发差额，防止券永久丢失
ALTER TABLE share_records ADD COLUMN leaderboard_rewarded_count INTEGER NOT NULL DEFAULT 0;

-- DOWN
-- ALTER TABLE share_records DROP COLUMN leaderboard_rewarded_count;
