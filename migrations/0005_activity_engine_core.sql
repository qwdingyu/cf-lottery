-- 活动引擎核心字段：先让抽奖成为 activity_kind 的一种，后续可扩展接龙/预约/投票等模式。
ALTER TABLE lottery_draws ADD COLUMN activity_kind TEXT NOT NULL DEFAULT 'lottery';
ALTER TABLE lottery_draws ADD COLUMN experience_type TEXT NOT NULL DEFAULT 'wheel';
ALTER TABLE lottery_draws ADD COLUMN result_mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE lottery_draws ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE lottery_draws ADD COLUMN promotion_config TEXT NOT NULL DEFAULT '{}';

-- 保持旧活动的前端体验不变：原先由 participation_mode 隐式决定游戏组件。
UPDATE lottery_draws
SET experience_type = CASE participation_mode
  WHEN 'invite_code' THEN 'slot'
  WHEN 'password' THEN 'scratch'
  WHEN 'roster' THEN 'card'
  ELSE 'wheel'
END;

-- result_mode 是长期字段；现阶段从旧 draw_trigger 派生，避免将来再解释历史数据。
UPDATE lottery_draws
SET result_mode = CASE
  WHEN draw_trigger IN ('manual', 'scheduled') THEN draw_trigger
  ELSE 'manual'
END;
