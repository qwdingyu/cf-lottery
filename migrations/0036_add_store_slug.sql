-- 0036_add_store_slug.sql
-- docs/142：店铺首页 - 新增租户店铺公开 Slug
-- store_slug 作为公开 URL 标识，不暴露内部 ID，与 public_slug 模式一致

-- UP
ALTER TABLE tenants ADD COLUMN store_slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_store_slug ON tenants(store_slug);

-- 为已有租户自动生成默认 slug（shop_ + 8 位 ID 前缀）
UPDATE tenants SET store_slug = 'shop_' || substr(id, 1, 8) WHERE store_slug IS NULL;

-- DOWN
DROP INDEX IF EXISTS idx_tenants_store_slug;