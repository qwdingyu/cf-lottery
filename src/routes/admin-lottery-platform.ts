/**
 * 管理端抽奖路由 — 平台目标管理域（docs/167 Phase 1）
 *
 * 提供 platformTargets 的完整 CRUD：
 * - 列表/详情/创建/更新/删除
 * - 创建时自动生成每群独立入站密钥（明文只返回一次，库中只存 SHA-256 哈希）
 * - 编辑时可填写新入站密钥覆盖；留空不更新；也支持系统生成重置入站密钥
 *
 * 设计约束：
 * - 平台目标（QQ 群/Telegram 群组等）归属租户，字段与 webhookConfigs 完全隔离（不污染 HTTP webhook 语义）
 * - 内置命令开关是固定集合，租户只能启停/改文案，不能新增任意命令
 * - 平台白名单/提供方白名单由 adapter-factory 动态提供，新增平台只需注册适配器
 * - P0 不接收 adapterConfig.token：没有加密存储闭环前，禁止用占位符伪装“已加密”
 */
import type { Context } from "hono";
import type { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb, ok, fail, clampInteger } from "../lib/http";
import { and, eq, desc, count } from "drizzle-orm";
import { platformTargets, platformDeliveries, lotteryDraws, auditLogs } from "../db/schema";
import { createPlatformInboundSecret, hashPlatformInboundSecret } from "../services/platform/security";
import { DEFAULT_BUILTIN_COMMANDS, type BuiltinCommandConfig } from "../services/platform/types";
import { getPlatformAdapter, getSupportedPlatforms, getSupportedProviders } from "../services/platform/adapter-factory";

/**
 * 有效平台列表动态从适配器工厂获取，新增平台只需在 adapter-factory.ts 注册，
 * 无需修改此处白名单。
 */
const VALID_PLATFORMS = new Set(getSupportedPlatforms());
const VALID_DEPLOYMENT_MODES = new Set(["tenant_hosted", "managed"]);
/**
 * 有效提供方列表动态从适配器工厂获取。
 */
const VALID_PROVIDERS = new Set(getSupportedProviders());

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

/**
 * 校验并规范化平台适配器配置。每个平台有独立的配置字段与校验规则，
 * 避免把 QQ(NapCat) 的 baseUrl 假设强加给其他平台（如 Telegram 需要 botToken）。
 *
 * 安全原则：P0 只保存非敏感连接信息。QQ 的 token / Telegram 的 botToken 都属于凭据，
 * 需要“租户级加密存储 + 解密投递 + 前端不回显”的完整闭环；在该闭环完成前，
 * QQ 直接拒绝敏感字段；Telegram 用 botToken 出站是刚性需求，单独评估风险。
 */
function normalizeAdapterConfig(
  platform: string,
  input: unknown,
): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "adapterConfig 必须是对象" };
  }
  const raw = input as Record<string, unknown>;

  // 平台特定校验：新增平台在此扩展
  if (platform === "qq") return validateQQAdapterConfig(raw);
  if (platform === "telegram") return validateTelegramAdapterConfig(raw);

  return { ok: false, message: `暂不支持的平台适配器配置: ${platform}` };
}

/** QQ (NapCat) 适配器配置：只需要 baseUrl，P0 拒绝保存纯文本 token */
function validateQQAdapterConfig(
  raw: Record<string, unknown>,
): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  if (raw.token !== undefined || raw.accessToken !== undefined || raw.authorization !== undefined) {
    return { ok: false, message: "P0 暂不支持保存 NapCat token，请使用内网、IP 白名单或反向代理保护适配器" };
  }
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  if (!baseUrl) return { ok: true, value: {} };
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, message: "adapterConfig.baseUrl 必须以 http:// 或 https:// 开头" };
  }
  return { ok: true, value: { baseUrl } };
}

/**
 * Telegram 适配器配置：需要 botToken 用于出站调用 Telegram Bot API。
 * 注意：botToken 属敏感凭据，P0 以明文字段存储，需在 docs 中明确风险并规划加密闭环。
 */
function validateTelegramAdapterConfig(
  raw: Record<string, unknown>,
): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  const botToken = typeof raw.botToken === "string" ? raw.botToken.trim() : "";
  if (!botToken) return { ok: true, value: {} };
  // Telegram Bot API token 格式：<bot_id>:<auth_key>
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    return { ok: false, message: "Telegram botToken 格式无效，应为 <bot_id>:<auth_key>" };
  }
  return { ok: true, value: { botToken } };
}

