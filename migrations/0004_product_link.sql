-- 导流：关联商品推广链接（JSON 格式：{url, title, imageUrl, price}）
ALTER TABLE lottery_draws ADD COLUMN product_link TEXT NOT NULL DEFAULT '{}';