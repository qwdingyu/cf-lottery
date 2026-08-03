/**
 * 外部 IdP（cf-auth）首次登录 → 本地 users 建档 / 绑定。
 *
 * 安全原则（防账号接管）：
 * 1. 主键绑定是 (provider, idp_sub)，不是裸 email。
 * 2. 仅当本地邮箱 **已验证** 时才按 email 链接存量账号；未验证注册行不可被 OAuth 劫持。
 * 3. JWT.sub **始终** 为本地 users.id（与 create-tenant / requireAuth 一致），不把上游 sub 当业务主键。
 * 4. OAuth 用户 password_hash 为不可登录占位符，不开放密码撞库面。
 * 5. 不自动创建租户（045 方案 C）：needsTenant 由 membership 决定，交给 onboarding。
 */
import { and, eq } from "drizzle-orm";
import type { DbType } from "../db/client";
import { authIdentities, tenantMembers, tenants, users } from "../db/schema";

/** 与 users.password_hash NOT NULL 兼容；verifyPassword 不会匹配真实口令 */
export const OAUTH_PASSWORD_PLACEHOLDER = "oauth_no_password:v1";

export const IDP_PROVIDER_CF_AUTH = "cf-auth" as const;

export type IdpProvider = typeof IDP_PROVIDER_CF_AUTH | string;

export type ProvisionIdpUserInput = {
  provider: IdpProvider;
  /** IdP userinfo.sub（不可变） */
  idpSub: string;
  email?: string;
  /** userinfo 展示名，仅用于生成 username 候选 */
  displayName?: string;
  emailVerified?: boolean;
};

export type ProvisionIdpUserResult = {
  userId: string;
  email: string;
  /** 默认租户（首个 membership），无则空串 */
  tenantId: string;
  tenantRole: string;
  needsTenant: boolean;
  /** 是否本轮新建了 users 行 */
  createdUser: boolean;
  /** 是否本轮新建了 auth_identities 绑定 */
  linkedIdentity: boolean;
};

/**
 * 从 email / displayName / idpSub 生成符合 USERNAME_RE 的候选（2-40 字母数字下划线）。
 * 纯函数，便于单测；碰撞时由 provision 追加后缀重试。
 */
export function buildOauthUsernameCandidate(
  input: { email?: string; displayName?: string; idpSub: string },
  attempt = 0,
): string {
  const rawLocal =
    String(input.email || "")
      .trim()
      .toLowerCase()
      .split("@")[0] ||
    String(input.displayName || "")
      .trim()
      .toLowerCase() ||
    "user";
  const cleaned = rawLocal.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const base = (cleaned || "user").slice(0, 20);
  // 稳定短后缀：idp sub 的简易指纹（非安全哈希，仅消碰撞）
  const sub = String(input.idpSub || "");
  let h = 0;
  for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) >>> 0;
  const finger = (h + attempt * 9973).toString(36).slice(0, 6);
  const name = `${base}_${finger}`.slice(0, 40);
  return name.length >= 2 ? name : `u_${finger}`.slice(0, 40);
}

