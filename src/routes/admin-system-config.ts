/**
 * 管理端系统配置路由（cf-lottery 精简版）
 *
 * 从 cf-shop 抽取，移除电商专用功能（Turnstile/支付/业务数据清理）。
 * 只保留系统配置的 CRUD 操作。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { fail, getDb, ok, safeJsonBody } from "../lib/http";
import { requireAuth } from "../middleware/auth";
import {
  adminSystemConfigDefinitions,
  isSensitiveSystemConfigKey,
  isSupportedSystemConfigKey,
  normalizeSystemConfigValue,
} from "../lib/system-config-registry";
import { getSystemConfig, upsertSystemConfig, deleteSystemConfig } from "../services/admin/system-config";

export const adminSystemConfigRoute = new Hono<AppEnv>();

// 所有管理端配置路由需要登录认证
adminSystemConfigRoute.use("*", requireAuth);

/** 获取系统配置 */
adminSystemConfigRoute.get("/", async (c) => {
  const db = getDb(c);
  const encryptionKey = c.env?.CREDENTIALS_ENCRYPTION_KEY;
  const config = await getSystemConfig(db, encryptionKey);
  const definitions = adminSystemConfigDefinitions().map((definition) => {
    if (!definition.sensitive) return definition;
    return { ...definition, configured: Boolean(config[definition.key]?.trim()) };
  });
  return ok(c, { config, definitions });
});

/** 更新系统配置 */
adminSystemConfigRoute.put("/", async (c) => {
  const body = await safeJsonBody<{ key: string; value: string }>(c);
  if (!body || !body.key) return fail(c, "请求参数无效", 400);

  const normalized = normalizeSystemConfigValue(body.key, body.value);
  if (!normalized.ok) return fail(c, normalized.message, 400);

  const db = getDb(c);
  await upsertSystemConfig(db, body.key, normalized.value, c.env?.CREDENTIALS_ENCRYPTION_KEY);

  const sensitive = isSensitiveSystemConfigKey(body.key);
  return ok(c, {
    key: body.key,
    value: sensitive ? "" : normalized.value,
    ...(sensitive ? { configured: Boolean(normalized.value) } : {}),
  });
});

/** 删除系统配置（仅允许删除非内置配置项） */
adminSystemConfigRoute.delete("/:key", async (c) => {
  const key = c.req.param("key");
  if (isSupportedSystemConfigKey(key)) {
    return fail(c, `内置配置项 "${key}" 不可删除，请使用 PUT 接口修改其值`, 400);
  }
  const db = getDb(c);
  await deleteSystemConfig(db, key);
  return ok(c, { deleted: key });
});