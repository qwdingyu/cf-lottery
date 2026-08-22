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
  let bodyKey: string | undefined;
  try {
    const body = await safeJsonBody<{ key: string; value: string }>(c);
    if (!body || !body.key) return fail(c, "请求参数无效", 400);
    bodyKey = body.key;

    const normalized = normalizeSystemConfigValue(body.key, body.value);
    if (!normalized.ok) return fail(c, normalized.message, 400);

    const db = getDb(c);
    const sensitive = isSensitiveSystemConfigKey(body.key);
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

      // 自定义链接：平台级设置，非空时更新目标租户的 store_slug，旧链接立即失效。
      // 纳入同事务（docs/258 部署前审查修复）：
      // ① slug 被其他租户占用 → 抛错回滚，配置与版本/审计一并撤销，杜绝"配置已提交但 500"的半成功；
      // ② 首次设置（无旧值）时若存在多个租户 → 明确报错，不再静默覆盖「第一个租户」的 L2 自定义 slug。
      if (body.key === "custom_shop_link" && normalized.value && normalized.ok) {
        const newSlug = normalized.value;
        // 按旧值定位目标租户；无旧值（首次设置）→ 单租户部署才允许自动绑定
        let targetTenantId: string | undefined;
        if (beforeValue) {
          const [tenant] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.storeSlug, beforeValue)).limit(1);
          targetTenantId = tenant?.id;
        } else {
          const all = await tx.select({ id: tenants.id }).from(tenants).limit(2);
          if (all.length === 0) {
            throw new Error("自定义链接设置失败：当前没有任何租户");
          }
          if (all.length > 1) {
            throw new Error("自定义链接设置失败：存在多个租户，无法自动确定目标，请先在该租户的品牌设置中配置店铺链接");
          }
          targetTenantId = all[0]!.id;
        }
        if (!targetTenantId) {
          throw new Error("自定义链接设置失败：未找到持有旧链接的租户，请先在该租户的品牌设置中配置店铺链接");
        }
        // 新 slug 已被其他租户占用 → 冲突回滚（避免唯一索引 500 与半成功）
        const [occupied] = await tx.select({ id: tenants.id }).from(tenants)
          .where(eq(tenants.storeSlug, newSlug)).limit(1);
        if (occupied && occupied.id !== targetTenantId) {
          throw new Error("自定义链接已被其他租户占用，请更换");
        }
        if (newSlug !== beforeValue) {
          await tx.update(tenants)
            .set({ storeSlug: newSlug, updatedAt: new Date().toISOString() })
            .where(eq(tenants.id, targetTenantId));
        }
      }
    });

    return ok(c, {
      key: body.key,
      value: sensitive ? "" : normalized.value,
      ...(sensitive ? { configured: Boolean(normalized.value) } : {}),
    });
  } catch (err) {
    // 自定义链接的租户联动错误是业务校验失败（slug 占用/多租户无法定目标），返回 400；
    // 其余系统配置错误保持 500（基础设施/数据库故障）。
    const message = err instanceof Error ? err.message : "更新系统配置失败";
    const isShopLinkConflict = bodyKey === "custom_shop_link"
      && message.startsWith("自定义链接");
    return fail(c, message, isShopLinkConflict ? 400 : 500);
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
