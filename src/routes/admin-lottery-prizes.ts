/**
 * 管理端抽奖路由 — 奖品/码管理域（admin-lottery 拆分，docs/049 #17）
 *
 * 奖品 CRUD、码池导入/生成/查询/导出/删除。
 * 通过 setupPrizeRoutes(route) 注册到 adminLotteryRoute 实例，无循环依赖。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { getDb, ok, fail } from "../lib/http";
import { eq, and, desc, sql, count, inArray, ne } from "drizzle-orm";
import { prizes, prizeCodes, auditLogs, lotteryPrizeTiers, lotteryDraws } from "../db/schema";
import { importPrizeCodes, createPrize } from "../services/lottery-service";
import {
  DIRECT_SALE_CODE_POOL_OCCUPYING_STATUSES,
  hasDirectSaleCodePoolConflict,
} from "../services/lottery/types";
import { escapeLike, parseAdminPagination, parseBatchDeleteIds } from "./admin-lottery-helpers";

/**
 * 批量统计候选奖品的可用卡密库存（docs/225 P0：避免逐条 N+1 查询）。
 * 一次 GROUP BY 返回所有候选 prizeId 的 available 数量。
 */
async function batchAvailableCounts(db: DbType, tenantId: string, prizeIds: string[]): Promise<Map<string, number>> {
  if (prizeIds.length === 0) return new Map();
  const rows = await db
    .select({ prizeId: prizeCodes.prizeId, total: count() })
    .from(prizeCodes)
    .where(and(
      eq(prizeCodes.tenantId, tenantId),
      eq(prizeCodes.status, "available"),
      inArray(prizeCodes.prizeId, prizeIds),
    ))
    .groupBy(prizeCodes.prizeId);
  return new Map(rows.map((r) => [r.prizeId, Number(r.total || 0)]));
}

/**
 * 批量统计候选卡密奖品被「进行中活动」占用的数量（docs/225 P0：直付共享码池判定）。
 * 与 publish-check-service 的 payment.fulfillment.code_prize.shared 同口径：
 * 状态为 OPEN/PAUSED/DRAWING 的活动视为占用。前端只做提前反馈，保存/发布预检仍是权威门禁。
 */
async function batchActiveUsage(
  db: DbType,
  tenantId: string,
  prizeIds: string[],
  excludedDrawId: string,
): Promise<Map<string, number>> {
  if (prizeIds.length === 0) return new Map();
  const conditions = [
    eq(lotteryPrizeTiers.tenantId, tenantId),
    inArray(lotteryPrizeTiers.prizeId, prizeIds),
    inArray(lotteryDraws.status, DIRECT_SALE_CODE_POOL_OCCUPYING_STATUSES),
  ];
  // 编辑直付活动时，本活动自身的已绑定奖品不是“其他活动共享”。
  if (excludedDrawId) conditions.push(ne(lotteryDraws.id, excludedDrawId));
  const rows = await db
    .select({ prizeId: lotteryPrizeTiers.prizeId, total: count() })
    .from(lotteryPrizeTiers)
    .innerJoin(lotteryDraws, and(
      eq(lotteryDraws.id, lotteryPrizeTiers.drawId),
      eq(lotteryDraws.tenantId, tenantId),
    ))
    .where(and(...conditions))
    .groupBy(lotteryPrizeTiers.prizeId);
  return new Map(rows.map((r) => [r.prizeId, Number(r.total || 0)]));
}

async function recordTenantAudit(c: Context<AppEnv>, action: string, targetType: string, targetId: string, metadata?: Record<string, unknown>) {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const actorUserId = c.get("userId") as string;
  if (!tenantId) return;
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    tenantId,
    actorUserId,
    action,
    targetType,
    targetId,
    metadataJson: metadata ? JSON.stringify(metadata) : "",
    createdAt: new Date().toISOString(),
  });
}

