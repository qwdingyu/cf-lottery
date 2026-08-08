-- 0038_payment_trade_no_unique.sql
-- 支付平台交易号收口为数据库唯一事实键，避免同一租户同一渠道下重复 trade_no 串单。

-- UP
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_provider_trade_no
  ON payment_orders(tenant_id, provider, provider_trade_no);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_order_attempts_provider_trade_no
  ON payment_order_attempts(tenant_id, provider, provider_trade_no);

-- DOWN
DROP INDEX IF EXISTS idx_payment_order_attempts_provider_trade_no;
DROP INDEX IF EXISTS idx_payment_orders_provider_trade_no;