function normalizeEmail(email: string | undefined): string {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/**
 * 将 IdP 身份落到本地 users + auth_identities，并解析租户。
 * 幂等：同一 (provider, idp_sub) 重复调用返回同一 userId。
 */
export async function provisionIdpUser(
  db: DbType,
  input: ProvisionIdpUserInput,
): Promise<ProvisionIdpUserResult> {
  const provider = String(input.provider || "").trim();
  const idpSub = String(input.idpSub || "").trim();
  if (!provider || !idpSub) {
    throw new Error("IdP provision 缺少 provider 或 sub");
  }
  const email = normalizeEmail(input.email);
  // OAuth 路径：userinfo 已认证；有 email 则视为已验证写入本地
  const markVerified = Boolean(email) && (input.emailVerified !== false);

  // 1) 已有 identity → 直接复用
  const [existingIdentity] = await db
    .select()
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, provider), eq(authIdentities.providerUserId, idpSub)))
    .limit(1);

  if (existingIdentity) {
    const [user] = await db.select().from(users).where(eq(users.id, existingIdentity.userId)).limit(1);
    if (!user) {
      throw new Error("auth_identities 指向的用户不存在");
    }
    if (user.status !== "active") {
      throw new Error("账号已被禁用");
    }
    // 回填邮箱（仅空邮箱时），不覆盖已有邮箱以免串号
    if (email && !user.email) {
      await db
        .update(users)
        .set({
          email,
          emailVerified: markVerified ? 1 : user.emailVerified,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(users.id, user.id));
    } else if (email && user.email === email && markVerified && !user.emailVerified) {
      await db
        .update(users)
        .set({ emailVerified: 1, updatedAt: new Date().toISOString() })
        .where(eq(users.id, user.id));
    }
    return finalize(db, user.id, email || user.email, false, false);
  }

  // 2) 按已验证邮箱链接存量账号（防未验证邮箱被 OAuth 绑定）
  let targetUserId: string | null = null;
  let createdUser = false;
  let linkedIdentity = false;

  if (email) {
    const [byEmail] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), eq(users.emailVerified, 1)))
      .limit(1);
    if (byEmail) {
      if (byEmail.status !== "active") {
        throw new Error("账号已被禁用");
      }
      targetUserId = byEmail.id;
    }
  }

  // 3) 无存量 → 新建 users（方案 C：不建租户）
  if (!targetUserId) {
    const userId = crypto.randomUUID();
    let username = buildOauthUsernameCandidate({
      email,
      displayName: input.displayName,
      idpSub,
    });
    let inserted = false;
    for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
      if (attempt > 0) {
        username = buildOauthUsernameCandidate(
          { email, displayName: input.displayName, idpSub },
          attempt,
        );
      }
      try {
        await db.insert(users).values({
          id: userId,
          username,
          email: email || "",
          emailVerified: markVerified ? 1 : 0,
          passwordHash: OAUTH_PASSWORD_PLACEHOLDER,
          status: "active",
        });
        inserted = true;
        createdUser = true;
        targetUserId = userId;
      } catch (err) {
        const msg = String((err as Error)?.message || err);
        // username 唯一冲突：换后缀重试；其它错误抛出
        if (!msg.includes("UNIQUE") && !msg.toLowerCase().includes("unique")) {
          throw err;
        }
        // 可能是并发同 username；继续 attempt
      }
    }
    if (!targetUserId) {
      throw new Error("无法分配唯一用户名，请稍后重试");
    }
  }

  // 4) 写入 identity 绑定（并发下可能撞 UNIQUE(provider, provider_user_id)）
  try {
    await db.insert(authIdentities).values({
      id: crypto.randomUUID(),
      userId: targetUserId,
      provider,
      providerUserId: idpSub,
      email: email || "",
    });
    linkedIdentity = true;
  } catch (err) {
    const msg = String((err as Error)?.message || err).toLowerCase();
    if (!msg.includes("unique")) throw err;
    // 另一请求已写入：以库中记录为准（幂等收敛）
    const [race] = await db
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.provider, provider), eq(authIdentities.providerUserId, idpSub)))
      .limit(1);
    if (!race) throw err;
    // 本轮若已 insert users 但 identity 被并发抢占：删除孤儿行，避免 users 膨胀
    if (createdUser && targetUserId && targetUserId !== race.userId) {
      try {
        await db.delete(users).where(eq(users.id, targetUserId));
      } catch {
        /* 尽力清理；失败不阻断登录（identity 已收敛到 race.userId） */
      }
    }
    return finalize(db, race.userId, email, false, false);
  }

  return finalize(db, targetUserId, email, createdUser, linkedIdentity);
}

async function finalize(
  db: DbType,
  userId: string,
  email: string,
  createdUser: boolean,
  linkedIdentity: boolean,
): Promise<ProvisionIdpUserResult> {
  const memberships = await db
    .select({
      tenantId: tenantMembers.tenantId,
      role: tenantMembers.role,
      tenantName: tenants.name,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(eq(tenantMembers.userId, userId));

  const first = memberships[0];
  return {
    userId,
    email,
    tenantId: first?.tenantId || "",
    tenantRole: first?.role || "",
    needsTenant: memberships.length === 0,
    createdUser,
    linkedIdentity,
  };
}