export function setupPrizeRoutes(route: Hono<AppEnv>) {
  /** 奖品列表（目录查询与活动选择器共用；派生字段须由调用方显式请求，docs/225 P0） */
  route.get("/prizes", async (c) => {
    const db = getDb(c);
    const tenantId = c.get("tenantId") as string;
    const { limit, offset } = parseAdminPagination(c, 50, 200);
    const search = c.req.query("search") || "";
    const prizeType = c.req.query("prizeType") || "";
    const idsRaw = c.req.query("ids") || "";
    const activeRaw = c.req.query("active"); // undefined=保持奖品目录既有“全部”语义
    const includeAvailability = c.req.query("includeAvailability") === "1";
    const directSaleDrawId = c.req.query("directSaleDrawId") || "";

    const conditions = [eq(prizes.tenantId, tenantId)];

    // ids 回填模式：按 ID 精确获取（含停用），用于编辑旧活动回填已绑定奖品。
    // 停用的历史奖品必须能显示名称，不能因 active 过滤而丢失。
    const ids = idsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const isIdsMode = ids.length > 0;
    if (isIdsMode) {
      if (ids.length > 10) return fail(c, "一次最多回填 10 个奖品", 400);
      if (search || prizeType || activeRaw !== undefined || directSaleDrawId) {
        return fail(c, "ids 回填模式不能与搜索、类型、状态或直付占用查询混用", 400);
      }
      conditions.push(inArray(prizes.id, ids));
    } else {
      // 普通奖品目录沿用既有全量列表；活动选择器显式传 active=1。
      if (activeRaw === "0") conditions.push(eq(prizes.active, 0));
      else if (activeRaw === "1") conditions.push(eq(prizes.active, 1));
      if (search) {
        const keyword = `%${escapeLike(search)}%`;
        conditions.push(sql`(${prizes.name} LIKE ${keyword} ESCAPE '\\' OR ${prizes.valueText} LIKE ${keyword} ESCAPE '\\')`);
      }
      if (prizeType) conditions.push(eq(prizes.prizeType, prizeType));
    }

    const [{ total }] = await db.select({ total: count() }).from(prizes).where(and(...conditions));
    const rows = await db
      .select()
      .from(prizes)
      .where(and(...conditions))
      .orderBy(desc(prizes.createdAt), desc(prizes.id))
      .limit(isIdsMode ? ids.length : limit)
      .offset(isIdsMode ? 0 : offset);

    // 只有活动选择器需要库存；普通目录请求不额外执行聚合。
    const prizeIds = rows.map((r) => r.id);
    const availableCounts = includeAvailability
      ? await batchAvailableCounts(db, tenantId, prizeIds)
      : new Map<string, number>();

    // directSaleDrawId 是选择器专用语义；发布预检仍为最终权威。
    const activeUsage = directSaleDrawId
      ? await batchActiveUsage(db, tenantId, prizeIds, directSaleDrawId === "new" ? "" : directSaleDrawId)
      : new Map<string, number>();

    const result = rows.map((p) => {
      return {
        ...p,
        ...(includeAvailability ? { availableCount: p.prizeType === "code" ? (availableCounts.get(p.id) || 0) : null } : {}),
        ...(directSaleDrawId ? { directSaleConflict: hasDirectSaleCodePoolConflict(activeUsage.get(p.id) || 0) } : {}),
      };
    });

    return ok(c, { prizes: result, total });
  });

/** 创建奖品 */
route.post("/prizes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ name: string; description?: string; prizeType?: string; imageUrl?: string; valueText?: string }>();
  try {
    const { id } = await createPrize(db, tenantId, body);
    return ok(c, { id });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "创建奖品失败", 400);
  }
});

/** 编辑奖品 */
route.patch("/prizes/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const prizeId = c.req.param("id");
  const body = await c.req.json<{ name?: string; description?: string; prizeType?: string; imageUrl?: string; valueText?: string; active?: number }>();

  const [existing] = await db
    .select()
    .from(prizes)
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)))
    .limit(1);

  if (!existing) return fail(c, "奖品不存在", 404);
  if (body.name !== undefined && !String(body.name).trim()) return fail(c, "奖品名称不能为空", 400);

  await db
    .update(prizes)
    .set({
      ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
      ...(body.description !== undefined ? { description: String(body.description).trim() } : {}),
      ...(body.prizeType !== undefined ? { prizeType: body.prizeType } : {}),
      ...(body.imageUrl !== undefined ? { imageUrl: String(body.imageUrl).trim() } : {}),
      ...(body.valueText !== undefined ? { valueText: String(body.valueText).trim() } : {}),
      ...(body.active !== undefined ? { active: body.active ? 1 : 0 } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)));

  return ok(c, { updated: true });
});

