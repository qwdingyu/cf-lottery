-- 用户邮箱验证状态。
--
-- schema.ts 与注册/登录逻辑已经依赖 users.email_verified。
-- 该列必须进入正式迁移，避免新环境或测试库只跑 migrations 后缺字段。
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

