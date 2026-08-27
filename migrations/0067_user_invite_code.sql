-- 用户级邀请码（docs/272）：注册时生成固定邀请码，所有活动通用
-- 解决"先参与才能分享"的鸡生蛋问题：用户注册后即可通过 ?ref={inviteCode} 分享活动链接
-- invite_code 允许 NULL（存量用户无码时为 NULL），UNIQUE 索引对 NULL 不冲突
ALTER TABLE users ADD COLUMN invite_code TEXT;
CREATE UNIQUE INDEX idx_users_invite_code ON users(invite_code);
