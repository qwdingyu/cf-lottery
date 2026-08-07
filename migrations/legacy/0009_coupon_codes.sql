-- 优惠券码池（唯一码，支持核销）
CREATE TABLE IF NOT EXISTS coupon_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT,
  code TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available',
  recipient_email TEXT,
  redeemed_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coupon_tenant ON coupon_codes(tenant_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_code ON coupon_codes(tenant_id, code);