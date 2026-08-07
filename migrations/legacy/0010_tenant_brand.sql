-- 白标/品牌配置（JSON 格式：{logo, primaryColor, companyName, domain}）
ALTER TABLE tenants ADD COLUMN brand_config TEXT NOT NULL DEFAULT '{}';