/**
 * 管理端 — 集成与商业化域（API Key / Webhook / 券 / 品牌 / 裂变分享 / 核销码）。
 *
 * 从 admin-lottery 拆出，避免主路由文件继续膨胀。
 */
import type { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb, ok, fail, clampInteger } from "../lib/http";
import { withDbTransaction } from "../db/client";
import { isShopFeatureEnabled } from "../lib/system-config-registry";
import {
  apiKeys, webhookConfigs, couponCodes, shareRecords, redemptionCodes, redemptionRecords,
  tenants,
} from "../db/schema";
import { eq, and, desc, sql, count } from "drizzle-orm";
import {
  hashApiKey,
  createWebhookSigningSecret,
  listWebhookDeliveries,
  dispatchWebhookDelivery,
  processPendingWebhookDeliveries,
  getTenantUsage,
} from "../services/lottery-service";
import {
  recordTenantAudit,
  parseAdminPagination,
  validateWebhookUrl,
  isUniqueConstraintError,
  tryParseJson,
} from "./admin-lottery-helpers";

export function setupIntegrationRoutes(adminLotteryRoute: Hono<AppEnv>) {
// ═════════════════════════════════════════════════════════
// API 密钥管理
// ═════════════════════════════════════════════════════════

/** store_slug 唯一冲突（事务内抛出，事务外转为 400，docs/258 部署前审查修复） */
class BrandSlugConflictError extends Error {}

/**
 * 列表展示用：从明文或哈希派生短前缀，永不回传完整 key/hash（docs/070 LOW #13）。
 * 明文形如 cl_xxx… 时取前 10 字符；哈希则固定「已保存」占位。
 */
function apiKeyListPrefix(stored: string): string {
  const s = String(stored || "").trim();
  if (!s) return "••••";
  // 历史若误存过明文 cl_…（极少数），仍只露前缀
  if (s.startsWith("cl_") && s.length > 12) return `${s.slice(0, 10)}…`;
  // 库内为哈希：不回传任何可离线试的材料
  return "cl_••••••••";
}

/** API 密钥列表 */
adminLotteryRoute.get("/api-keys", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      active: apiKeys.active,
      createdAt: apiKeys.createdAt,
      key: apiKeys.key,
    })
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId))
    .orderBy(desc(apiKeys.createdAt));
  // 对外字段：prefix 仅展示；不包含 key 哈希
  return ok(c, {
    keys: rows.map((r) => ({
      id: r.id,
      name: r.name,
      active: r.active,
      createdAt: r.createdAt,
      prefix: apiKeyListPrefix(r.key),
    })),
  });
});

/** 创建 API 密钥 */
adminLotteryRoute.post("/api-keys", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ name: string }>();
  const name = String(body.name || "").trim();
  if (!name) return fail(c, "请输入密钥名称", 400);

  const key = "cl_" + crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  // 明文只返回一次（前端弹窗展示），库中只存哈希，防止数据库泄漏时密钥全量暴露
  const keyHash = await hashApiKey(key);
  const apiKeyId = crypto.randomUUID();
  await db.insert(apiKeys).values({ id: apiKeyId, tenantId, name, key: keyHash });
  await recordTenantAudit(c, "apikey.create", "api_key", apiKeyId, { name });
  return ok(c, { key, prefix: apiKeyListPrefix(key) });
});

/** 删除 API 密钥 */
adminLotteryRoute.delete("/api-keys/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const apiKeyId = c.req.param("id");
  await db.delete(apiKeys).where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.tenantId, tenantId)));
  await recordTenantAudit(c, "apikey.delete", "api_key", apiKeyId);
  return ok(c, { deleted: true });
});

// ═════════════════════════════════════════════════════════
// Webhook 配置管理
// ═════════════════════════════════════════════════════════

/** Webhook 列表 */
adminLotteryRoute.get("/webhooks", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select({
      id: webhookConfigs.id,
      tenantId: webhookConfigs.tenantId,
      url: webhookConfigs.url,
      events: webhookConfigs.events,
      active: webhookConfigs.active,
      lastSentAt: webhookConfigs.lastSentAt,
      lastError: webhookConfigs.lastError,
      createdAt: webhookConfigs.createdAt,
      updatedAt: webhookConfigs.updatedAt,
    })
    .from(webhookConfigs)
    .where(eq(webhookConfigs.tenantId, tenantId))
    .orderBy(desc(webhookConfigs.createdAt));
  return ok(c, { webhooks: rows });
});

