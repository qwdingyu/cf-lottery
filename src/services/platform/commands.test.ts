/**
 * 平台内置命令服务测试（docs/167）。
 *
 * 覆盖 executeSpinCommand 和 executeMyPrizeCommand：
 * - spin：instant 活动可自动参与后抽奖、非 instant 活动提示、活动不存在、卡密脱敏
 * - my_prize：有奖品摘要、无奖品、未参与、卡密脱敏
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTestData, getTestDb } from "../../test-setup";
import { and, eq } from "drizzle-orm";
import {
  lotteryDraws,
  lotteryEntries,
  lotteryWinners,
  lotteryPrizeTiers,
  prizes,
  prizeCodes,
  platformTargets,
  tenants,
  lotterySpins,
} from "../../db/schema";
import type { DbType } from "../../db/client";
import type { Client } from "@libsql/client";
import { executeBuiltinPlatformCommand } from "./commands";
import type { ExecuteBuiltinCommandInput, BuiltinCommandConfig } from "./types";

let db: DbType;
let client: Client;

const TENANT_ID = "tenant-cmd-test";
const DRAW_ID = "draw-cmd-test";
const PLATFORM_TARGET_ID = "pt-cmd-test";
const GROUP_ID = "123456";
const USER_ID = "998877";

const DEFAULT_BUILTIN_COMMANDS: BuiltinCommandConfig = {
  checkinEnabled: true,
  spinEnabled: true,
  shareEnabled: true,
  leaderboardEnabled: true,
  myPrizeEnabled: true,
  helpEnabled: true,
};

function makeInput(overrides?: Partial<ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig }>): ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig } {
  return {
    tenantId: TENANT_ID,
    platformTargetId: PLATFORM_TARGET_ID,
    drawId: DRAW_ID,
    publicSlug: "cmd-test-slug",
    command: "spin",
    builtinCommands: DEFAULT_BUILTIN_COMMANDS,
    user: { identityType: "qq", identityValue: USER_ID, displayName: "测试用户" },
    source: { platform: "qq", groupId: GROUP_ID },
    ...overrides,
  } as ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig };
}

beforeAll(async () => {
  const ctx = await getTestDb();
  db = ctx.db;
  client = ctx.client;
});

beforeEach(async () => {
  await clearTestData(client);
  await db.insert(tenants).values({ id: TENANT_ID, name: "命令测试租户" });
  await db.insert(platformTargets).values({
    id: PLATFORM_TARGET_ID,
    tenantId: TENANT_ID,
    platform: "qq",
    targetId: GROUP_ID,
    targetName: "测试群",
    activeDrawId: DRAW_ID,
    activePublicSlug: "cmd-test-slug",
    assistantEnabled: 1,
    adapterDeploymentMode: "tenant_hosted",
    adapterProvider: "napcat",
    adapterConfigJson: "{}",
    inboundSecretHash: "",
    builtinCommandsJson: "{}",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

/** 播种一个 instant 即时抽奖活动 */
async function seedInstantDraw() {
  const now = new Date();
  await db.insert(lotteryDraws).values({
    id: DRAW_ID,
    tenantId: TENANT_ID,
    publicSlug: "cmd-test-slug",
    title: "即时抽奖测试",
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    resultMode: "instant",
    startAt: new Date(now.getTime() - 3600_000).toISOString(),
    endAt: new Date(now.getTime() + 86400_000 * 7).toISOString(),
    maxSpinsPerEntry: 5,
  });

  const prizeId = crypto.randomUUID();
  await db.insert(prizes).values({
    id: prizeId,
    tenantId: TENANT_ID,
    name: "测试奖品",
    prizeType: "code",
    totalCount: 10,
    active: 1,
  });

  const tierId = crypto.randomUUID();
  await db.insert(lotteryPrizeTiers).values({
    id: tierId,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    prizeId,
    tierName: "一等奖",
    winnerCount: 5,
    sortOrder: 100,
    weight: 100,
  });

  for (let i = 0; i < 5; i++) {
    await db.insert(prizeCodes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT_ID,
      prizeId,
      code: `CMD-CODE-${i}`,
      secret: `SEC-${i}`,
      status: "available",
    });
  }

  return { prizeId, tierId };
}

