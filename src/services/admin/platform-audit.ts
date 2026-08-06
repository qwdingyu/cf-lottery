import { writeAdminAudit } from "@usethink/cf-core/audit";
import type { DbType, DbWriteScope } from "../../db/client";

type PlatformAuditInput = {
  actorUserId: string;
  actorRole?: string;
  action: string;
  targetType: string;
  targetId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * 写入平台审计日志（docs/091 P1-13：统一到 cf-core writeAdminAudit + admin_audit_logs）。
 * actorRole 作为 metadata 扩展字段保存（core adminAuditLogs 无 actorRole 列）。
 * 租户维度通过 tenantId 写入 core 表的 tenant_id 列（P1-13 已加列）。
 */
export async function writePlatformAudit(db: DbType | DbWriteScope, input: PlatformAuditInput): Promise<void> {
  const metadata = { ...input.metadata, actorRole: input.actorRole };
  return writeAdminAudit(db as any, {
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId || "",
    metadata,
    ipHash: "",
    tenantId: input.tenantId || undefined,
    actorUserId: input.actorUserId,
  });
}