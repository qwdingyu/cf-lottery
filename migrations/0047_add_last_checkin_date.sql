-- 0047_add_last_checkin_date.sql
-- docs/171：签到积分与抽奖次数体系打通
-- 新增 lottery_entries.last_checkin_date 列，用于并发安全的每日签到去重。
--
-- 为什么需要这一列（而不是用 activity_events 去重）：
-- 1. 原实现用 SELECT(查今天事件) + UPDATE(spinsLeft) + INSERT(事件) 三步，
--    存在 TOCTOU 竞态：两个并发 /签到 可同时通过 SELECT 检查，导致双倍发放。
-- 2. 增加 last_checkin_date 后，用单条条件 UPDATE：
--      UPDATE lottery_entries
--        SET spins_left = spins_left + ?, last_checkin_date = ?
--        WHERE id = ? AND tenant_id = ?
--          AND (last_checkin_date IS NULL OR last_checkin_date < today)
--    spins 累加与 last_checkin_date 在同一条 UPDATE 原子完成；
--    WHERE 条件保证只有第一个并发请求命中，第二个影响 0 行即判定"今日已签到"。
-- 3. activity_events 仅保留 daily_checkin 事件用于数据分析，不再承担去重职责，
--    因此无需给 activity_events 加 UNIQUE（加了反而会阻止合法的跨天多次签到）。

-- UP
ALTER TABLE lottery_entries ADD COLUMN last_checkin_date TEXT;

-- DOWN
-- SQLite 不支持直接 DROP COLUMN；保留此列无副作用（NULL 等价于从未签到）。