/**
 * 管理端抽奖路由 — 平台目标管理域（docs/167 Phase 1）
 *
 * 提供 platformTargets 的完整 CRUD：
 * - 列表/详情/创建/更新/删除
 * - 创建时自动生成每目标独立入站密钥（明文只返回一次，库中只存 SHA-256 哈希）
 * - 编辑时可填写新入站密钥覆盖；留空不更新；也支持系统生成重置入站密钥
 *
 * 设计约束：
 * - 平台目标（QQ 群/Telegram 群组等）归属租户，字段与 webhookConfigs 完全隔离（不污染 HTTP webhook 语义）
 * - 内置命令开关是固定集合，租户只能启停/改文案，不能新增任意命令
 * - 平台白名单/提供方白名单由 adapter-factory 动态提供，新增平台只需注册适配器
 * - adapterConfig 中的 botToken/token 类字段必须加密存储，列表/详情只返回脱敏占位符
 */
import type { Context } from "hono";
import type { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb, ok, fail, clampInteger } from "../lib/http";
import { withDbTransaction } from "../db/client";
import { and, eq, desc, count } from "drizzle-orm";
import { platformTargets, platformDeliveries, lotteryDraws, auditLogs } from "../db/schema";
import { createPlatformInboundSecret, hashPlatformInboundSecret } from "../services/platform/security";
import { DEFAULT_BUILTIN_COMMANDS, type BuiltinCommandConfig } from "../services/platform/types";
import { parseStoredCheckinPolicy } from "../services/platform/checkin-reward";
import { getPlatformAdapter, getSupportedPlatforms, getSupportedProviders } from "../services/platform/adapter-factory";
import {
  encryptPlatformAdapterConfig,
  parsePlatformAdapterConfigJson,
  PLATFORM_SECRET_PLACEHOLDER,
  resolvePlatformAdapterConfigForRuntime,
  sanitizePlatformAdapterConfigForAdmin,
} from "../services/platform/adapter-config";
import { isCommunityFeatureEnabled } from "../lib/system-config-registry";
import { getEnv } from "../lib/platform";
import { validateProductLink } from "./admin-lottery-helpers";
/** 社群功能套餐配额校验（docs/180） */
import { canTenantCreatePlatformTarget } from "../services/platform/community-policy";

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

/**
 * 从请求体中解析并校验内建命令开关（布尔字段 + dailyCheckinPolicy 奖励次数 + purchaseConfig 购买链接）。
 *
 * 闭环要点（docs/171）：
 * 1. dailyCheckinPolicy.grantSpinCount 必须在此持久化，
 *    否则 targets.ts 解析 builtinCommandsJson 时恒为 undefined，签到奖励永不生效。
 * 2. purchaseConfig 必须在此持久化，否则 /秒杀 命令恒返回"管理员未配置"。
 *    两者都是「签到积分与抽奖次数打通」和「免费积分→付费购买转化漏斗」的闭环关键。
 */
