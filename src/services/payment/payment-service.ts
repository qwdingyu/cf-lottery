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
import { eq, and, sql } from "drizzle-orm";
import type { DbType } from "../../db/client";
import { tenantConfigs, paymentOrders, prizeCodes, lotteryPrizeTiers, prizes } from "../../db/schema";
import { PAYMENT_PROVIDER_CATALOG, isValidProviderName } from "./catalog";

export type PaymentProviderName = "stripe" | "alipay" | "usdt_trc20";

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
 * 支付回调处理：验签 → 幂等 → 标记 paid → 发卡密。
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

  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.id, callback.orderNo))
    .limit(1);
  if (!order) return { processed: false, error: "订单不存在" };
  if (order.tenantId !== tenantId) return { processed: false, error: "租户不匹配" };
  if (callback.amountCents !== order.amountCents || callback.currency !== order.currency) {
    return { processed: false, error: "金额不匹配" };
  }
  if (order.status === "paid") return { processed: false, order };

  // 原子取卡密：查活动的卡密奖（prizeType=code）→ 从 prizeCodes available 池取一条
  const tier = await findCodePrize(db, tenantId, order.drawId);
  let prizeCodeId: string | null = null;
  if (tier?.prizeId) {
    const acquired = await db
      .update(prizeCodes)
      .set({ status: "issued", issuedAt: sql`(datetime('now'))`, winnerId: order.entryId })
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

  await db
    .update(paymentOrders)
    .set({
      status: "paid",
      providerTradeNo: callback.providerTradeNo,
      prizeCodeId,
      paidAt: callback.paidAt,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(paymentOrders.id, order.id));

  const [updated] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, order.id)).limit(1);
  return { processed: true, order: updated };
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