/** 导入奖品码 */
route.post("/prizes/:id/codes/import", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const prizeId = c.req.param("id");
  const body = await c.req.json<{ codes: Array<{ code: string; secret?: string }> }>();

  if (!body.codes || body.codes.length === 0) {
    return fail(c, "请提供至少一个码", 400);
  }

  try {
    const result = await importPrizeCodes(db, tenantId, prizeId, body.codes);
    // P0 修复：导入返回实际插入数 + 跳过数（重复码不再静默入库），运营可见
    return ok(c, { imported: result.imported, skipped: result.skipped });
  } catch (err: any) {
    return fail(c, err?.message || "导入码失败", 400);
  }
});

/**
 * 自动生成奖品卡密。
 *
 * 使用 crypto.getRandomValues() 生成抗猜测的唯一码。
 * 字符集排除易混淆字符（0/O/1/I/l），降低运营者人工核对成本。
 */
route.post("/prizes/:id/codes/generate", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const prizeId = c.req.param("id");
  const body = await c.req.json<{ count?: number; prefix?: string; codeLength?: number; secretLength?: number }>();

  const count = Math.min(Math.max(Number(body.count) || 10, 1), 1000);
  const prefix = String(body.prefix || "").slice(0, 20);
  const codeLen = Math.min(Math.max(Number(body.codeLength) || 8, 4), 32);
  const secretLen = Math.min(Math.max(Number(body.secretLength) || 0, 0), 32);

  // 排除易混淆字符：0/O、1/I/l
  const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  // 随机字节数组大小必须能容纳 code + secret 的全部字符
  const randomBytes = new Uint8Array((codeLen + secretLen) * count);
  crypto.getRandomValues(randomBytes);

  const codes: Array<{ code: string; secret: string }> = [];
  let byteIdx = 0;
  for (let i = 0; i < count; i++) {
    let code = "";
    for (let j = 0; j < codeLen; j++) {
      code += CHARS[randomBytes[byteIdx++]! % CHARS.length]!;
    }
    const fullCode = prefix ? `${prefix}${code}` : code;
    let secret = "";
    for (let j = 0; j < secretLen; j++) {
      secret += CHARS[randomBytes[byteIdx++]! % CHARS.length]!;
    }
    codes.push({ code: fullCode, secret });
  }

  await importPrizeCodes(db, tenantId, prizeId, codes);
  await recordTenantAudit(c, "prize.codes.generate", "prize", prizeId, { count });
  return ok(c, { generated: count });
});

// ═════════════════════════════════════════════════════════
// 奖品码池查询（查看已导入/生成的卡密列表）
// ═════════════════════════════════════════════════════════

/** 查询某个奖品的码池列表（分页，支持按状态筛选） */
route.get("/prizes/:id/codes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const prizeId = c.req.param("id");
  const { limit, offset } = parseAdminPagination(c, 50, 200);
  const status = c.req.query("status") || "";
  // 码文本搜索（047 文档 🔴）：导入几百个码后可按码文本精确查找
  const search = c.req.query("search") || "";

  // 校验奖品归属
  const [prize] = await db
    .select({ id: prizes.id, name: prizes.name, prizeType: prizes.prizeType })
    .from(prizes)
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)))
    .limit(1);
  if (!prize) return fail(c, "奖品不存在", 404);

  const conditions: any[] = [
    eq(prizeCodes.tenantId, tenantId),
    eq(prizeCodes.prizeId, prizeId),
  ];
  if (status) conditions.push(eq(prizeCodes.status, status));
  // 码文本搜索：大小写不敏感（LIKE 匹配），按码内容过滤
  if (search) conditions.push(sql`${prizeCodes.code} LIKE ${'%' + escapeLike(search) + '%'}`);

  const rows = await db
    .select({
      id: prizeCodes.id,
      code: prizeCodes.code,
      secret: prizeCodes.secret,
      note: prizeCodes.note,
      status: prizeCodes.status,
      winnerId: prizeCodes.winnerId,
      issuedAt: prizeCodes.issuedAt,
      createdAt: prizeCodes.createdAt,
    })
    .from(prizeCodes)
    .where(and(...conditions))
    .orderBy(desc(prizeCodes.createdAt))
    .limit(limit)
    .offset(offset);

  // 统计各状态数量 + 总数（用于分页）
  const [totalCount] = await db
    .select({ total: count() })
    .from(prizeCodes)
    .where(and(...conditions));

  const [availCount] = await db
    .select({ total: count() })
    .from(prizeCodes)
    .where(and(eq(prizeCodes.tenantId, tenantId), eq(prizeCodes.prizeId, prizeId), eq(prizeCodes.status, "available")));

  const [issuedCount] = await db
    .select({ total: count() })
    .from(prizeCodes)
    .where(and(eq(prizeCodes.tenantId, tenantId), eq(prizeCodes.prizeId, prizeId), eq(prizeCodes.status, "issued")));

  return ok(c, {
    codes: rows,
    total: Number(totalCount?.total || 0),
    totalAvailable: Number(availCount?.total || 0),
    totalIssued: Number(issuedCount?.total || 0),
  });
});