function parseBuiltinCommandsInput(body: Record<string, unknown>): BuiltinCommandConfig {
  const enabled = (key: string, fallback: boolean) =>
    typeof body[key] === "boolean" ? body[key] as boolean : fallback;
  // 每日签到奖励配置：解析 dailyCheckinPolicy（支持 grantSpinCount 与 rewardConfig）。
  // 使用 checkin-reward 的 parseStoredCheckinPolicy 统一解析，避免与 targets.ts 语义漂移。
  // 0 / 缺失 / 非法 → 视为不发放奖励（省略 dailyCheckinPolicy）。
  const daily = body.dailyCheckinPolicy && typeof body.dailyCheckinPolicy === "object"
    ? body.dailyCheckinPolicy as Record<string, unknown>
    : undefined;
  const checkinPolicy = daily ? parseStoredCheckinPolicy(daily) : undefined;

  // 购买链接配置：解析 purchaseConfig.url 和 purchaseConfig.label。
  // url 必须为非空字符串，label 为空时使用默认文案"立即购买"。
  // 与 targets.ts 的 parseBuiltinCommandConfig 语义一致。
  const purchase = body.purchaseConfig && typeof body.purchaseConfig === "object"
    ? body.purchaseConfig as Record<string, unknown>
    : null;
  const purchaseUrl = purchase && typeof purchase.url === "string" && purchase.url.trim()
    ? String(purchase.url).trim()
    : "";
  const purchaseLabel = purchase && purchaseUrl
    && typeof purchase.label === "string" && purchase.label.trim()
    ? String(purchase.label).trim()
    : (purchaseUrl ? "立即购买" : "");

  return {
    checkinEnabled: enabled("checkinEnabled", DEFAULT_BUILTIN_COMMANDS.checkinEnabled),
    spinEnabled: enabled("spinEnabled", DEFAULT_BUILTIN_COMMANDS.spinEnabled),
    shareEnabled: enabled("shareEnabled", DEFAULT_BUILTIN_COMMANDS.shareEnabled),
    leaderboardEnabled: enabled("leaderboardEnabled", DEFAULT_BUILTIN_COMMANDS.leaderboardEnabled),
    myPrizeEnabled: enabled("myPrizeEnabled", DEFAULT_BUILTIN_COMMANDS.myPrizeEnabled),
    myCardCodeEnabled: enabled("myCardCodeEnabled", DEFAULT_BUILTIN_COMMANDS.myCardCodeEnabled),
    helpEnabled: enabled("helpEnabled", DEFAULT_BUILTIN_COMMANDS.helpEnabled),
    flashEnabled: enabled("flashEnabled", DEFAULT_BUILTIN_COMMANDS.flashEnabled),
    // 跨平台绑定命令始终可用（用户级工具，不随群开关关闭；docs/179）
    bindEnabled: true,
    ...(checkinPolicy
      ? { dailyCheckinPolicy: checkinPolicy }
      : {}),
    ...(purchaseUrl
      ? { purchaseConfig: { url: purchaseUrl, label: purchaseLabel } }
      : {}),
  };
}

function validatePurchaseConfigInput(body: Record<string, unknown>): string | null {
  const purchase = body.purchaseConfig && typeof body.purchaseConfig === "object"
    ? body.purchaseConfig as Record<string, unknown>
    : null;
  const url = typeof purchase?.url === "string" ? purchase.url.trim() : "";
  if (!url) return null;
  const error = validateProductLink({ url });
  return error ? `购买链接无效：${error}` : null;
}

/**
 * 校验并规范化平台适配器配置。每个平台有独立的配置字段与校验规则，
 * 避免把 QQ(NapCat) 的 baseUrl 假设强加给其他平台（如 Telegram 需要 botToken）。
 *
 * 安全原则：botToken / NapCat token 属于凭据，必须由调用方在写库前加密。
 * 本函数只做平台字段校验和规范化，不接触环境密钥。
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

/** QQ (NapCat) 适配器配置：baseUrl 必填于发送前；token 可选但必须在写库前加密。botId 为入站自动写入的只读字段，不接受运营手动输入 */
function validateQQAdapterConfig(
  raw: Record<string, unknown>,
): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  const value: Record<string, string> = {};

  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  if (baseUrl) {
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, message: "adapterConfig.baseUrl 必须以 http:// 或 https:// 开头" };
    }
    value.baseUrl = baseUrl;
  }
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  if (token && token !== PLATFORM_SECRET_PLACEHOLDER) value.token = token;

  // 注意：不再接受手动输入 botId（docs/177 方案升级）。botId = bot 自身 QQ 号是运行时已知值，
  // 由入站 `self_id` 自动写入（syncInboundBotIdentity），运营手动填会引入 typo/过时号等错误源。
  return { ok: true, value };
}

/**
 * Telegram 适配器配置：需要 botToken 用于出站调用 Telegram Bot API。
 */
function validateTelegramAdapterConfig(
  raw: Record<string, unknown>,
): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  const botToken = typeof raw.botToken === "string" ? raw.botToken.trim() : "";
  if (!botToken) return { ok: true, value: {} };
  if (botToken === PLATFORM_SECRET_PLACEHOLDER) return { ok: true, value: { botToken } };
  // Telegram Bot API token 格式：<bot_id>:<auth_key>
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    return { ok: false, message: "Telegram botToken 格式无效，应为 <bot_id>:<auth_key>" };
  }
  return { ok: true, value: { botToken } };
}

function buildPlatformTestMessage(platform: string, targetName: string) {
  const name = targetName.trim() || "当前目标";
  return `【cf-lottery 平台助手】${name} 连接测试成功。收到这条消息说明 ${platform} 出站配置可用。`;
}

/**
 * 平台测试发送的最小配置门禁。
 *
 * 这里不能只检查 QQ/NapCat 的 baseUrl：Telegram 的出站闭环依赖 botToken，
 * 如果后台误用 baseUrl 门禁，会导致 Telegram 目标已经能创建、webhook 也能入站，
 * 但运营无法在管理后台完成“配置 → 测试发送 → 上线”的闭环。
 */
