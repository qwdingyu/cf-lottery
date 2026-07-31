/**
 * cf-lottery 冒烟测试
 *
 * 验证部署后的 API 是否正常工作。
 * 用法：node scripts/04-smoke-lottery.mjs
 *
 * 环境变量：
 *   BASE_URL     — 部署地址（默认 http://localhost:8787）
 *   ADMIN_USER   — 管理员用户名（默认 admin）
 *   ADMIN_PASS   — 管理员密码（默认 admin1234）
 */
const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin1234";

let passed = 0;
let failed = 0;

async function smoke(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

async function main() {
  console.log(`\n🚀 cf-lottery Smoke Test\n`);
  console.log(`Target: ${BASE_URL}\n`);

  // ── 1. 健康检查 ──
  console.log("📋 健康检查");
  await smoke("GET /api/health", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Health check failed: ${JSON.stringify(data)}`);
  });

  // ── 2. 注册/登录 ──
  console.log("\n📋 认证");
  let authToken = "";
  const testUser = `smoke_${Date.now()}`;
  await smoke("POST /api/auth/register", async () => {
    const data = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: testUser, password: "Test1234" }),
    });
    authToken = data.token;
    if (!authToken) throw new Error("No token returned");
  });

  await smoke("POST /api/auth/login", async () => {
    const data = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: testUser, password: "Test1234" }),
    });
    if (!data.token) throw new Error("No token returned");
    authToken = data.token;
  });

  // ── 3. 管理端 API ──
  console.log("\n📋 管理端 API");
  const headers = { Authorization: `Bearer ${authToken}` };

  await smoke("GET /api/admin/me", async () => {
    await request("/api/admin/me", { headers });
  });

  let drawId = "";
  await smoke("POST /api/admin/draws (创建活动)", async () => {
    const now = new Date();
    const startAt = new Date(now.getTime() + 60000).toISOString();
    const endAt = new Date(now.getTime() + 3600000).toISOString();
    const drawAt = new Date(now.getTime() + 7200000).toISOString();
    const data = await request("/api/admin/draws", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Smoke 测试活动",
        startAt,
        endAt,
        drawAt,
        winnerCount: 3,
      }),
    });
    drawId = data.id;
    if (!drawId) throw new Error("No draw ID returned");
  });

  await smoke("GET /api/admin/draws (活动列表)", async () => {
    const data = await request("/api/admin/draws", { headers });
    if (!Array.isArray(data.draws)) throw new Error("No draws array");
  });

  let prizeId = "";
  await smoke("POST /api/admin/prizes (创建奖品)", async () => {
    const data = await request("/api/admin/prizes", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Smoke 测试奖品" }),
    });
    prizeId = data.id;
  });

  await smoke("POST /api/admin/prizes/:id/codes/import (导入码)", async () => {
    const codes = Array.from({ length: 5 }, (_, i) => ({ code: `SMOKE${i+1}`, secret: `secret${i+1}` }));
    await request(`/api/admin/prizes/${prizeId}/codes/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({ codes }),
    });
  });

  // ── 4. 公开 API ──
  console.log("\n📋 公开 API");
  await smoke("GET /api/health", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    const data = await res.json();
    if (!data.ok) throw new Error("Health check failed");
  });

  // ── 5. 系统配置 ──
  console.log("\n📋 系统配置");
  await smoke("GET /api/system-config", async () => {
    const data = await request("/api/system-config");
    if (!data.config) throw new Error("No config returned");
  });

  await smoke("GET /api/admin/system-config", async () => {
    const data = await request("/api/admin/system-config", { headers });
    if (!data.config) throw new Error("No config returned");
  });

  // ── 结果 ──
  console.log(`\n${'═'.repeat(40)}`);
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  console.log(`${'═'.repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n❌ 测试异常: ${err.message}`);
  process.exit(1);
});