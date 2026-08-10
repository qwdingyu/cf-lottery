/**
 * 公共访问令牌路由（docs/179）。
 *
 * 核心用途：Bot 生成一次性 Web 链接后，用户通过该链接无需登录即可查看卡密。
 * 令牌验证：
 * - SHA-256 哈希匹配
 * - 未过期（expires_at > now）
 * - 未使用（used = 0）
 * 验证通过后自动标记为已使用。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb, ok, fail } from "../lib/http";
import { consumeAccessToken } from "../services/platform/access-token";
import {
  authIdentities,
  lotteryEntries,
  lotteryWinners,
  lotteryPrizeTiers,
  prizes,
  prizeCodes,
  lotteryDraws,
} from "../db/schema";
import { and, eq, inArray, isNotNull, desc, or } from "drizzle-orm";

export const publicAccessRoute = new Hono<AppEnv>();

/**
 * GET /api/public/access/card-codes?token=xxx
 *
 * 验证一次性令牌，返回该用户的所有卡密。
 * 令牌在验证成功后被标记为已使用（一次性）。
 * 使用 GET 请求，方便前端直接打开链接。
 */
publicAccessRoute.get("/card-codes", async (c) => {
  const db = getDb(c);

  const token = c.req.query("token");
  if (!token) return fail(c, "缺少令牌参数", 400);

  // 验证并消费令牌
  const tokenData = await consumeAccessToken(db, token, "card_code");
  if (!tokenData) {
    return fail(c, "令牌无效或已过期。请重新在群内发送 /我的卡密 获取新的链接。", 404);
  }
  const { userId, drawId } = tokenData;
  if (!drawId) {
    return fail(c, "令牌缺少活动范围，请重新在群内发送 /我的卡密 获取新的链接。", 400);
  }

  // 查找该用户的所有平台身份
  const identities = await db
    .select({
      provider: authIdentities.provider,
      providerUserId: authIdentities.providerUserId,
    })
    .from(authIdentities)
    .where(eq(authIdentities.userId, userId));

  if (identities.length === 0) {
    return fail(c, "未找到用户身份信息。", 404);
  }

  // 收集所有平台身份下的参与记录（entryId）
  // 每个身份对应 lotteryEntries 中的一条或多条记录（不同活动）
  const identityConditions = identities.map((id) =>
    and(
      eq(lotteryEntries.identityType, id.provider),
      eq(lotteryEntries.identityValue, id.providerUserId),
    )
  );

  const entries = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.drawId, drawId),
      identityConditions.length === 1 ? identityConditions[0] : or(...identityConditions),
    ));

  if (entries.length === 0) {
    return ok(c, { cardCodes: [], total: 0 });
  }

  const entryIds = entries.map((e) => e.id);

  // 令牌必须绑定 drawId，只返回该活动下的卡密。
  // 旧版空 drawId 令牌已在入口处拒绝，避免同一 users.id 横跨多个租户时泄露其他活动卡密。
  const winnerConditions = [
    inArray(lotteryWinners.entryId, entryIds),
    isNotNull(lotteryWinners.prizeCodeId),
    eq(lotteryWinners.drawId, drawId),
  ];

  // 查询中奖卡密（通过 entryId 关联 winner）
  const winners = await db
    .select({
      drawTitle: lotteryDraws.title,
      tierName: lotteryPrizeTiers.tierName,
      prizeName: prizes.name,
      code: prizeCodes.code,
      secret: prizeCodes.secret,
      drawnAt: lotteryWinners.drawnAt,
    })
    .from(lotteryWinners)
    .leftJoin(lotteryDraws, eq(lotteryDraws.id, lotteryWinners.drawId))
    .leftJoin(lotteryPrizeTiers, eq(lotteryPrizeTiers.id, lotteryWinners.tierId))
    .leftJoin(prizes, eq(prizes.id, lotteryPrizeTiers.prizeId))
    .leftJoin(prizeCodes, eq(prizeCodes.id, lotteryWinners.prizeCodeId))
    .where(and(...winnerConditions))
    .orderBy(desc(lotteryWinners.drawnAt));

  // 格式化返回
  const cardCodes = winners.map((w) => ({
    drawTitle: w.drawTitle || "",
    prizeName: w.prizeName || w.tierName || "奖品",
    // 卡密全文：有 secret 时拼 "code:secret"
    cardCode: w.code ? (w.secret ? `${w.code}:${w.secret}` : w.code) : null,
    drawnAt: w.drawnAt,
  }));

  return ok(c, {
    cardCodes,
    total: cardCodes.length,
  });
});
