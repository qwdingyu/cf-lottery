-- 0046_platform_targets.sql
-- docs/167：租户内置 QQ 群助手的平台目标与投递审计表
--
-- 设计约束：
-- 1. 不扩展 webhook_configs；HTTP webhook 与平台消息投递语义分离。
-- 2. P0 只实现 QQ，字段保留 platform 便于未来接官方 QQ Bot / Telegram。
-- 3. 内置命令开关只做启停和文案覆盖，不支持租户动态新增任意命令。

-- UP
CREATE TABLE IF NOT EXISTS platform_targets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'qq',
  target_id TEXT NOT NULL,
  target_name TEXT NOT NULL DEFAULT '',
  active_draw_id TEXT NOT NULL,
  active_public_slug TEXT NOT NULL DEFAULT '',
  assistant_enabled INTEGER NOT NULL DEFAULT 1,
  adapter_deployment_mode TEXT NOT NULL DEFAULT 'tenant_hosted',
  adapter_provider TEXT NOT NULL DEFAULT 'napcat',
  adapter_config_json TEXT NOT NULL DEFAULT '{}',
  inbound_secret_hash TEXT NOT NULL DEFAULT '',
  builtin_commands_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_platform_targets_tenant
  ON platform_targets(tenant_id, platform, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_targets_target_unique
  ON platform_targets(platform, target_id);

CREATE INDEX IF NOT EXISTS idx_platform_targets_active_draw
  ON platform_targets(tenant_id, active_draw_id);

CREATE TABLE IF NOT EXISTS platform_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  platform_target_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'qq',
  target_id TEXT NOT NULL,
  event_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT NOT NULL DEFAULT '',
  response_body TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  next_retry_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_platform_deliveries_tenant_status
  ON platform_deliveries(tenant_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_deliveries_target
  ON platform_deliveries(platform_target_id, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_deliveries_event
  ON platform_deliveries(tenant_id, event_type, created_at);
