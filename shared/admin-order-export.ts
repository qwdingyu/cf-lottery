/**
 * Admin 订单导出 CSV 与 L0 结算筛选的共享契约。
 * 服务端 /orders/export 与后台「导出已选」必须同表头，避免对账列漂移。
 */

/** 服务端 CSV 与客户端「导出已选」表头（顺序即列顺序） */
export const ADMIN_ORDER_EXPORT_CSV_HEADERS = [
  "orderNo",
  "productTitle",
  "orderSource",
  "storefrontId",
  "storefrontNameSnapshot",
  "storefrontSlugSnapshot",
  "buyerContact",
  "buyerEmail",
  "amountCents",
  "discountCents",
  "currency",
  "status",
  "paymentProvider",
  "paymentMethod",
  "paymentRef",
  "campaignCode",
  "referralCode",
  "couponCode",
  "clientIp",
  "batchId",
  "accountLabel",
  "deliveryNote",
  "createdAt",
  "paidAt",
  "issuedAt",
] as const;

export type AdminOrderExportCsvHeader = (typeof ADMIN_ORDER_EXPORT_CSV_HEADERS)[number];

/**
 * L0 人工结算 / 渠道复盘口径：已支付 + 已发货。
 * 权威定义见 `order-status` 的 PAID_LIKE_*；此处 re-export 保持既有 import 路径稳定。
 */
export {
  PAID_LIKE_ORDER_STATUSES as SETTLEMENT_ORDER_STATUSES,
  PAID_LIKE_ORDER_STATUS_QUERY as SETTLEMENT_ORDER_STATUS_QUERY,
} from "./order-status";
