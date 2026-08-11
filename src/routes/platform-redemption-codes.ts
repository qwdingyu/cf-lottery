/**
 * 平台端兑换码路由（L3 平台运营者专用）
 *
 * 平台运营者在此生成、查看、统计所有租户的兑换码。
 * 租户侧兑换保留在 /api/admin/redemption-codes/redeem。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { withDbTransaction } from "../db/client";
import { clampInteger, fail, getDb, ok, safeJsonBody } from "../lib/http";
import { requireAuth, requirePlatformMember } from "../middleware/auth";
import { redemptionCodes } from "../db/schema";
import { eq, desc, count, and, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { writePlatformAudit } from "../services/admin/platform-audit";

export const platformRedemptionCodesRoute = new Hono<AppEnv>();

// 所有平台兑换码路由需要登录 + 平台成员权限
platformRedemptionCodesRoute.use("*", requireAuth, requirePlatformMember(["platform_owner", "platform_operator"]));

const REDEMPTION_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REDEMPTION_CODE_STATUSES = new Set(["active", "used", "expired", "disabled"]);

/**
 * 生成平台额度码。
 *
 * 额度码等同于平台可售权益，必须使用 Web Crypto。Math.random() 只适合动画，
 * 不适合任何可兑换、可猜测会造成损失的业务凭证。
 */
function generateCode(): string {
  const segments: string[] = [];
  const randomBytes = new Uint8Array(12);
  crypto.getRandomValues(randomBytes);
  for (let s = 0; s < 3; s++) {
    let seg = "";
    for (let i = 0; i < 4; i++) {
      seg += REDEMPTION_CODE_CHARS[randomBytes[s * 4 + i] % REDEMPTION_CODE_CHARS.length];
    }
    segments.push(seg);
  }
  return `LUCKY-${segments.join("-")}`;
}

function isRedemptionCodeCollision(error: unknown): boolean {
  const err = error as { message?: unknown; code?: unknown; cause?: { message?: unknown } };
  const message = [err.code, err.message, err.cause?.message].filter(Boolean).join(" ");
  return message.includes("UNIQUE constraint failed")
    && message.includes("redemption_codes.code");
}

/** 兑换码列表（分页 + 搜索，支持按状态筛选） */
platformRedemptionCodesRoute.get("/", async (c) => {
  const db = getDb(c);
  const status = c.req.query("status") || "";
  const search = c.req.query("search") || "";
  const limit = clampInteger(c.req.query("limit"), 50, 1, 200);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 100_000);

  if (status && !REDEMPTION_CODE_STATUSES.has(status)) {
    return fail(c, "兑换码状态无效", 400);
  }

  const conditions: SQL[] = [];
  if (status) conditions.push(eq(redemptionCodes.status, status));
  if (search) conditions.push(sql`${redemptionCodes.code} LIKE ${`%${search.replace(/[%_]/g, "\\$&")}%`}`);

  const hasFilter = conditions.length > 0;
  const [{ total }] = hasFilter
    ? await db.select({ total: count() }).from(redemptionCodes).where(and(...conditions))
    : await db.select({ total: count() }).from(redemptionCodes);
  const rows = hasFilter
    ? await db.select().from(redemptionCodes).where(and(...conditions)).orderBy(desc(redemptionCodes.createdAt)).limit(limit).offset(offset)
    : await db.select().from(redemptionCodes).orderBy(desc(redemptionCodes.createdAt)).limit(limit).offset(offset);

  return ok(c, { codes: rows, total });
});

