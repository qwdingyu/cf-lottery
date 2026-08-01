import type { DbType, DbWriteScope } from "../../db/client";
import { platformAuditLogs } from "../../db/schema";

type PlatformAuditInput = {
  actorUserId: string;
  actorRole?: string;
  action: string;
  targetType: string;
  targetId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
};

function safeAuditJson(metadata: Record<string, unknown> = {}): string {
  const json = JSON.stringify(metadata);
  // 审计 metadata 只保存定位问题需要的摘要，避免大 payload 或敏感值进入日志表。
  return json.length > 2000 ? `${json.slice(0, 1997)}...` : json;
}

/** 写入平台审计日志。平台审计与租户审计分表，避免污染租户隔离和用量统计。 */
export async function writePlatformAudit(db: DbType | DbWriteScope, input: PlatformAuditInput): Promise<void> {
  await db.insert(platformAuditLogs).values({
    id: crypto.randomUUID(),
    actorUserId: input.actorUserId,
    actorRole: input.actorRole || "",
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId || "",
    tenantId: input.tenantId || "",
    metadataJson: safeAuditJson(input.metadata),
  });
}