/** 播种一个非 instant 活动（如 manual 手动开奖） */
async function seedManualDraw() {
  const now = new Date();
  await db.insert(lotteryDraws).values({
    id: DRAW_ID,
    tenantId: TENANT_ID,
    publicSlug: "cmd-test-slug",
    title: "手动开奖测试",
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "submit",
    resultMode: "manual",
    startAt: new Date(now.getTime() - 3600_000).toISOString(),
    endAt: new Date(now.getTime() + 86400_000 * 7).toISOString(),
  });
}

/** 播种一个 instant 但非 lottery 的活动，验证 /抽奖 不会误接入其他玩法 */
async function seedInstantNonLotteryDraw() {
  const now = new Date();
  await db.insert(lotteryDraws).values({
    id: DRAW_ID,
    tenantId: TENANT_ID,
    publicSlug: "cmd-test-slug",
    title: "即时非抽奖活动测试",
    status: "open",
    activityKind: "vote",
    participationMode: "open",
    experienceType: "submit",
    resultMode: "instant",
    startAt: new Date(now.getTime() - 3600_000).toISOString(),
    endAt: new Date(now.getTime() + 86400_000 * 7).toISOString(),
  });
}

/** 让用户加入活动（获得 entry） */
async function ensureEntry() {
  await db.insert(lotteryEntries).values({
    id: crypto.randomUUID(),
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    identityType: "qq",
    identityValue: USER_ID,
    displayName: "测试用户",
    joinedAt: new Date().toISOString(),
    spinsLeft: 5,
    spinsTotalGranted: 5,
  });
}

/**
 * 给用户直接插入一条完整的中奖记录（spin+winner+prize+codes）。
 * - 传入 entryId 时复用已有参与记录（多奖品场景），否则新建一条。
 * - 通过 opts 定制奖项名/卡密/排序，避免在测试体里重复拼 SQL。
 */
async function seedWinner(opts?: {
  prizeName?: string;
  tierName?: string;
  code?: string;
  secret?: string;
  sortOrder?: number;
  entryId?: string;
}): Promise<{ entryId: string; codeId: string; tierId: string }> {
  const prizeId = crypto.randomUUID();
  await db.insert(prizes).values({
    id: prizeId,
    tenantId: TENANT_ID,
    name: opts?.prizeName || "测试奖品",
    prizeType: "code",
    totalCount: 1,
    active: 1,
  });

  const tierId = crypto.randomUUID();
  await db.insert(lotteryPrizeTiers).values({
    id: tierId,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    prizeId,
    tierName: opts?.tierName || "一等奖",
    winnerCount: 1,
    sortOrder: opts?.sortOrder ?? 100,
    weight: 100,
  });

  const codeId = crypto.randomUUID();
  await db.insert(prizeCodes).values({
    id: codeId,
    tenantId: TENANT_ID,
    prizeId,
    code: opts?.code || "WIN-CODE-1",
    secret: opts?.secret || "WIN-SEC-1",
    status: "issued",
    issuedAt: new Date().toISOString(),
  });

  // 复用已有 entry 或新插入一条
  let entryId = opts?.entryId || "";
  if (!entryId) {
    entryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: entryId,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "qq",
      identityValue: USER_ID,
      displayName: "测试用户",
      joinedAt: new Date().toISOString(),
      spinsLeft: 0,
      spinsTotalGranted: 5,
    });
  }

  const spinId = crypto.randomUUID();
  await db.insert(lotterySpins).values({
    id: spinId,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    entryId,
    tierId,
    idempotencyKey: `seed-${spinId}`,
    prizeCodeId: codeId,
    prizeIndex: 0,
    won: 1,
    algorithmVersion: "1",
    createdAt: new Date().toISOString(),
  });

  await db.insert(lotteryWinners).values({
    id: crypto.randomUUID(),
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    tierId,
    entryId,
    spinId,
    identityType: "qq",
    identityValue: USER_ID,
    prizeCodeId: codeId,
    drawnAt: new Date().toISOString(),
    notificationStatus: "pending",
  });

  return { entryId, codeId, tierId };
}

