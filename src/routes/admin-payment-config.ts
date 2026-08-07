/**
 * L2 租户后台 — 支付配置与订单管理。
 *
 * 路由：
 *   GET    /admin/payment-config                 — 返回渠道元数据 + 当前租户配置（脱敏）
 *   PUT    /admin/payment-config                 — 保存支付配置（凭据加密存储）
 *   GET    /admin/payment-config/check           — 静态自检支付配置完整性
 *   GET    /admin/payment-orders                 — 查询当前租户支付订单
 *   POST   /admin/payment-orders/:id/retry-fulfillment — 人工补发卡密
 *
 * 鉴权：requireAuth + requireTenantMember（仅 owner/admin 可写）
 */
import { Hono } from "hono";
import { and, count, desc, eq } from "drizzle-orm";
import { getDb, ok, fail } from "../lib/http";
import { getEnv } from "../lib/platform";
import { requireAuth, requireTenantMember } from "../middleware/auth";
import {
  auditLogs,
  lotteryDraws,
  lotteryEntries,
  paymentOrders,
  prizeCodes,
  tenantConfigs,
} from "../db/schema";
import { parseAdminPagination, recordTenantAudit } from "./admin-lottery-helpers";
import { PAYMENT_PROVIDER_CATALOG, getProviderMeta } from "../services/payment/catalog";
import { retryPaymentFulfillment } from "../services/payment/payment-service";
import type { AppEnv } from "../bindings";
import { sql } from "drizzle-orm";

export const adminPaymentConfigRoute = new Hono<AppEnv>();
adminPaymentConfigRoute.use("*", requireAuth, requireTenantMember());

/** 脱敏字段占位符：前端不回显密文，后端用占位符保留原值。 */
const SENSITIVE_CONFIG_PLACEHOLDER = "••••••••";

function parseSavedProviders(raw: string): Record<string, Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, Record<string, unknown>>
      : {};
  } catch {
    return {};
  }
}

function savedProviderValue(config: Record<string, unknown> | undefined, key: string): string {
  if (!config) return "";
  return String(config[key.toLowerCase()] ?? config[key] ?? "").trim();
}

// ═══════════════════════════════════════════════════════════════
// GET /admin/payment-config  docs/131 §10
// ═══════════════════════════════════════════════════════════════
adminPaymentConfigRoute.get("/payment-config", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") || "";

  // 读取当前租户配置
  const [row] = await db
    .select()
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId))
    .limit(1);
  let savedProviders: Record<string, unknown> = {};
  if (row) {
    savedProviders = parseSavedProviders(row.providers);
  }

  // 脱敏：敏感字段统一用占位符，防前端回写覆盖真实密钥。
  const sanitizedProviders: Record<string, { enabled: boolean; fields: Record<string, string> }> = {};
  for (const meta of PAYMENT_PROVIDER_CATALOG) {
    const saved = (savedProviders[meta.name] || {}) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const field of meta.fields) {
      const raw = String(saved[field.key.toLowerCase()] ?? saved[field.key] ?? "");
      fields[field.key] = raw && field.sensitive ? SENSITIVE_CONFIG_PLACEHOLDER : raw;
    }
    sanitizedProviders[meta.name] = {
      enabled: saved.enabled === true,
      fields,
    };
  }

  return ok(c, {
    providers: PAYMENT_PROVIDER_CATALOG.map((meta) => ({
      name: meta.name,
      displayName: meta.displayName,
      description: meta.description,
      supportedCurrencies: meta.supportedCurrencies,
      fields: meta.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type || "text",
        required: f.required,
        sensitive: f.sensitive,
        placeholder: (f as any).placeholder || "",
        hint: (f as any).hint || "",
      })),
      configured: sanitizedProviders[meta.name]?.enabled || false,
      saved: sanitizedProviders[meta.name] || null,
      enabled: sanitizedProviders[meta.name]?.enabled || false,
    })),
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /admin/payment-config/check  docs/131 §10
// ═══════════════════════════════════════════════════════════════
adminPaymentConfigRoute.get("/payment-config/check", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") || "";
  const encryptionKeyConfigured = Boolean(getEnv(c, "CREDENTIALS_ENCRYPTION_KEY"));

  const [row] = await db
    .select()
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId))
    .limit(1);

  const providers = parseSavedProviders(row?.providers || "{}");
  const checks = PAYMENT_PROVIDER_CATALOG.map((meta) => {
    const config = providers[meta.name];
    const enabled = config?.enabled === true;
    const issues: string[] = [];
    const warnings: string[] = [];

    if (!enabled) {
      issues.push("未启用");
    }
    if (!meta.supportsDirectFulfillment) {
      issues.push("当前未支持直付自动发卡");
    }
    for (const field of meta.fields) {
      const value = savedProviderValue(config, field.key);
      if (field.required && !value) {
        issues.push(`${field.label} 未配置`);
      }
      if (field.sensitive && value) {
        if (value.startsWith("enc:") && !encryptionKeyConfigured) {
          issues.push(`${field.label} 已加密但 CREDENTIALS_ENCRYPTION_KEY 未配置`);
        } else if (!value.startsWith("enc:")) {
          warnings.push(`${field.label} 未以 enc: 形式保存，建议重新保存配置`);
        }
      }
    }

    return {
      name: meta.name,
      displayName: meta.displayName,
      enabled,
      configured: enabled && issues.length === 0,
      supportsDirectFulfillment: meta.supportsDirectFulfillment,
      supportedCurrencies: meta.supportedCurrencies,
      issues,
      warnings,
    };
  });

  const currencySupport = ["cny", "usd", "usdt"].map((currency) => {
    const availableProviders = checks
      .filter((check) => (
        check.configured &&
        check.supportsDirectFulfillment &&
        check.supportedCurrencies.some((item) => item.toLowerCase() === currency)
      ))
      .map((check) => check.name);
    return {
      currency,
      available: availableProviders.length > 0,
      providers: availableProviders,
    };
  });

  return ok(c, {
    credentialsEncryptionKey: {
      configured: encryptionKeyConfigured,
    },
    providers: checks,
    currencySupport,
  });
});