// ═════════════════════════════════════════════════════════
// 导出奖品码为 CSV
// ═════════════════════════════════════════════════════════

route.get("/prizes/:id/codes/export", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const prizeId = c.req.param("id");
  const status = c.req.query("status") || "";

  const [prize] = await db
    .select({ name: prizes.name })
    .from(prizes)
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)))
    .limit(1);
  if (!prize) return fail(c, "奖品不存在", 404);

  const conditions: any[] = [
    eq(prizeCodes.tenantId, tenantId),
    eq(prizeCodes.prizeId, prizeId),
  ];
  if (status) conditions.push(eq(prizeCodes.status, status));

  const rows = await db
    .select({ code: prizeCodes.code, secret: prizeCodes.secret, status: prizeCodes.status, note: prizeCodes.note })
    .from(prizeCodes)
    .where(and(...conditions))
    .orderBy(prizeCodes.createdAt)
    .limit(10000);  // 单次最多导出 1 万条

  // BOM 防中文乱码 + CSV 转义
  const BOM = "\uFEFF";
  const csvRows = [["卡密", "密钥", "状态", "备注"].join(",")];
  for (const row of rows) {
    const fields = [row.code, row.secret || "", row.status === "available" ? "可用" : "已发放", (row.note || "").replace(/"/g, '""')];
    csvRows.push(fields.map(f => `"${f}"`).join(","));
  }

  const filename = encodeURIComponent(`${prize.name}-码池.csv`);
  return new Response(BOM + csvRows.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
    },
  });
});

// ═════════════════════════════════════════════════════════
// 删除单个奖品码（仅 available 状态可删）
// ═════════════════════════════════════════════════════════

route.delete("/prizes/codes/:codeId", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const codeId = c.req.param("codeId");

  // 仅允许删除 available 状态的码，已发放的码保留审计线索
  const result = await db
    .delete(prizeCodes)
    .where(and(
      eq(prizeCodes.id, codeId),
      eq(prizeCodes.tenantId, tenantId),
      eq(prizeCodes.status, "available"),
    ));

  if ((result.rowsAffected ?? 0) === 0) {
    return fail(c, "码不存在或已发放，无法删除", 404);
  }

  return ok(c, { deleted: true });
});

/**
 * 批量删除奖品码（docs/082 P2）。
 * 仅 available；已发放的计入 failed。一次 inArray 删除 + 一条审计汇总。
 * 请求体：{ ids: string[] }，上限见 ADMIN_BATCH_DELETE_MAX。
 */
