/**
 * cf-auth OAuth RP 客户端（授权码 + PKCE）。
 *
 * 为什么独立成纯模块：
 * - 多项目边界是标准 OAuth，不是共享 Better Auth cookie（cf-auth docs/001）。
 * - vitest 可直接驱动 buildAuthorizeUrl / exchangeAuthorizationCode / map 函数，
 *   不必先起完整 Worker。
 * - 交换成功后仍签发 lottery 自签 JWT，与 requireAuth 路径兼容。
 */
import { signJwt } from "../middleware/auth";

/** lottery 侧 cf-auth 客户端配置（来自 env，secret 永不下发浏览器） */
export type CfAuthClientConfig = {
  enabled: boolean;
  /** IdP base，如 http://localhost:8788（无尾斜杠） */
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
};

export type CfAuthUserInfo = {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  email_verified?: boolean;
  [key: string]: unknown;
};

export type CfAuthTokenResponse = {
  access_token: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

export type PkcePair = {
  /** 前端会话保存，换 token 时提交 */
  verifier: string;
  /** 放进 authorize 的 code_challenge（S256） */
  challenge: string;
};

const DEFAULT_SCOPES = "openid profile email";

/** 从原始 env 解析配置；缺关键项则 enabled=false（安全默认关闭） */
export function resolveCfAuthConfig(env: {
  CF_AUTH_ENABLED?: string;
  CF_AUTH_ISSUER?: string;
  CF_AUTH_CLIENT_ID?: string;
  CF_AUTH_CLIENT_SECRET?: string;
  CF_AUTH_REDIRECT_URI?: string;
  CF_AUTH_SCOPES?: string;
}): CfAuthClientConfig {
  const flag = String(env.CF_AUTH_ENABLED || "").trim().toLowerCase();
  const want = flag === "1" || flag === "true" || flag === "yes" || flag === "on";
  const issuer = String(env.CF_AUTH_ISSUER || "").trim().replace(/\/$/, "");
  const clientId = String(env.CF_AUTH_CLIENT_ID || "").trim();
  const clientSecret = String(env.CF_AUTH_CLIENT_SECRET || "").trim();
  const redirectUri = String(env.CF_AUTH_REDIRECT_URI || "").trim();
  const scopes = String(env.CF_AUTH_SCOPES || DEFAULT_SCOPES).trim() || DEFAULT_SCOPES;
  const complete = Boolean(issuer && clientId && clientSecret && redirectUri);
  return {
    enabled: want && complete,
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    scopes,
  };
}

/** 浏览器可看的元数据（无 secret） */
export function publicCfAuthMeta(config: CfAuthClientConfig): {
  enabled: boolean;
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
} {
  const base = config.issuer;
  return {
    enabled: config.enabled,
    issuer: base,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    authorizeUrl: base ? `${base}/api/auth/oauth2/authorize` : "",
    tokenUrl: base ? `${base}/api/auth/oauth2/token` : "",
    userinfoUrl: base ? `${base}/api/auth/oauth2/userinfo` : "",
  };
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  // btoa 在 Node/Workers 均可用（Node 18+ 全局）
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** 生成 PKCE S256 对（Web Crypto，Workers 兼容） */
export async function createPkcePair(): Promise<PkcePair> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = b64urlFromBytes(raw);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = b64urlFromBytes(new Uint8Array(digest));
  return { verifier, challenge };
}

/** 随机 state（CSRF） */
export function createOAuthState(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  return b64urlFromBytes(raw);
}

/**
 * 构造授权 URL（response_type=code + S256）。
 * 不发起网络请求，便于单测断言 query。
 */
export function buildAuthorizeUrl(
  config: Pick<CfAuthClientConfig, "issuer" | "clientId" | "redirectUri" | "scopes">,
  opts: { state: string; codeChallenge: string; codeChallengeMethod?: "S256" },
): string {
  if (!config.issuer || !config.clientId || !config.redirectUri) {
    throw new Error("cf-auth 配置不完整，无法构造 authorize URL");
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes || DEFAULT_SCOPES,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: opts.codeChallengeMethod || "S256",
  });
  return `${config.issuer.replace(/\/$/, "")}/api/auth/oauth2/authorize?${params}`;
}

export type ExchangeResult =
  | { ok: true; tokens: CfAuthTokenResponse }
  | { ok: false; status: number; message: string; bodyText?: string };

/**
 * 用授权码 + code_verifier 换 token（真实 HTTP POST 到 IdP）。
 * fetcher 可注入（测试里指向 cf-auth app.request 包装）。
 */