/** 创建 Webhook */
adminLotteryRoute.post("/webhooks", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ url: string; events?: string[] }>();
  const url = String(body.url || "").trim();
  if (!url) return fail(c, "请输入 Webhook URL", 400);
  const urlError = validateWebhookUrl(url);
  if (urlError) return fail(c, urlError, 400);

  const quota = await getTenantUsage(db, tenantId);
  if (quota.limits.maxWebhooks !== null) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(webhookConfigs)
      .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, 1)));
    if (Number(total || 0) >= quota.limits.maxWebhooks) {
      return fail(c, `当前套餐最多允许 ${quota.limits.maxWebhooks} 个 Webhook`, 403);
    }
  }

  const signingSecret = createWebhookSigningSecret();
  const webhookId = crypto.randomUUID();
  await db.insert(webhookConfigs).values({
    id: webhookId,
    tenantId,
    url,
    events: JSON.stringify(body.events || ["draw.completed", "prize.issued"]),
    signingSecret,
  });
  await recordTenantAudit(c, "webhook.create", "webhook_config", webhookId, { url });
  return ok(c, { created: true, signingSecret });
});

/** 删除 Webhook */
adminLotteryRoute.delete("/webhooks/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const webhookId = c.req.param("id");
  await db.delete(webhookConfigs).where(and(eq(webhookConfigs.id, webhookId), eq(webhookConfigs.tenantId, tenantId)));
  await recordTenantAudit(c, "webhook.delete", "webhook_config", webhookId);
  return ok(c, { deleted: true });
});

/** Webhook 投递记录 */
adminLotteryRoute.get("/webhook-deliveries", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { limit, offset } = parseAdminPagination(c);
  const deliveries = await listWebhookDeliveries(db, tenantId, limit, offset);
  return ok(c, { deliveries });
});

/** 重试单条 Webhook 投递 */
adminLotteryRoute.post("/webhook-deliveries/:id/retry", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const result = await dispatchWebhookDelivery(db, tenantId, c.req.param("id"));
  return ok(c, result);
});

/** 批量处理待重试 Webhook 投递 */
adminLotteryRoute.post("/webhook-deliveries/process", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ limit?: number }>().catch((): { limit?: number } => ({}));
  const result = await processPendingWebhookDeliveries(db, tenantId, fetch, clampInteger(body.limit, 20, 1, 100));
  return ok(c, result);
});

// ═════════════════════════════════════════════════════════
// 优惠券码池管理
// ═════════════════════════════════════════════════════════

/** 优惠券列表 */
adminLotteryRoute.get("/coupons", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { limit, offset } = parseAdminPagination(c);
  const rows = await db
    .select()
    .from(couponCodes)
    .where(eq(couponCodes.tenantId, tenantId))
    .orderBy(desc(couponCodes.createdAt))
    .limit(limit).offset(offset);
  return ok(c, { coupons: rows });
});

/** 批量导入优惠券 */
adminLotteryRoute.post("/coupons/import", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ codes: string[]; label?: string; expiresAt?: string }>();
  if (!body.codes || body.codes.length === 0) return fail(c, "请提供至少一个码", 400);
  let count = 0;
  let skipped = 0;
  for (const code of body.codes) {
    try {
      await db.insert(couponCodes).values({
        id: crypto.randomUUID(), tenantId, code: code.trim(),
        label: body.label || "", expiresAt: body.expiresAt || null,
      });
      count++;
    } catch (err) {
      // 只把唯一索引冲突视为“重复券码”跳过；其他数据库错误必须暴露，避免导入半成功却不可感知。
      if (!isUniqueConstraintError(err)) throw err;
      skipped++;
    }
  }
  return ok(c, { imported: count, skipped });
});

/** 核销优惠券（CAS 条件更新防止并发重复核销） */
adminLotteryRoute.post("/coupons/redeem", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ code: string }>();
  const code = String(body.code || "").trim();
  if (!code) return fail(c, "请输入优惠券码", 400);

  // CAS 条件更新：仅当 status = 'available' 时更新为 redeemed
  const result = await db.update(couponCodes)
    .set({ status: "redeemed", redeemedAt: new Date().toISOString() })
    .where(and(eq(couponCodes.tenantId, tenantId), eq(couponCodes.code, code), eq(couponCodes.status, "available")));

  if ((result.rowsAffected ?? 0) === 0) {
    return fail(c, "优惠券不存在或已使用", 404);
  }

  const [coupon] = await db
    .select({ label: couponCodes.label })
    .from(couponCodes)
    .where(and(eq(couponCodes.tenantId, tenantId), eq(couponCodes.code, code)))
    .limit(1);

  await recordTenantAudit(c, "coupon.redeem", "coupon_code", code);
  return ok(c, { redeemed: true, label: coupon?.label || "" });
});

