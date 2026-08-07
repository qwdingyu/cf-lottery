/**
 * 支付服务（秒杀卡密多租户直付，docs/131）
 *
 * 职责：
 * - 按租户加载/解密支付配置（tenant_configs.providers JSON，多租户隔离）
 * - 创建订单（payment_orders，entryId UNIQUE 一参与一订单）
 * - 调用 cf-core Provider 创建支付（Stripe/支付宝/TRC20）
 * - 支付回调验签 + 幂等 + 发卡密（prizeCodes available → issued 原子取卡）
 *
 * 复用 @usethink/cf-core/features/payment（Provider 抽象已在共享库）。
 */
import { createProviderRegistry } from "@usethink/cf-core/features/payment";
import type { PaymentProvider, CreatePaymentResult } from "@usethink/cf-core/features/payment";
import { eq, and, sql, inArray } from "drizzle-orm";
import type { DbType } from "../../db/client";
import { withDbTransaction } from "../../db/client";
import { tenantConfigs, paymentOrders, prizeCodes, lotteryPrizeTiers, prizes, lotteryEntries } from "../../db/schema";
import { PAYMENT_PROVIDER_CATALOG, isValidProviderName } from "./catalog";

export type PaymentProviderName = "stripe" | "alipay" | "usdt_trc20";

/** 订单超时时间(分钟)：超过此时间未支付的 pending 订单标记 expired（docs/131 §8） */
const ORDER_EXPIRE_MINUTES = 30;

/** 懒清理：标记超过 30 分钟未支付的 pending 订单为 expired，并释放关联 entry 名额（docs/131 §8） */
async function expireOverdueOrders(db: DbType, tenantId: string): Promise<number> {
  const cutoff = sql`datetime('now', '-' || ${ORDER_EXPIRE_MINUTES} || ' minutes')`;
  // 查过期订单
  const overdue = await db
    .select({ id: paymentOrders.id, entryId: paymentOrders.entryId })
    .from(paymentOrders)
    .where(and(
      eq(paymentOrders.tenantId, tenantId),
      eq(paymentOrders.status, "pending"),
      sql`${paymentOrders.createdAt} < ${cutoff}`,
    ));
  if (overdue.length === 0) return 0;

  // 标记订单 expired
  await db
    .update(paymentOrders)
    .set({ status: "expired", updatedAt: sql`(datetime('now'))` })
    .where(and(
      eq(paymentOrders.tenantId, tenantId),
      eq(paymentOrders.status, "pending"),
      sql`${paymentOrders.createdAt} < ${cutoff}`,
    ));

  // 软释放：关联 entry 标记 payment_status=expired（不删 entry，保留审计链）
  const entryIds = overdue.map((o) => o.entryId).filter(Boolean);
  if (entryIds.length > 0) {
    await db
      .update(lotteryEntries)
      .set({ paymentStatus: "expired" })
      .where(inArray(lotteryEntries.id, entryIds));
  }

  return overdue.length;
}

/** 从 DB 加载并解密租户支付配置；未配置或密钥缺失返回 null（照搬 cf-shop loadPaymentProviderConfigs） */
export async function loadTenantConfig(
  db: DbType,
  tenantId: string,
  encryptionKey?: string,
): Promise<{ provider: PaymentProviderName; env: Record<string, string> } | null> {
  const [row] = await db
    .select()
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId))
    .limit(1);
  if (!row || !row.enabled) return null;

  let providers: Record<string, Record<string, unknown>> = {};
  try {
    providers = JSON.parse(row.providers || "{}");
  } catch {
    return null;
  }

  const decrypt = async (v: string): Promise<string> => {
    if (!v.startsWith("enc:")) return v;
    if (!encryptionKey) throw new Error("CREDENTIALS_ENCRYPTION_KEY 未配置");
    const { decrypt: aesDecrypt } = await import("@usethink/cf-core");
    const decrypted = await aesDecrypt(v.slice(4), encryptionKey);
    return String(decrypted);
  };

  // 按 catalog 顺序遍历，返回第一个已启用且凭据完整的渠道
  for (const item of PAYMENT_PROVIDER_CATALOG) {
    if (!isValidProviderName(item.name)) continue;
    const cfg = providers[item.name] as Record<string, unknown> | undefined;
    if (!cfg || cfg.enabled !== true) continue;

    const env: Record<string, string> = {};
    let complete = true;
    try {
      for (const field of item.fields) {
        const raw = cfg[field.key.toLowerCase()] ?? cfg[field.key];
        if (typeof raw !== "string" || !raw) {
          if (field.required) { complete = false; break; }
          continue;
        }
        env[field.key] = await decrypt(raw);
      }
    } catch {
      continue; // 解密失败 → 该渠道禁用，fail closed
    }
    if (!complete) continue;
    return { provider: item.name as PaymentProviderName, env };
  }
  return null;
}

/** 用租户配置创建 Provider 注册表并返回首选 Provider */
export function createTenantProvider(env: Record<string, string>): PaymentProvider | null {
  const registry = createProviderRegistry(env, PAYMENT_PROVIDER_CATALOG.map((i) => i.factory));
  return registry.selectOnline() ?? null;
}

export interface CreateOrderInput {
  tenantId: string;
  drawId: string;
  entryId: string;
  amountCents: number;
  currency: string;
  provider: PaymentProviderName;
  notifyUrl: string;
  returnUrl?: string;
  description?: string;
}

