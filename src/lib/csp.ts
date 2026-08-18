/**
 * Content-Security-Policy 构建（docs/242）
 *
 * 背景：cf-lottery 的 index.html 虽只有 1 个外部 <script src="...">（无内联脚本），
 * 但为了防御未来引入内联脚本（如 Vite legacy 插件注入），采用 per-request nonce 方案：
 * 服务端每次请求生成随机 nonce，写入 CSP 头，并给 HTML 中每个 <script> 补上 nonce 属性。
 * 攻击者注入的脚本拿不到当次 nonce，因而不会被执行。
 *
 * 三个函数均无副作用，易于单测。
 * 依赖 crypto.getRandomValues / btoa（Node 18+ 全局可用），不依赖 CF Worker 环境。
 */

/** script-src 允许的第三方脚本源 */
const SCRIPT_HOSTS = [
  "https://unpkg.com",
  "https://static.cloudflareinsights.com",
  "https://challenges.cloudflare.com",
  "https://telegram.org",
] as const;

/**
 * 生成一次性 CSP nonce（128 bit 随机，base64 编码）。
 * 入口文档响应为 no-store，nonce 不会被浏览器或 CDN 缓存复用。
 */
export function createCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 构建 CSP 头字符串。
 * @param scriptNonce - 传入时 script-src 追加 'nonce-xxx'（仅 HTML 入口文档需要）
 */
export function buildCsp(scriptNonce?: string): string {
  const scriptSrc = [
    "script-src 'self'",
    ...(scriptNonce ? [`'nonce-${scriptNonce}'`] : []),
    ...SCRIPT_HOSTS,
  ].join(" ");

  return [
    "default-src 'self'",
    // style-src 保留 'unsafe-inline'：Vue :style 绑定生成内联 style 属性，
    // CSP nonce 只对 <style> 元素生效、对 style 属性无效，此为已知取舍。
    "style-src 'self' 'unsafe-inline' https://unpkg.com",
    scriptSrc,
    "img-src 'self' data: https:",
    "connect-src 'self' https://unpkg.com https://challenges.cloudflare.com",
    "frame-src 'self' https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

/**
 * 给 HTML 中每个 <script> 标签补上 nonce 属性。
 * 仅用于 SPA 入口文档（约 3KB，全量读入内存无压力）。
 * 匹配 /<script(?=[\s>])/ ——要求 script 后紧跟空白或 '>'，避免误伤 <scripting> 等标签名。
 */
export function injectCspNonce(html: string, nonce: string): string {
  return html.replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
}