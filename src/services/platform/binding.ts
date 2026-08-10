/**
 * 跨平台身份绑定服务（docs/179）。
 *
 * 核心用途：同一用户希望把 QQ 与 Telegram 两个平台身份关联到同一个 users.id，
 * 从而在任一平台参与的卡密都能通过统一 Web 链接查看。
 *
 * 流程：
 * 1. 用户在「第一平台」执行 /绑定 → 生成 6 位绑定码，存储 pending binding
 * 2. 用户在「第二平台」执行 /绑定 <code> → 验证码并完成关联
 * 3. 合并只重写 auth_identities.userId，不迁移 lottery_entries（保持存量约束）
 *
 * 并发安全：
 * - 绑定码 UNIQUE 约束 + CAS used=0 条件，防并发重复消费
 * - 更新 auth_identities.userId 时，若目标 userId 已存在 identity 则跳过（防重复合并）
 */
import { and, eq } from "drizzle-orm";
import type { DbType } from "../../db/client";
import { authIdentities, platformBindings, users } from "../../db/schema";

/** 绑定码生成结果 */
export type BindingCodeResult = {
  code: string;
  expiresAt: string;
};

/** 绑定消费结果 */
export type BindingConsumeResult =
  | { ok: true; merged: boolean }
  | { ok: false; reason: string };

/** 绑定码字符集（排除易混淆字符：O/0, I/1/L, 8/B） */
const BINDING_CODE_CHARS = "ACDEFGHJKMNPQRTUVWXYZ2345679";
const BINDING_CODE_LENGTH = 6;
const BINDING_CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 生成 6 位绑定码。
 * 使用高熵字符集（排除易混淆字符），36^6 ≈ 2.2B 种组合，10 分钟有效期。
 */
function generateCode(): string {
  let code = "";
  for (let i = 0; i < BINDING_CODE_LENGTH; i++) {
    const idx = Math.floor(Math.random() * BINDING_CODE_CHARS.length);
    code += BINDING_CODE_CHARS[idx];
  }
  return code;
}

/**
 * 生成绑定码（第一阶段：/绑定 无参数时调用）。
 *
 * @param db 数据库实例
 * @param sourceProvider 发起平台（qq / telegram）
 * @param sourceProviderUserId 发起方平台用户 ID
 * @param sourceUserId 发起方关联的 users.id
 * @returns 绑定码和过期时间
 */
export async function generateBindingCode(
  db: DbType,
  sourceProvider: string,
  sourceProviderUserId: string,
  sourceUserId: string,
): Promise<BindingCodeResult> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + BINDING_CODE_EXPIRY_MS).toISOString();

  await db.insert(platformBindings).values({
    id: crypto.randomUUID(),
    code,
    sourceProvider,
    sourceProviderUserId,
    sourceUserId,
    expiresAt,
    used: 0,
  });

  return { code, expiresAt };
}

/**
 * 消费绑定码（第二阶段：/绑定 <code> 时调用）。
 *
 * 验证规则：
 * 1. 绑定码必须存在且未使用
 * 2. 绑定码未过期
 * 3. 当前用户不能与发起方使用同一平台（不能 QQ 绑定 QQ）
 * 4. 当前用户不能与发起方是同一用户（已在同一 users.id 下）
 *
 * 合并逻辑：
 * - 将当前用户的 auth_identities(provider, providerUserId) 的 userId 重写为发起方的 userId
 * - 如果当前用户没有其他身份，可选删除孤儿用户行
 *
 * @param db 数据库实例
 * @param code 绑定码
 * @param targetProvider 当前用户平台（qq / telegram）
 * @param targetProviderUserId 当前用户平台用户 ID
 * @param targetUserId 当前用户关联的 users.id
 */
export async function consumeBindingCode(
  db: DbType,
  code: string,
  targetProvider: string,
  targetProviderUserId: string,
  targetUserId: string,
): Promise<BindingConsumeResult> {
  // 1. 查找有效的绑定码
  const [binding] = await db
    .select()
    .from(platformBindings)
    .where(and(
      eq(platformBindings.code, code),
      eq(platformBindings.used, 0),
    ))
    .limit(1);

  if (!binding) {
    return { ok: false, reason: "绑定码无效或已过期，请重新发送 /绑定 获取新的绑定码。" };
  }

  // 2. 检查过期
  if (new Date(binding.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: "绑定码已过期，请重新发送 /绑定 获取新的绑定码。" };
  }

  // 3. 禁止同一平台自我绑定
  if (binding.sourceProvider === targetProvider) {
    return { ok: false, reason: "绑定码只能在两个不同平台之间使用（如 QQ ↔ Telegram）。" };
  }

  // 4. 检查是否已指向同一用户（已在同一 users.id 下）
  if (binding.sourceUserId === targetUserId) {
    // 标记已使用（避免重复消费）
    await db
      .update(platformBindings)
      .set({ used: 1 })
      .where(and(
        eq(platformBindings.id, binding.id),
        eq(platformBindings.used, 0),
      ));
    return { ok: true, merged: false };
  }

  // 5. 检查当前用户的 identity 是否已存在（防重复合并）
  const [existingIdentity] = await db
    .select()
    .from(authIdentities)
    .where(and(
      eq(authIdentities.userId, binding.sourceUserId),
      eq(authIdentities.provider, targetProvider),
      eq(authIdentities.providerUserId, targetProviderUserId),
    ))
    .limit(1);

  if (existingIdentity) {
    // 当前用户的 identity 已指向目标用户，无需重复合并
    await db
      .update(platformBindings)
      .set({ used: 1 })
      .where(and(
        eq(platformBindings.id, binding.id),
        eq(platformBindings.used, 0),
      ));
    return { ok: true, merged: false };
  }

  // 6. CAS 式标记绑定码已使用（防并发重复消费）
  const updated = await db
    .update(platformBindings)
    .set({ used: 1 })
    .where(and(
      eq(platformBindings.id, binding.id),
      eq(platformBindings.used, 0),
    ))
    .returning({ id: platformBindings.id });

  if (updated.length === 0) {
    return { ok: false, reason: "绑定码已被使用，请重新发送 /绑定 获取新的绑定码。" };
  }

  // 7. 执行合并：将当前用户的 auth_identities.userId 重写为发起方的 userId
  await db
    .update(authIdentities)
    .set({ userId: binding.sourceUserId })
    .where(and(
      eq(authIdentities.provider, targetProvider),
      eq(authIdentities.providerUserId, targetProviderUserId),
    ));

  // 8. 尝试清理孤儿用户行（当前用户原 users.id）
  // 注意：不清理 lottery_entries 等关联数据，保持存量约束。
  // 若原用户有关联数据删除失败，忽略（不影响合并结果）。
  try {
    await db.delete(users).where(eq(users.id, targetUserId));
  } catch {
    // 可能有关联数据，删除失败忽略
  }

  return { ok: true, merged: true };
}

/**
 * 解析命令文本中的绑定码。
 * 支持格式：/绑定 XXXXXX 或 绑定 XXXXXX
 */
export function parseBindingCode(text: string): string | null {
  const trimmed = text.trim();
  // 匹配 /绑定 或 绑定 后面的连续大写字母数字
  const match = trimmed.match(/^\/?绑定\s*([A-Z0-9]+)$/i);
  if (!match) return null;
  const code = match[1].toUpperCase();
  // 有效绑定码为 6 位
  if (code.length !== BINDING_CODE_LENGTH) return null;
  return code;
}

/**
 * 判断是否为 /绑定 命令（无参数，生成绑定码）。
 */
export function isBindingCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "/绑定" || trimmed === "绑定";
}