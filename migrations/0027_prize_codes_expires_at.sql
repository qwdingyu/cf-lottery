-- UP
-- 奖品卡密过期时间（docs/111 §7.3）：限时卡密奖品（月卡/体验券/7天会员卡）刚需字段。
-- 可空，空 = 永不过期，兼容现有卡密数据。
ALTER TABLE prize_codes ADD COLUMN expires_at TEXT;

-- DOWN
ALTER TABLE prize_codes DROP COLUMN expires_at;
