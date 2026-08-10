/**
 * 平台目标绑定读取服务测试（docs/167 + docs/171）。
 *
 * 覆盖 parseBuiltinCommandConfig 的三个核心解析路径：
 * 1. 命令开关（checkinEnabled / spinEnabled / flashEnabled 等）
 * 2. dailyCheckinPolicy.grantSpinCount（签到奖励闭环，docs/171 §断层A）
 * 3. purchaseConfig（购买引导闭环，docs/171 §断层B）
 *
 * 为什么单独测试 targets.ts 而非合并到 commands.test.ts？
 * targets.ts 的 parseBuiltinCommandConfig 是「管理端保存 → 命令层读取」的中间桥梁，
 * 它独立于命令执行，但直接影响命令层的行为（不用影响就得测）。
 * 合并到 commands.test.ts 会模糊测试边界，且 commands.test.ts 已接近 750 行。
 */
import { describe, expect, it } from "vitest";
import { parseBuiltinCommandConfig } from "./targets";
import type { BuiltinCommandConfig } from "./types";

const DEFAULT: BuiltinCommandConfig = {
  checkinEnabled: true,
  spinEnabled: true,
  shareEnabled: true,
  leaderboardEnabled: true,
  myPrizeEnabled: true,
  myCardCodeEnabled: true,
  helpEnabled: true,
  flashEnabled: true,
  bindEnabled: true,
};

