-- UP
-- 防止并发结算双倍写入（docs/274 F-1）：
-- activity_events 表增加 UNIQUE(tenant_id, draw_id, entry_id, event_type, ref_code) 约束。
-- settleRewardByPercent / cancelRewardPending 的 SELECT-then-INSERT 幂等性依赖此约束
-- 作为最后一道防线：并发事务中第二个 INSERT 触发约束冲突，被 .catch() 静默降级。

-- 步骤1：历史重复数据去重——同一 (tenant_id, draw_id, entry_id, event_type, ref_code)
-- 只保留最早一条（MIN(id)），其余删除（审计日志场景下重复行无保留价值，
-- 与 prize_codes 的 revoked 保留策略不同——奖励事件无"已发放"关联需要保留）。
DELETE FROM activity_events
WHERE id NOT IN (
  SELECT MIN(id)
  FROM activity_events
  GROUP BY tenant_id, draw_id, entry_id, event_type, ref_code
);

-- 步骤2：建立硬唯一约束
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_reward_unique
  ON activity_events (tenant_id, draw_id, entry_id, event_type, ref_code);

-- DOWN
DROP INDEX IF EXISTS idx_activity_events_reward_unique;