/** 创建订单并请求支付，返回订单 + 支付入口 */
export async function createPaymentOrder(
  db: DbType,
  input: CreateOrderInput,
  provider: PaymentProvider,
): Promise<{ order: typeof paymentOrders.$inferSelect; payResult: CreatePaymentResult }> {
  // 懒清理本租户超时订单（避免定时任务，docs/131 §8）
  await expireOverdueOrders(db, input.tenantId);

  const id = crypto.randomUUID();
  await db.insert(paymentOrders).values({
    id,
    tenantId: input.tenantId,
    drawId: input.drawId,
    entryId: input.entryId,
    amountCents: input.amountCents,
    currency: input.currency,
    status: "pending",
    provider: input.provider,
  });

  // 标记关联 entry 支付状态为 pending（软释放，docs/131 §8）
  await db
    .update(lotteryEntries)
    .set({ paymentStatus: "pending" })
    .where(eq(lotteryEntries.id, input.entryId));

  const payResult = await provider.createPayment({
    orderNo: id,
    amountCents: input.amountCents,
    currency: input.currency,
    notifyUrl: input.notifyUrl,
    returnUrl: input.returnUrl,
    description: input.description,
  });

  const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, id)).limit(1);
  return { order: order!, payResult };
}

/**
 * 支付回调处理：验签 → 幂等 → 事务内（取卡密 + 标记 paid）→ 返回订单。
 * 卡密不足时订单标记 paid_fulfillment_failed（不静默 paid+null，docs/131 §7）。
 * params 为支付平台回调的 searchParams（Record<string,string>，由 Provider verifyCallback 解析）。
 * 重复回调返回 { processed: false, order } 不重复发卡。
 */
export async function handlePaymentCallback(
  db: DbType,
  tenantId: string,
  provider: PaymentProvider,
  params: Record<string, string>,
): Promise<{ processed: boolean; order?: typeof paymentOrders.$inferSelect; error?: string }> {
  const callback = await provider.verifyCallback(params);
  if (!callback) return { processed: false, error: "验签失败" };

  const [pre] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.id, callback.orderNo))
    .limit(1);
  if (!pre) return { processed: false, error: "订单不存在" };
  if (pre.tenantId !== tenantId) return { processed: false, error: "租户不匹配" };
  if (callback.amountCents !== pre.amountCents || callback.currency !== pre.currency) {
    return { processed: false, error: "金额不匹配" };
  }

  // 事务内完成发卡与状态更新（docs/131 §7：读取→取卡密→更新订单，一次提交）
  const order = await withDbTransaction(db, async (tx) => {
    // 幂等：事务内重新读取，已 paid 的订单直接返回
    const [current] = await tx
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, pre.id))
      .limit(1);
    if (!current) return null;
    if (current.status === "paid" || current.status === "paid_fulfillment_failed") {
      return current;
    }

    // 查活动的卡密奖（prizeType=code）
    const tier = await findCodePrize(tx, tenantId, pre.drawId);

    // 原子取卡密：available → issued（winnerId=entryId）
    let prizeCodeId: string | null = null;
    if (tier?.prizeId) {
      const acquired = await tx
        .update(prizeCodes)
        .set({ status: "issued", issuedAt: sql`(datetime('now'))`, winnerId: pre.entryId })
        .where(and(
          eq(prizeCodes.tenantId, tenantId),
          eq(prizeCodes.prizeId, tier.prizeId),
          eq(prizeCodes.status, "available"),
        ))
        .orderBy(prizeCodes.id)
        .limit(1)
        .returning({ id: prizeCodes.id });
      prizeCodeId = acquired[0]?.id ?? null;
    }

    // 卡密不足：标记 paid_fulfillment_failed（运营后台可见，docs/131 §7），不静默 null
    const newStatus = prizeCodeId ? "paid" : "paid_fulfillment_failed";
    await tx
      .update(paymentOrders)
      .set({
        status: newStatus,
        providerTradeNo: callback.providerTradeNo,
        prizeCodeId: prizeCodeId ?? null,
        paidAt: callback.paidAt,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(paymentOrders.id, pre.id));

    // 支付成功 → entry 标记 paid（软释放状态机，docs/131 §8）
    if (newStatus === "paid") {
      await tx
        .update(lotteryEntries)
        .set({ paymentStatus: "paid" })
        .where(eq(lotteryEntries.id, pre.entryId));
    }

    const [updated] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, pre.id)).limit(1);
    return updated ?? null;
  });

  if (!order) return { processed: false, error: "订单不存在" };
  return { processed: order.status === "paid" || order.status === "paid_fulfillment_failed", order };
}

/** 查询活动的卡密奖品（prizeType=code）的 prizeId，用于发卡 */
async function findCodePrize(db: DbType, tenantId: string, drawId: string) {
  const rows = await db
    .select({ prizeId: lotteryPrizeTiers.prizeId })
    .from(lotteryPrizeTiers)
    .innerJoin(prizes, and(eq(prizes.id, lotteryPrizeTiers.prizeId), eq(prizes.prizeType, "code")))
    .where(and(eq(lotteryPrizeTiers.tenantId, tenantId), eq(lotteryPrizeTiers.drawId, drawId)))
    .limit(1);
  return rows[0] ?? null;
}