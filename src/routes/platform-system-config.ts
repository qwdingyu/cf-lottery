/**
 * 平台端系统配置路由（L3 平台运营者专用）
 *
 * 这是 /api/admin/system-config 的目标替代入口：系统配置属于 L3 平台后台，
 * 不能继续放在 L2 租户后台下。当前阶段读写都收敛到 platform_owner，
 * 后续如要放开只读支持账号，必须先补平台审计和最小可见字段清单。
 * 这是唯一正确的系统配置管理入口。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { desc, eq } from "drizzle-orm";
import { withDbTransaction } from "../db/client";
import { clampInteger, fail, getDb, ok, safeJsonBody } from "../lib/http";
import { getEnv } from "../lib/platform";
import { decryptSecretConfigValueObserved } from "../lib/secret-config";
import { requireAuth, requirePlatformMember } from "../middleware/auth";
import {
  adminSystemConfigDefinitions,
  getSystemConfigDefinition,
  isSensitiveSystemConfigKey,
  isSupportedSystemConfigKey,
  normalizeSystemConfigValue,
} from "../lib/system-config-registry";
import {
  getSystemConfig,
  getSystemConfigHistory,
  getSystemConfigStoredValue,
  recordSystemConfigVersion,
  upsertSystemConfig,
  upsertSystemConfigStoredValue,
  deleteSystemConfig,
} from "../services/admin/system-config";
import { writePlatformAudit } from "../services/admin/platform-audit";
import { systemConfigVersions, tenants } from "../db/schema";

export const platformSystemConfigRoute = new Hono<AppEnv>();

// 所有平台配置路由需要登录 + 平台成员权限
platformSystemConfigRoute.use("*", requireAuth, requirePlatformMember(["platform_owner"]));

/** 获取系统配置 */
platformSystemConfigRoute.get("/", async (c) => {
  const db = getDb(c);
  const encryptionKey = getEnv(c, "CREDENTIALS_ENCRYPTION_KEY");
  const config = await getSystemConfig(db, encryptionKey);
  const definitions = adminSystemConfigDefinitions().map((definition) => {
    if (!definition.sensitive) return definition;
    return { ...definition, configured: Boolean(config[definition.key]?.trim()) };
  });
  return ok(c, { config, definitions });
});

