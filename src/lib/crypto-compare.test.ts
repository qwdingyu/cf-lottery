/**
 * 常量时间比较单测：正确性优先（时差无法在单元测试中严格证明）。
 */
import { describe, expect, it } from "vitest";
import { timingSafeEqualHex, timingSafeEqualString } from "./crypto-compare";

describe("timingSafeEqualHex", () => {
  it("相同 hex 返回 true（大小写不敏感）", () => {
    expect(timingSafeEqualHex("a1b2", "A1B2")).toBe(true);
    expect(timingSafeEqualHex("", "")).toBe(true);
  });

  it("不同内容或长度返回 false", () => {
    expect(timingSafeEqualHex("a1b2", "a1b3")).toBe(false);
    expect(timingSafeEqualHex("a1", "a1b2")).toBe(false);
    expect(timingSafeEqualHex("dead", "beef")).toBe(false);
  });
});

describe("timingSafeEqualString", () => {
  it("相同字符串 true，不同 false", () => {
    expect(timingSafeEqualString("hello", "hello")).toBe(true);
    expect(timingSafeEqualString("hello", "hellp")).toBe(false);
    expect(timingSafeEqualString("a", "ab")).toBe(false);
  });
});
