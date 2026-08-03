/**
 * 管理端抽奖路由 — 奖品/码管理域（admin-lottery 拆分，docs/049 #17）
 *
 * 奖品 CRUD、码池导入/生成/查询/导出/删除。
 * 通过 setupPrizeRoutes(route) 注册到 adminLotteryRoute 实例，无循环依赖。
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../bindings";
import { getDb, ok, fail, clampInteger } from "../lib/http";
import { eq, and, desc, sql, count } from "drizzle-orm";
import { prizes, prizeCodes, auditLogs } from "../db/schema";
import { importPrizeCodes, createPrize } from "../services/lottery-service";

// ── 辅助函数（与 admin-lottery.ts 共享，为避免循环依赖复制至此） ──

/** 转义 LIKE 通配符，防止用户输入 % 和 _ 导致全表扫描 DoS */
export function escapeLike(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

function parseAdminPagination(c: Context<AppEnv>, fallbackLimit = 50, maxLimit = 200) {
  return {
    limit: clampInteger(c.req.query("limit"), fallbackLimit, 1, maxLimit),
    offset: clampInteger(c.req.query("offset"), 0, 0, 100_000),
  };
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
  route.get("/prizes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select()
    .from(prizes)
    .where(eq(prizes.tenantId, tenantId))
    .orderBy(desc(prizes.createdAt));
  return ok(c, { prizes: rows });
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

  await importPrizeCodes(db, tenantId, prizeId, body.codes);
  return ok(c, { imported: body.codes.length });
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
  const randomBytes = new Uint8Array(Math.max(codeLen, secretLen) * count);
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

// ═════════════════════════════════════════════════════════
// 活动管理
// ═════════════════════════════════════════════════════════

}