describe("parseBuiltinCommandConfig", () => {
  // ═══════════════════════════════════════════════════════════════
  // 命令开关解析
  // ═══════════════════════════════════════════════════════════════

  it("空对象 JSON 时返回所有开关默认值", () => {
    const result = parseBuiltinCommandConfig("{}");
    expect(result.purchaseConfig).toBeUndefined();
    expect(result.dailyCheckinPolicy).toBeUndefined();
    expect(result).toEqual(DEFAULT);
  });

  it("null 输入时返回默认值", () => {
    const result = parseBuiltinCommandConfig(null);
    expect(result.purchaseConfig).toBeUndefined();
    expect(result.flashEnabled).toBe(true);
  });

  it("undefined 输入时返回默认值", () => {
    const result = parseBuiltinCommandConfig(undefined);
    expect(result.purchaseConfig).toBeUndefined();
    expect(result.flashEnabled).toBe(true);
  });

  it("JSON 解析失败时返回默认值", () => {
    const result = parseBuiltinCommandConfig("not-json");
    expect(result.purchaseConfig).toBeUndefined();
    expect(result.flashEnabled).toBe(true);
    expect(result.checkinEnabled).toBe(true);
  });

  it("命令开关显式布尔值生效", () => {
    const raw = JSON.stringify({
      checkinEnabled: false,
      flashEnabled: false,
      spinEnabled: true,
    });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.checkinEnabled).toBe(false);
    expect(result.flashEnabled).toBe(false);
    expect(result.spinEnabled).toBe(true);
    expect(result.shareEnabled).toBe(true);
    expect(result.leaderboardEnabled).toBe(true);
    expect(result.myPrizeEnabled).toBe(true);
    expect(result.helpEnabled).toBe(true);
  });

  it("replyOverrides 透传", () => {
    const raw = JSON.stringify({
      replyOverrides: { checkin: "自定义签到文案" },
    });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.replyOverrides?.checkin).toBe("自定义签到文案");
  });

  // ═══════════════════════════════════════════════════════════════
  // dailyCheckinPolicy.grantSpinCount 解析（签到奖励闭环，docs/171 §断层A）
  // ═══════════════════════════════════════════════════════════════

  it("grantSpinCount 正整数时持久化（签到奖励闭环）", () => {
    const raw = JSON.stringify({ dailyCheckinPolicy: { grantSpinCount: 3 } });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.dailyCheckinPolicy).toEqual({ grantSpinCount: 3 });
  });

  it("grantSpinCount=0 时省略 dailyCheckinPolicy（视为不奖励）", () => {
    const raw = JSON.stringify({ dailyCheckinPolicy: { grantSpinCount: 0 } });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.dailyCheckinPolicy).toBeUndefined();
  });

  it("grantSpinCount 为负数时归零并省略（不产生负奖励）", () => {
    const raw = JSON.stringify({ dailyCheckinPolicy: { grantSpinCount: -5 } });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.dailyCheckinPolicy).toBeUndefined();
  });

  it("grantSpinCount 为小数时向下取整", () => {
    const raw = JSON.stringify({ dailyCheckinPolicy: { grantSpinCount: 2.9 } });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.dailyCheckinPolicy?.grantSpinCount).toBe(2);
  });

  it("grantSpinCount 为非法值（非数字字符串）时省略", () => {
    const raw = JSON.stringify({ dailyCheckinPolicy: { grantSpinCount: "abc" } });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.dailyCheckinPolicy).toBeUndefined();
  });

  it("grantSpinCount 为 NaN 时省略", () => {
    const raw = JSON.stringify({ dailyCheckinPolicy: { grantSpinCount: NaN } });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.dailyCheckinPolicy).toBeUndefined();
  });

  it("dailyCheckinPolicy 缺失时 grantSpinCount 为 undefined", () => {
    const raw = JSON.stringify({});
    const result = parseBuiltinCommandConfig(raw);
    expect(result.dailyCheckinPolicy).toBeUndefined();
  });

  it("dailyCheckinPolicy 不是对象时忽略", () => {
    const raw = JSON.stringify({ dailyCheckinPolicy: "not-an-object" });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.dailyCheckinPolicy).toBeUndefined();
  });

  // ═══════════════════════════════════════════════════════════════
  // purchaseConfig 解析（购买引导闭环，docs/171 §断层B）
  // ═══════════════════════════════════════════════════════════════

  it("解析完整的 purchaseConfig（url + label）", () => {
    const raw = JSON.stringify({
      flashEnabled: true,
      purchaseConfig: { url: "https://example.com/flash", label: "🔥 限时秒杀 ¥9.90" },
    });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.purchaseConfig).toEqual({
      url: "https://example.com/flash",
      label: "🔥 限时秒杀 ¥9.90",
    });
    expect(result.flashEnabled).toBe(true);
  });

  it("purchaseConfig.label 为空时使用默认文案「立即购买」", () => {
    const raw = JSON.stringify({
      purchaseConfig: { url: "https://example.com/buy", label: "" },
    });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.purchaseConfig).toEqual({
      url: "https://example.com/buy",
      label: "立即购买",
    });
  });

  it("purchaseConfig.label 缺失时使用默认文案「立即购买」", () => {
    const raw = JSON.stringify({
      purchaseConfig: { url: "https://example.com/buy" },
    });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.purchaseConfig).toEqual({
      url: "https://example.com/buy",
      label: "立即购买",
    });
  });

  it("purchaseConfig.label 为纯空白时回退默认文案「立即购买」（对齐 admin API 语义）", () => {
    const raw = JSON.stringify({
      purchaseConfig: { url: "https://example.com/buy", label: "   " },
    });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.purchaseConfig).toEqual({
      url: "https://example.com/buy",
      label: "立即购买",
    });
  });

  it("purchaseConfig.url 为空时省略 purchaseConfig", () => {
    const raw = JSON.stringify({
      flashEnabled: true,
      purchaseConfig: { url: "", label: "🔥 限时秒杀" },
    });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.purchaseConfig).toBeUndefined();
    expect(result.flashEnabled).toBe(true);
  });

  it("purchaseConfig.url 为空白字符串时省略 purchaseConfig", () => {
    const raw = JSON.stringify({
      purchaseConfig: { url: "   ", label: "立即购买" },
    });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.purchaseConfig).toBeUndefined();
  });

  it("purchaseConfig 不是对象时忽略", () => {
    const raw = JSON.stringify({ purchaseConfig: "not-an-object" });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.purchaseConfig).toBeUndefined();
  });

  it("purchaseConfig 为 null 时忽略", () => {
    const raw = JSON.stringify({ purchaseConfig: null });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.purchaseConfig).toBeUndefined();
  });

  it("purchaseConfig.url 前后空格被 trim", () => {
    const raw = JSON.stringify({
      purchaseConfig: { url: "  https://example.com/flash  ", label: "  🔥 限时秒杀  " },
    });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.purchaseConfig).toEqual({
      url: "https://example.com/flash",
      label: "🔥 限时秒杀",
    });
  });

  it("purchaseConfig 与 dailyCheckinPolicy 可共存（完整闭环配置）", () => {
    const raw = JSON.stringify({
      checkinEnabled: true,
      dailyCheckinPolicy: { grantSpinCount: 3 },
      purchaseConfig: { url: "https://example.com/flash", label: "🔥 限时秒杀" },
    });
    const result = parseBuiltinCommandConfig(raw);
    expect(result.dailyCheckinPolicy).toEqual({ grantSpinCount: 3 });
    expect(result.purchaseConfig).toEqual({
      url: "https://example.com/flash",
      label: "🔥 限时秒杀",
    });
  });
});