export async function exchangeAuthorizationCode(
  config: CfAuthClientConfig,
  input: { code: string; codeVerifier: string; redirectUri?: string },
  fetcher: typeof fetch = fetch,
): Promise<ExchangeResult> {
  if (!config.enabled && !(config.issuer && config.clientId && config.clientSecret)) {
    return { ok: false, status: 503, message: "cf-auth 未启用或配置不完整" };
  }
  if (!input.code?.trim() || !input.codeVerifier?.trim()) {
    return { ok: false, status: 400, message: "缺少 code 或 code_verifier" };
  }
  const redirectUri = (input.redirectUri || config.redirectUri).trim();
  if (!redirectUri) {
    return { ok: false, status: 400, message: "缺少 redirect_uri" };
  }

  const tokenUrl = `${config.issuer.replace(/\/$/, "")}/api/auth/oauth2/token`;
  const basic = btoa(`${config.clientId}:${config.clientSecret}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code.trim(),
    redirect_uri: redirectUri,
    code_verifier: input.codeVerifier.trim(),
  });

  let res: Response;
  try {
    res = await fetcher(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
        // Better Auth 部分路径校验 Origin
        Origin: config.issuer,
      },
      body,
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: `无法连接 cf-auth token 端点: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status >= 400 && res.status < 600 ? res.status : 502,
      message: "cf-auth token 交换失败",
      bodyText: text.slice(0, 500),
    };
  }

  let tokens: CfAuthTokenResponse;
  try {
    tokens = JSON.parse(text) as CfAuthTokenResponse;
  } catch {
    return { ok: false, status: 502, message: "cf-auth token 响应非 JSON", bodyText: text.slice(0, 200) };
  }
  if (!tokens.access_token) {
    return { ok: false, status: 502, message: "cf-auth token 响应缺少 access_token", bodyText: text.slice(0, 200) };
  }
  return { ok: true, tokens };
}

export type UserInfoResult =
  | { ok: true; profile: CfAuthUserInfo }
  | { ok: false; status: number; message: string };

/** 用 access_token 拉 userinfo */
export async function fetchCfAuthUserInfo(
  config: Pick<CfAuthClientConfig, "issuer">,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<UserInfoResult> {
  if (!accessToken?.trim()) {
    return { ok: false, status: 400, message: "缺少 access_token" };
  }
  const url = `${config.issuer.replace(/\/$/, "")}/api/auth/oauth2/userinfo`;
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: `无法连接 cf-auth userinfo: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, message: "cf-auth userinfo 失败" };
  }
  const profile = (await res.json()) as CfAuthUserInfo;
  if (!profile?.sub) {
    return { ok: false, status: 502, message: "userinfo 缺少 sub" };
  }
  return { ok: true, profile };
}

/**
 * userinfo → lottery 自签 JWT claims。
 * tenant 字段先空，后续可绑用户表 / onboarding。
 */
export function mapCfAuthUserToJwtClaims(profile: CfAuthUserInfo): {
  sub: string;
  email: string;
  tenantId: string;
  tenantRole: string;
  platformRole: null;
  impersonated: false;
  identityProvider: "cf-auth";
} {
  const email = String(profile.email || profile.preferred_username || "").trim();
  return {
    sub: String(profile.sub),
    email,
    tenantId: "",
    tenantRole: "",
    platformRole: null,
    impersonated: false,
    identityProvider: "cf-auth",
  };
}

/** userinfo → 业务 Bearer JWT（requireAuth 可验） */
export async function issueBusinessTokenFromCfAuth(
  profile: CfAuthUserInfo,
  jwtSecret: string,
  ttlSeconds = 24 * 3600,
): Promise<string> {
  const claims = mapCfAuthUserToJwtClaims(profile);
  return signJwt(claims, jwtSecret, ttlSeconds);
}

/**
 * 完整 RP 交换：code → token → userinfo → 业务 JWT。
 * 单入口供路由与联调测试调用。
 */
export async function completeCfAuthCodeExchange(
  config: CfAuthClientConfig,
  input: { code: string; codeVerifier: string; redirectUri?: string },
  jwtSecret: string,
  fetcher: typeof fetch = fetch,
): Promise<
  | { ok: true; token: string; email: string; sub: string; accessToken: string }
  | { ok: false; status: number; message: string; detail?: string }
> {
  if (!jwtSecret) {
    return { ok: false, status: 500, message: "JWT_SECRET 未配置" };
  }
  // 允许测试传入完整 client 字段但 enabled=false 的「强制跑」：以 secret 是否齐全为准
  if (!config.issuer || !config.clientId || !config.clientSecret) {
    return { ok: false, status: 503, message: "cf-auth 未启用或配置不完整" };
  }

  const tokenResult = await exchangeAuthorizationCode(config, input, fetcher);
  if (!tokenResult.ok) {
    return {
      ok: false,
      status: tokenResult.status,
      message: tokenResult.message,
      detail: tokenResult.bodyText,
    };
  }

  const info = await fetchCfAuthUserInfo(config, tokenResult.tokens.access_token, fetcher);
  if (!info.ok) {
    return { ok: false, status: info.status, message: info.message };
  }

  const token = await issueBusinessTokenFromCfAuth(info.profile, jwtSecret);
  const claims = mapCfAuthUserToJwtClaims(info.profile);
  return {
    ok: true,
    token,
    email: claims.email,
    sub: claims.sub,
    accessToken: tokenResult.tokens.access_token,
  };
}
