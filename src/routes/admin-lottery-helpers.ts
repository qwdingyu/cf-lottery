/**
 * 管理端抽奖路由共享辅助。
 *
 * 为什么独立：主路由、奖品域、租户运维、集成域都需要分页/审计/身份展示等；
 * 集中一处避免复制粘贴漂移（原先 prizes 子模块曾本地复制 escapeLike）。
 */
import type { Context, Next } from "hono";
import type { AppEnv } from "../bindings";
import { getDb, fail, clampInteger } from "../lib/http";
import type { DbType, DbWriteScope } from "../db/client";
import {
  auditLogs,
  users,
  lotteryPrizeTiers,
  lotteryRosterMembers,
  lotteryInviteCodes,
  lotteryWinners,
  lotteryEntries,
  activitySubmissions,
  activityEvents,
  activityOutcomes,
  shareRecords,
  emailAccessCodes,
  lotteryDraws,
} from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";

/** 单次 batch-delete 上限：防误炸与 Turso 长事务（docs/082 P2） */
export const ADMIN_BATCH_DELETE_MAX = 100;

export const TENANT_MEMBER_ROLES = new Set(["owner", "admin", "viewer"]);

export async function requireTenantRouteCapability(c: Context<AppEnv>, next: Next) {
  const role = c.get("tenantRole");
  const method = c.req.method.toUpperCase();
  const path = new URL(c.req.url).pathname;

  if (method === "GET" || method === "HEAD") {
    await next();
    return;
  }

  if (path.includes("/members") && role !== "owner") {
    return fail(c, "只有租户 owner 可以管理团队成员", 403);
  }

  if (role !== "owner" && role !== "admin") {
    return fail(c, "权限不足", 403);
  }

  await next();
}

export function parseTenantMemberRole(value: unknown, fallback = "admin"): string | null {
  const role = String(value ?? fallback).trim();
  return TENANT_MEMBER_ROLES.has(role) ? role : null;
}

export function isUniqueConstraintError(error: unknown): boolean {
  const err = error as { message?: unknown; code?: unknown; cause?: { message?: unknown } };
  const message = [err.code, err.message, err.cause?.message].filter(Boolean).join(" ");
  return message.includes("UNIQUE constraint failed");
}

export async function recordTenantAudit(
  c: Context<AppEnv>,
  action: string,
  targetType: string,
  targetId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await getDb(c).insert(auditLogs).values({
      id: crypto.randomUUID(),
      tenantId: c.get("tenantId") as string,
      actorUserId: c.get("userId") as string,
      action,
      targetType,
      targetId,
      metadataJson: JSON.stringify(metadata || {}),
    });
  } catch (err) {
    // 审计失败不影响主业务（审计是尽力而为的留痕，不阻塞操作）
    console.error("[admin] audit write failed:", err);
  }
}

/**
 * 解析 batch-delete 请求体的 ids。
 * 去重、去空、上限 ADMIN_BATCH_DELETE_MAX；不在此做业务状态校验。
 */
export function parseBatchDeleteIds(body: unknown): { ids: string[]; error?: string } {
  if (!body || typeof body !== "object") {
    return { ids: [], error: "请求体无效" };
  }
  const raw = (body as { ids?: unknown }).ids;
  if (!Array.isArray(raw)) {
    return { ids: [], error: "ids 必须为数组" };
  }
  const ids = [
    ...new Set(
      raw
        .map((x) => String(x ?? "").trim())
        .filter((id) => id.length > 0),
    ),
  ];
  if (ids.length === 0) {
    return { ids: [], error: "请提供至少一个 id" };
  }
  if (ids.length > ADMIN_BATCH_DELETE_MAX) {
    return { ids: [], error: `单次最多删除 ${ADMIN_BATCH_DELETE_MAX} 条` };
  }
  return { ids };
}

/**
 * 活动级联删除子表 + 主表（单事务内调用）。
 * 与 DELETE /draws/:id 同源，供单删与 batch-delete 复用，避免两套级联漂移。
 * 调用方须先校验 status 非 open/drawing、且活动属于本租户。
 */
export async function cascadeDeleteDraw(
  tx: DbWriteScope,
  tenantId: string,
  drawId: string,
): Promise<void> {
  await tx.delete(lotteryPrizeTiers).where(and(eq(lotteryPrizeTiers.drawId, drawId), eq(lotteryPrizeTiers.tenantId, tenantId)));
  await tx.delete(lotteryRosterMembers).where(and(eq(lotteryRosterMembers.drawId, drawId), eq(lotteryRosterMembers.tenantId, tenantId)));
  await tx.delete(lotteryInviteCodes).where(and(eq(lotteryInviteCodes.drawId, drawId), eq(lotteryInviteCodes.tenantId, tenantId)));
  await tx.delete(lotteryWinners).where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)));
  await tx.delete(lotteryEntries).where(and(eq(lotteryEntries.drawId, drawId), eq(lotteryEntries.tenantId, tenantId)));
  await tx.delete(activitySubmissions).where(and(eq(activitySubmissions.drawId, drawId), eq(activitySubmissions.tenantId, tenantId)));
  await tx.delete(activityEvents).where(and(eq(activityEvents.drawId, drawId), eq(activityEvents.tenantId, tenantId)));
  await tx.delete(activityOutcomes).where(and(eq(activityOutcomes.drawId, drawId), eq(activityOutcomes.tenantId, tenantId)));
  await tx.delete(shareRecords).where(and(eq(shareRecords.drawId, drawId), eq(shareRecords.tenantId, tenantId)));
  await tx.delete(emailAccessCodes).where(eq(emailAccessCodes.drawId, drawId));
  await tx.delete(lotteryDraws).where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
}

