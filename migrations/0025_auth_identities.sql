-- UP
-- 外部 IdP（cf-auth）身份绑定表：本地 users.id ↔ IdP sub
-- 见 docs/062；JWT.sub 使用本地 user id，create-tenant 才能 FK/成员关系闭环。

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_provider_sub
  ON auth_identities (provider, provider_user_id);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user
  ON auth_identities (user_id);

-- DOWN
DROP INDEX IF EXISTS idx_auth_identities_user;
DROP INDEX IF EXISTS idx_auth_identities_provider_sub;
DROP TABLE IF EXISTS auth_identities;
