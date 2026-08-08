-- 0037_reconcile_paid_fulfillment_entry_status.sql
--
-- 背景：早期回调实现曾把“已收款但码池为空”的 entry 写成 paid，
-- 但用户约定的 paid 必须同时满足“已支付并完成发卡”。
-- 只修正仍然没有 prizeCodeId 的履约失败订单；已发卡订单不受影响。

-- UP
UPDATE lottery_entries
SET payment_status = 'paid_fulfillment_failed'
WHERE payment_status = 'paid'
  AND EXISTS (
    SELECT 1
    FROM payment_orders
    WHERE payment_orders.entry_id = lottery_entries.id
      AND payment_orders.tenant_id = lottery_entries.tenant_id
      AND payment_orders.draw_id = lottery_entries.draw_id
      AND payment_orders.status = 'paid_fulfillment_failed'
      AND payment_orders.prize_code_id IS NULL
  );

-- 该迁移只做事实纠正，不提供 DOWN，避免回滚再次制造错误的 paid 语义。