route.post("/prizes/codes/batch-delete", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求体无效", 400);
  }
  const parsed = parseBatchDeleteIds(body);
  if (parsed.error) return fail(c, parsed.error, 400);

  // 本租户范围内查状态，决定可删与失败原因
  const rows = await db
    .select({ id: prizeCodes.id, status: prizeCodes.status })
    .from(prizeCodes)
    .where(and(eq(prizeCodes.tenantId, tenantId), inArray(prizeCodes.id, parsed.ids)));

  const found = new Map(rows.map((r) => [r.id, r.status]));
  const deletable: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const id of parsed.ids) {
    const status = found.get(id);
    if (!status) {
      failed.push({ id, reason: "码不存在" });
      continue;
    }
    if (status !== "available") {
      failed.push({ id, reason: "已发放，无法删除" });
      continue;
    }
    deletable.push(id);
  }

  let deletedCount = 0;
  if (deletable.length > 0) {
    const result = await db
      .delete(prizeCodes)
      .where(and(
        eq(prizeCodes.tenantId, tenantId),
        eq(prizeCodes.status, "available"),
        inArray(prizeCodes.id, deletable),
      ));
    deletedCount = Number(result.rowsAffected ?? 0);
    // 极端并发：状态在查后变 issued → rowsAffected 可能小于 deletable
    if (deletedCount < deletable.length) {
      const still = await db
        .select({ id: prizeCodes.id })
        .from(prizeCodes)
        .where(and(eq(prizeCodes.tenantId, tenantId), inArray(prizeCodes.id, deletable)));
      const stillSet = new Set(still.map((r) => r.id));
      for (const id of deletable) {
        if (stillSet.has(id)) {
          failed.push({ id, reason: "删除失败或状态已变更" });
        }
      }
      deletedCount = deletable.length - stillSet.size;
    }
  }

  const deletedIds = deletable.filter((id) => !failed.some((f) => f.id === id));

  await recordTenantAudit(c, "prize.codes.batch_delete", "prize_code", "batch", {
    requested: parsed.ids.length,
    deleted: deletedIds.length,
    failed: failed.length,
    deletedIds: deletedIds.slice(0, 50),
    failedSample: failed.slice(0, 20),
  });

  return ok(c, {
    deleted: deletedIds.length,
    failed: failed.length,
    deletedIds,
    failedItems: failed,
  });
});

// ═════════════════════════════════════════════════════════
// 作废单个奖品码（docs/111 §7.3 状态机：issued → revoked / available → revoked）
// ═════════════════════════════════════════════════════════

/**
 * POST /prizes/:prizeId/codes/:codeId/revoke — 运营人工作废卡密。
 *
 * 状态机规则（为什么这么设计）：
 * - available → revoked：未发放，直接作废安全（等价于删除但保留审计）。
 * - issued 且 paymentOrderId 为空：抽奖/instant 发放、未支付场景，撤奖作废安全。
 * - issued 且 paymentOrderId 非空：直付已发卡（用户已付款），直接作废会破坏支付履约，
 *   必须走订单退款流程（refundPaymentOrder 会把该订单卡密统一 revoked），这里拒绝并提示。
 * - redeemed：已核销消费，作废会篡改核销事实，拒绝。
 *
 * 跨租户/跨奖品隔离：查询同时限定 id + tenantId + prizeId，找不到即 404（不泄露其它租户资源存在性）。
 */
route.post("/prizes/:prizeId/codes/:codeId/revoke", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const prizeId = c.req.param("prizeId");
  const codeId = c.req.param("codeId");

  const [code] = await db
    .select({
      id: prizeCodes.id,
      status: prizeCodes.status,
      paymentOrderId: prizeCodes.paymentOrderId,
      winnerId: prizeCodes.winnerId,
    })
    .from(prizeCodes)
    .where(and(
      eq(prizeCodes.id, codeId),
      eq(prizeCodes.tenantId, tenantId),
      eq(prizeCodes.prizeId, prizeId),
    ))
    .limit(1);
  if (!code) return fail(c, "码不存在或不属于当前租户", 404);

  if (code.status === "redeemed") {
    return fail(c, "码已核销，不能作废", 409);
  }
  if (code.status === "issued" && code.paymentOrderId) {
    return fail(c, "直付已发卡密请走退款流程，不能直接作废", 409);
  }
  if (code.status !== "available" && code.status !== "issued") {
    return fail(c, `状态 ${code.status} 的码不能作废`, 409);
  }

  // 只改状态，保留 winnerId/paymentOrderId/issuedAt 审计字段
  await db
    .update(prizeCodes)
    .set({ status: "revoked" })
    .where(and(eq(prizeCodes.id, codeId), eq(prizeCodes.tenantId, tenantId)));

  await recordTenantAudit(c, "prize.code.revoke", "prize_code", codeId, {
    prizeId,
    previousStatus: code.status,
    winnerId: code.winnerId || "",
    paymentOrderId: code.paymentOrderId || "",
  });

  return ok(c, { revoked: true });
});

}
