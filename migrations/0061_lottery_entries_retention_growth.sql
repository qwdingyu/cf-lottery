-- UP
-- 保底机制（docs/218 模式一）：连续未中奖次数，事务内与抽奖结果同步更新
ALTER TABLE lottery_entries ADD COLUMN consecutive_no_win_spins INTEGER NOT NULL DEFAULT 0;

-- 每日免费抽奖（docs/218 模式二）：每日首次 spin 免费，原子条件 UPDATE 去重
ALTER TABLE lottery_entries ADD COLUMN last_daily_free_spin_at TEXT;

-- DOWN
-- ALTER TABLE lottery_entries DROP COLUMN consecutive_no_win_spins;
-- ALTER TABLE lottery_entries DROP COLUMN last_daily_free_spin_at;