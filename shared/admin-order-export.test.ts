import { describe, expect, it } from "vitest";
import {
  ADMIN_ORDER_EXPORT_CSV_HEADERS,
  SETTLEMENT_ORDER_STATUSES,
  SETTLEMENT_ORDER_STATUS_QUERY,
} from "./admin-order-export";
import {
  isSettlementOrderStatusFilter,
  PAID_LIKE_ORDER_STATUS_QUERY,
  PAID_LIKE_ORDER_STATUSES,
  parseOrderStatusFilterInput,
} from "./order-status";

describe("admin-order-export contract", () => {
  it("keeps settlement query as paid,issued only (L0 ops path)", () => {
    // re-export 必须与 order-status 权威定义同一引用语义
    expect(SETTLEMENT_ORDER_STATUSES).toEqual(PAID_LIKE_ORDER_STATUSES);
    expect(SETTLEMENT_ORDER_STATUS_QUERY).toBe(PAID_LIKE_ORDER_STATUS_QUERY);
    expect(SETTLEMENT_ORDER_STATUSES).toEqual(["paid", "issued"]);
    expect(SETTLEMENT_ORDER_STATUS_QUERY).toBe("paid,issued");
    // 结算口径不含 pending / refunded（避免把建单或退款当成交）
    expect(SETTLEMENT_ORDER_STATUSES).not.toContain("pending");
    expect(SETTLEMENT_ORDER_STATUSES).not.toContain("refunded");
    expect(isSettlementOrderStatusFilter(SETTLEMENT_ORDER_STATUS_QUERY)).toBe(true);
    expect(isSettlementOrderStatusFilter(["issued", "paid"])).toBe(true);
    expect(isSettlementOrderStatusFilter("paid")).toBe(false);
    expect(isSettlementOrderStatusFilter("paid,issued,refunded")).toBe(false);
  });

  it("export CSV headers include attribution and payment timestamps for reconciliation", () => {
    const headers = [...ADMIN_ORDER_EXPORT_CSV_HEADERS];
    expect(headers).toContain("campaignCode");
    expect(headers).toContain("referralCode");
    expect(headers).toContain("clientIp");
    expect(headers).toContain("paymentRef");
    expect(headers).toContain("paidAt");
    expect(headers).toContain("issuedAt");
    expect(headers).toContain("discountCents");
    // 顺序：payment 后跟归因，时间戳在尾部
    const paymentRefIdx = headers.indexOf("paymentRef");
    const campaignIdx = headers.indexOf("campaignCode");
    const referralIdx = headers.indexOf("referralCode");
    const paidAtIdx = headers.indexOf("paidAt");
    const issuedAtIdx = headers.indexOf("issuedAt");
    expect(campaignIdx).toBe(paymentRefIdx + 1);
    expect(referralIdx).toBe(campaignIdx + 1);
    expect(paidAtIdx).toBeLessThan(issuedAtIdx);
    expect(issuedAtIdx).toBe(headers.length - 1);
  });

  it("parseOrderStatusFilterInput accepts comma strings used by settlement deep links", () => {
    expect(parseOrderStatusFilterInput("paid,issued")).toEqual(["paid", "issued"]);
    expect(parseOrderStatusFilterInput(" paid , issued ")).toEqual(["paid", "issued"]);
    expect(parseOrderStatusFilterInput(["paid,issued"])).toEqual(["paid", "issued"]);
    expect(parseOrderStatusFilterInput(["paid", "issued"])).toEqual(["paid", "issued"]);
    expect(parseOrderStatusFilterInput("")).toEqual([]);
    expect(parseOrderStatusFilterInput(null)).toEqual([]);
    expect(parseOrderStatusFilterInput(undefined)).toEqual([]);
  });
});
