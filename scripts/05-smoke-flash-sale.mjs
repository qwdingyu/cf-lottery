import "dotenv/config";
import { createClient } from "@libsql/client";
import { randomUUID, webcrypto as nodeCrypto } from "node:crypto";

/**
 * 秒杀创建烟测脚本
 *
 * 目标：
 * 1. 以真实 API 创建一个秒杀草稿
 * 2. 配置阶梯价与卡密奖品池
 * 3. 跑发布前检查，确认「秒杀配置 + 阶梯价 + 卡密闭环」在支付前可用
 *
 * 默认不启用 paymentRequired，避免把支付配置测试提前引入。
 *
 * 用法：
 *   ADMIN_PASS='...' node scripts/05-smoke-flash-sale.mjs
 *
 * 环境变量：
 *   BASE_URL                    — API 地址，默认 http://localhost:8787
 *   ADMIN_USER                  — 登录用户名，默认 admin
 *   ADMIN_PASS                  — 登录密码，必填
 *   FLASH_SALE_PAYMENT_REQUIRED — 是否顺便测直付支付前提，默认 false
 *   FLASH_SALE_DESTINATION_URL  — 秒杀导流链接，默认 https://example.com/flash-sale
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const PAYMENT_REQUIRED = ["1", "true", "yes"].includes(String(process.env.FLASH_SALE_PAYMENT_REQUIRED || "").toLowerCase());
const DESTINATION_URL = process.env.FLASH_SALE_DESTINATION_URL || "https://example.com/flash-sale";
const DB_URL = process.env.DATABASE_URL || process.env.TURSO_URL || "file:./data/lottery.db";
const LOCAL_BOOTSTRAP_ALLOWED = isLocalBaseUrl(BASE_URL) && DB_URL.startsWith("file:");

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
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { ok: false, message: text };
  }
  if (!res.ok || !data?.ok) {
    const message = data?.message || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

function futureIso(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function isLocalBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, pepper) {
  const encoder = new TextEncoder();
  const salt = nodeCrypto.getRandomValues(new Uint8Array(16));
  const payload = new Uint8Array(salt.length + encoder.encode(password).length);
  payload.set(salt);
  payload.set(encoder.encode(password), salt.length);
  const key = await nodeCrypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await nodeCrypto.subtle.sign("HMAC", key, payload);
  return `hmac_sha256_v1:${hex(salt)}:${hex(new Uint8Array(mac))}`;
}

async function bootstrapLocalUser(username, email, password) {
  const client = createClient({ url: DB_URL, authToken: process.env.TURSO_TOKEN });
  try {
    const pepper = process.env.PASSWORD_PEPPER || process.env.JWT_SECRET;
    if (!pepper || String(pepper).length < 16) {
      throw new Error("本地 bootstrap 需要 PASSWORD_PEPPER 或 JWT_SECRET");
    }
    const passwordHash = await hashPassword(password, pepper);
    const now = new Date().toISOString();
    await client.execute({
      sql: `
        INSERT INTO users (id, username, email, email_verified, password_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, 'active', ?, ?)
        ON CONFLICT(username) DO UPDATE SET
          email = excluded.email,
          email_verified = 1,
          password_hash = excluded.password_hash,
          status = 'active',
          updated_at = excluded.updated_at
      `,
      args: [randomUUID(), username, email, passwordHash, now, now],
    });
  } finally {
    await client.close();
  }
}

async function loginOrBootstrap() {
  const loginUsername = ADMIN_USER;
  const loginPassword = ADMIN_PASS || `Smoke${Date.now()}A1!`;
  try {
    const login = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: loginUsername, password: loginPassword }),
    });
    return { token: login.token, username: loginUsername, password: loginPassword, bootstrapped: false };
  } catch (err) {
    if (!LOCAL_BOOTSTRAP_ALLOWED) throw err;
    const bootstrapUsername = loginUsername || `smoke_${Date.now()}`;
    const bootstrapEmail = `${bootstrapUsername}@example.com`;
    await bootstrapLocalUser(bootstrapUsername, bootstrapEmail, loginPassword);
    const login = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: bootstrapUsername, password: loginPassword }),
    });
    return { token: login.token, username: bootstrapUsername, password: loginPassword, bootstrapped: true };
  }
}

async function main() {
  console.log(`\n🚀 cf-lottery 秒杀烟测\n`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Payment required: ${PAYMENT_REQUIRED ? "yes" : "no"}`);
  console.log(`Local bootstrap: ${LOCAL_BOOTSTRAP_ALLOWED ? "yes" : "no"}`);
  console.log(`\n`);

  await smoke("GET /api/health", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Health check failed: ${JSON.stringify(data)}`);
  });

  console.log("\n📋 认证与租户");
  const login = await loginOrBootstrap();
  let authToken = login.token;
  if (!authToken) throw new Error("登录未返回 token");
  if (login.bootstrapped) {
    console.log(`    已在本地库 bootstrap 用户：${login.username}`);
  }

  const tenantName = `秒杀烟测-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  await smoke("POST /api/auth/create-tenant", async () => {
    const created = await request("/api/auth/create-tenant", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ name: tenantName }),
    });
    authToken = created.token;
    if (!created.tenantId) throw new Error("未返回 tenantId");
  });

  const headers = { Authorization: `Bearer ${authToken}` };
  await smoke("GET /api/admin/me", async () => {
    const me = await request("/api/admin/me", { headers });
    if (!me.tenant?.id) throw new Error("未能读取租户上下文");
  });

  console.log("\n📋 创建秒杀草稿");
  const drawTitle = `秒杀烟测-${Date.now()}`;
  const drawRes = await request("/api/admin/draws", {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: drawTitle,
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "flash_sale",
      drawTrigger: "manual",
      resultMode: "manual",
      startAt: futureIso(30),
      endAt: futureIso(120),
      winnerCount: 1,
      maxParticipants: 10,
      promotionConfig: {
        destination: {
          title: "去看看",
          url: DESTINATION_URL,
        },
        flashSale: {
          enabled: true,
          sessionLabel: "10:00场",
          stockLimit: 10,
          maxPerUser: 5,
          showCountdown: true,
          showProgress: true,
          showStock: true,
          ctaLabel: "抢",
          paymentRequired: PAYMENT_REQUIRED,
          priceCents: 9900,
          currency: "cny",
          title: "秒杀烟测商品",
          pricingTiers: [
            { minQuantity: 1, unitPriceCents: 9900, label: "1件" },
            { minQuantity: 3, unitPriceCents: 8900, label: "3件" },
          ],
        },
      },
    }),
  });
  const drawId = drawRes.id;
  const publicSlug = drawRes.publicSlug;
  if (!drawId || !publicSlug) throw new Error("创建活动未返回 id/publicSlug");

  let prizeId = "";
  await smoke("POST /api/admin/prizes", async () => {
    const prize = await request("/api/admin/prizes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "秒杀码池",
        prizeType: "code",
        description: "秒杀烟测用卡密奖品",
      }),
    });
    prizeId = prize.id;
    if (!prizeId) throw new Error("未返回 prizeId");
  });

  await smoke("POST /api/admin/prizes/:id/codes/import", async () => {
    const codes = Array.from({ length: 3 }, (_, i) => ({
      code: `FLASHSALE-${Date.now()}-${i + 1}`,
      secret: `secret-${i + 1}`,
    }));
    await request(`/api/admin/prizes/${prizeId}/codes/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({ codes }),
    });
  });

  await smoke("POST /api/admin/draws/:id/tiers", async () => {
    await request(`/api/admin/draws/${drawId}/tiers`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tiers: [
          {
            prizeId,
            tierName: "秒杀码",
            winnerCount: 1,
            sortOrder: 100,
            weight: 1,
          },
        ],
      }),
    });
  });

  console.log("\n📋 发布前检查");
  await smoke("GET /api/admin/draws/:id/publish-check", async () => {
    const check = await request(`/api/admin/draws/${drawId}/publish-check`, { headers });
    const errors = Array.isArray(check.errors) ? check.errors : [];
    const warnings = Array.isArray(check.warnings) ? check.warnings : [];
    if (warnings.length > 0) {
      console.log("    warnings:", warnings.map((item) => `${item.section}:${item.code}`).join(", "));
    }
    if (errors.length > 0) {
      throw new Error(errors.map((item) => `${item.section}:${item.code}`).join(", "));
    }
  });

  await smoke("GET /api/admin/draws/:id", async () => {
    const detail = await request(`/api/admin/draws/${drawId}`, { headers });
    if (!detail.draw || !Array.isArray(detail.tiers) || detail.tiers.length !== 1) {
      throw new Error("活动详情未包含期望的奖项配置");
    }
  });

  console.log("\n📋 结果");
  console.log(`活动ID: ${drawId}`);
  console.log(`公开标识: ${publicSlug}`);
  console.log(`租户名称: ${tenantName}`);
  console.log(`\n${"═".repeat(40)}`);
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  console.log(`${"═".repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n❌ 测试异常: ${err.message}`);
  process.exit(1);
});
