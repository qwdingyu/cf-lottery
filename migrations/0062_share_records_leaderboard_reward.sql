-- UP
-- 排行榜奖励（docs/218 模式三）：同活动、同 shareRecord CAS 幂等，防止并发重复发放
ALTER TABLE share_records ADD COLUMN leaderboard_rewarded_at TEXT NOT NULL DEFAULT '';

-- DOWN
-- ALTER TABLE share_records DROP COLUMN leaderboard_rewarded_at;