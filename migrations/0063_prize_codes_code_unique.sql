-- UP
-- P0 修复（2026-08 审查）：prize_codes 缺失 code 唯一约束，
-- importPrizeCodes 依赖"UNIQUE 约束自动跳过"是死代码，重复卡密可被静默导入并重复发放（违反验收标准）。
-- 步骤1：历史重复数据去重——同一 (tenant_id, prize_id, code) 只保留最早一条（MIN(id)），
--        其余标记 revoked（保留 winner/order 关联作为审计轨迹，运营可见需补偿的中奖者）。
UPDATE prize_codes
SET status = 'revoked'
WHERE id IN (
  SELECT pc.id
  FROM prize_codes pc
  JOIN (
    SELECT tenant_id, prize_id, code, MIN(id) AS keep_id
    FROM prize_codes
    GROUP BY tenant_id, prize_id, code
    HAVING COUNT(*) > 1
  ) dup ON pc.tenant_id = dup.tenant_id
       AND pc.prize_id = dup.prize_id
       AND pc.code = dup.code
  WHERE pc.id <> dup.keep_id
);

-- 步骤2：建立硬唯一约束（PARTIAL——只约束可发放/已发放状态）。
-- ⚠️ 上线前关键修复（2026-08 上线预演发现）：若用全局 UNIQUE，去重时被标记 revoked 的
-- 多余行之间（同 code 同租户）仍互相重复，CREATE UNIQUE INDEX 会失败 → server.ts 启动迁移
-- 失败 → 进程退出（生产不可用）。revoked/expired 是终态审计行，不再参与发放，
-- 不参与唯一约束；available/issued/reserved 必须唯一（防重复发放）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_prize_codes_tenant_prize_code
  ON prize_codes (tenant_id, prize_id, code)
  WHERE status IN ('available', 'issued', 'reserved');

-- DOWN
DROP INDEX IF EXISTS idx_prize_codes_tenant_prize_code;