// ═══════════════════════════════════════════════════════════════
// PUT /admin/payment-config  docs/131 §10
// ═══════════════════════════════════════════════════════════════
adminPaymentConfigRoute.put("/payment-config", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") || "";
  const tenantRole = c.get("tenantRole") || "";
  // docs/131 §9：支付配置只允许 owner/admin 写入（viewer 只读）
  if (tenantRole !== "owner" && tenantRole !== "admin") {
    return fail(c, "无权限：仅租户所有者/管理员可配置支付", 403);
  }
  const encryptionKey = getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "";
  if (!encryptionKey) {
    return fail(c, "CREDENTIALS_ENCRYPTION_KEY 未配置，无法加密保存支付凭据", 400);
  }

  const body = await c.req.json<{
    providers: Array<{
      name: string;
      enabled: boolean;
      fields: Record<string, string>;
    }>;
  }>();

  if (!body.providers || !Array.isArray(body.providers)) {
    return fail(c, "缺少 providers 参数", 400);
  }

  // 读取现有配置（用于占位符保留原值）
  const [existingRow] = await db
    .select()
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId))
    .limit(1);
  let existingProviders: Record<string, Record<string, unknown>> = {};
  if (existingRow) {
    existingProviders = parseSavedProviders(existingRow.providers);
  }

  // 加密敏感字段,构建存储对象
  const { encrypt: aesEncrypt } = await import("@usethink/cf-core");
  const providers: Record<string, Record<string, unknown>> = {};
  const issues: string[] = [];

  for (const item of body.providers) {
    const meta = getProviderMeta(item.name);
    if (!meta) { issues.push(`未知渠道: ${item.name}`); continue; }

    const cfg: Record<string, unknown> = { enabled: item.enabled };
    for (const field of meta.fields) {
      let raw = item.fields[field.key] || "";
      // 占位符 → 保留原值，避免保存表单时把真实密钥覆盖为空。
      if (field.sensitive && raw === SENSITIVE_CONFIG_PLACEHOLDER) {
        const existing = existingProviders[item.name]?.[field.key.toLowerCase()] ?? existingProviders[item.name]?.[field.key];
        if (existing && String(existing).startsWith("enc:")) {
          cfg[field.key.toLowerCase()] = existing;
          continue;
        }
        // DB 也无值 → 视为空
        raw = "";
      }
      if (field.required && !raw) {
        if (item.enabled) issues.push(`${meta.displayName}: ${field.label} 必填`);
        continue;
      }
      if (!raw) continue;
      cfg[field.key.toLowerCase()] = field.sensitive
        ? "enc:" + (await aesEncrypt(raw as unknown as Record<string, unknown>, encryptionKey))
        : raw;
    }
    providers[item.name] = cfg;
  }

  if (issues.length > 0) {
    return fail(c, issues.join("; "), 400);
  }

  // 写入租户配置表
  await db
    .insert(tenantConfigs)
    .values({
      tenantId,
      providers: JSON.stringify(providers),
      enabled: 1,
    })
    .onConflictDoUpdate({
      target: tenantConfigs.tenantId,
      set: { providers: JSON.stringify(providers), enabled: 1, updatedAt: sql`(datetime('now'))` },
    });

  // docs/131 §9：保存写租户审计（只记录渠道与启用状态摘要，不含密钥）
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      tenantId,
      actorUserId: c.get("userId") as string,
      action: "tenant.payment_config.update",
      targetType: "payment_config",
      targetId: tenantId,
      metadataJson: JSON.stringify({
        providers: body.providers.map((p) => ({ name: p.name, enabled: p.enabled })),
      }),
    });
  } catch (err) {
    console.error("[admin] payment config audit failed:", err);
  }

  return ok(c, { ok: true });
});

