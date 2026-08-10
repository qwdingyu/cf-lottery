/**
 * 平台用户身份关联（Phase B：QQ/Telegram 身份自动关联到 users 表）。
 *
 * 背景（docs/176 §3）：
 * - QQ/Telegram 用户通过平台消息参与活动，但此前在 users 表中没有对应记录。
 * - 这导致无法跨平台关联、无法登录 Web 端、卡密私聊失败后无法通过 Web 找回。
 * - Phase B 在平台入站时自动创建 users + authIdentities 记录，为 Web 登录铺路。
 *
 * 设计原则：
 * 1. 不改变 lotteryEntries.identityType（保持 "qq"/"telegram"），向后兼容。
 * 2. 每个平台用户（provider + providerUserId）对应唯一的 users.id。
 * 3. 使用 OAUTH_PASSWORD_PLACEHOLDER 作为密码，不可登录（Post-Phase C 前）。
 * 4. 幂等：同一 (provider, providerUserId) 重复调用返回同一 userId。
 * 5. 与 provisionIdpUser（cf-auth）共享 authIdentities 表，provider 不同。
 */
import { and, eq } from "drizzle-orm";
import type { DbType } from "../../db/client";
import { authIdentities, users } from "../../db/schema";
import { OAUTH_PASSWORD_PLACEHOLDER } from "../idp-user-provision";

/** 支持平台身份的类型 */
export type PlatformIdentityProvider = "qq" | "telegram";

export type ProvisionPlatformUserInput = {
  /** 平台类型：qq / telegram */
  provider: PlatformIdentityProvider;
  /** 平台侧用户 ID（QQ 号 / Telegram user_id） */
  providerUserId: string;
  /** 平台侧展示名，用于生成 username 候选 */
  displayName?: string;
};

export type ProvisionPlatformUserResult = {
  userId: string;
  /** 是否本轮新建了 users 行 */
  created: boolean;
};

/**
 * 从平台身份生成唯一 username。
 * 格式：{provider}_{providerUserId}_{fingerprint}，确保唯一且可读。
 */
function buildPlatformUsername(
  provider: string,
  providerUserId: string,
  displayName?: string,
  attempt = 0,
): string {
  // 优先使用 displayName 的前缀，否则用 provider 前缀
  const namePart = displayName
    ? String(displayName).replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 12)
    : `${provider}_${providerUserId.slice(0, 8)}`;
  const base = (namePart || `user_${provider}`).slice(0, 20);
  // 稳定短指纹：provider + providerUserId 的简易哈希
  const sub = `${provider}_${providerUserId}`;
  let h = 0;
  for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) >>> 0;
  const finger = (h + attempt * 9973).toString(36).slice(0, 6);
  const name = `${base}_${finger}`.slice(0, 40);
  return name.length >= 2 ? name : `u_${finger}`.slice(0, 40);
}

/**
 * 确保平台用户（QQ/Telegram）在本地 users 表中有对应记录。
 *
 * 幂等：同一 (provider, providerUserId) 重复调用返回同一 userId。
 * 并发安全：authIdentities UNIQUE(provider, providerUserId) 约束 + 重试兜底。
 */
export async function provisionPlatformUser(
  db: DbType,
  input: ProvisionPlatformUserInput,
): Promise<ProvisionPlatformUserResult> {
  const provider = String(input.provider || "").trim();
  const providerUserId = String(input.providerUserId || "").trim();
  if (!provider || !providerUserId) {
    throw new Error("平台身份配置缺少 provider 或 providerUserId");
  }

  // 1) 已有 identity → 直接复用
  const [existingIdentity] = await db
    .select()
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, provider), eq(authIdentities.providerUserId, providerUserId)))
    .limit(1);

  if (existingIdentity) {
    return { userId: existingIdentity.userId, created: false };
  }

  // 2) 无存量 → 新建 users + authIdentities
  const userId = crypto.randomUUID();
  let username = buildPlatformUsername(provider, providerUserId, input.displayName);
  let inserted = false;
  for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
    if (attempt > 0) {
      username = buildPlatformUsername(provider, providerUserId, input.displayName, attempt);
    }
    try {
      await db.insert(users).values({
        id: userId,
        username,
        email: "", // 平台用户无 email；后续可绑定
        emailVerified: 0, // 未验证邮箱
        passwordHash: OAUTH_PASSWORD_PLACEHOLDER, // 不可密码登录
        status: "active",
      });
      inserted = true;
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      // username 唯一冲突：换后缀重试；其它错误抛出
      if (!msg.includes("UNIQUE") && !msg.toLowerCase().includes("unique")) {
        throw err;
      }
      // 继续 attempt
    }
  }
  if (!inserted) {
    throw new Error("无法分配唯一用户名，请稍后重试");
  }

  // 3) 写入 identity 绑定（并发下可能撞 UNIQUE(provider, providerUserId)）
  try {
    await db.insert(authIdentities).values({
      id: crypto.randomUUID(),
      userId,
      provider,
      providerUserId,
      email: "",
    });
    return { userId, created: true };
  } catch (err) {
    const msg = String((err as Error)?.message || err).toLowerCase();
    if (!msg.includes("unique")) throw err;
    // 另一请求已写入：以库中记录为准（幂等收敛）
    const [race] = await db
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.provider, provider), eq(authIdentities.providerUserId, providerUserId)))
      .limit(1);
    if (!race) throw err;
    // 本轮已 insert users 但 identity 被并发抢占：删除孤儿行
    try {
      await db.delete(users).where(eq(users.id, userId));
    } catch {
      /* 尽力清理；失败不阻断登录 */
    }
    return { userId: race.userId, created: false };
  }
}