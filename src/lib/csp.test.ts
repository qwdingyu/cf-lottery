/**
 * CSP nonce 工具单测（docs/242）
 */
import { describe, expect, it } from "vitest";
import { buildCsp, createCspNonce, injectCspNonce } from "./csp";

describe("createCspNonce", () => {
  it("生成 base64 编码的 128bit 随机值，且每次不同", () => {
    const a = createCspNonce();
    const b = createCspNonce();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
    // base64 无引号/尖括号，拼进属性值不会截断
    expect(a).not.toMatch(/["'<>]/);
  });
});

describe("buildCsp", () => {
  it("无 nonce 时 script-src 只放行 self 与白名单", () => {
    const csp = buildCsp();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("nonce-");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("有 nonce 时 script-src 追加 nonce 且不含 unsafe-inline", () => {
    const csp = buildCsp("abc123");
    expect(csp).toContain("'nonce-abc123'");
    // script-src 段不含 unsafe-inline（CSP Level 3：nonce 与 unsafe-inline 同现时后者被忽略）
    const scriptSrc = csp.split("; ").find((s) => s.startsWith("script-src"))!;
    expect(scriptSrc).not.toContain("unsafe-inline");
  });
});

describe("injectCspNonce", () => {
  it("给每个 script 标签补 nonce 属性", () => {
    const html = `<html><head><script type="module" src="/assets/index.js"></script></head><body></body></html>`;
    const out = injectCspNonce(html, "n1");
    expect(out).toContain(`<script nonce="n1" type="module"`);
  });

  it("不误伤 <scripting> 等标签名前缀", () => {
    const html = `<scripting>not a script</scripting><script src="/a.js"></script>`;
    const out = injectCspNonce(html, "n2");
    expect(out).toContain(`<scripting>`); // 原样保留
    expect(out).toContain(`<script nonce="n2" src="/a.js"`);
  });
});