// ═══════════════════════════════════════════════════════════════
// GET /admin/payment-orders  docs/131 §10
// ═══════════════════════════════════════════════════════════════
adminPaymentConfigRoute.get("/payment-orders", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") || "";
  const { limit, offset } = parseAdminPagination(c, 20, 100);
  const status = String(c.req.query("status") || "").trim();
  const provider = String(c.req.query("provider") || "").trim();
  const drawId = String(c.req.query("drawId") || "").trim();

  const conditions = [
    eq(paymentOrders.tenantId, tenantId),
    eq(lotteryDraws.tenantId, tenantId),
    eq(lotteryEntries.tenantId, tenantId),
  ];
  if (status) conditions.push(eq(paymentOrders.status, status));
  if (provider) conditions.push(eq(paymentOrders.provider, provider));
  if (drawId) conditions.push(eq(paymentOrders.drawId, drawId));

  const where = and(...conditions);
  const rows = await db
    .select({
      id: paymentOrders.id,
      tenantId: paymentOrders.tenantId,
      drawId: paymentOrders.drawId,
      entryId: paymentOrders.entryId,
      amountCents: paymentOrders.amountCents,
      currency: paymentOrders.currency,
      status: paymentOrders.status,
      provider: paymentOrders.provider,
      providerTradeNo: paymentOrders.providerTradeNo,
      prizeCodeId: paymentOrders.prizeCodeId,
      paidAt: paymentOrders.paidAt,
      createdAt: paymentOrders.createdAt,
      updatedAt: paymentOrders.updatedAt,
      drawTitle: lotteryDraws.title,
      publicSlug: lotteryDraws.publicSlug,
      identityType: lotteryEntries.identityType,
      identityValue: lotteryEntries.identityValue,
      entryPaymentStatus: lotteryEntries.paymentStatus,
      prizeCodeStatus: prizeCodes.status,
    })
    .from(paymentOrders)
    .innerJoin(lotteryDraws, eq(lotteryDraws.id, paymentOrders.drawId))
    .innerJoin(lotteryEntries, eq(lotteryEntries.id, paymentOrders.entryId))
    .leftJoin(prizeCodes, and(
      eq(prizeCodes.id, paymentOrders.prizeCodeId),
      eq(prizeCodes.tenantId, tenantId),
    ))
    .where(where)
    .orderBy(desc(paymentOrders.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: count() })
    .from(paymentOrders)
    .innerJoin(lotteryDraws, eq(lotteryDraws.id, paymentOrders.drawId))
    .innerJoin(lotteryEntries, eq(lotteryEntries.id, paymentOrders.entryId))
    .where(where);

  return ok(c, {
    orders: rows.map((row) => ({
      ...row,
      hasPrizeCode: Boolean(row.prizeCodeId),
    })),
    total: Number(total || 0),
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /admin/payment-orders/:id/retry-fulfillment  docs/131 §10
// ═══════════════════════════════════════════════════════════════
adminPaymentConfigRoute.post("/payment-orders/:id/retry-fulfillment", async (c) => {
  const tenantRole = c.get("tenantRole") || "";
  if (tenantRole !== "owner" && tenantRole !== "admin") {
    return fail(c, "无权限：仅租户所有者/管理员可补发卡密", 403);
  }

  const db = getDb(c);
  const tenantId = c.get("tenantId") || "";
  const orderId = c.req.param("id");
  const result = await retryPaymentFulfillment(db, tenantId, orderId);
  if (!result.ok) {
    const status = result.error === "订单不存在"
      ? 404
      : result.error?.includes("没有可用卡密")
        ? 409
        : 400;
    return fail(c, result.error || "补发失败", status);
  }

  await recordTenantAudit(c, "tenant.payment_order.retry_fulfillment", "payment_order", orderId, {
    status: result.order?.status,
    prizeCodeId: result.order?.prizeCodeId || null,
  });

  return ok(c, { order: result.order });
});