// ═════════════════════════════════════════════════════════
// 租户品牌配置（白标）
// ═════════════════════════════════════════════════════════

/** 获取品牌配置（含商户名称） */
adminLotteryRoute.get("/brand", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const [tenant] = await db.select({ name: tenants.name, brandConfig: tenants.brandConfig, storeSlug: tenants.storeSlug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return fail(c, "租户不存在", 404);
  const config = tryParseJson(tenant.brandConfig);
  // 店铺功能开关：L3 平台运营者配置，控制主页右上角「我的商铺」按钮与 /admin/brand 的「打开」按钮
  const shopFeatureEnabled = await isShopFeatureEnabled(db);
  return ok(c, { config, storeSlug: tenant.storeSlug || "", name: tenant.name, shopFeatureEnabled });
});

/** 更新品牌配置（含商户名称、品牌字段合并） */
adminLotteryRoute.put("/brand", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const [tenant] = await db.select({ name: tenants.name, brandConfig: tenants.brandConfig, storeSlug: tenants.storeSlug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return fail(c, "租户不存在", 404);

  const body = await c.req.json<any>();
  const existingConfig = tryParseJson(tenant.brandConfig) || {};

  // 合并品牌配置：仅更新 body 中明确提供的字段，未提供的保留原值
  // 注意：null 也视为「未提供」，避免 API 直接调用传递 null 污染存储
  const config = {
    logo: body.logo !== undefined && body.logo !== null ? String(body.logo) : existingConfig.logo || "",
    primaryColor: body.primaryColor !== undefined && body.primaryColor !== null ? String(body.primaryColor) : existingConfig.primaryColor || "",
    companyName: body.companyName !== undefined && body.companyName !== null ? String(body.companyName) : existingConfig.companyName || "",
    domain: body.domain !== undefined && body.domain !== null ? String(body.domain) : existingConfig.domain || "",
  };

  // 商户名称（tenant.name）：saas 注册时填写的名称，在此可修改
  const name = body.name !== undefined && body.name !== null ? String(body.name).trim().slice(0, 100) : "";

  // store_slug 允许 L2 自定义（为空时保留原值或自动生成）
  // 格式校验与 L3 custom_shop_link / normalize 规则一致（docs/258 部署前审查修复）：
  // 仅字母数字与短横线、短横线不能在首尾、强制小写，避免公开链接 /shops/{slug} 畸形或大小写敏感。
  const storeSlugRaw = body.storeSlug !== undefined && body.storeSlug !== null ? String(body.storeSlug).trim().slice(0, 30) : tenant.storeSlug || "";
  let storeSlug = storeSlugRaw.toLowerCase();
  if (storeSlug) {
    const slugValid = storeSlug.length === 1
      ? /^[a-z0-9]$/.test(storeSlug)
      : /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(storeSlug);
    if (!slugValid) {
      return fail(c, "店铺链接只能包含字母数字和短横线，且短横线不能在首尾", 400);
    }
  }

  try {
    await withDbTransaction(db, async (tx) => {
      // 品牌配置与店铺链接同事务提交：避免"品牌已保存但 slug 冲突 500"的半成功状态
      const updateData: Record<string, any> = {
        brandConfig: JSON.stringify(config),
        updatedAt: new Date().toISOString(),
      };
      if (name) updateData.name = name;

      // store_slug 变更前先查重：唯一索引兜底，这里给友好 400（而非 500）
      if (storeSlug && storeSlug !== tenant.storeSlug) {
        const [dup] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.storeSlug, storeSlug)).limit(1);
        if (dup && dup.id !== tenantId) {
          throw new BrandSlugConflictError();
        }
        updateData.storeSlug = storeSlug;
      }

      await tx.update(tenants).set(updateData).where(eq(tenants.id, tenantId));
    });
  } catch (err) {
    if (err instanceof BrandSlugConflictError) {
      return fail(c, "店铺链接已被占用", 400);
    }
    throw err;
  }

  // 品牌配置更新成功后留审计（事务外，审计失败不影响主业务，与同文件 webhook/coupon 一致）
  await recordTenantAudit(c, "tenant.brand.update", "tenant", tenantId, {
    name: name || undefined,
    storeSlug: storeSlug || undefined,
    configKeys: Object.keys(config).filter((k) => config[k as keyof typeof config]),
  });

  return ok(c, { config, storeSlug: storeSlug || tenant.storeSlug, name: name || tenant.name });
});

// ═════════════════════════════════════════════════════════
// 分享裂变统计
// ═════════════════════════════════════════════════════════

