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
import { and, eq, inArray, isNotNull, desc } from "drizzle-orm";

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
    .where(identityConditions.length === 1 ? identityConditions[0] : and(
      ...identityConditions.map((c) => c),
    ));

  if (entries.length === 0) {
    return ok(c, { cardCodes: [], total: 0 });
  }

  const entryIds = entries.map((e) => e.id);

  // P0-1 跨租户隔离：令牌绑定了 drawId，则只返回该 draw 下的卡密。
  // 防止同一 userId 因跨租户有多个活动时，凭一个令牌看到其他租户活动的卡密。
  //
  // drawId 为空字符串时的行为：
  // 如果 drawId 为空字符串，则不做 drawId 过滤（向后兼容已存令牌）。
  // 空字符串表示「不限制」（schema 中 default("")），生产环境中可能存在大量
  // 升级前已生成的旧令牌，其 drawId 为空字符串。此时返回该用户所有租户下的卡密。
  // 性能说明：少量旧令牌不会造成性能问题，但大量旧 token 同时使用同一用户 ID
  // 查询时，因缺少 drawId 索引可能导致全表扫描。后续可安排定时任务为旧 token 补全 drawId。
  const winnerConditions = [
    inArray(lotteryWinners.entryId, entryIds),
    isNotNull(lotteryWinners.prizeCodeId),
  ];
  if (drawId) {
    winnerConditions.push(eq(lotteryWinners.drawId, drawId));
  }

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