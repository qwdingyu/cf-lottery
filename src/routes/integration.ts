/**
 * 外部集成路由。
 *
 * 这些接口面向租户自己的业务系统或第三方系统，使用租户 API Key 鉴权。
 * 外部成交、核销、注册等只能通过这里回传，不能由公开页点击或 UTM 推断。
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../bindings";
import { fail, getDb, ok } from "../lib/http";
import { checkDbRateLimit } from "../lib/rate-limit";
import {
  authenticateApiKey,
  recordExternalConversion,
  type ExternalConversionType,
} from "../services/lottery-service";

export const integrationRoute = new Hono<AppEnv>();

const CONVERSION_TYPES = new Set<ExternalConversionType>([
  "registration",
  "purchase",
  "coupon_redeemed",
  "lead_qualified",
  "offline_redeemed",
  "custom",
]);

// 外部转化回传限流：300 次/分钟/API key（#15）。
// 正常业务量远低于此（回传按事件计数），阈值仅防滥用刷爆 external_conversions 表；
// 使用 DB 级限流（单条原子条件 INSERT，跨 Worker 实例一致），不依赖内存 Map。
const CONVERSION_RATE_LIMIT = 300;
const CONVERSION_RATE_WINDOW_MS = 60000;

function readApiKey(c: Context<AppEnv>): string {
  const authHeader = c.req.header("Authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  return bearer || c.req.header("X-CF-Lottery-API-Key") || "";
}

/** 外部转化回传：成交/核销/注册等必须由外部系统显式上报。 */
integrationRoute.post("/conversions", async (c) => {
  const db = getDb(c);
  const apiKey = await authenticateApiKey(db, readApiKey(c));
  if (!apiKey) return fail(c, "API Key 无效", 401);

  // 限流检查：以 API key 维度计数，防止单个 key 高频写入拖垮数据表与 Turso rows written 配额
  if (!(await checkDbRateLimit(db, `integration:${apiKey.id}`, CONVERSION_RATE_LIMIT, CONVERSION_RATE_WINDOW_MS))) {
    return fail(c, "调用过于频繁，请稍后再试", 429);
  }

  const body = await c.req.json<{
    drawId?: string;
    publicSlug?: string;
    externalEventId?: string;
    conversionType?: ExternalConversionType;
    source?: string;
    entryId?: string;
    identityType?: string;
    identityValue?: string;
    refCode?: string;
    amountCents?: number;
    currency?: string;
    payload?: Record<string, unknown>;
    occurredAt?: string;
  }>().catch(() => null);
  if (!body) return fail(c, "请求体不是有效 JSON", 400);
  if (!body.drawId && !body.publicSlug) return fail(c, "请提供 drawId 或 publicSlug", 400);
  if (!body.externalEventId) return fail(c, "请提供 externalEventId", 400);
  if (!body.conversionType || !CONVERSION_TYPES.has(body.conversionType)) {
    return fail(c, "外部转化类型无效", 400);
  }

  try {
    const result = await recordExternalConversion(db, {
      tenantId: apiKey.tenantId,
      drawId: body.drawId,
      publicSlug: body.publicSlug,
      externalEventId: body.externalEventId,
      conversionType: body.conversionType,
      source: body.source,
      entryId: body.entryId,
      identityType: body.identityType,
      identityValue: body.identityValue,
      refCode: body.refCode,
      amountCents: body.amountCents,
      currency: body.currency,
      payload: body.payload,
      occurredAt: body.occurredAt,
    });
    return ok(c, {
      created: result.created,
      conversionId: result.conversion.id,
      drawId: result.conversion.drawId,
      eventId: result.conversion.externalEventId,
    });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "外部转化回传失败", 400);
  }
});
