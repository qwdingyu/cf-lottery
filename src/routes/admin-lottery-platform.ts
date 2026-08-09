/**
 * 管理端抽奖路由 — QQ 群助手/平台目标管理域（docs/167 Phase 1）
 *
 * 提供 platformTargets 的完整 CRUD：
 * - 列表/详情/创建/更新/删除
 * - 创建时自动生成每群独立入站密钥（明文只返回一次，库中只存 SHA-256 哈希）
 * - 重置入站密钥
 *
 * 设计约束：
 * - 平台目标（QQ 群）归属租户，字段与 webhookConfigs 完全隔离（不污染 HTTP webhook 语义）
 * - 内置命令开关是固定集合，租户只能启停/改文案，不能新增任意命令
 * - adapterConfig 中的敏感字段（token）P0 落库前以占位符落库，避免明文存储
 */
import type { Context } from "hono";
import type { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb, ok, fail, clampInteger } from "../lib/http";
import { and, eq, desc, count } from "drizzle-orm";
import { platformTargets, lotteryDraws, auditLogs } from "../db/schema";
import { createPlatformInboundSecret, hashPlatformInboundSecret } from "../services/platform/security";
import { DEFAULT_BUILTIN_COMMANDS, type BuiltinCommandConfig } from "../services/platform/types";

const VALID_PLATFORMS = new Set(["qq", "telegram"]);
const VALID_DEPLOYMENT_MODES = new Set(["tenant_hosted", "managed"]);
const VALID_PROVIDERS = new Set(["napcat"]);

function parsePagination(c: Context<AppEnv>) {
  return {
    limit: clampInteger(c.req.query("limit"), 50, 1, 200),
    offset: clampInteger(c.req.query("offset"), 0, 0, 100_000),
  };
}

async function recordPlatformAudit(
  c: Context<AppEnv>,
  action: string,
  targetId: string,
  metadata?: Record<string, unknown>,
) {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const actorUserId = c.get("userId") as string;
  if (!tenantId) return;
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    tenantId,
    actorUserId,
    action,
    targetType: "platform_target",
    targetId,
    metadataJson: metadata ? JSON.stringify(metadata) : "",
    createdAt: new Date().toISOString(),
  });
}

/** 从请求体中解析并校验内建命令开关（只接受布尔字段，未知键忽略） */
function parseBuiltinCommandsInput(body: Record<string, unknown>): BuiltinCommandConfig {
  const enabled = (key: string, fallback: boolean) =>
    typeof body[key] === "boolean" ? body[key] as boolean : fallback;
  return {
    checkinEnabled: enabled("checkinEnabled", DEFAULT_BUILTIN_COMMANDS.checkinEnabled),
    spinEnabled: enabled("spinEnabled", DEFAULT_BUILTIN_COMMANDS.spinEnabled),
    shareEnabled: enabled("shareEnabled", DEFAULT_BUILTIN_COMMANDS.shareEnabled),
    leaderboardEnabled: enabled("leaderboardEnabled", DEFAULT_BUILTIN_COMMANDS.leaderboardEnabled),
    myPrizeEnabled: enabled("myPrizeEnabled", DEFAULT_BUILTIN_COMMANDS.myPrizeEnabled),
    helpEnabled: enabled("helpEnabled", DEFAULT_BUILTIN_COMMANDS.helpEnabled),
  };
}

/** 校验 activeDrawId 归属当前租户，返回活动（含 publicSlug） */
async function resolveDraw(db: ReturnType<typeof getDb>, tenantId: string, activeDrawId: string) {
  if (!activeDrawId) return null;
  const [draw] = await db
    .select({ id: lotteryDraws.id, publicSlug: lotteryDraws.publicSlug })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.id, activeDrawId)))
    .limit(1);
  return draw || null;
}

