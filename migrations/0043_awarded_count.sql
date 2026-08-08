-- 0043_awarded_count.sql
-- docs/148 §四：奖档 awarded_count CAS，替代 COUNT(lottery_winners) 读改写，
-- 消除 PostgreSQL/MySQL 多写者超发风险。

-- UP
ALTER TABLE lottery_prize_tiers ADD COLUMN awarded_count INTEGER NOT NULL DEFAULT 0;

-- 回填已有活动的 awarded_count（即时开奖活动使用 lottery_winners 聚合）
UPDATE lottery_prize_tiers
SET awarded_count = (
  SELECT COUNT(*)
  FROM lottery_winners
  WHERE lottery_winners.tenant_id = lottery_prize_tiers.tenant_id
    AND lottery_winners.draw_id = lottery_prize_tiers.draw_id
    AND lottery_winners.tier_id = lottery_prize_tiers.id
)
WHERE EXISTS (
  SELECT 1
  FROM lottery_winners
  WHERE lottery_winners.tenant_id = lottery_prize_tiers.tenant_id
    AND lottery_winners.draw_id = lottery_prize_tiers.draw_id
    AND lottery_winners.tier_id = lottery_prize_tiers.id
);

-- 校验：回填后无超发（awarded_count > winner_count）
-- 若存在，需人工核查
-- SELECT id, tenant_id, draw_id, winner_count, awarded_count
-- FROM lottery_prize_tiers
-- WHERE awarded_count > winner_count;

-- DOWN
-- ALTER TABLE lottery_prize_tiers DROP COLUMN awarded_count;