/** 更新系统配置（仅 platform_owner） */
platformSystemConfigRoute.put("/", async (c) => {
  try {
    const body = await safeJsonBody<{ key: string; value: string }>(c);
    if (!body || !body.key) return fail(c, "请求参数无效", 400);

    const normalized = normalizeSystemConfigValue(body.key, body.value);
    if (!normalized.ok) return fail(c, normalized.message, 400);

    const db = getDb(c);
    const sensitive = isSensitiveSystemConfigKey(body.key);
    // 自定义链接：在事务外捕获旧值，用于事务后更新租户 store_slug
    const oldCustomLink = body.key === "custom_shop_link"
      ? (await getSystemConfigStoredValue(db, body.key))
        ?? getSystemConfigDefinition(body.key)?.defaultValue
        ?? ""
      : undefined;
    await withDbTransaction(db, async (tx) => {
      const beforeValue = (await getSystemConfigStoredValue(tx, body.key))
        ?? getSystemConfigDefinition(body.key)?.defaultValue
        ?? "";
      const storedValue = await upsertSystemConfig(tx, body.key, normalized.value, c.env?.CREDENTIALS_ENCRYPTION_KEY);
      await recordSystemConfigVersion(tx, {
        key: body.key,
        beforeValue,
        afterValue: storedValue,
        changeType: "update",
        actorUserId: c.get("userId") as string,
        actorRole: c.get("platformRole") as string,
      });
      // 平台配置变更和审计必须同成同败，避免出现"配置已生效但接口 500、审计缺失"的半成功状态。
      await writePlatformAudit(tx, {
        actorUserId: c.get("userId") as string,
        actorRole: c.get("platformRole") as string,
        action: "platform.system_config.update",
        targetType: "system_config",
        targetId: body.key,
        metadata: { key: body.key, sensitive, configured: Boolean(normalized.value) },
      });
    });

    // 自定义链接：平台级设置，非空时更新租户的 store_slug，旧链接立即失效
    if (body.key === "custom_shop_link" && normalized.value && normalized.ok) {
      const beforeValue = oldCustomLink!;
      // 按旧值（beforeValue）查找租户；首次设置时查第一个租户
      let tenantId: string | undefined;
      if (beforeValue) {
        const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.storeSlug, beforeValue)).limit(1);
        tenantId = tenant?.id;
      }
      if (!tenantId) {
        const [firstTenant] = await db.select({ id: tenants.id }).from(tenants).orderBy(tenants.createdAt).limit(1);
        tenantId = firstTenant?.id;
      }
      if (tenantId) {
        await db.update(tenants).set({ storeSlug: normalized.value, updatedAt: new Date().toISOString() }).where(eq(tenants.id, tenantId));
      }
    }

    return ok(c, {
      key: body.key,
      value: sensitive ? "" : normalized.value,
      ...(sensitive ? { configured: Boolean(normalized.value) } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "更新系统配置失败";
    return fail(c, message, 500);
  }
});

/** 系统配置历史（仅平台 owner） */
platformSystemConfigRoute.get("/history/:key", async (c) => {
  const key = c.req.param("key");
  if (!isSupportedSystemConfigKey(key)) return fail(c, `系统参数 "${key}" 未注册`, 404);

  const db = getDb(c);
  const history = await getSystemConfigHistory(
    db,
    key,
    c.env?.CREDENTIALS_ENCRYPTION_KEY,
    clampInteger(c.req.query("limit"), 10, 1, 20),
  );
  const currentStoredValue = await getSystemConfigStoredValue(db, key);
  const currentValue = currentStoredValue
    ? (isSensitiveSystemConfigKey(key)
      ? await decryptSecretConfigValueObserved(
        currentStoredValue,
        c.env?.CREDENTIALS_ENCRYPTION_KEY,
        () => void 0,
      )
      : currentStoredValue)
    : getSystemConfigDefinition(key)?.defaultValue ?? "";
  return ok(c, {
    key,
    currentValue,
    history,
  });
});

/** 回滚系统配置到上一版（仅平台 owner） */
platformSystemConfigRoute.post("/rollback/:key", async (c) => {
  try {
    const key = c.req.param("key");
    if (!isSupportedSystemConfigKey(key)) return fail(c, `系统参数 "${key}" 未注册`, 404);

    const db = getDb(c);
    const sensitive = isSensitiveSystemConfigKey(key);
    // 回滚必须在同一事务内重新读取“当前最新版本”，
    // 否则请求开始前的预读可能被并发更新打断，导致把旧版本回错到更早的状态。
    const latest = await withDbTransaction(db, async (tx) => {
      const [currentLatest] = await tx
        .select()
        .from(systemConfigVersions)
        .where(eq(systemConfigVersions.key, key))
        .orderBy(desc(systemConfigVersions.revision))
        .limit(1);
      if (!currentLatest) return null;

      await upsertSystemConfigStoredValue(tx, key, currentLatest.beforeValue);
      await recordSystemConfigVersion(tx, {
        key,
        beforeValue: currentLatest.afterValue,
        afterValue: currentLatest.beforeValue,
        changeType: "rollback",
        actorUserId: c.get("userId") as string,
        actorRole: c.get("platformRole") as string,
      });
      await writePlatformAudit(tx, {
        actorUserId: c.get("userId") as string,
        actorRole: c.get("platformRole") as string,
        action: "platform.system_config.rollback",
        targetType: "system_config",
        targetId: key,
        metadata: {
          key,
          revision: currentLatest.revision,
          sensitive,
        },
      });

      return currentLatest;
    });

    if (!latest) return fail(c, "没有可回滚的历史版本", 400);

    return ok(c, {
      key,
      rolledBackTo: isSensitiveSystemConfigKey(key)
        ? ""
        : latest.beforeValue,
      configured: Boolean(latest.beforeValue),
      revision: latest.revision,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "回滚系统配置失败";
    return fail(c, message, 500);
  }
});

/** 删除系统配置（仅允许删除非内置配置项） */
platformSystemConfigRoute.delete("/:key", async (c) => {
  try {
    const key = c.req.param("key");
    if (isSupportedSystemConfigKey(key)) {
      return fail(c, `内置配置项 "${key}" 不可删除，请使用 PUT 接口修改其值`, 400);
    }
    const db = getDb(c);
    await withDbTransaction(db, async (tx) => {
      const beforeValue = (await getSystemConfigStoredValue(tx, key)) ?? "";
      await deleteSystemConfig(tx, key);
      await recordSystemConfigVersion(tx, {
        key,
        beforeValue,
        afterValue: "",
        changeType: "delete",
        actorUserId: c.get("userId") as string,
        actorRole: c.get("platformRole") as string,
      });
      await writePlatformAudit(tx, {
        actorUserId: c.get("userId") as string,
        actorRole: c.get("platformRole") as string,
        action: "platform.system_config.delete",
        targetType: "system_config",
        targetId: key,
        metadata: { key },
      });
    });
    return ok(c, { deleted: key });
  } catch (err) {
    const message = err instanceof Error ? err.message : "删除系统配置失败";
    return fail(c, message, 500);
  }
});

/**
 * 发送测试邮件（验证 Resend 配置）
 */
platformSystemConfigRoute.post("/email-test", async (c) => {
  const body = await c.req.json<{ to: string }>();
  const to = String(body.to || "").trim();
  if (!to || !to.includes("@")) return fail(c, "请输入有效的邮箱地址", 400);

  const apiKey = getEnv(c, "RESEND_API_KEY");
  if (!apiKey) return fail(c, "RESEND_API_KEY 未配置", 500);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "onboarding@resend.dev",
        to,
        subject: "cf-lottery 邮件配置测试",
        html: "<p>✅ 邮件配置成功！</p>",
      }),
    });
    const data = await res.json() as any;
    if (!res.ok) return fail(c, (data as any)?.message || "发送失败", 500);
    return ok(c, { sent: true, resendId: data.id });
  } catch (err) {
    return fail(c, "发送异常: " + ((err as Error).message || "未知"), 500);
  }
});