export function setupPlatformRoutes(route: Hono<AppEnv>) {
  // ── 列表 ──
  route.get("/platform-targets", async (c) => {
    const db = getDb(c);
    const tenantId = c.get("tenantId") as string;
    const { limit, offset } = parsePagination(c);

    const [totalRow] = await db
      .select({ total: count() })
      .from(platformTargets)
      .where(eq(platformTargets.tenantId, tenantId));
    const rows = await db
      .select()
      .from(platformTargets)
      .where(eq(platformTargets.tenantId, tenantId))
      .orderBy(desc(platformTargets.createdAt))
      .limit(limit)
      .offset(offset);

    return ok(c, {
      total: Number(totalRow?.total || 0),
      items: rows,
    });
  });

  // ── 详情 ──
  route.get("/platform-targets/:id", async (c) => {
    const db = getDb(c);
    const tenantId = c.get("tenantId") as string;
    const [row] = await db
      .select()
      .from(platformTargets)
      .where(and(eq(platformTargets.tenantId, tenantId), eq(platformTargets.id, c.req.param("id"))))
      .limit(1);
    if (!row) return fail(c, "绑定不存在", 404);
    return ok(c, { item: row });
  });

  // ── 创建 ──
  route.post("/platform-targets", async (c) => {
    const db = getDb(c);
    const tenantId = c.get("tenantId") as string;
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return fail(c, "请求体不是有效 JSON");

    const platform = String(body.platform || "qq");
    if (!VALID_PLATFORMS.has(platform)) return fail(c, "平台类型无效，仅支持 qq/telegram");
    const targetId = String(body.targetId || "").trim();
    if (!targetId) return fail(c, "缺少群号 targetId");
    const targetName = String(body.targetName || "").trim().slice(0, 120);

    const activeDrawId = String(body.activeDrawId || "").trim();
    const draw = activeDrawId ? await resolveDraw(db, tenantId, activeDrawId) : null;
    if (activeDrawId && !draw) return fail(c, "绑定活动不存在或不属于当前租户");

    const deploymentMode = String(body.adapterDeploymentMode || "tenant_hosted");
    if (!VALID_DEPLOYMENT_MODES.has(deploymentMode)) return fail(c, "部署模式无效，仅支持 tenant_hosted/managed");
    const provider = String(body.adapterProvider || "napcat");
    if (provider && !VALID_PROVIDERS.has(provider)) return fail(c, "适配器提供方无效，P0 仅支持 napcat");

    // 创建时禁止通过 adapterConfig 直接写明文 token：P0 安全兜底，落库前以占位符替换
    const adapterConfig = body.adapterConfig && typeof body.adapterConfig === "object"
      ? body.adapterConfig as Record<string, unknown>
      : {};
    if (adapterConfig.token) adapterConfig.token = "[encrypted]";

    const builtinCommands = parseBuiltinCommandsInput(body as Record<string, unknown>);
    const assistantEnabled = body.assistantEnabled === false ? 0 : 1;

    // 每群独立入站密钥：明文只返回一次，库中只存哈希
    const inboundSecret = createPlatformInboundSecret();
    const inboundSecretHash = await hashPlatformInboundSecret(inboundSecret);

    // targetId 全租户唯一（schema 唯一索引 platform+targetId）
    const [existing] = await db
      .select({ id: platformTargets.id })
      .from(platformTargets)
      .where(and(eq(platformTargets.platform, platform), eq(platformTargets.targetId, targetId)))
      .limit(1);
    if (existing && existing.id) return fail(c, "该群已绑定，请勿重复添加");

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(platformTargets).values({
      id,
      tenantId,
      platform,
      targetId,
      targetName,
      activeDrawId: draw?.id || "",
      activePublicSlug: draw?.publicSlug || "",
      assistantEnabled,
      adapterDeploymentMode: deploymentMode,
      adapterProvider: provider,
      adapterConfigJson: JSON.stringify(adapterConfig),
      inboundSecretHash,
      builtinCommandsJson: JSON.stringify(builtinCommands),
      createdAt: now,
      updatedAt: now,
    });

    await recordPlatformAudit(c, "platform_target.create", id, { platform, targetId });

    // 明文密钥只在此返回一次（前端弹窗展示后丢弃）
    return ok(c, { item: { id }, inboundSecret });
  });

  // ── 更新 ──
  route.put("/platform-targets/:id", async (c) => {
    const db = getDb(c);
    const tenantId = c.get("tenantId") as string;
    const id = c.req.param("id");
    const [row] = await db
      .select()
      .from(platformTargets)
      .where(and(eq(platformTargets.tenantId, tenantId), eq(platformTargets.id, id)))
      .limit(1);
    if (!row) return fail(c, "绑定不存在", 404);

    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return fail(c, "请求体不是有效 JSON");

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };

    if (typeof body.targetName === "string") {
      patch.targetName = body.targetName.trim().slice(0, 120);
    }
    if (typeof body.assistantEnabled === "boolean") {
      patch.assistantEnabled = body.assistantEnabled ? 1 : 0;
    }
    if (body.activeDrawId !== undefined) {
      const activeDrawId = String(body.activeDrawId || "").trim();
      const draw = activeDrawId ? await resolveDraw(db, tenantId, activeDrawId) : null;
      if (activeDrawId && !draw) return fail(c, "绑定活动不存在或不属于当前租户");
      patch.activeDrawId = draw?.id || "";
      patch.activePublicSlug = draw?.publicSlug || "";
    }
    if (typeof body.adapterConfig === "object" && body.adapterConfig !== null) {
      patch.adapterConfigJson = JSON.stringify(body.adapterConfig);
    }
    if (body.builtinCommands && typeof body.builtinCommands === "object") {
      const merged = parseBuiltinCommandsInput(body.builtinCommands as Record<string, unknown>);
      patch.builtinCommandsJson = JSON.stringify(merged);
    }

    await db
      .update(platformTargets)
      .set(patch as never)
      .where(and(eq(platformTargets.tenantId, tenantId), eq(platformTargets.id, id)));

    await recordPlatformAudit(c, "platform_target.update", id, { patchKeys: Object.keys(patch) });
    return ok(c, { ok: true });
  });

  // ── 删除 ──
  route.delete("/platform-targets/:id", async (c) => {
    const db = getDb(c);
    const tenantId = c.get("tenantId") as string;
    const id = c.req.param("id");
    const [row] = await db
      .select({ id: platformTargets.id })
      .from(platformTargets)
      .where(and(eq(platformTargets.tenantId, tenantId), eq(platformTargets.id, id)))
      .limit(1);
    if (!row) return fail(c, "绑定不存在", 404);

    await db
      .delete(platformTargets)
      .where(and(eq(platformTargets.tenantId, tenantId), eq(platformTargets.id, id)));
    await recordPlatformAudit(c, "platform_target.delete", id);
    return ok(c, { ok: true });
  });

  // ── 重置入站密钥（明文只返回一次） ──
  route.post("/platform-targets/:id/reset-secret", async (c) => {
    const db = getDb(c);
    const tenantId = c.get("tenantId") as string;
    const id = c.req.param("id");
    const [row] = await db
      .select({ id: platformTargets.id })
      .from(platformTargets)
      .where(and(eq(platformTargets.tenantId, tenantId), eq(platformTargets.id, id)))
      .limit(1);
    if (!row) return fail(c, "绑定不存在", 404);

    const inboundSecret = createPlatformInboundSecret();
    const inboundSecretHash = await hashPlatformInboundSecret(inboundSecret);
    await db
      .update(platformTargets)
      .set({ inboundSecretHash, updatedAt: new Date().toISOString() })
      .where(and(eq(platformTargets.tenantId, tenantId), eq(platformTargets.id, id)));

    await recordPlatformAudit(c, "platform_target.reset_secret", id);
    return ok(c, { inboundSecret });
  });
}