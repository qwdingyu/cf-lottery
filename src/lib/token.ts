/**
 * Token 工具模块
 *
 * 抽奖 SaaS 专属的 token 生成函数。
 */

/**
 * 生成随机 token
 */
export function createOrderToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}