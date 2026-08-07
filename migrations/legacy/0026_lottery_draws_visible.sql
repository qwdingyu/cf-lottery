-- UP
-- 公开展示开关：与 status / 时间窗独立（docs/083）
-- 1=用户面可见；0=公开列表/详情拒绝；管理端始终可见
ALTER TABLE lottery_draws ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;

-- DOWN
ALTER TABLE lottery_draws DROP COLUMN visible;
