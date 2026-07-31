/**
 * 运营侧买家邮箱策略：域名白名单、禁止 + 别名。
 *
 * 与 canonicalBuyerEmail（限购/OTP 身份合并）职责分离：
 * - canonical：决定「是否同一买家」（防 +tag / Gmail 点号刷限购）。
 * - 本模块：决定「是否允许该输入邮箱进入发码/新下单」等入口。
 *
 * 默认策略（domainRestrictionEnabled=false, aliasBlockEnabled=false）：
 * evaluateBuyerEmailPolicy 恒为 ok，不改变任何线上默认行为。
 */

/** 后台可读配置；allowedDomains 仅在 domainRestrictionEnabled 时生效。 */
export type EmailPolicyConfig = {
  /** 仅允许白名单域名；默认 false（不限制） */
  domainRestrictionEnabled: boolean;
  /** 拒绝 local-part 含 + 的地址；默认 false（允许，仍由 canonical 合并限购） */
  aliasBlockEnabled: boolean;
  /** 允许的 apex 域名（小写）；仅启用域名限制时使用 */
  allowedDomains: string[];
};

/** 路由 fail(details.code) 使用的稳定错误码，前端可按码展示文案。 */
export type EmailPolicyViolationCode =
  | "EMAIL_ALIAS_BLOCKED"
  | "EMAIL_DOMAIN_NOT_ALLOWED"
  | "EMAIL_DOMAIN_WHITELIST_EMPTY";

export type EmailPolicyResult =
  | { ok: true }
  | { ok: false; code: EmailPolicyViolationCode; message: string };

/**
 * 域名行校验：至少含一个点的标签序列（如 qq.com、mail.example.co.uk）。
 * 不支持裸主机名、IP、带端口/路径的输入。
 */
const DOMAIN_LINE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** 与 Gmail 投递习惯对齐：googlemail.com 视为 gmail.com（仅策略匹配，不改用户填写的邮箱）。 */
function normalizePolicyDomain(domain: string): string {
  return domain === "googlemail.com" ? "gmail.com" : domain;
}

/**
 * 解析白名单原文 → 域名数组。
 * 容忍换行 / 逗号 / 分号分隔；小写、去首尾点、去重保序。
 * 注意：此处不做合法性硬拦（保存时用 normalizeEmailDomainWhitelistInput）。
 */
export function parseEmailDomainWhitelist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,;]+/)) {
    const domain = part.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

/**
 * Admin 保存白名单时的规范化：
 * - 按行解析（与 textarea 一致）
 * - 允许误写 @qq.com
 * - 非法行拒绝整段保存，避免半残配置悄悄生效
 */
export function normalizeEmailDomainWhitelistInput(
  raw: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    // 运营常粘贴 @qq.com；去掉前导 @ 再校验
    const domain = line.replace(/^@+/, "").toLowerCase().replace(/^\.+|\.+$/g, "");
    if (!DOMAIN_LINE_RE.test(domain)) {
      return { ok: false, message: `无效邮箱域名：${line}` };
    }
    if (domain.length > 253) {
      return { ok: false, message: `邮箱域名过长：${line}` };
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    normalized.push(domain);
  }
  if (normalized.length > 200) {
    return { ok: false, message: "邮箱域名白名单最多 200 个" };
  }
  // 存成每行一个，便于 Admin 回显与 diff
  return { ok: true, value: normalized.join("\n") };
}

/** 从邮箱提取域名（小写）；非法返回 null。 */
export function extractEmailDomain(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return null;
  const domain = normalized.slice(at + 1).replace(/^\.+|\.+$/g, "");
  return domain || null;
}

/**
 * local-part 含 +（含末尾单独 +）视为别名地址。
 * 仅在 aliasBlockEnabled 时拒绝；关闭时仍允许填写，限购走 canonical。
 */
export function emailHasPlusAlias(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return false;
  return normalized.slice(0, at).includes("+");
}

/**
 * 核心判定（纯函数，无 I/O）。
 * 顺序：先别名、后域名 —— 错误码稳定，便于前端与日志归因。
 */
export function evaluateBuyerEmailPolicy(
  email: string,
  policy: EmailPolicyConfig,
): EmailPolicyResult {
  // ── 别名硬拦（可选）──────────────────────────────────────────
  if (policy.aliasBlockEnabled && emailHasPlusAlias(email)) {
    return {
      ok: false,
      code: "EMAIL_ALIAS_BLOCKED",
      message: "当前店铺不允许使用带 + 的邮箱别名，请使用主邮箱地址",
    };
  }

  // ── 域名限制关闭：直接放行（默认路径）────────────────────────
  if (!policy.domainRestrictionEnabled) {
    return { ok: true };
  }

  // 开启限制但白名单为空：拒绝全部，避免「开了开关却等于不限制」的误配
  if (policy.allowedDomains.length === 0) {
    return {
      ok: false,
      code: "EMAIL_DOMAIN_WHITELIST_EMPTY",
      message: "已启用邮箱域名限制，但白名单为空，请联系管理员配置允许的域名",
    };
  }

  const domain = extractEmailDomain(email);
  if (!domain) {
    return {
      ok: false,
      code: "EMAIL_DOMAIN_NOT_ALLOWED",
      message: "邮箱格式无效",
    };
  }

  // 白名单与输入侧都做 googlemail → gmail 归一，避免运营只写 gmail.com 时误伤
  const allowed = new Set(
    policy.allowedDomains.map((item) => normalizePolicyDomain(item.toLowerCase())),
  );
  if (!allowed.has(normalizePolicyDomain(domain))) {
    return {
      ok: false,
      code: "EMAIL_DOMAIN_NOT_ALLOWED",
      message: "当前店铺仅接受指定邮箱域名，请更换邮箱后重试",
    };
  }

  return { ok: true };
}
