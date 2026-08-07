-- 修复运行期索引语义，避免把性能索引误变成业务唯一约束。
--
-- 背景：
-- 1. prize_codes / lottery_draws 的索引用于列表、扫描和定时任务查询，本来允许重复业务组合。
-- 2. email_access_codes 只需要限制“同一邮箱同一活动只能有一个未使用验证码”，历史 used=1 记录应允许保留多条。
-- 3. Drizzle schema 若误写 uniqueIndex，后续生成迁移会制造隐藏的唯一约束灾难。

DROP INDEX IF EXISTS idx_prize_codes_prize_status;
CREATE INDEX IF NOT EXISTS idx_prize_codes_prize_status
  ON prize_codes(tenant_id, prize_id, status, created_at);

DROP INDEX IF EXISTS idx_draws_tenant_status;
CREATE INDEX IF NOT EXISTS idx_draws_tenant_status
  ON lottery_draws(tenant_id, status, created_at DESC);

DROP INDEX IF EXISTS idx_draws_due;
CREATE INDEX IF NOT EXISTS idx_draws_due
  ON lottery_draws(status, draw_at);

DROP INDEX IF EXISTS idx_email_code_draw;
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_code_active
  ON email_access_codes(email, draw_id)
  WHERE used = 0;
