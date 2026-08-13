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

-- 步骤2：建立硬唯一约束，后续导入的重复码直接拒绝（importPrizeCodes 显式查重 + 此约束双保险）
CREATE UNIQUE INDEX IF NOT EXISTS idx_prize_codes_tenant_prize_code
  ON prize_codes (tenant_id, prize_id, code);

-- DOWN
DROP INDEX IF EXISTS idx_prize_codes_tenant_prize_code;
