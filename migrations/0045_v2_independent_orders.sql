-- 0045_v2_independent_orders.sql
-- docs/158：V2 独立订单/订单项模型
--
-- 核心变更：
-- 1. payment_orders.entry_id 去掉 UNIQUE 约束 → 普通索引，支持同一参与身份多笔订单
-- 2. payment_orders 新增购买身份快照列（buyer_identity_type/value/display_name）
-- 3. payment_orders 移除 prize_code_id（改由 order_items 承载）
-- 4. 新增 payment_order_items 表，每行 = 一个已购单元，履约后绑定 prize_code_id
--
-- 注意：SQLite 不支持 ALTER TABLE DROP CONSTRAINT，必须重建表。
-- 所有操作在事务内完成，避免数据丢失。

-- UP
BEGIN TRANSACTION;

-- 1. 重建 payment_orders：去掉 entry_id UNIQUE，新增 buyer snapshot，移除 prize_code_id
CREATE TABLE IF NOT EXISTS payment_orders_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  buyer_identity_type TEXT NOT NULL DEFAULT 'email',
  buyer_identity_value TEXT NOT NULL DEFAULT '',
  buyer_display_name TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  pricing_snapshot_json TEXT NOT NULL DEFAULT '{}',
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'cny',
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT NOT NULL,
  provider_trade_no TEXT,
  current_attempt_id TEXT,
  access_token_hash TEXT,
  access_token_expires_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO payment_orders_new (
  id, tenant_id, draw_id, entry_id,
  buyer_identity_type, buyer_identity_value, buyer_display_name,
  quantity, unit_price_cents, pricing_snapshot_json,
  amount_cents, currency, status, provider, provider_trade_no,
  current_attempt_id, access_token_hash, access_token_expires_at,
  paid_at, created_at, updated_at
)
SELECT
  po.id, po.tenant_id, po.draw_id, po.entry_id,
  COALESCE(e.identity_type, 'email'), COALESCE(e.identity_value, ''), COALESCE(e.display_name, ''),
  po.quantity, po.unit_price_cents, po.pricing_snapshot_json,
  po.amount_cents, po.currency, po.status, po.provider, po.provider_trade_no,
  po.current_attempt_id, po.access_token_hash, po.access_token_expires_at,
  po.paid_at, po.created_at, po.updated_at
FROM payment_orders po
LEFT JOIN lottery_entries e ON e.id = po.entry_id AND e.tenant_id = po.tenant_id;

DROP TABLE payment_orders;
ALTER TABLE payment_orders_new RENAME TO payment_orders;

CREATE INDEX IF NOT EXISTS idx_payment_orders_tenant ON payment_orders(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_orders_tenant_status_created ON payment_orders(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_orders_current_attempt ON payment_orders(current_attempt_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_entry ON payment_orders(tenant_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_buyer_identity ON payment_orders(tenant_id, draw_id, buyer_identity_value);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_provider_trade_no
  ON payment_orders(tenant_id, provider, provider_trade_no)
  WHERE provider_trade_no IS NOT NULL AND provider_trade_no <> '';

-- 2. 新增 payment_order_items 表
CREATE TABLE IF NOT EXISTS payment_order_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  payment_order_id TEXT NOT NULL,
  prize_code_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_order_items_order ON payment_order_items(tenant_id, payment_order_id);
CREATE INDEX IF NOT EXISTS idx_payment_order_items_prize_code ON payment_order_items(tenant_id, prize_code_id);

-- 3. 迁移存量订单：对每笔已支付/已发卡订单，按 quantity 创建订单项（绑定已发卡密）
-- 确保存量数据在 V2 模型下仍可查询
INSERT INTO payment_order_items (
  id, tenant_id, draw_id, payment_order_id, prize_code_id, status, unit_price_cents, created_at, updated_at
)
SELECT
  (po.id || '-' || printf('%03d', seq.i)),
  po.tenant_id,
  po.draw_id,
  po.id,
  CASE WHEN seq.i = 1 THEN po.prize_code_id ELSE NULL END,
  CASE WHEN po.status IN ('paid', 'paid_fulfillment_failed') THEN 'fulfilled' ELSE 'pending' END,
  po.unit_price_cents,
  po.created_at,
  po.updated_at
FROM payment_orders po
CROSS JOIN (
  SELECT 1 AS i UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
  UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8
  UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12
  UNION ALL SELECT 13 UNION ALL SELECT 14 UNION ALL SELECT 15 UNION ALL SELECT 16
  UNION ALL SELECT 17 UNION ALL SELECT 18 UNION ALL SELECT 19 UNION ALL SELECT 20
) seq
WHERE seq.i <= po.quantity;

COMMIT;

-- DOWN
-- 回滚脚本：删除 order_items 表，重建 payment_orders 回到 V1 结构
-- 注意：会丢失 buyer snapshot 数据，仅在测试/开发环境使用
-- BEGIN TRANSACTION;
-- DROP TABLE IF EXISTS payment_order_items;
-- DROP TABLE IF EXISTS payment_orders;
-- -- 用 0031-0039 迁移重建 V1 表（此处省略，实际回滚走完整基线）
-- COMMIT;