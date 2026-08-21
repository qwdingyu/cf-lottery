/**
 * payment-utils 单元测试（docs/257 死磕闭环）。
 *
 * 测试 isRetryingPaymentOrder 的边界：
 * - null/undefined → false（安全兜底）
 * - 无 status 字段 → false（isRetryablePaymentOrderStatus 处理 undefined 的防御）
 * - pending/paid/refunded → false（非可重试状态）
 * - expired/cancelled → true（可重试状态）
 */
import { describe, expect, it } from "vitest";
import { isRetryingPaymentOrder } from "./payment-utils";

describe("isRetryingPaymentOrder", () => {
  it("null → false", () => {
    expect(isRetryingPaymentOrder(null)).toBe(false);
  });

  it("undefined → false", () => {
    expect(isRetryingPaymentOrder(undefined)).toBe(false);
  });

  it("空对象（无 status 字段）→ false", () => {
    // 类型上不允许，但运行时可能传入；isRetryablePaymentOrderStatus 接受 undefined 返回 false
    expect(isRetryingPaymentOrder({} as { status: string })).toBe(false);
  });

  it("pending → false", () => {
    expect(isRetryingPaymentOrder({ status: "pending" })).toBe(false);
  });

  it("paid → false", () => {
    expect(isRetryingPaymentOrder({ status: "paid" })).toBe(false);
  });

  it("refunded → false", () => {
    expect(isRetryingPaymentOrder({ status: "refunded" })).toBe(false);
  });

  it("expired → true", () => {
    expect(isRetryingPaymentOrder({ status: "expired" })).toBe(true);
  });

  it("cancelled → true", () => {
    expect(isRetryingPaymentOrder({ status: "cancelled" })).toBe(true);
  });

  it("unexpired → false（未在可重试列表中）", () => {
    expect(isRetryingPaymentOrder({ status: "unexpired" })).toBe(false);
  });
});