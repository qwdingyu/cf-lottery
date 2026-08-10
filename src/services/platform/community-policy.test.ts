/**
 * 社群功能策略服务测试（docs/180）。
 *
 * 覆盖：
 * 1. getTenantCommunityPolicy — 套餐默认 + 租户覆写合并
 * 2. canTenantCreatePlatformTarget — 群绑定数上限（POST/PUT 拦增量）
 * 3. enforceGroupMemberCap — 运行时强制群人数上限
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTestData, getTestDb } from "../../test-setup";
import { and, eq } from "drizzle-orm";
import { tenantCommunityOverrides, communityMembers } from "../../db/schema";
import type { DbType } from "../../db/client";
import type { Client } from "@libsql/client";
import {
  getTenantCommunityPolicy,
  canTenantCreatePlatformTarget,
  enforceGroupMemberCap,
} from "./community-policy";

let db: DbType;
let client: Client;

const TENANT = "tenant-community-test";
const TARGET_A = "pt-community-a";

beforeAll(async () => {
  const ctx = await getTestDb();
  db = ctx.db;
  client = ctx.client;
});

beforeEach(async () => {
  await clearTestData(client);
  // 测试租户：默认 free 套餐（1 群 × 200 人）
  const now = new Date().toISOString();
  await client.execute({
    sql: "INSERT INTO tenants (id, name, plan, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [TENANT, "配额测试租户", "free", "active", now, now],
  });
});

async function insertTarget(id: string, tenantId: string): Promise<void> {
  const now = new Date().toISOString();
  await client.execute({
    sql: "INSERT INTO platform_targets (id, tenant_id, platform, target_id, target_name, active_draw_id, active_public_slug, assistant_enabled, adapter_deployment_mode, adapter_provider, adapter_config_json, inbound_secret_hash, builtin_commands_json, created_at, updated_at) VALUES (?, ?, 'qq', ?, '', 'draw-test', 'slug-test', 1, 'tenant_hosted', 'napcat', '{}', '', '{}', ?, ?)",
    args: [id, tenantId, id, now, now],
  });
}

describe("getTenantCommunityPolicy", () => {
  it("无覆写 → 返回套餐默认 + source=plan", async () => {
    const policy = await getTenantCommunityPolicy(db, TENANT);
    expect(policy.source).toBe("plan");
    expect(policy.communityEnabled).toBe(true);
    expect(policy.maxPlatformTargets).toBe(1);
    expect(policy.maxGroupMembers).toBe(200);
  });

  it("有覆写 → 返回覆写 + source=override", async () => {
    await db.insert(tenantCommunityOverrides).values({
      tenantId: TENANT,
      communityEnabled: 1,
      maxPlatformTargets: 5,
      maxGroupMembers: 1000,
      note: "",
      updatedBy: "actor",
      updatedAt: new Date().toISOString(),
    });
    const policy = await getTenantCommunityPolicy(db, TENANT);
    expect(policy.source).toBe("override");
    expect(policy.maxPlatformTargets).toBe(5);
    expect(policy.maxGroupMembers).toBe(1000);
  });

  it("覆写 communityEnabled=0 → 返回 false（惩罚性关闭）", async () => {
    await db.insert(tenantCommunityOverrides).values({
      tenantId: TENANT,
      communityEnabled: 0,
      maxPlatformTargets: null,
      maxGroupMembers: null,
      note: "",
      updatedBy: "actor",
      updatedAt: new Date().toISOString(),
    });
    const policy = await getTenantCommunityPolicy(db, TENANT);
    expect(policy.communityEnabled).toBe(false);
  });

  it("覆写 maxGroupMembers=null → 返回不限", async () => {
    await db.insert(tenantCommunityOverrides).values({
      tenantId: TENANT,
      communityEnabled: 1,
      maxPlatformTargets: null,
      maxGroupMembers: null,
      note: "",
      updatedBy: "actor",
      updatedAt: new Date().toISOString(),
    });
    const policy = await getTenantCommunityPolicy(db, TENANT);
    expect(policy.maxPlatformTargets).toBeNull();
    expect(policy.maxGroupMembers).toBeNull();
  });
describe("canTenantCreatePlatformTarget", () => {
  it("free 套餐最多 1 个群，绑满后拒绝新增", async () => {
    // 未绑定时，允许创建第 1 个
    const first = await canTenantCreatePlatformTarget(db, TENANT);
    expect(first.ok).toBe(true);

    await insertTarget(TARGET_A, TENANT);

    // 已绑定 1 个群，达到 free 上限，拒绝第 2 个
    const second = await canTenantCreatePlatformTarget(db, TENANT);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toContain("最多绑定 1 个群");
  });

  it("覆写扩大群数上限后放行", async () => {
    await insertTarget(TARGET_A, TENANT);
    await db.insert(tenantCommunityOverrides).values({
      tenantId: TENANT,
      communityEnabled: 1,
      maxPlatformTargets: 3,
      maxGroupMembers: 200,
      note: "",
      updatedBy: "actor",
      updatedAt: new Date().toISOString(),
    });
    const result = await canTenantCreatePlatformTarget(db, TENANT);
    expect(result.ok).toBe(true);
  });

  it("覆写关闭社群功能后拒绝新增", async () => {
    await db.insert(tenantCommunityOverrides).values({
      tenantId: TENANT,
      communityEnabled: 0,
      maxPlatformTargets: null,
      maxGroupMembers: null,
      note: "",
      updatedBy: "actor",
      updatedAt: new Date().toISOString(),
    });
    const result = await canTenantCreatePlatformTarget(db, TENANT);
    expect(result.ok).toBe(false);
  });

  it("enterprise 不限群数，始终放行", async () => {
    await client.execute({ sql: "UPDATE tenants SET plan = ? WHERE id = ?", args: ["enterprise", TENANT] });
    for (let i = 0; i < 5; i++) {
      const result = await canTenantCreatePlatformTarget(db, TENANT);
      expect(result.ok).toBe(true);
    }
  });
});

describe("enforceGroupMemberCap", () => {
  it("userId 为空 → 放行（provisioning 降级）", async () => {
    const result = await enforceGroupMemberCap(db, {
      tenantId: TENANT,
      platformTargetId: TARGET_A,
      userId: undefined,
    });
    expect(result.ok).toBe(true);
  });

  it("enterprise 不限人数 → 放行", async () => {
    await client.execute({ sql: "UPDATE tenants SET plan = ? WHERE id = ?", args: ["enterprise", TENANT] });
    const result = await enforceGroupMemberCap(db, {
      tenantId: TENANT,
      platformTargetId: TARGET_A,
      userId: "user-1",
    });
    expect(result.ok).toBe(true);
  });

  it("free 套餐：新成员累计到上限后拒绝", async () => {
    // 预先插入 200 条成员记录，占满 free 上限
    for (let i = 0; i < 200; i++) {
      await db.insert(communityMembers).values({
        id: `cm-${i}`,
        tenantId: TENANT,
        platformTargetId: TARGET_A,
        userId: `user-${i}`,
        identityValue: `user-${i}`,
        createdAt: new Date().toISOString(),
      });
    }
    // 存量成员放行
    const existing = await enforceGroupMemberCap(db, {
      tenantId: TENANT,
      platformTargetId: TARGET_A,
      userId: "user-0",
    });
    expect(existing.ok).toBe(true);

    // 新成员超限拒绝
    const over = await enforceGroupMemberCap(db, {
      tenantId: TENANT,
      platformTargetId: TARGET_A,
      userId: "user-new",
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reply).toContain("200");
  });

  it("free 套餐：未达上限时新成员可加入并注册", async () => {
    const result = await enforceGroupMemberCap(db, {
      tenantId: TENANT,
      platformTargetId: TARGET_A,
      userId: "brand-user",
    });
    expect(result.ok).toBe(true);

    // 确认已注册
    const [row] = await db
      .select({ id: communityMembers.id })
      .from(communityMembers)
      .where(and(
        eq(communityMembers.platformTargetId, TARGET_A),
        eq(communityMembers.userId, "brand-user"),
      ))
      .limit(1);
    expect(row).toBeTruthy();
  });

  it("同群 userId 去重：重复调用只算 1 人", async () => {
    await enforceGroupMemberCap(db, { tenantId: TENANT, platformTargetId: TARGET_A, userId: "dup-user" });
    await enforceGroupMemberCap(db, { tenantId: TENANT, platformTargetId: TARGET_A, userId: "dup-user" });

    const rows = await db
      .select({ id: communityMembers.id })
      .from(communityMembers)
      .where(and(
        eq(communityMembers.platformTargetId, TARGET_A),
        eq(communityMembers.userId, "dup-user"),
      ));
    expect(rows.length).toBe(1);
  });
});
});