import { describe, expect, it } from "vitest";
import {
  ABNORMAL_ORDER_STATUSES,
  expandOrderStatusFilter,
  isPaidLikeOrderStatus,
  isSafeDeleteOrderStatus,
  isSettlementOrderStatusFilter,
  normalizeOrderStatus,
  ORDER_STATUSES,
  orderStatusLabel,
  PAID_LIKE_ORDER_STATUS_QUERY,
  PAID_LIKE_ORDER_STATUSES,
  parseOrderStatusFilterInput,
  SAFE_DELETE_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
} from "./order-status";

describe("order-status", () => {
  it("normalizes cancelled to canceled and trims case", () => {
    expect(normalizeOrderStatus("cancelled")).toBe("canceled");
    expect(normalizeOrderStatus(" Cancelled ")).toBe("canceled");
    expect(normalizeOrderStatus("CANCELED")).toBe("canceled");
    expect(normalizeOrderStatus("paid")).toBe("paid");
    expect(normalizeOrderStatus("")).toBe("");
    expect(normalizeOrderStatus(null)).toBe("");
    expect(normalizeOrderStatus(undefined)).toBe("");
  });

  it("canonical catalog never lists the legacy cancelled spelling", () => {
    expect(ORDER_STATUSES).toContain("canceled");
    expect(ORDER_STATUSES).not.toContain("cancelled");
    expect(SAFE_DELETE_ORDER_STATUSES).toEqual(["failed", "canceled", "closed", "expired"]);
    expect(SAFE_DELETE_ORDER_STATUSES).not.toContain("cancelled");
    expect(SAFE_DELETE_ORDER_STATUSES).not.toContain("refunded");
    expect(ABNORMAL_ORDER_STATUSES).toContain("refunded");
    expect(ABNORMAL_ORDER_STATUSES).toContain("canceled");
    expect(ABNORMAL_ORDER_STATUSES).not.toContain("cancelled");
    expect(TERMINAL_ORDER_STATUSES).toContain("canceled");
    expect(TERMINAL_ORDER_STATUSES).not.toContain("cancelled");
    expect(TERMINAL_ORDER_STATUSES).toContain("issued");
  });

  it("treats every safe-delete status and legacy cancelled as deletable", () => {
    for (const status of SAFE_DELETE_ORDER_STATUSES) {
      expect(isSafeDeleteOrderStatus(status)).toBe(true);
      expect(isSafeDeleteOrderStatus(status.toUpperCase())).toBe(true);
    }
    expect(isSafeDeleteOrderStatus("canceled")).toBe(true);
    expect(isSafeDeleteOrderStatus("cancelled")).toBe(true);
    expect(isSafeDeleteOrderStatus(" CANCELLED ")).toBe(true);
    expect(isSafeDeleteOrderStatus("refunded")).toBe(false);
    expect(isSafeDeleteOrderStatus("issued")).toBe(false);
    expect(isSafeDeleteOrderStatus("paid")).toBe(false);
    expect(isSafeDeleteOrderStatus("pending")).toBe(false);
    expect(isSafeDeleteOrderStatus("")).toBe(false);
    expect(isSafeDeleteOrderStatus(null)).toBe(false);
  });

  it("expands canceled filter to include legacy cancelled spelling without duplicates", () => {
    expect(expandOrderStatusFilter(["canceled", "failed"]).sort()).toEqual(
      ["canceled", "cancelled", "failed"].sort(),
    );
    expect(expandOrderStatusFilter(["cancelled"])).toEqual(["canceled", "cancelled"]);
    // 同时传入规范/历史拼写时去重，仍只展开一次
    expect(expandOrderStatusFilter(["canceled", "cancelled", "CANCELED"]).sort()).toEqual(
      ["canceled", "cancelled"].sort(),
    );
    expect(expandOrderStatusFilter(["", "  ", "failed"]).sort()).toEqual(["failed"]);
    expect(expandOrderStatusFilter([])).toEqual([]);
    // 异常 tab 全量展开应含 cancelled，便于筛到历史行
    const abnormalExpanded = expandOrderStatusFilter(ABNORMAL_ORDER_STATUSES);
    expect(abnormalExpanded).toContain("cancelled");
    expect(abnormalExpanded).toContain("canceled");
    expect(abnormalExpanded).toContain("refunded");
  });

  it("parses status filter input including nested comma strings", () => {
    expect(parseOrderStatusFilterInput("paid,issued")).toEqual(["paid", "issued"]);
    expect(parseOrderStatusFilterInput(["failed", "canceled,expired"])).toEqual([
      "failed",
      "canceled",
      "expired",
    ]);
    expect(parseOrderStatusFilterInput("pending")).toEqual(["pending"]);
    // expand 后仍含 cancelled
    expect(expandOrderStatusFilter(parseOrderStatusFilterInput("canceled,failed")).sort()).toEqual(
      ["canceled", "cancelled", "failed"].sort(),
    );
  });

  it("detects L0 settlement status filter (paid+issued only)", () => {
    expect(PAID_LIKE_ORDER_STATUSES).toEqual(["paid", "issued"]);
    expect(PAID_LIKE_ORDER_STATUS_QUERY).toBe("paid,issued");
    expect(isSettlementOrderStatusFilter("paid,issued")).toBe(true);
    expect(isSettlementOrderStatusFilter("issued,paid")).toBe(true);
    expect(isSettlementOrderStatusFilter(["paid", "issued"])).toBe(true);
    expect(isSettlementOrderStatusFilter(" PAID , ISSUED ")).toBe(true);
    expect(isSettlementOrderStatusFilter("paid")).toBe(false);
    expect(isSettlementOrderStatusFilter("paid,issued,refunded")).toBe(false);
    expect(isSettlementOrderStatusFilter("")).toBe(false);
    expect(isSettlementOrderStatusFilter(null)).toBe(false);
  });

  it("isPaidLikeOrderStatus matches PAID_LIKE only (shared with L1 grant)", () => {
    expect(isPaidLikeOrderStatus("paid")).toBe(true);
    expect(isPaidLikeOrderStatus("issued")).toBe(true);
    expect(isPaidLikeOrderStatus(" PAID ")).toBe(true);
    expect(isPaidLikeOrderStatus("pending")).toBe(false);
    expect(isPaidLikeOrderStatus("refunded")).toBe(false);
    expect(isPaidLikeOrderStatus("")).toBe(false);
    expect(isPaidLikeOrderStatus(null)).toBe(false);
    // paidAt 缺失不拒绝（历史数据）
    expect(isPaidLikeOrderStatus("paid", null)).toBe(true);
  });

  it("labels via normalized status", () => {
    expect(orderStatusLabel("cancelled")).toBe("已取消");
    expect(orderStatusLabel("canceled")).toBe("已取消");
    expect(orderStatusLabel("  CANCELLED ")).toBe("已取消");
    expect(orderStatusLabel("unknown-x")).toBe("unknown-x");
    expect(orderStatusLabel("")).toBe("-");
    expect(orderStatusLabel(null)).toBe("-");
  });
});
