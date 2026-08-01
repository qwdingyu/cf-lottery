-- 活动玩法配置字段。
--
-- 只在 lottery_draws 上增加一个版本化 JSON 字段，不新增 forms/votes 等重表。
-- 设计目的：让问卷字段、投票选项、资料领取字段都能复用同一个轻量配置入口，
-- 并在公开提交时由后端按配置做白名单校验。
ALTER TABLE lottery_draws ADD COLUMN activity_config TEXT NOT NULL DEFAULT '{}';

