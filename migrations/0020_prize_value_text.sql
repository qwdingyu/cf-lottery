-- 奖品展示价值文案。
-- 该字段只用于运营侧和活动页展示，例如“价值 199 元”“50 USDT”。
-- 不参与金额计算、结算或财务统计，避免把营销文案误当成可计算价格。
ALTER TABLE prizes ADD COLUMN value_text TEXT NOT NULL DEFAULT '';
