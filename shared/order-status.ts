/**
 * 订单状态契约（前后端 / 删除门槛共用）。
 *
 * 规范拼写固定为美式 canceled（一 d）。
 * 历史英式 cancelled 仅在读路径归一化兼容，禁止新写入。
 */

export const ORDER_STATUSES = [
  "pending",
  "paid",
  "issued",
  "expired",
  "failed",
  "canceled",
  "closed",
  "refunded",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** 未勾选「全部删除」时允许批量删除的安全终态（不含 refunded：退款对账通常需保留）。 */
export const SAFE_DELETE_ORDER_STATUSES = [
  "failed",
  "canceled",
  "closed",
  "expired",
] as const;

export type SafeDeleteOrderStatus = (typeof SAFE_DELETE_ORDER_STATUSES)[number];

export const SAFE_DELETE_ORDER_STATUS_SET: ReadonlySet<string> = new Set(SAFE_DELETE_ORDER_STATUSES);

/** 售后/异常视图常用集合（含 refunded）。 */
export const ABNORMAL_ORDER_STATUSES = [
  "failed",
  "canceled",
  "closed",
  "expired",
  "refunded",
] as const;

/** 终态：轮询应停止。 */
export const TERMINAL_ORDER_STATUSES = [
  "issued",
  "expired",
  "failed",
  "canceled",
  "closed",
  "refunded",
] as const;

export const TERMINAL_ORDER_STATUS_SET: ReadonlySet<string> = new Set(TERMINAL_ORDER_STATUSES);

/**
 * 支付事实成立口径（L0 结算筛选 / L1 发奖 / 退款冲正 CAS 同源）。
 * 仅 paid + issued；不含 pending（未付）与 refunded 等售后态。
 *
 * 权威定义只在本文件；`admin-order-export` 与 `referral-reward` 从此 re-export / 派生，禁止再写第二份字面量。
 */
export const PAID_LIKE_ORDER_STATUSES = ["paid", "issued"] as const;

export type PaidLikeOrderStatus = (typeof PAID_LIKE_ORDER_STATUSES)[number];

export const PAID_LIKE_ORDER_STATUS_SET: ReadonlySet<string> = new Set(PAID_LIKE_ORDER_STATUSES);

/** 路由 query / 下拉 option：`status=paid,issued` */
export const PAID_LIKE_ORDER_STATUS_QUERY = PAID_LIKE_ORDER_STATUSES.join(",");

/**
 * 是否为「支付事实成立」状态（paid|issued）。
 * `_paidAt` 保留参数位：历史数据可能缺 paidAt，调用方尽量写入；本函数不因缺失而拒绝。
 */
export function isPaidLikeOrderStatus(
  status: string | null | undefined,
  _paidAt?: string | null,
): boolean {
  void _paidAt;
  return PAID_LIKE_ORDER_STATUS_SET.has(normalizeOrderStatus(status));
}

/**
 * 把任意订单状态字符串归一化为规范值。
 * - cancelled → canceled
 * - 去空白、小写
 * - 空串返回空串
 */
export function normalizeOrderStatus(status: string | null | undefined): string {
  const raw = String(status ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "cancelled") return "canceled";
  return raw;
}

/** 是否属于默认可批量删除的安全终态（含历史 cancelled 拼写）。 */
export function isSafeDeleteOrderStatus(status: string | null | undefined): boolean {
  return SAFE_DELETE_ORDER_STATUS_SET.has(normalizeOrderStatus(status));
}

/**
 * 解析列表/导出 `status` 查询入参。
 *
 * 支持：空、单状态、字符串数组、逗号串（如 L0 `paid,issued`）、数组元素内再含逗号。
 * 只做拆分与 trim，**不做** canceled→cancelled 展开（由 expandOrderStatusFilter 负责）。
 */
export function parseOrderStatusFilterInput(
  status: string | string[] | null | undefined,
): string[] {
  if (status == null || status === "") return [];
  const raw = Array.isArray(status) ? status : [status];
  return raw.flatMap((item) =>
    String(item)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

/**
 * 列表/导出筛选：把规范状态展开为 DB 中可能存在的原始拼写，避免漏查历史 cancelled 行。
 * 例：canceled → ["canceled", "cancelled"]
 */
export function expandOrderStatusFilter(statuses: readonly string[]): string[] {
  const out = new Set<string>();
  for (const item of statuses) {
    const normalized = normalizeOrderStatus(item);
    if (!normalized) continue;
    out.add(normalized);
    if (normalized === "canceled") out.add("cancelled");
  }
  return Array.from(out);
}

/**
 * 是否为 L0 结算筛选口径（恰好 paid + issued，顺序无关）。
 * 用于订单页状态下拉回显「已成交（结算）」；与 PAID_LIKE_ORDER_STATUSES 同源。
 */
export function isSettlementOrderStatusFilter(
  status: string | string[] | null | undefined,
): boolean {
  const parts = parseOrderStatusFilterInput(status).map(normalizeOrderStatus).filter(Boolean);
  if (parts.length !== PAID_LIKE_ORDER_STATUSES.length) return false;
  const set = new Set(parts);
  return PAID_LIKE_ORDER_STATUSES.every((s) => set.has(s));
}

export const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: "待支付",
  paid: "已支付",
  issued: "已发卡",
  canceled: "已取消",
  closed: "已关闭",
  expired: "已过期",
  failed: "失败",
  refunded: "已退款",
};

export function orderStatusLabel(status: string | null | undefined): string {
  const normalized = normalizeOrderStatus(status);
  if (!normalized) return "-";
  return ORDER_STATUS_LABELS[normalized] || normalized;
}