function parseAdapterConfigJson(rawJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function buildPlatformTestMessage(platform: string, targetName: string) {
  const name = targetName.trim() || "当前群组";
  return `【cf-lottery 群助手】${name} 连接测试成功。收到这条消息说明 ${platform} 出站配置可用。`;
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
    if (!VALID_PLATFORMS.has(platform)) {
      const supported = Array.from(VALID_PLATFORMS).join(", ");
      return fail(c, `平台类型无效，当前支持的平台: ${supported}`);
    }
    const targetId = String(body.targetId || "").trim();
    if (!targetId) return fail(c, "缺少群号 targetId");
    const targetName = String(body.targetName || "").trim().slice(0, 120);

    const activeDrawId = String(body.activeDrawId || "").trim();
    const draw = activeDrawId ? await resolveDraw(db, tenantId, activeDrawId) : null;
    if (activeDrawId && !draw) return fail(c, "绑定活动不存在或不属于当前租户");

    const deploymentMode = String(body.adapterDeploymentMode || "tenant_hosted");
    if (!VALID_DEPLOYMENT_MODES.has(deploymentMode)) return fail(c, "部署模式无效，仅支持 tenant_hosted/managed");
    const provider = String(body.adapterProvider || "napcat");
    if (provider && !VALID_PROVIDERS.has(provider)) {
      const providers = Array.from(VALID_PROVIDERS).join(", ");
      return fail(c, `适配器提供方无效，当前支持的提供方: ${providers}`);
    }

    const adapterConfigResult = normalizeAdapterConfig(platform, body.adapterConfig);
    if (!adapterConfigResult.ok) return fail(c, adapterConfigResult.message);
    const adapterConfig = adapterConfigResult.value;

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
      const adapterConfigResult = normalizeAdapterConfig(row.platform, body.adapterConfig);
      if (!adapterConfigResult.ok) return fail(c, adapterConfigResult.message);
      patch.adapterConfigJson = JSON.stringify(adapterConfigResult.value);
    }
    if (body.builtinCommands && typeof body.builtinCommands === "object") {
      const merged = parseBuiltinCommandsInput(body.builtinCommands as Record<string, unknown>);
      patch.builtinCommandsJson = JSON.stringify(merged);
    }
    if (typeof body.inboundSecret === "string") {
      const inboundSecret = body.inboundSecret.trim();
      if (inboundSecret) {
        if (inboundSecret.length < 16) return fail(c, "入站密钥至少 16 位");
        patch.inboundSecretHash = await hashPlatformInboundSecret(inboundSecret);
      }
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

  // ── 发送测试消息：用于租户自托管 NapCat/OneBot 上线前联调 ──
  route.post("/platform-targets/:id/test-message", async (c) => {
    const db = getDb(c);
    const tenantId = c.get("tenantId") as string;
    const id = c.req.param("id");
    const [target] = await db
      .select()
      .from(platformTargets)
      .where(and(eq(platformTargets.tenantId, tenantId), eq(platformTargets.id, id)))
      .limit(1);
    if (!target) return fail(c, "绑定不存在", 404);
    const adapterConfig = parseAdapterConfigJson(target.adapterConfigJson);
    const baseUrl = String(adapterConfig.baseUrl || "").trim();
    if (!baseUrl) return fail(c, "请先配置适配器 baseUrl 后再测试发送");

    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const customText = typeof body?.text === "string" ? body.text.trim().slice(0, 200) : "";
    const text = customText || buildPlatformTestMessage(target.platform, target.targetName);
    const deliveryId = crypto.randomUUID();
    const now = new Date().toISOString();
    const payloadJson = JSON.stringify({ eventType: "platform.test", renderedMessage: text });

    try {
      const adapter = getPlatformAdapter(target.platform, adapterConfig, fetch);
      const result = await adapter.send({
        platform: target.platform as "qq" | "telegram",
        targetId: target.targetId,
        type: "text",
        text,
      });
      await db.insert(platformDeliveries).values({
        id: deliveryId,
        tenantId,
        platformTargetId: target.id,
        platform: target.platform,
        targetId: target.targetId,
        eventId: `ptest_${crypto.randomUUID().replace(/-/g, "")}`,
        eventType: "platform.test",
        command: "test_message",
        payloadJson,
        status: "sent",
        attemptCount: 1,
        providerMessageId: result.messageId,
        responseBody: JSON.stringify(result.response || {}),
        sentAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await recordPlatformAudit(c, "platform_target.test_message", id, { ok: true });
      return ok(c, { deliveryId, providerMessageId: result.messageId });
    } catch (err) {
      const errorMsg = String(err instanceof Error ? err.message : err);
      await db.insert(platformDeliveries).values({
        id: deliveryId,
        tenantId,
        platformTargetId: target.id,
        platform: target.platform,
        targetId: target.targetId,
        eventId: `ptest_${crypto.randomUUID().replace(/-/g, "")}`,
        eventType: "platform.test",
        command: "test_message",
        payloadJson,
        status: "failed",
        attemptCount: 1,
        lastError: errorMsg.slice(0, 500),
        createdAt: now,
        updatedAt: now,
      });
      await recordPlatformAudit(c, "platform_target.test_message", id, { ok: false, error: errorMsg.slice(0, 200) });
      return fail(c, `测试发送失败：${errorMsg.slice(0, 200)}`, 502);
    }
  });
}
