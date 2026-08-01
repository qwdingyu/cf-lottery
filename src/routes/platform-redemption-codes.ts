/**
 * 平台端兑换码路由（L3 平台运营者专用）
 *
 * 平台运营者在此生成、查看、统计所有租户的兑换码。
 * 租户侧兑换保留在 /api/admin/redemption-codes/redeem。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { fail, getDb, ok, safeJsonBody } from "../lib/http";
import { requireAuth, requirePlatformMember } from "../middleware/auth";
import { redemptionCodes } from "../db/schema";
import { eq, desc, count } from "drizzle-orm";

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

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/** 兑换码列表（分页，支持按状态筛选） */
platformRedemptionCodesRoute.get("/", async (c) => {
  const db = getDb(c);
  const status = c.req.query("status") || "";
  const limit = clampInteger(c.req.query("limit"), 50, 1, 200);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 100_000);

  if (status && !REDEMPTION_CODE_STATUSES.has(status)) {
    return fail(c, "兑换码状态无效", 400);
  }

  // 不传 status 时不能构造空 and()。直接走无 where 的分页列表，
  // 避免 ORM 版本差异导致运行时异常，也保持平台低频列表行为可预测。
  const rows = status
    ? await db
      .select()
      .from(redemptionCodes)
      .where(eq(redemptionCodes.status, status))
      .orderBy(desc(redemptionCodes.createdAt))
      .limit(limit).offset(offset)
    : await db
      .select()
      .from(redemptionCodes)
      .orderBy(desc(redemptionCodes.createdAt))
      .limit(limit).offset(offset);

  return ok(c, { codes: rows });
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
  const codes: string[] = [];

  for (let i = 0; i < batchCount; i++) {
    // 唯一码碰撞概率极低，但 UNIQUE 约束仍是最后防线；有界重试比预查更省 rows read。
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      try {
        await db.insert(redemptionCodes).values({
          id: crypto.randomUUID(), code,
          plan: "custom",
          activityQuota, participantQuota, durationDays,
          maxUses,
          note,
          createdBy: userId,  // 平台运营者生成，记录 userId，后续平台审计可追溯。
          createdAt: now, expiresAt, updatedAt: now,
        });
        codes.push(code);
        break;
      } catch (err) {
        if (attempt === 4) throw err;
      }
    }
  }

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
