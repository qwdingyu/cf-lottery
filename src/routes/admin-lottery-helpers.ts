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
  paymentOrders,
} from "../db/schema";
import { and, count, eq, inArray } from "drizzle-orm";
import { DELETABLE_DRAW_STATUSES } from "../services/lottery-service";
// P2 审查项：默认体验/结果模式已收敛到 lib/activity-utils.ts（旧实现本地重复一份），
// 此处仅做转发，保持 admin-lottery.ts 既有导入路径不变。
import {
  defaultExperienceForParticipation as libDefaultExperienceForParticipation,
  defaultExperienceForActivity as libDefaultExperienceForActivity,
} from "../lib/activity-utils";

/** 单次 batch-delete 上限：防误炸与 Turso 长事务（docs/082 P2） */
export const ADMIN_BATCH_DELETE_MAX = 100;

/** 有支付订单的活动不能物理删除，必须保留订单、回调与发卡审计链。 */
export class DrawDeletionBlockedError extends Error {
  constructor() {
    super("活动存在支付订单，不能物理删除；请保留活动历史或先完成订单处置");
    this.name = "DrawDeletionBlockedError";
  }
}

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
  const [{ total }] = await tx
    .select({ total: count() })
    .from(paymentOrders)
    .where(and(
      eq(paymentOrders.tenantId, tenantId),
      eq(paymentOrders.drawId, drawId),
    ));
  if (Number(total || 0) > 0) {
    // payment_orders 没有随活动删除而级联清理：它承载支付平台回调、退款/补发和客服排障所需的历史。
    // 这里 fail closed，避免删除 entry 后留下无法完成回调的孤儿订单。
    throw new DrawDeletionBlockedError();
  }

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
  return (DELETABLE_DRAW_STATUSES as readonly string[]).includes(status);
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

/**
 * 游标分页编码/解码（活动列表用）。
 *
 * 复合游标由 createdAt 和 id 组成，以 | 分隔后 base64 编码。
 * createdAt 排序为主键，id 为辅去重键——同一毫秒创建多个活动时不会重复/遗漏。
 * 与 `ORDER BY createdAt DESC, id DESC` 配合使用，确保分页结果确定性。
 */

/** 编码活动列表游标 */
export function encodeDrawCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`);
}

/** 解码活动列表游标，解码失败返回 null */
export function decodeDrawCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const raw = atob(cursor);
    const sep = raw.indexOf("|");
    if (sep === -1) return null;
    return { createdAt: raw.slice(0, sep), id: raw.slice(sep + 1) };
  } catch {
    return null;
  }
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

export function normalizeOptionalNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${fieldName}必须为非负整数`);
  }
  return normalized;
}

export function defaultExperienceForParticipation(participationMode: string): string {
  return libDefaultExperienceForParticipation(participationMode);
}

export function defaultExperienceForActivity(activityKind: string, participationMode: string): string {
  return libDefaultExperienceForActivity(activityKind, participationMode);
}

export function tryParseJson(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

/**
 * JSON 列顶层键级 merge（P1 修复，2026-08 审查）。
 *
 * 用于 promotionConfig / activityConfig 的 PATCH 更新：
 * - 旧实现整包 JSON.stringify 覆盖，前端 buildPromotionConfigPayload 重建整包时，
 *   任何"前端未回填的新增键"（如 activityConfig.operational / prizeImage / 未来块）会被静默擦除。
 * - 新语义：以 DB 现有对象为底，把 incoming 的顶层键合并上去（incoming 覆盖同名键）。
 *   前端重建整包时只覆盖自己认识的键，未知键原样保留（透传）。
 * - incoming === null → "{}"（显式清空，与旧 null 语义一致）。
 * - incoming 为空字符串 → 保持原值（避免空串误清）。
 * - 非法 JSON / 非对象 → 保持原值（fail-closed，不破坏存量配置）。
 */
export function mergeJsonTopLevel(existing: string | null | undefined, incoming: unknown): string {
  if (incoming === null || incoming === undefined) {
    return "{}";
  }

  let parsedIncoming: unknown;
  if (typeof incoming === "string") {
    const trimmed = incoming.trim();
    if (!trimmed) return String(existing || "{}"); // 空串：不修改
    try {
      parsedIncoming = JSON.parse(trimmed);
    } catch {
      return String(existing || "{}"); // 非法 JSON：保持原值
    }
  } else {
    parsedIncoming = incoming;
  }
  if (typeof parsedIncoming !== "object" || parsedIncoming === null || Array.isArray(parsedIncoming)) {
    return String(existing || "{}"); // 非对象：保持原值
  }

  let existingObj: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(existing || "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existingObj = parsed as Record<string, unknown>;
    }
  } catch {
    existingObj = {};
  }

  return JSON.stringify({ ...existingObj, ...(parsedIncoming as Record<string, unknown>) });
}
