#!/usr/bin/env node
/**
 * 初始化首个平台运营者。
 *
 * 用法：
 *   node scripts/bootstrap-platform-owner.mjs --email owner@example.com
 *   node scripts/bootstrap-platform-owner.mjs --email owner@example.com --role platform_operator
 *
 * 设计原则：
 * - 不提供公开 bootstrap API，避免生产环境遗留高危入口。
 * - 用户必须先通过正常注册流程存在于 users 表，再由本脚本授予平台角色。
 * - 平台角色只写 platform_members，不创建 tenant_id=NULL 或 __platform__ 特殊租户。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

const ALLOWED_ROLES = new Set(["platform_owner", "platform_operator", "platform_support"]);

function loadDotEnv() {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function usage(message) {
  if (message) console.error(`[bootstrap-platform-owner] ${message}`);
  console.error("用法：node scripts/bootstrap-platform-owner.mjs --email owner@example.com [--role platform_owner]");
  process.exit(1);
}

loadDotEnv();

const email = argValue("email").trim().toLowerCase();
const role = (argValue("role").trim() || "platform_owner");

if (!email || !email.includes("@")) usage("请提供有效邮箱");
if (!ALLOWED_ROLES.has(role)) usage(`平台角色无效：${role}`);
if (!process.env.TURSO_URL) usage("缺少 TURSO_URL");

const client = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

try {
  const userResult = await client.execute({
    sql: "SELECT id, email FROM users WHERE lower(email) = ? LIMIT 1",
    args: [email],
  });
  const user = userResult.rows[0];
  if (!user?.id) {
    usage(`未找到邮箱为 ${email} 的用户。请先通过正常注册流程创建账号。`);
  }

  const now = new Date().toISOString();
  await client.execute({
    sql: `
      INSERT INTO platform_members (user_id, role, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        role = excluded.role,
        status = 'active',
        updated_at = excluded.updated_at
    `,
    args: [String(user.id), role, now, now],
  });

  console.log(`[bootstrap-platform-owner] 已授予平台角色：${email} -> ${role}`);
} finally {
  await client.close();
}
