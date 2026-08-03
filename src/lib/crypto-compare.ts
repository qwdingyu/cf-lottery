/**
 * 常量时间比较工具（Workers / 浏览器 WebCrypto 环境无 Node crypto.timingSafeEqual）。
 *
 * 用途：密码哈希、OTP codeHash、活动访问密码等「机密相等」判断。
 * 为什么：普通 `===` 在部分引擎上可能因短路产生可测时差；本实现固定扫描两串长度上界，
 * 避免把「前缀是否相同」直接泄漏给计时侧信道。
 *
 * 注意：不能消除哈希计算本身的时差；这是防御深度的一层，不是替代限流/锁账户。
 */

/**
 * 比较两个 hex 字符串是否相等（忽略大小写；非法 hex 字符按 0 处理，仍走完整扫描）。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const left = (a || "").toLowerCase();
  const right = (b || "").toLowerCase();
  const len = Math.max(left.length, right.length);
  // 长度不同也必须扫完，再把 length 差并入 diff
  let diff = left.length === right.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < left.length ? left.charCodeAt(i) : 0;
    const cb = i < right.length ? right.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/**
 * 通用 UTF-8 字符串常量时间比较（用于非 hex 机密，如 legacy 整串 hash）。
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = a || "";
  const right = b || "";
  const len = Math.max(left.length, right.length);
  let diff = left.length === right.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < left.length ? left.charCodeAt(i) : 0;
    const cb = i < right.length ? right.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}
