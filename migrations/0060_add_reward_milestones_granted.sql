-- UP
-- 推荐奖励阶梯已发放里程碑（P0，docs/216 §7.1）
-- 幂等存储：每个 shareRecordId + requireCount 组合只发放一次奖励
ALTER TABLE share_records ADD COLUMN reward_milestones_granted TEXT NOT NULL DEFAULT '[]';

-- DOWN
-- ALTER TABLE share_records DROP COLUMN reward_milestones_granted;