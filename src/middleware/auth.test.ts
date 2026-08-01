/**
 * JWT 认证中间件测试
 *
 * 测试 verifyJwt 和 signJwt 函数。
 * 使用 Web Crypto API（Cloudflare Workers 原生支持）。
 */
import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt } from "../middleware/auth";

const TEST_SECRET = "test-jwt-secret-0123456789abcdef";
const TEST_USER_ID = "user-123";
const TEST_TENANT_ID = "tenant-456";

describe("JWT 签名与验证", () => {
  it("签名后能正确验证", async () => {
    const token = await signJwt({ sub: TEST_USER_ID, tenantId: TEST_TENANT_ID }, TEST_SECRET, 3600);
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });

  it("验证成功返回 payload", async () => {
    const token = await signJwt({ sub: TEST_USER_ID, tenantId: TEST_TENANT_ID }, TEST_SECRET, 3600);
    const payload = await verifyJwt(token, TEST_SECRET);
    expect(payload).toBeTruthy();
    expect(payload!.sub).toBe(TEST_USER_ID);
    expect(payload!.tenantId).toBe(TEST_TENANT_ID);
  });

  it("过期 token 验证失败", async () => {
    // 签名过期时间为 0 秒
    const token = await signJwt({ sub: TEST_USER_ID, tenantId: TEST_TENANT_ID }, TEST_SECRET, 0);
    // 等待 1 秒确保过期
    await new Promise(r => setTimeout(r, 10));
    const payload = await verifyJwt(token, TEST_SECRET);
    expect(payload).toBeNull();
  });

  it("错误的密钥验证失败", async () => {
    const token = await signJwt({ sub: TEST_USER_ID, tenantId: TEST_TENANT_ID }, TEST_SECRET, 3600);
    const payload = await verifyJwt(token, "wrong-secret");
    expect(payload).toBeNull();
  });

  it("恶意 token 格式验证失败", async () => {
    const payload = await verifyJwt("invalid.token.format", TEST_SECRET);
    expect(payload).toBeNull();
  });

  it("空 token 验证失败", async () => {
    const payload = await verifyJwt("", TEST_SECRET);
    expect(payload).toBeNull();
  });
});