// ── /抽奖 测试 ──

describe("/抽奖 (executeSpinCommand)", () => {
  it("活动不存在时返回提示消息", async () => {
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "spin" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("绑定活动不存在");
  });

  it("非 instant 活动时提示不可抽奖", async () => {
    await seedManualDraw();
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "spin" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("不是即时抽奖模式");
  });

  it("instant 但非 lottery 活动时提示绑定即时抽奖活动", async () => {
    await seedInstantNonLotteryDraw();
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "spin" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("不是抽奖活动");
  });

  it("instant 活动未参与时自动创建 QQ 参与记录并抽奖", async () => {
    await seedInstantDraw();
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "spin" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("恭喜");

    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.tenantId, TENANT_ID),
        eq(lotteryEntries.drawId, DRAW_ID),
        eq(lotteryEntries.identityType, "qq"),
        eq(lotteryEntries.identityValue, USER_ID),
      ));
    expect(entries).toHaveLength(1);
  });

  it("instant 活动已参与可抽奖并返回结果", async () => {
    await seedInstantDraw();
    await ensureEntry();

    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "spin" }));
    expect(result.handled).toBe(true);
    // weight=100 + 有 available 码，应中奖
    expect(result.reply).toContain("恭喜");
    expect(result.reply).not.toContain("CMD-CODE-");
    expect(result.reply).not.toContain("SEC-");
  });

  it("命令关闭时返回禁用提示", async () => {
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "spin",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, spinEnabled: false },
    }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("未启用");
  });
});
// ── /我的奖品 测试 ──

describe("/我的奖品 (executeMyPrizeCommand)", () => {
  it("未参与活动时提示先参与", async () => {
    await seedInstantDraw();
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "my_prize" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("还未参与");
  });

  it("已参与但无奖品时提示暂无奖品", async () => {
    await seedInstantDraw();
    await ensureEntry();
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "my_prize" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("还没有获得奖品");
  });

  it("有奖品时返回奖品摘要且不展示卡密", async () => {
    await seedInstantDraw();
    await seedWinner({ prizeName: "测试奖品", code: "WIN-CODE-1", secret: "WIN-SEC-1" });

    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "my_prize" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("测试奖品");
    expect(result.reply).not.toContain("WIN-CODE-1");
    expect(result.reply).not.toContain("WIN-SEC-1");
    expect(result.reply).toContain("群内不展示");
    expect(result.reply).toContain("共 1 件");
  });

  it("有多个奖品时返回完整列表", async () => {
    await seedInstantDraw();
    // 第一个奖品会新建 entry，第二个复用同一 entry 模拟同一用户多件中奖
    const first = await seedWinner({ prizeName: "二等奖", code: "WIN-CODE-2", secret: "WIN-SEC-2" });
    await seedWinner({
      prizeName: "三等奖",
      tierName: "三等奖",
      code: "WIN-CODE-3",
      secret: "WIN-SEC-3",
      sortOrder: 200,
      entryId: first.entryId,
    });

    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "my_prize" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("二等奖");
    expect(result.reply).toContain("三等奖");
    expect(result.reply).not.toContain("WIN-CODE-2");
    expect(result.reply).not.toContain("WIN-SEC-2");
    expect(result.reply).not.toContain("WIN-CODE-3");
    expect(result.reply).not.toContain("WIN-SEC-3");
    expect(result.reply).toContain("共 2 件");
  });

  it("命令关闭时返回禁用提示", async () => {
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "my_prize",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, myPrizeEnabled: false },
    }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("未启用");
  });
});
