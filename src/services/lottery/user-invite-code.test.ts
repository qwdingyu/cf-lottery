/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { generateUserInviteCode } from "./participation";

/**
 * docs/272：用户级邀请码单元测试
 *
 * generateUserInviteCode() 在用户注册时调用一次，生成 8 位定长邀请码。
 * 所有活动通用，不存在活动级别/本地存储的重复风险。
 */

describe("generateUserInviteCode", () => {
  it("返回 8 位字符串", () => {
    const code = generateUserInviteCode();
    expect(typeof code).toBe("string");
    expect(code).toHaveLength(8);
  });

  it("只包含安全字符集（ABCDEFGHJKMNPQRSTUVWXYZ23456789）", () => {
    const SAFE = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    for (let i = 0; i < 50; i++) {
      const code = generateUserInviteCode();
      for (const ch of code) {
        expect(SAFE).toContain(ch);
      }
    }
  });

  it("不含容易混淆的字符（0/O/1/I/L）", () => {
    const CONFUSABLE = /[0O1IL]/;
    for (let i = 0; i < 50; i++) {
      expect(CONFUSABLE.test(generateUserInviteCode())).toBe(false);
    }
  });

  it("多次调用产生不同值（概率性，碰撞概率 < 36^-8 ≈ 2e-12）", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generateUserInviteCode());
    }
    // 100 个不同邀请码（碰撞概率几乎为零）
    expect(codes.size).toBe(100);
  });
});
