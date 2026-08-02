/**
 * 抽奖服务层 — 纯工具模块（lottery-service 拆分，docs/049 #17）
 *
 * 无业务/数据库依赖：CSPRNG 部分 Fisher-Yates 随机抽取（开奖公平性核心）、
 * 活动访问密码的哈希与验证（带随机 salt，防彩虹表）。
 * verifyAccessPassword 拆分前为内部函数，现导出供参与域复用。
 */

/* ── 内部工具 ─────────────────────────────────────────────── */

/**
 * Fisher-Yates 洗牌算法，使用 CSPRNG（crypto.getRandomValues）。
 * 从候选数组中随机抽取指定数量的元素，保证等概率。
 *
 * 为什么不使用 Math.random()：
 * Math.random() 是伪随机数生成器，可预测且不安全。
 * crypto.getRandomValues() 是密码学安全的随机数生成器，适合抽奖等公平性场景。
 */
export async function randomSelect<T>(candidates: T[], count: number): Promise<T[]> {
  // 实际抽取数量不超过候选池大小
  const n = Math.min(count, candidates.length);
  if (n <= 0) return [];

  // 复制候选数组，避免修改原数组
  const result = [...candidates];

  // 部分 Fisher-Yates 洗牌（#12 优化）：
  // 只洗尾部 n 个位置——每轮把 result[i] 与 [0, i] 中随机一个交换，
  // 使 [length-n, length) 区间的元素成为等概率的随机子集，然后取尾部 n 个。
  // 与全量洗牌概率等价，但 crypto.getRandomValues 调用从 O(N) 降为 O(n)：
  // 大活动（10 万参与者）下全量洗牌需 10 万次密码学随机调用，远超免费层 CPU 预算
  // （023 §5.1 红线：大数组排序/复杂随机）；部分洗牌仅需 n 次（n 通常 ≤ 千级）。
  for (let i = result.length - 1; i >= result.length - n; i--) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    // 取模运算产生 0 到 i 之间的随机索引
    const j = random[0]! % (i + 1);
    // 交换 result[i] 和 result[j]
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }

  // 洗牌后取尾部 n 个作为中奖者
  return result.slice(result.length - n);
}

/* ── 密码工具 ────────────────────────────────────────────── */

/**
 * 哈希活动访问密码（带随机 salt，格式 `salt_v1:{salt_hex}:{sha256(salt+password)_hex}`）。
 * 防止数据库泄漏后彩虹表反查。
 */
export async function hashAccessPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  const data = new Uint8Array(salt.length + encoder.encode(password).length);
  data.set(salt);
  data.set(encoder.encode(password), salt.length);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `salt_v1:${saltHex}:${hashHex}`;
}

/**
 * 验证访问密码。兼容新旧两种格式。
 */
export async function verifyAccessPassword(inputPassword: string, storedHash: string): Promise<boolean> {
  const encoder = new TextEncoder();
  // 新格式：salt_v1:saltHex:hashHex
  if (storedHash.startsWith("salt_v1:")) {
    const [, saltHex, hashHex] = storedHash.split(":");
    if (!saltHex || !hashHex) return false;
    const salt = new Uint8Array(saltHex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
    const data = new Uint8Array(salt.length + encoder.encode(inputPassword).length);
    data.set(salt);
    data.set(encoder.encode(inputPassword), salt.length);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const computedHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
    return computedHex === hashHex;
  }
  // 旧格式：纯 SHA-256 hex（无 salt）
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(inputPassword));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("") === storedHash;
}