/** 活动状态是否允许物理删除（与 canDeleteDraw / DELETE 单条一致；无 force） */
export function isDrawStatusDeletable(status: string): boolean {
  return status === "draft" || status === "paused" || status === "drawn" || status === "cancelled";
}

export function escapeLike(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

export function parseAdminPagination(c: Context<AppEnv>, fallbackLimit = 50, maxLimit = 200) {
  return {
    limit: clampInteger(c.req.query("limit"), fallbackLimit, 1, maxLimit),
    offset: clampInteger(c.req.query("offset"), 0, 0, 100_000),
  };
}

/**
 * 参与者身份展示解析（L2 管理员视角闭环）。
 */
export async function decorateIdentityDisplay(
  db: DbType,
  rows: Array<{ identityType?: string | null; identityValue: string }>,
): Promise<void> {
  const userIds = [...new Set(rows.filter(r => r.identityType === "user_id" && r.identityValue).map(r => r.identityValue))];
  if (userIds.length === 0) return;
  const userRows = await db
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(inArray(users.id, userIds));
  const nameMap = new Map(userRows.map(u => [u.id, `${u.username}（${u.email}）`] as const));
  for (const r of rows) {
    if (r.identityType === "user_id") {
      (r as any).identityDisplay = nameMap.get(r.identityValue) || `用户 ${r.identityValue.slice(0, 8)}`;
    }
  }
}

export function csvEscape(value: unknown): string {
  const raw = String(value ?? "");
  let out = raw;
  if (/^[=+\-@]/.test(out)) {
    out = "'" + out;
  }
  if (/[",\n\r]/.test(out)) {
    out = '"' + out.replace(/"/g, '""') + '"';
  }
  return out;
}

export function validateProductLink(link: any): string | null {
  if (!link || typeof link !== "object") return "商品链接配置无效";
  if (typeof link.url !== "string" || !link.url.trim()) return "商品链接不能为空";
  try {
    const url = new URL(link.url);
    if (!["https:", "http:"].includes(url.protocol)) {
      return "商品链接仅支持 http 和 https 协议";
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return "商品链接不能指向本地地址";
    }
    if (url.href.length > 2000) return "商品链接过长";
  } catch {
    return "商品链接格式无效";
  }
  if (typeof link.title === "string" && link.title.length > 200) return "商品名称过长";
  if (typeof link.imageUrl === "string" && link.imageUrl.length > 2000) return "图片链接过长";
  if (typeof link.price === "string" && link.price.length > 50) return "展示价格过长";
  return null;
}

export function validateWebhookUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "URL 格式无效";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "Webhook 仅支持 http 和 https 协议";
  }
  const hostname = parsed.hostname.toLowerCase();
  // 本机地址
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
    return "Webhook 不能指向本地地址";
  }
  // IPv4 私网/保留地址检查（处理 IPv4 和 IPv6 映射）
  const ipv4 = hostname.replace(/^\[|\]$/g, "");
  const isIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(ipv4);
  if (isIpv4) {
    const parts = ipv4.split(".").map(Number);
    const [a, b] = parts;
    const isPrivate =
      a === 10 ||                                // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||       // 172.16.0.0/12
      (a === 192 && b === 168) ||                // 192.168.0.0/16
      a === 127 ||                               // 127.0.0.0/8
      a === 0 ||                                 // 0.0.0.0/8
      (a === 169 && b === 254) ||                // 169.254.0.0/16（含云元数据）
      (a === 100 && b >= 64 && b <= 127);        // 100.64.0.0/10（CGN）
    if (isPrivate) return "Webhook 不能指向内网地址";
  }
  if (parsed.href.length > 2000) return "Webhook URL 过长";
  return null;
}

export function coerceEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  const normalized = String(value || "").trim();
  return allowed.has(normalized) ? normalized : fallback;
}

export function normalizeOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`${fieldName}必须为正整数`);
  }
  return normalized;
}

export function defaultExperienceForParticipation(participationMode: string): string {
  if (participationMode === "invite_code") return "slot";
  if (participationMode === "password") return "scratch";
  if (participationMode === "roster") return "card";
  return "wheel";
}

export function defaultExperienceForActivity(activityKind: string, participationMode: string): string {
  if (activityKind === "signup_chain") return "list";
  if (activityKind === "reservation") return "calendar";
  if (activityKind === "vote") return "ballot";
  if (activityKind === "survey") return "form";
  if (activityKind === "checkin") return "checkin";
  if (activityKind === "waitlist") return "queue";
  if (activityKind === "approval") return "form";
  if (activityKind === "claim") return "reveal";
  return defaultExperienceForParticipation(participationMode);
}

export function tryParseJson(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}
