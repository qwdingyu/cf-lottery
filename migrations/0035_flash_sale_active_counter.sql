-- 0035_flash_sale_active_counter.sql
-- docs/138：直付秒杀容量改为活动级 CAS 计数器，移除高并发热路径 COUNT。

-- UP
ALTER TABLE lottery_draws ADD COLUMN active_participant_count INTEGER NOT NULL DEFAULT 0;

-- 迁移已有直付参与事实；普通活动不依赖该计数器。
UPDATE lottery_draws
SET active_participant_count = (
  SELECT COUNT(*)
  FROM lottery_entries
  WHERE lottery_entries.tenant_id = lottery_draws.tenant_id
    AND lottery_entries.draw_id = lottery_draws.id
    AND lottery_entries.payment_status IN ('reserved', 'pending', 'paid')
)
WHERE experience_type = 'flash_sale'
   OR promotion_config LIKE '%"paymentRequired":true%';

-- DOWN
-- SQLite 不安全地回滚新增列；测试阶段保留列，避免误删活动容量事实。