function validateAdapterConfigForTest(platform: string, adapterConfig: Record<string, unknown>): string | null {
  if (platform === "qq") {
    const baseUrl = String(adapterConfig.baseUrl || "").trim();
    return baseUrl ? null : "请先配置 QQ 适配器 baseUrl 后再测试发送";
  }
  if (platform === "telegram") {
    const botToken = String(adapterConfig.botToken || "").trim();
    return botToken ? null : "请先配置 Telegram botToken 后再测试发送";
  }
  return `暂不支持 ${platform} 平台测试发送`;
}

function sanitizePlatformTargetRow<T extends { adapterConfigJson: string }>(row: T): T {
  return {
    ...row,
    adapterConfigJson: sanitizePlatformAdapterConfigForAdmin(row.adapterConfigJson),
  };
}

async function normalizeAdapterConfigForStorage(
  platform: string,
  input: unknown,
  existingRawJson: string,
  encryptionKey: string,
): Promise<{ ok: true; value: Record<string, string> } | { ok: false; message: string }> {
  const adapterConfigResult = normalizeAdapterConfig(platform, input);
  if (!adapterConfigResult.ok) return adapterConfigResult;

  const existing = parsePlatformAdapterConfigJson(existingRawJson);
  const value = { ...adapterConfigResult.value };

  // 脱敏占位符表示保留原密文/明文值，避免前端保存表单时把真实凭据覆盖成占位符。
  for (const key of ["botToken", "token"]) {
    if (value[key] === PLATFORM_SECRET_PLACEHOLDER) {
      const prior = typeof existing[key] === "string" ? String(existing[key]) : "";
      if (prior) value[key] = prior;
      else delete value[key];
    }
  }

  try {
    return { ok: true, value: await encryptPlatformAdapterConfig(value, encryptionKey) };
  } catch (err) {
    return { ok: false, message: String(err instanceof Error ? err.message : err) };
  }
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

/** 社群功能全局开关从 system-config-registry.ts 导入 */

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
      items: rows.map(sanitizePlatformTargetRow),
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
    return ok(c, { item: sanitizePlatformTargetRow(row) });
  });

  // ── 创建 ──
  route.post("/platform-targets", async (c) => {
    const db = getDb(c);
    const tenantId = c.get("tenantId") as string;
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return fail(c, "请求体不是有效 JSON");

    // 社群功能全局开关校验：平台运营者关闭后，所有租户禁止新建群绑定
    if (!(await isCommunityFeatureEnabled(db))) {
      return fail(c, "社群功能已被平台运营者关闭，暂无法创建群绑定", 403);
    }

    const platform = String(body.platform || "qq");
    if (!VALID_PLATFORMS.has(platform)) {
      const supported = Array.from(VALID_PLATFORMS).join(", ");
      return fail(c, `平台类型无效，当前支持的平台: ${supported}`);
    }
    const targetId = String(body.targetId || "").trim();
    if (!targetId) return fail(c, "缺少 targetId");
    const targetName = String(body.targetName || "").trim().slice(0, 120);

    // targetId 全租户唯一（schema 唯一索引 platform+targetId）。这里先做一次快速友好校验；
    // 真正防并发的校验会在下面写事务内再次执行，避免两个 POST 同时穿透套餐群数上限。
    const [existing] = await db
      .select({ id: platformTargets.id })
      .from(platformTargets)
      .where(and(eq(platformTargets.platform, platform), eq(platformTargets.targetId, targetId)))
      .limit(1);
    if (existing && existing.id) return fail(c, "该目标已绑定，请勿重复添加");

    const activeDrawId = String(body.activeDrawId || "").trim();
    const draw = activeDrawId ? await resolveDraw(db, tenantId, activeDrawId) : null;
    if (activeDrawId && !draw) return fail(c, "绑定活动不存在或不属于当前租户");

    const deploymentMode = String(body.adapterDeploymentMode || "tenant_hosted");
    if (!VALID_DEPLOYMENT_MODES.has(deploymentMode)) return fail(c, "部署模式无效，仅支持 tenant_hosted/managed");
    // 适配器提供方默认值平台感知：QQ 默认 napcat，Telegram 等平台不需要中间件提供方
    const defaultProvider = platform === "qq" ? "napcat" : "";
    const provider = String(body.adapterProvider || defaultProvider);
    if (provider && !VALID_PROVIDERS.has(provider)) {
      const providers = Array.from(VALID_PROVIDERS).join(", ");
      return fail(c, `适配器提供方无效，当前支持的提供方: ${providers}`);
    }

    const adapterConfigResult = await normalizeAdapterConfigForStorage(
      platform,
      body.adapterConfig,
      "{}",
      getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "",
    );
    if (!adapterConfigResult.ok) return fail(c, adapterConfigResult.message);
    const adapterConfig = adapterConfigResult.value;

    const purchaseConfigError = validatePurchaseConfigInput(body);
    if (purchaseConfigError) return fail(c, purchaseConfigError);
    const builtinCommands = parseBuiltinCommandsInput(body as Record<string, unknown>);
    const assistantEnabled = body.assistantEnabled === false ? 0 : 1;

    // 每群独立入站密钥：明文只返回一次，库中只存哈希
    const inboundSecret = createPlatformInboundSecret();
    const inboundSecretHash = await hashPlatformInboundSecret(inboundSecret);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const createResult = await withDbTransaction(db, async (tx) => {
      // 创建群绑定是套餐资源分配动作，必须在同一个写事务内完成：
      // 1. 复查目标是否已被其他并发请求绑定；
      // 2. 复查当前租户套餐群数是否仍有余量；
      // 3. 通过后立即插入 platform_targets。
      //
      // 若把 COUNT 校验放在事务外，两个不同 targetId 的并发 POST 都可能读到“未满”，
      // 最终免费租户创建出超过上限的群绑定，形成典型检查-使用竞态。
      const scopedTx = tx as ReturnType<typeof getDb>;
      const [existingInTx] = await scopedTx
        .select({ id: platformTargets.id })
        .from(platformTargets)
        .where(and(eq(platformTargets.platform, platform), eq(platformTargets.targetId, targetId)))
        .limit(1);
      if (existingInTx && existingInTx.id) {
        return { ok: false as const, message: "该目标已绑定，请勿重复添加", status: 400 };
      }

      // 社群功能套餐配额校验（docs/180）：按套餐限制群绑定数，拦新增不阻断存量。
      // 这里传入事务对象，确保 count 与 insert 共享同一个 SQLite 写锁。
      const quotaCheck = await canTenantCreatePlatformTarget(scopedTx, tenantId);
      if (!quotaCheck.ok) {
        return { ok: false as const, message: quotaCheck.message, status: 403 };
      }

      await scopedTx.insert(platformTargets).values({
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

      return { ok: true as const };
    });
    if (!createResult.ok) return fail(c, createResult.message, createResult.status);

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

    // 社群功能全局开关校验：平台运营者关闭后，禁止修改已存在的群绑定
    if (!(await isCommunityFeatureEnabled(db))) {
      return fail(c, "社群功能已被平台运营者关闭，暂无法修改群绑定", 403);
    }

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
      const adapterConfigResult = await normalizeAdapterConfigForStorage(
        row.platform,
        body.adapterConfig,
        row.adapterConfigJson,
        getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "",
      );
      if (!adapterConfigResult.ok) return fail(c, adapterConfigResult.message);
      // 保留入站自动写入的 botId（只读字段，docs/177 方案升级）：更新 baseUrl 时不覆盖 botId
      let existingBotId: string | undefined;
      try {
        const existing = parsePlatformAdapterConfigJson(row.adapterConfigJson);
        if (existing.botId && typeof existing.botId === "string") existingBotId = existing.botId;
      } catch { /* 忽略解析异常 */ }
      if (existingBotId) {
        adapterConfigResult.value.botId = existingBotId;
      }
      patch.adapterConfigJson = JSON.stringify(adapterConfigResult.value);
    }
    if (body.builtinCommands && typeof body.builtinCommands === "object") {
      const purchaseConfigError = validatePurchaseConfigInput(body.builtinCommands as Record<string, unknown>);
      if (purchaseConfigError) return fail(c, purchaseConfigError);
      const merged = parseBuiltinCommandsInput(body.builtinCommands as Record<string, unknown>);
      patch.builtinCommandsJson = JSON.stringify(merged);
    }
    if (typeof body.inboundSecret === "string") {
      const inboundSecret = body.inboundSecret.trim();
      if (inboundSecret) {
        // 入站密钥最小长度：6 位（够短便于在 NapCat 等客户端手动粘贴，仍具备足够熵空间；
        // 上限防御：64 位封顶防止超长输入拖慢哈希）
        if (inboundSecret.length < 6) return fail(c, "入站密钥至少 6 位");
        if (inboundSecret.length > 64) return fail(c, "入站密钥最多 64 位");
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

  // ── 发送测试消息：用于租户自托管适配器上线前联调 ──
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
    const adapterConfig = await resolvePlatformAdapterConfigForRuntime(
      parsePlatformAdapterConfigJson(target.adapterConfigJson),
      getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "",
    );
    const configError = validateAdapterConfigForTest(target.platform, adapterConfig);
    if (configError) return fail(c, configError);

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

  // ── 注册 Telegram Webhook：避免运维手动执行 curl ──
  route.post("/platform-targets/:id/register-telegram-webhook", async (c) => {
    const db = getDb(c);
    const tenantId = c.get("tenantId") as string;
    const id = c.req.param("id");
    const [target] = await db
      .select()
      .from(platformTargets)
      .where(and(eq(platformTargets.tenantId, tenantId), eq(platformTargets.id, id)))
      .limit(1);
    if (!target) return fail(c, "绑定不存在", 404);
    if (target.platform !== "telegram") {
      return fail(c, "仅 Telegram 平台目标支持注册 webhook");
    }

    // 解密 botToken
    const adapterConfig = await resolvePlatformAdapterConfigForRuntime(
      parsePlatformAdapterConfigJson(target.adapterConfigJson),
      getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "",
    );
    const botToken = String(adapterConfig.botToken || "").trim();
    if (!botToken) {
      return fail(c, "请先配置 Telegram Bot Token 后再注册 webhook");
    }

    // 构建 webhook URL：优先请求体传入，其次 APP_ORIGIN 环境变量，最后 Origin 头
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const webhookOrigin = body && typeof body === "object" ? String((body as Record<string, unknown>).webhookOrigin || "") : "";
    const origin = String(webhookOrigin || getEnv(c, "APP_ORIGIN") || c.req.header("Origin") || "").trim();
    if (!origin) {
      return fail(c, "无法确定 webhook URL，请提供 webhookOrigin 参数或配置 APP_ORIGIN 环境变量");
    }
    // 移除末尾斜杠后拼接固定路径
    const webhookUrl = `${origin.replace(/\/+$/, "")}/api/platform/telegram/message`;

    // 生成新入站密钥，用于 Telegram 回调验证
    const inboundSecret = createPlatformInboundSecret();
    const inboundSecretHash = await hashPlatformInboundSecret(inboundSecret);

    // 调用 Telegram Bot API setWebhook
    const apiBase = `https://api.telegram.org/bot${botToken}`;
    let webhookError: string | null = null;

    try {
      const res = await fetch(`${apiBase}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: inboundSecret,
          // 允许所有更新类型（消息、回调等）
          allowed_updates: ["message", "callback_query"],
        }),
      });
      const data = await res.json<Record<string, unknown>>().catch(() => null);
      if (!data || data.ok !== true) {
        webhookError = String(data?.description || "Telegram API 返回错误");
      }
    } catch (err) {
      webhookError = String(err instanceof Error ? err.message : err);
    }

    if (webhookError) {
      return fail(c, `Webhook 注册失败：${webhookError.slice(0, 300)}`);
    }

    // 同步注册 Bot 命令列表，让用户在 Telegram 输入 / 时能自动补全
    const botCommands = [
      { command: "checkin", description: "每日签到" },
      { command: "spin", description: "抽奖" },
      { command: "share", description: "分享活动" },
      { command: "leaderboard", description: "排行榜" },
      { command: "my_prize", description: "我的奖品" },
      { command: "help", description: "帮助" },
      { command: "card_code", description: "我的卡密" },
      { command: "flash", description: "秒杀/购买" },
      { command: "bind", description: "绑定账号" },
    ];
    // setMyCommands 失败不影响 webhook 主流程，仅记录日志
    try {
      await fetch(`${apiBase}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: botCommands }),
      });
    } catch {
      // 静默忽略
    }

    // 持久化新入站密钥哈希
    await db
      .update(platformTargets)
      .set({ inboundSecretHash, updatedAt: new Date().toISOString() })
      .where(and(eq(platformTargets.tenantId, tenantId), eq(platformTargets.id, id)));

    await recordPlatformAudit(c, "platform_target.register_telegram_webhook", id, { webhookUrl });
    return ok(c, { webhookUrl, message: "Telegram Webhook 注册成功" });
  });
}
