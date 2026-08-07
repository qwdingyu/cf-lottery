/**
 * L2 租户后台 — 支付配置管理（照搬 cf-shop admin-payment.ts 模式）
 *
 * 路由：
 *   GET    /admin/tenant-configs/payment   — 返回渠道元数据 + 当前租户配置（脱敏）
 *   PUT    /admin/tenant-configs/payment   — 保存支付配置（凭据加密存储）
 *
 * 鉴权：requireAuth + requireTenantMember（仅 owner/admin 可写）
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, ok, fail } from "../lib/http";
import { getEnv } from "../lib/platform";
import { requireAuth, requireTenantMember } from "../middleware/auth";
import { tenantConfigs } from "../db/schema";
import { PAYMENT_PROVIDER_CATALOG, getProviderMeta } from "../services/payment/catalog";
import type { AppEnv } from "../bindings";
import { sql } from "drizzle-orm";

export const adminPaymentConfigRoute = new Hono<AppEnv>();
adminPaymentConfigRoute.use("*", requireAuth, requireTenantMember());

// ═══════════════════════════════════════════════════════════════
// GET /admin/tenant-configs/payment
// ═══════════════════════════════════════════════════════════════
adminPaymentConfigRoute.get("/", async (c) => {
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
    try { savedProviders = JSON.parse(row.providers || "{}"); } catch {}
  }

  // 脱敏：隐藏敏感字段的密钥内容
  const sanitizedProviders: Record<string, { enabled: boolean; fields: Record<string, string> }> = {};
  for (const meta of PAYMENT_PROVIDER_CATALOG) {
    const saved = (savedProviders[meta.name] || {}) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const field of meta.fields) {
      const raw = String(saved[field.key.toLowerCase()] ?? saved[field.key] ?? "");
      if (raw && field.sensitive) {
        fields[field.key] = raw.length > 8 ? raw.slice(0, 4) + "****" : "****";
      } else if (raw) {
        fields[field.key] = raw;
      } else {
        fields[field.key] = "";
      }
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
// PUT /admin/tenant-configs/payment
// ═══════════════════════════════════════════════════════════════
adminPaymentConfigRoute.put("/", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") || "";
  const encryptionKey = getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "";

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

  // 加密敏感字段,构建存储对象
  const { encrypt: aesEncrypt } = await import("@usethink/cf-core");
  const providers: Record<string, Record<string, unknown>> = {};
  const issues: string[] = [];

  for (const item of body.providers) {
    const meta = getProviderMeta(item.name);
    if (!meta) { issues.push(`未知渠道: ${item.name}`); continue; }

    const cfg: Record<string, unknown> = { enabled: item.enabled };
    for (const field of meta.fields) {
      const raw = item.fields[field.key] || "";
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

  return ok(c, { ok: true });
});