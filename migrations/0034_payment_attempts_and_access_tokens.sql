-- 0034_payment_attempts_and_access_tokens.sql
-- docs/138：逻辑支付订单与外部支付尝试分离，并使用短期订单访问令牌。

-- UP
ALTER TABLE payment_orders ADD COLUMN current_attempt_id TEXT;
ALTER TABLE payment_orders ADD COLUMN access_token_hash TEXT;
ALTER TABLE payment_orders ADD COLUMN access_token_expires_at TEXT;

CREATE TABLE IF NOT EXISTS payment_order_attempts (
  id TEXT PRIMARY KEY,
  payment_order_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  provider TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'cny',
  status TEXT NOT NULL DEFAULT 'pending',
  provider_trade_no TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(payment_order_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_current_attempt
  ON payment_orders(current_attempt_id);
CREATE INDEX IF NOT EXISTS idx_payment_order_attempts_tenant_status
  ON payment_order_attempts(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_order_attempts_order
  ON payment_order_attempts(payment_order_id, created_at);

-- 测试阶段直接收口模型；对已存在的订单建立一次初始 attempt，避免迁移后遗留孤儿事实。
INSERT INTO payment_order_attempts (
  id, payment_order_id, tenant_id, draw_id, attempt_no, provider, amount_cents, currency,
  status, provider_trade_no, paid_at, created_at, updated_at
)
SELECT
  id,
  id,
  tenant_id,
  draw_id,
  1,
  provider,
  amount_cents,
  currency,
  CASE
    WHEN status IN ('paid', 'paid_fulfillment_failed') THEN 'paid'
    WHEN status = 'paid_late_needs_refund' THEN 'paid_late_needs_refund'
    WHEN status IN ('expired', 'cancelled') THEN 'expired'
    ELSE 'pending'
  END,
  provider_trade_no,
  paid_at,
  created_at,
  updated_at
FROM payment_orders
WHERE NOT EXISTS (
  SELECT 1
  FROM payment_order_attempts
  WHERE payment_order_attempts.payment_order_id = payment_orders.id
);

UPDATE payment_orders
SET current_attempt_id = id
WHERE current_attempt_id IS NULL;

-- DOWN
DROP INDEX IF EXISTS idx_payment_order_attempts_order;
DROP INDEX IF EXISTS idx_payment_order_attempts_tenant_status;
DROP INDEX IF EXISTS idx_payment_orders_current_attempt;
DROP TABLE IF EXISTS payment_order_attempts;
-- SQLite 不安全地回滚新增列；测试阶段保留列，避免误删支付事实。