/** 批量生成兑换码 */
platformRedemptionCodesRoute.post("/batch", async (c) => {
  const db = getDb(c);
  const userId = c.get("userId") as string;
  const body = await safeJsonBody<{
    count: number;
    activityQuota: number;
    participantQuota: number;
    durationDays: number;
    maxUses?: number;
    note?: string;
  }>(c);
  if (!body) return fail(c, "请求参数无效", 400);

  const batchCount = clampInteger(body.count, 1, 1, 100);
  const activityQuota = clampInteger(body.activityQuota, 0, 0, 100_000);
  const participantQuota = clampInteger(body.participantQuota, 0, 0, 10_000_000);
  const durationDays = clampInteger(body.durationDays, 30, 1, 3650);
  const maxUses = clampInteger(body.maxUses, 1, 1, 100_000);
  const note = String(body.note || "").slice(0, 500);

  if (activityQuota === 0 && participantQuota === 0) {
    return fail(c, "活动次数和参与人数不能同时为 0", 400);
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + durationDays * 86400000).toISOString();

  const codes = await withDbTransaction(db, async (tx) => {
    const createdCodes: string[] = [];
    for (let i = 0; i < batchCount; i++) {
      // 唯一码碰撞概率极低，但 UNIQUE 约束仍是最后防线；有界重试比预查更省 rows read。
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        try {
          await tx.insert(redemptionCodes).values({
            id: crypto.randomUUID(), code,
            plan: "custom",
            activityQuota, participantQuota, durationDays,
            maxUses,
            note,
            createdBy: userId,  // 平台运营者生成，记录 userId，后续平台审计可追溯。
            createdAt: now, expiresAt, updatedAt: now,
          });
          createdCodes.push(code);
          break;
        } catch (err) {
          // 只有兑换码唯一索引冲突才重试；锁竞争、结构错误等必须交给事务层处理或直接暴露。
          if (!isRedemptionCodeCollision(err)) throw err;
          if (attempt === 4) throw err;
        }
      }
    }

    // 发码是平台可售权益的创建动作；码记录和审计必须同成同败，
    // 否则运维重试会生成额外可兑换资产且难以追溯。
    await writePlatformAudit(tx, {
      actorUserId: userId,
      actorRole: c.get("platformRole") as string,
      action: "platform.redemption_codes.batch_create",
      targetType: "redemption_code_batch",
      metadata: {
        count: createdCodes.length,
        requestedCount: batchCount,
        activityQuota,
        participantQuota,
        durationDays,
        maxUses,
        hasNote: Boolean(note),
      },
    });
    return createdCodes;
  });

  return ok(c, { codes, count: batchCount, activityQuota, participantQuota, durationDays });
});

/** 兑换码统计 */
platformRedemptionCodesRoute.get("/stats", async (c) => {
  const db = getDb(c);

  const [total] = await db
    .select({ total: count() })
    .from(redemptionCodes);

  const [used] = await db
    .select({ total: count() })
    .from(redemptionCodes)
    .where(eq(redemptionCodes.status, "used"));

  const [active] = await db
    .select({ total: count() })
    .from(redemptionCodes)
    .where(eq(redemptionCodes.status, "active"));

  return ok(c, {
    total: Number(total?.total ?? 0),
    used: Number(used?.total ?? 0),
    active: Number(active?.total ?? 0),
  });
});

/**
 * 禁用单条兑换码（仅 active → disabled）。
 *
 * 为什么不做物理删除：码与 redemption_records / 平台审计需可追溯；
 * 测试清场用「禁用」即可阻断兑换，与 used/expired 终态语义一致。
 */
platformRedemptionCodesRoute.patch("/:id", async (c) => {
  const db = getDb(c);
  const userId = c.get("userId") as string;
  const id = c.req.param("id");
  const body = await safeJsonBody<{ status?: string }>(c);
  if (!body || body.status !== "disabled") {
    return fail(c, "仅支持将兑换码状态设为 disabled", 400);
  }

  const [row] = await db
    .select({ id: redemptionCodes.id, status: redemptionCodes.status, code: redemptionCodes.code })
    .from(redemptionCodes)
    .where(eq(redemptionCodes.id, id))
    .limit(1);
  if (!row) return fail(c, "兑换码不存在", 404);
  if (row.status !== "active") {
    return fail(c, `仅有效(active)兑换码可禁用，当前状态为 ${row.status}`, 409);
  }

  const now = new Date().toISOString();
  await withDbTransaction(db, async (tx) => {
    await tx
      .update(redemptionCodes)
      .set({ status: "disabled", updatedAt: now })
      .where(eq(redemptionCodes.id, id));

    await writePlatformAudit(tx, {
      actorUserId: userId,
      actorRole: c.get("platformRole") as string,
      action: "platform.redemption_codes.disable",
      targetType: "redemption_code",
      targetId: id,
      metadata: { codeSuffix: row.code.slice(-4), fromStatus: row.status },
    });
  });

  return ok(c, { disabled: true, id });
});
