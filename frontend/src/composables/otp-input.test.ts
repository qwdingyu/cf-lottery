import { describe, expect, it } from "vitest";
import { isOtpComplete, normalizeOtpDigits, OTP_CODE_LENGTH } from "./otp-input";

describe("normalizeOtpDigits", () => {
  it("只保留数字并截断到 6 位", () => {
    expect(normalizeOtpDigits("12-34 ab")).toBe("1234");
    expect(normalizeOtpDigits("123456789")).toBe("123456");
    expect(normalizeOtpDigits("")).toBe("");
    expect(normalizeOtpDigits("  ")).toBe("");
  });

  it("默认长度与常量一致", () => {
    expect(OTP_CODE_LENGTH).toBe(6);
    expect(normalizeOtpDigits("1".repeat(10), OTP_CODE_LENGTH).length).toBe(6);
  });
});

describe("isOtpComplete", () => {
  it("满 6 位为 true", () => {
    expect(isOtpComplete("123456")).toBe(true);
    expect(isOtpComplete("12345")).toBe(false);
    expect(isOtpComplete(normalizeOtpDigits("12 34 56"))).toBe(true);
  });
});
