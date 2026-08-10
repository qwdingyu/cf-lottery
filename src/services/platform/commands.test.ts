/**
 * 平台内置命令服务测试（docs/167）。
 *
 * 覆盖 executeSpinCommand 和 executeMyPrizeCommand：
 * - spin：instant 活动可自动参与后抽奖、非 instant 活动提示、活动不存在、卡密脱敏
 * - my_prize：有奖品摘要、无奖品、未参与、卡密脱敏
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTestData, getTestDb } from "../../test-setup";
import { and, eq, sql } from "drizzle-orm";
import {
  activityEvents,
  lotteryDraws,
  lotteryEntries,
  lotteryWinners,
  lotteryPrizeTiers,
  prizes,
  prizeCodes,
  platformTargets,
  tenants,
  lotterySpins,
  spinsLog,
} from "../../db/schema";
import type { DbType } from "../../db/client";
import type { Client } from "@libsql/client";
import { executeBuiltinPlatformCommand, recognizeBuiltinCommand, renderHelpReply } from "./commands";
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
  myCardCodeEnabled: true,
  helpEnabled: true,
  flashEnabled: true,
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
    secret: opts?.secret ?? "WIN-SEC-1",
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
    expect(result.reply).toContain("手动开奖");
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

// ── /我的卡密 测试 ──

describe("/我的卡密 (executeCardCodeCommand)", () => {
  it("未参与活动时提示先参与", async () => {
    await seedInstantDraw();
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "card_code" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("还未参与");
  });

  it("已参与但无卡密奖品时提示无卡密", async () => {
    await seedInstantDraw();
    await ensureEntry();
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "card_code" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("还没有获得卡密奖品");
  });

  it("有卡密奖品时通过私聊发送卡密，群内不展示明文", async () => {
    await seedInstantDraw();
    await seedWinner({ prizeName: "测试奖品", code: "CARD-CODE-001", secret: "CARD-SEC-001" });

    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "card_code" }));
    expect(result.handled).toBe(true);
    // 群内回复应告知卡密数量和私聊发送
    expect(result.reply).toContain("1 条卡密");
    expect(result.reply).toContain("私聊消息");
    // 群内回复不应包含卡密明文
    expect(result.reply).not.toContain("CARD-CODE-001");
    expect(result.reply).not.toContain("CARD-SEC-001");
    // 私聊消息中应包含卡密明文
    expect(result.privateMessages).toBeDefined();
    expect(result.privateMessages).toHaveLength(1);
    expect(result.privateMessages![0].text).toContain("CARD-CODE-001");
    // 有 secret 时应包含完整卡密（code:secret），与 spin-execution.ts 的拼接规则一致
    expect(result.privateMessages![0].text).toContain("CARD-CODE-001:CARD-SEC-001");
    expect(result.privateMessages![0].text).toContain("测试奖品");
    // 私聊对象是当前用户
    expect(result.privateMessages![0].userId).toBe(USER_ID);
    expect(result.privateMessages![0].groupId).toBe(GROUP_ID);
  });

  it("有多个卡密奖品时逐条私聊发送", async () => {
    await seedInstantDraw();
    // 第一个奖品会新建 entry，第二个复用同一 entry
    const first = await seedWinner({ prizeName: "奖品A", code: "CARD-A", secret: "SEC-A" });
    await seedWinner({
      prizeName: "奖品B",
      tierName: "奖品B",
      code: "CARD-B",
      secret: "SEC-B",
      sortOrder: 200,
      entryId: first.entryId,
    });

    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "card_code" }));
    expect(result.handled).toBe(true);
    // 群内回复应告知卡密数量
    expect(result.reply).toContain("2 条卡密");
    // 群内不应包含任何卡密明文
    expect(result.reply).not.toContain("CARD-A");
    expect(result.reply).not.toContain("CARD-B");
    // 私聊消息应为 2 条
    expect(result.privateMessages).toBeDefined();
    expect(result.privateMessages).toHaveLength(2);
    expect(result.privateMessages![0].text).toContain("CARD-A");
    expect(result.privateMessages![1].text).toContain("CARD-B");
    // 每条私聊都应包含完整卡密（code:secret）
    expect(result.privateMessages![0].text).toContain("CARD-A:SEC-A");
    expect(result.privateMessages![1].text).toContain("CARD-B:SEC-B");
  });

  it("命令关闭时返回禁用提示", async () => {
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "card_code",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, myCardCodeEnabled: false },
    }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("未启用");
  });
  it("无 secret 的卡密只展示 code，不拼 secret", async () => {
    // 只设 code，secret 显式传空字符串（对应 prize_codes.secret 默认空值场景）
    await seedInstantDraw();
    await seedWinner({ prizeName: "无密码奖品", code: "CODE-ONLY", secret: "" });
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "card_code" }));
    expect(result.handled).toBe(true);
    expect(result.privateMessages).toHaveLength(1);
    // 应只包含 code，不拼 ":secret" 后缀
    expect(result.privateMessages![0].text).toContain("CODE-ONLY");
    expect(result.privateMessages![0].text).not.toContain("CODE-ONLY:");
  });
});

describe("executeBuiltinPlatformCommand 通用兜底", () => {
  it("群已绑定但未选择活动时返回友好提示，不抛活动不存在", async () => {
    const result = await executeBuiltinPlatformCommand(db, makeInput({ drawId: "", publicSlug: "" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("未选择活动");
  });

  it("命令处理器抛异常时返回系统繁忙提示，避免用户收不到任何回复", async () => {
    // 用抛异常的 db 模拟数据库故障，验证顶层 try/catch 兜底
    const throwingDb = {
      select: () => { throw new Error("db down"); },
    } as unknown as DbType;
    const result = await executeBuiltinPlatformCommand(throwingDb, makeInput({ command: "my_prize" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("系统繁忙");
  });

  it("未注册 handler 的命令返回暂不支持提示", async () => {
    // 传入一个不在 COMMAND_HANDLERS 中的命令名，验证 fallback 生效
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "unknown_cmd" as never } as never));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("暂不支持");
  });
});

// ── /签到 签到奖励测试 ──

describe("/签到 (executeCheckinCommand) 签到奖励", () => {
  it("未配置 grantSpinCount 时保持原有行为（只参与记录）", async () => {
    await seedInstantDraw();
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, dailyCheckinPolicy: undefined },
    }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("签到成功");
  });

  it("签到奖励：首次签到增加 spinsLeft", async () => {
    await seedInstantDraw();
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: {
        ...DEFAULT_BUILTIN_COMMANDS,
        dailyCheckinPolicy: { grantSpinCount: 1 },
      },
    }));
    expect(result.handled).toBe(true);
    // 回复包含奖励提示
    expect(result.reply).toContain("获得 1 次抽奖机会");
    // 验证 entry 的 spinsLeft 增加了
    const [entry] = await db
      .select({ id: lotteryEntries.id, spinsLeft: lotteryEntries.spinsLeft })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)))
      .limit(1);
    // initialSpinsOnJoin(1, 来自 joinDraw 的初始发放) + grantSpinCount(1) = 2
    expect(Number(entry?.spinsLeft ?? 0)).toBe(2);

    // spins 流水日志（P1）：记录签到奖励发放
    const checkinLogs = await db
      .select()
      .from(spinsLog)
      .where(and(
        eq(spinsLog.entryId, entry!.id),
        eq(spinsLog.reason, "checkin"),
      ));
    expect(checkinLogs).toHaveLength(1);
    expect(checkinLogs[0]!).toMatchObject({ delta: 1, balanceAfter: 2, reason: "checkin" });
  });

  it("同一天重复签到不增加次数", async () => {
    await seedInstantDraw();
    // 第一次签到
    await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, dailyCheckinPolicy: { grantSpinCount: 1 } },
    }));
    // 第二次签到（同一天）
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, dailyCheckinPolicy: { grantSpinCount: 1 } },
    }));
    expect(result.reply).toContain("今日已签到");
    // 验证 spinsLeft 没有额外增加
    const [entry] = await db
      .select({ spinsLeft: lotteryEntries.spinsLeft })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)))
      .limit(1);
    expect(Number(entry?.spinsLeft ?? 0)).toBe(2); // 没有变成 3
  });

  it("grantSpinCount=0 时保持原有行为", async () => {
    await seedInstantDraw();
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, dailyCheckinPolicy: { grantSpinCount: 0 } },
    }));
    expect(result.reply).toContain("签到成功");
    // 只获得 initialSpinsOnJoin(1)，没有额外奖励
    const [entry] = await db
      .select({ spinsLeft: lotteryEntries.spinsLeft })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)))
      .limit(1);
    expect(Number(entry?.spinsLeft ?? 0)).toBe(1);
  });

  it("签到奖励 grantSpinCount=2 时增加 2 次", async () => {
    await seedInstantDraw();
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: {
        ...DEFAULT_BUILTIN_COMMANDS,
        dailyCheckinPolicy: { grantSpinCount: 2 },
      },
    }));
    expect(result.reply).toContain("获得 2 次抽奖机会");
    // initialSpinsOnJoin(1) + grantSpinCount(2) = 3
    const [entry] = await db
      .select({ spinsLeft: lotteryEntries.spinsLeft })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)))
      .limit(1);
    expect(Number(entry?.spinsLeft ?? 0)).toBe(3);
  });

  it("签到后 activity_events 记录当天签到事件", async () => {
    await seedInstantDraw();
    await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: {
        ...DEFAULT_BUILTIN_COMMANDS,
        dailyCheckinPolicy: { grantSpinCount: 1 },
      },
    }));
    const todayStartIso = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const [entry] = await db
      .select({ id: lotteryEntries.id })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)))
      .limit(1);
    const [event] = await db
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT_ID),
        eq(activityEvents.drawId, DRAW_ID),
        eq(activityEvents.entryId, entry!.id),
        eq(activityEvents.eventType, "daily_checkin"),
        sql`${activityEvents.createdAt} >= ${todayStartIso}`,
      ))
      .limit(1);
    expect(event).toBeDefined();
  });

  it("命令关闭时返回禁用提示", async () => {
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, checkinEnabled: false },
    }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("未启用");
  });

  it("lastCheckinDate 已是今天时，条件 UPDATE 影响 0 行，不重复发放", async () => {
    await seedInstantDraw();
    // 模拟今天已签到：先走一次正常签到，再手动校验幂等
    await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, dailyCheckinPolicy: { grantSpinCount: 1 } },
    }));
    const [entryAfterFirst] = await db
      .select({
        spinsLeft: lotteryEntries.spinsLeft,
        lastCheckinDate: lotteryEntries.lastCheckinDate,
      })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)))
      .limit(1);
    const today = new Date().toISOString().slice(0, 10);
    // lastCheckinDate 已写入今天
    expect(entryAfterFirst?.lastCheckinDate).toBe(today);
    expect(Number(entryAfterFirst?.spinsLeft ?? 0)).toBe(2);

    // 再次签到：UPDATE 应影响 0 行，spinsLeft 不再增加
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, dailyCheckinPolicy: { grantSpinCount: 1 } },
    }));
    expect(result.reply).toContain("今日已签到");
    const [entryAfter] = await db
      .select({ spinsLeft: lotteryEntries.spinsLeft })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)))
      .limit(1);
    expect(Number(entryAfter?.spinsLeft ?? 0)).toBe(2);
  });

  it("lastCheckinDate 为昨天时，可再次签到并更新为今天", async () => {
    await seedInstantDraw();
    // 先让用户加入获得 entry
    await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, dailyCheckinPolicy: { grantSpinCount: 1 } },
    }));
    // 模拟跨天：把 last_checkin_date 改回昨天（等价于时间流逝到下一天）
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    await db
      .update(lotteryEntries)
      .set({ lastCheckinDate: yesterday })
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)));

    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, dailyCheckinPolicy: { grantSpinCount: 1 } },
    }));
    expect(result.reply).toContain("签到成功");
    expect(result.reply).toContain("获得 1 次抽奖机会");

    const [entry] = await db
      .select({
        spinsLeft: lotteryEntries.spinsLeft,
        lastCheckinDate: lotteryEntries.lastCheckinDate,
      })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)))
      .limit(1);
    // 昨天那次(1) + 今天这次(1) + initialSpinsOnJoin(1) = 3
    expect(Number(entry?.spinsLeft ?? 0)).toBe(3);
    const today = new Date().toISOString().slice(0, 10);
    expect(entry?.lastCheckinDate).toBe(today);
  });

  it("首次签到（lastCheckinDate 为 NULL）时条件 UPDATE 可命中", async () => {
    await seedInstantDraw();
    // 直接插入 entry，lastCheckinDate 保持 NULL（默认），spinsLeft=0 模拟从未签到
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "qq",
      identityValue: USER_ID,
      displayName: "测试用户",
      joinedAt: new Date().toISOString(),
      spinsLeft: 0,
      spinsTotalGranted: 0,
    });
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, dailyCheckinPolicy: { grantSpinCount: 1 } },
    }));
    expect(result.reply).toContain("签到成功");
    const [entry] = await db
      .select({
        spinsLeft: lotteryEntries.spinsLeft,
        lastCheckinDate: lotteryEntries.lastCheckinDate,
      })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)))
      .limit(1);
    expect(Number(entry?.spinsLeft ?? 0)).toBe(1); // 0 + grantSpinCount(1)
    expect(entry?.lastCheckinDate).toBe(new Date().toISOString().slice(0, 10));
  });
it("并发签到原子性：两个并发 /签到 只有第一个增加 spinsLeft（原子 UPDATE 消除 TOCTOU）", async () => {
    // 先播种活动并创建 entry，spinsLeft=0, lastCheckinDate=NULL
    await seedInstantDraw();
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "qq",
      identityValue: USER_ID,
      displayName: "测试用户",
      joinedAt: new Date().toISOString(),
      spinsLeft: 0,
      spinsTotalGranted: 0,
    });

    // 两个并发 /签到，模拟两个请求同时到达。
    // 注意：同一 DB 连接的 Promise.all 无法复现真实并发（SQLite 单写者模型下，
    // UPDATE 序列化；但 JavaScript 微任务队列中两个 SELECT 可能都先完成）。
    // 此测试主要验证最终不变量：spinsLeft 只增加一次，而非两次。
    await Promise.all([
      executeBuiltinPlatformCommand(db, makeInput({
        command: "checkin",
        builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, dailyCheckinPolicy: { grantSpinCount: 1 } },
      })),
      executeBuiltinPlatformCommand(db, makeInput({
        command: "checkin",
        builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, dailyCheckinPolicy: { grantSpinCount: 1 } },
      })),
    ]);

    // 断言核心不变量（数据库层面保证，不依赖 Promise.all 的调度顺序）：
    // 无论两个请求如何交错，spinsLeft 都只增加一次 grantSpinCount(1)，绝不双倍发放。
    // SQLite 单写者模型下 UPDATE 自带行锁串行执行，第二个请求的
    // WHERE last_checkin_date IS NULL 条件不再命中 → 影响 0 行 → 不重复发放。
    const [entry] = await db
      .select({ spinsLeft: lotteryEntries.spinsLeft })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)))
      .limit(1);
    // 关键不变量：spinsLeft 只增加了一次 grantSpinCount(1)，而不是两次
    expect(Number(entry?.spinsLeft ?? 0)).toBe(1);
  });

  it("端到端闭环：签到获得 spins → 抽奖消耗 spins（验证签到奖励的 spins 可被消耗）", async () => {
    await seedInstantDraw();
    // 先签到获得 spins
    const checkinResult = await executeBuiltinPlatformCommand(db, makeInput({
      command: "checkin",
      builtinCommands: {
        ...DEFAULT_BUILTIN_COMMANDS,
        dailyCheckinPolicy: { grantSpinCount: 1 },
      },
    }));
    expect(checkinResult.reply).toContain("签到成功");

    // 查看签到后的 spinsLeft：initialSpinsOnJoin(1) + grantSpinCount(1) = 2
    const [entryBefore] = await db
      .select({ spinsLeft: lotteryEntries.spinsLeft })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, DRAW_ID)))
      .limit(1);
    expect(Number(entryBefore?.spinsLeft ?? 0)).toBe(2);

    // 抽奖消耗 1 次
    const spinResult = await executeBuiltinPlatformCommand(db, makeInput({ command: "spin" }));
    expect(spinResult.handled).toBe(true);
    // 无论中奖与否，spinsLeft 都应减少 1
    expect(spinResult.reply).toContain("剩余抽奖次数：1 次");

    // 再次抽奖消耗最后 1 次
    const spinResult2 = await executeBuiltinPlatformCommand(db, makeInput({ command: "spin" }));
    expect(spinResult2.handled).toBe(true);
    expect(spinResult2.reply).toContain("剩余抽奖次数：0 次");

    // 第三次抽奖应触发次数耗尽
    const spinResult3 = await executeBuiltinPlatformCommand(db, makeInput({ command: "spin" }));
    expect(spinResult3.handled).toBe(true);
    expect(spinResult3.reply).toContain("抽奖次数已用完");
  });
});

// ── /秒杀 测试（docs/171 §断层B：打通免费→付费转化）──
describe("/秒杀 (executeFlashCommand)", () => {
  it("未配置购买链接时提示管理员未配置", async () => {
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "flash" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("尚未配置购买链接");
  });

  it("配置购买链接时返回链接和展示文案", async () => {
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "flash",
      builtinCommands: {
        ...DEFAULT_BUILTIN_COMMANDS,
        purchaseConfig: { url: "https://example.com/flash", label: "🔥 限时秒杀 ¥9.90" },
      },
    }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("🔥 限时秒杀 ¥9.90");
    expect(result.reply).toContain("https://example.com/flash");
  });

  it("命令关闭时返回禁用提示", async () => {
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "flash",
      builtinCommands: { ...DEFAULT_BUILTIN_COMMANDS, flashEnabled: false },
    }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("未启用");
  });

  it("识别 /秒杀 和「购买」文本", () => {
    expect(recognizeBuiltinCommand("/秒杀")).toBe("flash");
    expect(recognizeBuiltinCommand("秒杀")).toBe("flash");
    expect(recognizeBuiltinCommand("购买")).toBe("flash");
  });
});

// ── /帮助 渲染测试（docs/171 §断层B：帮助列表与购买配置的联动）──
describe("renderHelpReply", () => {
  it("默认配置下显示所有命令（含 /秒杀）", () => {
    const reply = renderHelpReply({
      ...DEFAULT_BUILTIN_COMMANDS,
      purchaseConfig: { url: "https://example.com/buy", label: "立即购买" },
    });
    expect(reply).toContain("/秒杀");
    expect(reply).toContain("/签到");
    expect(reply).toContain("/抽奖");
  });

  it("未配置 purchaseConfig.url 时帮助列表不显示 /秒杀", () => {
    const reply = renderHelpReply(DEFAULT_BUILTIN_COMMANDS);
    expect(reply).not.toContain("/秒杀");
    // 其他命令不受影响
    expect(reply).toContain("/签到");
    expect(reply).toContain("/抽奖");
  });

  it("flashEnabled=false 时帮助列表不显示 /秒杀（即使有购买链接）", () => {
    const reply = renderHelpReply({
      ...DEFAULT_BUILTIN_COMMANDS,
      flashEnabled: false,
      purchaseConfig: { url: "https://example.com/buy", label: "立即购买" },
    });
    expect(reply).not.toContain("/秒杀");
  });

  it("所有命令关闭时返回空提示", () => {
    const reply = renderHelpReply({
      checkinEnabled: false,
      spinEnabled: false,
      shareEnabled: false,
      leaderboardEnabled: false,
      myPrizeEnabled: false,
      myCardCodeEnabled: false,
      helpEnabled: false,
      flashEnabled: false,
    });
    expect(reply).toBe("当前群未启用群助手命令。");
  });
});

// ── 抽奖次数耗尽 → 购买引导（docs/171 §断层B）──
describe("抽奖次数耗尽 → 购买引导", () => {
  /** 播种一个 spinsLeft=0 的 entry，直接触发 spin.quota.exhausted */
  async function seedExhaustedEntry() {
    await seedInstantDraw();
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
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

  it("配置购买链接时，抽奖次数耗尽提示使用 /秒杀", async () => {
    await seedExhaustedEntry();
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "spin",
      builtinCommands: {
        ...DEFAULT_BUILTIN_COMMANDS,
        purchaseConfig: { url: "https://example.com/flash", label: "🔥 限时秒杀" },
      },
    }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("抽奖次数已用完");
    expect(result.reply).toContain("/秒杀");
  });

  it("未配置购买链接时，抽奖次数耗尽不误导用户", async () => {
    await seedExhaustedEntry();
    const result = await executeBuiltinPlatformCommand(db, makeInput({ command: "spin" }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("抽奖次数已用完");
    expect(result.reply).not.toContain("/秒杀");
  });

  it("flashEnabled=false 时，即使有购买链接也不提示 /秒杀（避免提示可用→实际不可用）", async () => {
    await seedExhaustedEntry();
    const result = await executeBuiltinPlatformCommand(db, makeInput({
      command: "spin",
      builtinCommands: {
        ...DEFAULT_BUILTIN_COMMANDS,
        flashEnabled: false,
        purchaseConfig: { url: "https://example.com/flash", label: "🔥 限时秒杀" },
      },
    }));
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("抽奖次数已用完");
    // flashEnabled=false 时 /秒杀 命令不可用，不应提示用户使用它
    expect(result.reply).not.toContain("/秒杀");
  });
});
