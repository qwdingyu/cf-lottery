/**
 * 回填存量用户的邀请码（docs/272）。
 *
 * 功能：
 * 1. 查询所有 invite_code IS NULL 的用户
 * 2. 为每个用户生成 8 位邀请码（与 generateUserInviteCode() 同逻辑）
 * 3. 逐条 UPDATE 并重试 UNIQUE 碰撞（31^8 ≈ 8.5×10^11，碰撞概率极低）
 * 4. 输出统计：成功/失败/跳过数量
 *
 * 使用方式：
 *   npm run db:backfill-invite-codes          # 仅预览（dry-run）
 *   npm run db:backfill-invite-codes -- --apply # 实际写入
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ── 加载 .env ──
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

// ── 与 generateUserInviteCode() 完全一致的字符集 ──
// 排除了易混淆字符：I/L/O/0/1
const INVITE_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

/** 生成一个 8 位邀请码（纯伪随机，与服务层逻辑一致） */
function generateCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => INVITE_CODE_CHARS[b % INVITE_CODE_CHARS.length]).join("");
}

// ── 数据库连接 ──
const url = process.env.TURSO_URL;
const token = process.env.TURSO_TOKEN;

if (!url) {
  console.error("[backfill] 缺少 TURSO_URL，请在 .env 中配置");
  process.exit(1);
}

const isLocal = url.startsWith("file:");
if (!isLocal && !token) {
  console.error("[backfill] 远程数据库需要 TURSO_TOKEN，请在 .env 中配置");
  process.exit(1);
}

const client = createClient(isLocal ? { url } : { url, authToken: token });

// ── 命令行参数 ──
const args = process.argv.slice(2);
const dryRun = !args.includes("--apply");

async function main() {
  if (dryRun) {
    console.log("🔍 [dry-run] 仅预览，不写入数据库。添加 --apply 参数实际执行。\n");
  }

  // 0. 迁移预检：确认 invite_code 列存在（未运行 0067 迁移会报错）
  try {
    await client.execute("SELECT invite_code FROM users LIMIT 1");
  } catch {
    console.error("[backfill] ❌ users 表缺少 invite_code 列，请先运行数据库迁移 (npm run db:migrate)");
    process.exit(1);
  }

  // 1. 查询需要回填的用户
  const result = await client.execute(
    "SELECT id, email FROM users WHERE invite_code IS NULL ORDER BY created_at ASC"
  );
  const users = result.rows;

  if (users.length === 0) {
    console.log("✅ 所有用户已有邀请码，无需回填。");
    process.exit(0);
  }

  console.log(`📋 找到 ${users.length} 个需要回填邀请码的用户\n`);

  let successCount = 0;
  let failCount = 0;
  const codeSet = new Set(); // 用于进程内去重

  for (const user of users) {
    let code = null;
    let retries = 5;
    let lastError = null;

    while (retries > 0) {
      code = generateCode();

      // 进程内去重：先检查本轮已生成的码
      if (codeSet.has(code)) {
        retries--;
        continue;
      }

      if (dryRun) {
        // dry-run 模式：只记录不写入
        codeSet.add(code);
        console.log(`  [dry-run] ${user.email} → ${code}`);
        successCount++;
        break;
      }

      // 实际写入模式：UPDATE 并捕获 UNIQUE 碰撞
      try {
        await client.execute({
          sql: "UPDATE users SET invite_code = ? WHERE id = ? AND invite_code IS NULL",
          args: [code, user.id],
        });
        codeSet.add(code);
        console.log(`  ✓ ${user.email} → ${code}`);
        successCount++;
        break;
      } catch (err) {
        lastError = err;
        retries--;
        // UNIQUE 碰撞时重试，其他错误直接终止
        const msg = String(err.message || err);
        if (!msg.includes("UNIQUE") && !msg.includes("unique")) {
          console.error(`  ✗ ${user.email}: ${msg}`);
          failCount++;
          lastError = null;
          break;
        }
      }
    }

    if (lastError) {
      console.error(`  ✗ ${user.email}: 重试耗尽 (${lastError.message})`);
      failCount++;
    }
  }

  console.log(`\n📊 回填完成：成功 ${successCount}，失败 ${failCount}，总计 ${users.length}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill] 致命错误:", err);
  process.exit(1);
});
