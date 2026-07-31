/**
 * 免费商品的判定只看商品基础价格，不看优惠后的应付金额。
 * 付费商品使用 100% 优惠码后仍属于优惠结算，必须继续走优惠码核销流程。
 */
export function isBasePriceFree(basePriceMinor: number): boolean {
  return basePriceMinor === 0;
}

export const FREE_PRODUCT_QUANTITY = 1;

/** 免费领取默认每邮箱限购件数（运营侧与后端兜底一致） */
export const FREE_PRODUCT_DEFAULT_PURCHASE_LIMIT = 1;

/**
 * 商品限购/限领统计周期。
 *
 * lifetime：同一 canonical 邮箱对同一商品累计最多 N 件，沿用原有付费限购语义。
 * daily：同一 canonical 邮箱在一个运营日内最多 N 件；当前只允许免费活动真正生效。
 */
export type PurchaseLimitPeriod = "lifetime" | "daily";

/** 免费活动的“当天”按 UTC+8 运营日计算；跨时区业务再升级为系统参数。 */
export const FREE_CLAIM_DAILY_RESET_OFFSET_MINUTES = 8 * 60;

/** 结账统一要求的 6 位邮箱验证码格式 */
export const EMAIL_ACCESS_CODE_PATTERN = /^\d{6}$/;

export type CheckoutPaymentChannel = "alipay" | "wxpay" | "qqpay";

export interface CheckoutIntentInput {
  quantity: number;
  couponCode?: string;
  balancePayment?: boolean;
  paymentChannel?: CheckoutPaymentChannel | "";
  emailAccessCode?: string;
}

export interface CheckoutIntent {
  quantity: number;
  couponCode: string;
  balancePayment: boolean;
  paymentChannel: CheckoutPaymentChannel | "";
  emailAccessCode: string;
}

/**
 * 前端提交和待恢复请求共用同一套规范化规则。
 * 免费商品固定单次领取 1 件，清空支付/优惠凭据。
 * 所有商品均保留邮箱验证码（归属校验必需）。
 */
export function normalizeCheckoutIntent(basePriceMinor: number, input: CheckoutIntentInput): CheckoutIntent {
  const emailAccessCode = input.emailAccessCode?.trim() || "";
  if (isBasePriceFree(basePriceMinor)) {
    return {
      quantity: FREE_PRODUCT_QUANTITY,
      couponCode: "",
      balancePayment: false,
      paymentChannel: "",
      emailAccessCode,
    };
  }
  return {
    quantity: input.quantity,
    couponCode: input.couponCode?.trim() || "",
    balancePayment: input.balancePayment === true,
    paymentChannel: input.balancePayment ? "" : (input.paymentChannel || ""),
    emailAccessCode,
  };
}

export type FreeProductCheckoutViolation =
  | "quantity"
  | "coupon"
  | "payment_method";

/**
 * 后端使用该函数校验客户端是否绕过免费领取界面直接构造请求。
 * 返回 null 表示请求符合免费商品约束；非免费商品不受这组专用规则影响。
 *
 * 邮箱验证码由全商品门禁单独校验，不在此重复判定。
 */
export function getFreeProductCheckoutViolation(
  basePriceMinor: number,
  input: CheckoutIntentInput,
): FreeProductCheckoutViolation | null {
  if (!isBasePriceFree(basePriceMinor)) return null;
  if (input.quantity !== FREE_PRODUCT_QUANTITY) return "quantity";
  if (input.couponCode?.trim()) return "coupon";
  if (input.balancePayment || input.paymentChannel) return "payment_method";
  return null;
}

/** 结账是否已携带合法 6 位邮箱验证码（前后端共用）。 */
export function hasValidEmailAccessCode(code: string | undefined | null): boolean {
  return EMAIL_ACCESS_CODE_PATTERN.test((code || "").trim());
}

/**
 * 免费商品限购兜底：运营未配置 purchaseLimit 时按默认 1 件计。
 * 付费商品仍尊重“空=不限购”。
 */
export function effectivePurchaseLimitForProduct(
  basePriceMinor: number,
  purchaseLimit: number | null | undefined,
): number | null {
  if (typeof purchaseLimit === "number" && purchaseLimit > 0) return purchaseLimit;
  if (isBasePriceFree(basePriceMinor)) return FREE_PRODUCT_DEFAULT_PURCHASE_LIMIT;
  return null;
}

/**
 * 对外部输入和数据库历史值做保守归一化。
 * 只有明确写入 daily 时才进入每日限领，其他空值/脏值全部回到 lifetime，避免误放宽限购。
 */
export function normalizePurchaseLimitPeriod(value: unknown): PurchaseLimitPeriod {
  return value === "daily" ? "daily" : "lifetime";
}

/**
 * 根据商品基础价格决定最终执行周期。
 *
 * 关键约束：付费商品永远按 lifetime 解释，即使数据库中存在 daily 脏数据。
 * 原因是付费商品的 purchaseLimit 过去就是“总限购”，不能因为新增免费活动能力改变既有交易语义。
 */
export function effectivePurchaseLimitPeriodForProduct(
  basePriceMinor: number,
  purchaseLimitPeriod: unknown,
): PurchaseLimitPeriod {
  if (!isBasePriceFree(basePriceMinor)) return "lifetime";
  return normalizePurchaseLimitPeriod(purchaseLimitPeriod);
}

/**
 * 返回当前运营日开始时刻的 ISO 字符串，用于 SQL created_at 下界。
 *
 * 算法：先把当前时间平移到运营时区，再取 UTC 日期零点，最后平移回真实 UTC 时间。
 * 例如 UTC+8 的 2026-07-27 00:00 对应 2026-07-26T16:00:00.000Z。
 */
export function startOfOperationalDayIso(
  now: Date = new Date(),
  offsetMinutes = FREE_CLAIM_DAILY_RESET_OFFSET_MINUTES,
): string {
  const offsetMs = offsetMinutes * 60 * 1000;
  const shifted = new Date(now.getTime() + offsetMs);
  const dayStartUtcMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(dayStartUtcMs - offsetMs).toISOString();
}
