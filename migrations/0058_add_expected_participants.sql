-- 0058_add_expected_participants.sql
-- 预计参与人数（运营参考值，仅展示用，不参与名额/库存计算）
-- 产品链路：创建表单「预计参与」输入 → 列表 tooltip 展示

-- UP
ALTER TABLE lottery_draws ADD COLUMN expected_participants INTEGER NOT NULL DEFAULT 0;

-- DOWN
-- ALTER TABLE lottery_draws DROP COLUMN expected_participants;