/** 分享统计 */
adminLotteryRoute.get("/draws/:id/shares", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const rows = await db
    .select()
    .from(shareRecords)
    .where(and(eq(shareRecords.tenantId, tenantId), eq(shareRecords.drawId, drawId)))
    .orderBy(desc(shareRecords.createdAt));
  const totalClicks = rows.reduce((s, r) => s + r.clickedCount, 0);
  const totalJoins = rows.reduce((s, r) => s + r.joinedCount, 0);
  return ok(c, { shares: rows, totalClicks, totalJoins, sharerCount: rows.length });
});

// ═════════════════════════════════════════════════════════
// 兑换码管理（运营者生成，终端用户兑换）
// ═════════════════════════════════════════════════════════

/** 生成唯一兑换码 */

// 兑换码平台管理入口已迁移到 /api/platform/redemption-codes。
// 租户侧只保留兑换接口：/api/admin/redemption-codes/redeem

/** 兑换历史记录（租户侧：查看本租户的兑换记录） */
adminLotteryRoute.get("/redemption-records", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
  const offset = Math.max(0, Number(c.req.query("offset") || "0"));

  const rows = await db
    .select()
    .from(redemptionRecords)
    .where(eq(redemptionRecords.tenantId, tenantId))
    .orderBy(desc(redemptionRecords.redeemedAt))
    .limit(limit).offset(offset);

  return ok(c, { records: rows });
});

/** 兑换码兑换（租户侧：输入兑换码，获得额度）
 *
 * 使用 CAS（条件更新）防止并发超发：
 *   UPDATE redemption_codes SET used_count = used_count + 1
 *   WHERE id = ? AND used_count < max_uses AND status = 'active'
 * 如果影响行数为 0，说明兑换码已被用完或失效。
 */
adminLotteryRoute.post("/redemption-codes/redeem", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ code: string }>();
  const codeInput = String(body.code || "").trim().toUpperCase();

  if (!codeInput) return fail(c, "请输入兑换码", 400);

  try {
    const grant = await withDbTransaction(db, async (tx) => {
      // 查找兑换码和发放额度必须与后续 CAS、租户加额、兑换记录同事务提交。
      // 否则网络抖动或写锁错误会留下“码已用但额度未到账”的半成功状态。
      const [codeRecord] = await tx
        .select()
        .from(redemptionCodes)
        .where(eq(redemptionCodes.code, codeInput))
        .limit(1);

      if (!codeRecord) throw new RedeemError("兑换码不存在", 404);
      if (codeRecord.status !== "active") throw new RedeemError("兑换码已失效", 400);
      if (new Date() > new Date(codeRecord.expiresAt)) throw new RedeemError("兑换码已过期", 400);

      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + codeRecord.durationDays * 86400000).toISOString();

      // CAS 条件更新：原子递增 used_count，只有未用完且状态仍 active 时才成功。
      const updateResult = await tx.update(redemptionCodes)
        .set({
          usedCount: sql`used_count + 1`,
          status: sql`CASE WHEN used_count + 1 >= max_uses THEN 'used' ELSE 'active' END`,
          updatedAt: now,
        })
        .where(and(
          eq(redemptionCodes.id, codeRecord.id),
          eq(redemptionCodes.status, "active"),
          sql`used_count < max_uses`,
        ));

      if ((updateResult.rowsAffected ?? 0) === 0) {
        throw new RedeemError("兑换码已被使用", 409);
      }

      await tx.update(tenants).set({
        extraActivityQuota: sql`COALESCE(extra_activity_quota, 0) + ${codeRecord.activityQuota}`,
        extraParticipantQuota: sql`COALESCE(extra_participant_quota, 0) + ${codeRecord.participantQuota}`,
        extraQuotaExpiresAt: expiresAt,
        updatedAt: now,
      }).where(eq(tenants.id, tenantId));

      const [tenant] = await tx
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      await tx.insert(redemptionRecords).values({
        id: crypto.randomUUID(),
        codeId: codeRecord.id,
        code: codeInput,
        tenantId,
        tenantName: tenant?.name || "",
        activityQuotaGranted: codeRecord.activityQuota,
        participantQuotaGranted: codeRecord.participantQuota,
        durationDaysGranted: codeRecord.durationDays,
        expiresAt,
        redeemedAt: now,
      });

      return {
        activityQuota: codeRecord.activityQuota,
        participantQuota: codeRecord.participantQuota,
        expiresAt,
      };
    });

    await recordTenantAudit(c, "redemption.redeem", "redemption_code", codeInput);
    return ok(c, { redeemed: true, ...grant });
  } catch (err) {
    if (err instanceof RedeemError) return fail(c, err.message, err.status);
    throw err;
  }
});

class RedeemError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
}
