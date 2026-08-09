-- 0044_bulk_wholesale_pricing.sql
-- docs/141：直付秒杀支持单笔批量购买、批发模式和阶梯定价。
-- 设计原则：保留 lottery_entries 一身份一记录，批量数量落在 payment_orders，
-- 避免移除核心 UNIQUE 约束导致普通活动去重失效。

-- UP
ALTER TABLE payment_orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
ALTER TABLE payment_orders ADD COLUMN unit_price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_orders ADD COLUMN pricing_snapshot_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE prize_codes ADD COLUMN payment_order_id TEXT;

UPDATE payment_orders
SET unit_price_cents = amount_cents
WHERE unit_price_cents = 0;

CREATE INDEX IF NOT EXISTS idx_prize_codes_payment_order
  ON prize_codes(tenant_id, payment_order_id);

-- DOWN
DROP INDEX IF EXISTS idx_prize_codes_payment_order;
-- SQLite 不安全回滚新增列；保留列避免误删支付和履约事实。
