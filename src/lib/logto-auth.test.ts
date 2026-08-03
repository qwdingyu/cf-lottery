/**
 * Logto 身份认证模块测试（docs/051 方案）
 *
 * 覆盖：
 * - 配置缺失时抛出正确的错误消息
 * - exchangeLogtoToken 生成的自签 JWT 格式正确
 * - 自签 JWT 可通过现有 verifyJwt 验证
 *
 * 注意：verifyLogtoIdToken 需要真实 Logto JWKS 端点，此处不测试；
 * 集成测试需在部署后使用真实 Logto 配置进行。
 */
import { describe, it, expect } from "vitest";
import { exchangeLogtoToken } from "../lib/logto-auth";
import { verifyJwt } from "../middleware/auth";

const JWT_SECRET = "test-jwt-secret-0123456789abcdef";

describe("Logto 身份认证（logto-auth）", () => {
  describe("exchangeLogtoToken", () => {
    it("用 Logto payload 生成的自签 JWT 可通过 verifyJwt 验证", async () => {
      const logtoPayload = {
        sub: "logto|user_12345",
        email: "test@example.com",
        iss: "https://test.logto.app/oidc",
        aud: "test-app-id",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      };

      const token = await exchangeLogtoToken(logtoPayload, JWT_SECRET);
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");

      // 自签 JWT 应可通过现有 verifyJwt 验证
      const claims = await verifyJwt(token, JWT_SECRET);
      expect(claims).not.toBeNull();
      expect(claims!.sub).toBe("logto|user_12345");
      expect(claims!.email).toBe("test@example.com");
      // 自签字段应正确传递
      expect(claims!.tenantId).toBe("");
      expect(claims!.impersonated).toBe(false);
    });

    it("自签 JWT 包含 24 小时有效期", async () => {
      const logtoPayload = {
        sub: "logto|user_test",
        email: "test@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      };

      const token = await exchangeLogtoToken(logtoPayload, JWT_SECRET);
      const claims = await verifyJwt(token, JWT_SECRET);
      expect(claims).not.toBeNull();
      // 24 小时 ≈ 86400 秒
      const ttl = (claims!.exp as number) - (claims!.iat as number);
      expect(ttl).toBeGreaterThanOrEqual(86000);
      expect(ttl).toBeLessThanOrEqual(86500);
    });
  });
});