-- 0051_add_draw_id_to_access_tokens.sql
-- P0-1 安全修复：跨租户隔离
-- 令牌绑定 drawId，public-access.ts 查询时按 drawId 过滤，防止同一 userId 跨租户看到其他租户的卡密
-- 空字符串 '' 表示不限制（向后兼容已存令牌）

-- UP
ALTER TABLE access_tokens ADD COLUMN draw_id TEXT NOT NULL DEFAULT '';

-- DOWN
-- SQLite 不支持 DROP COLUMN，回滚需重建表
-- 此处不提供 DOWN 脚本，迁移不可逆