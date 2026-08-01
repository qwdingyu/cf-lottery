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
import { fail, getDb, ok, safeJsonBody } from "../lib/http";
import { requireAuth, requirePlatformMember } from "../middleware/auth";
import {
  adminSystemConfigDefinitions,
  isSensitiveSystemConfigKey,
  isSupportedSystemConfigKey,
  normalizeSystemConfigValue,
} from "../lib/system-config-registry";
import { getSystemConfig, upsertSystemConfig, deleteSystemConfig } from "../services/admin/system-config";

export const platformSystemConfigRoute = new Hono<AppEnv>();

// 所有平台配置路由需要登录 + 平台成员权限
platformSystemConfigRoute.use("*", requireAuth, requirePlatformMember(["platform_owner"]));

/** 获取系统配置 */
platformSystemConfigRoute.get("/", async (c) => {
  const db = getDb(c);
  const encryptionKey = c.env?.CREDENTIALS_ENCRYPTION_KEY;
  const config = await getSystemConfig(db, encryptionKey);
  const definitions = adminSystemConfigDefinitions().map((definition) => {
    if (!definition.sensitive) return definition;
    return { ...definition, configured: Boolean(config[definition.key]?.trim()) };
  });
  return ok(c, { config, definitions });
});

/** 更新系统配置（仅 platform_owner） */
platformSystemConfigRoute.put("/", async (c) => {
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
platformSystemConfigRoute.delete("/:key", async (c) => {
  const key = c.req.param("key");
  if (isSupportedSystemConfigKey(key)) {
    return fail(c, `内置配置项 "${key}" 不可删除，请使用 PUT 接口修改其值`, 400);
  }
  const db = getDb(c);
  await deleteSystemConfig(db, key);
  return ok(c, { deleted: key });
});
