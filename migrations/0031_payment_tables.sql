-- 0031_payment_tables.sql
-- docs/131：秒杀卡密多租户直付 - 新增租户配置表（通用，providers 承载支付配置）+ 支付订单表
-- tenant_configs：按租户隔离配置（providers JSON 支持多渠道，凭据加密 enc:，未来可加其他模块配置）
-- payment_orders：订单表（entryId UNIQUE 一参与一订单，防重复下单/回调）

-- UP
CREATE TABLE IF NOT EXISTS tenant_configs (
  tenant_id TEXT PRIMARY KEY,
  providers TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'cny',
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT NOT NULL,
  provider_trade_no TEXT,
  prize_code_id TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_tenant ON payment_orders(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status, created_at);

-- DOWN
DROP TABLE IF EXISTS payment_orders;
DROP TABLE IF EXISTS tenant_configs;
