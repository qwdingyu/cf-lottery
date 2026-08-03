/**
 * 系统配置多选枚举（enabled_activity_kinds / enabled_participation_modes）规范化测试。
 * 存储仍为逗号分隔字符串；UI 复选框 + 服务端白名单/空选/排序闭环。
 */
import { describe, expect, it } from "vitest";
import {
  getSystemConfigDefinition,
  normalizeSystemConfigValue,
} from "./system-config-registry";

describe("system-config 多选枚举定义", () => {
  it("enabled_activity_kinds 带 enum 与标签", () => {
    const def = getSystemConfigDefinition("enabled_activity_kinds");
    expect(def?.enum).toContain("lottery");
    expect(def?.enum).toContain("survey");
    expect(def?.enumLabels?.lottery).toBe("抽奖");
  });

  it("enabled_participation_modes 带 enum 与标签", () => {
    const def = getSystemConfigDefinition("enabled_participation_modes");
    expect(def?.enum).toEqual(
      expect.arrayContaining(["open", "registered", "roster", "password", "invite_code"]),
    );
    expect(def?.enumLabels?.invite_code).toBe("邀请码");
  });
});

describe("normalizeSystemConfigValue 多选枚举", () => {
  it("接受合法子集并按定义顺序稳定输出", () => {
    const result = normalizeSystemConfigValue(
      "enabled_activity_kinds",
      "vote, lottery, survey",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 定义顺序：lottery 在 survey/vote 前
      expect(result.value).toBe("lottery,survey,vote");
    }
  });

  it("去重重复 token", () => {
    const result = normalizeSystemConfigValue(
      "enabled_participation_modes",
      "open,password,open,roster",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("open,roster,password");
    }
  });

  it("拒绝非法选项", () => {
    const result = normalizeSystemConfigValue(
      "enabled_activity_kinds",
      "lottery,not_a_kind",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/不支持|not_a_kind/);
    }
  });

  it("拒绝空选", () => {
    const result = normalizeSystemConfigValue("enabled_activity_kinds", "  ,  ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/至少/);
    }
  });

  it("拒绝空字符串", () => {
    const result = normalizeSystemConfigValue("enabled_participation_modes", "");
    expect(result.ok).toBe(false);
  });

  it("全量默认值可规范化通过", () => {
    const kinds = getSystemConfigDefinition("enabled_activity_kinds");
    const modes = getSystemConfigDefinition("enabled_participation_modes");
    expect(kinds?.defaultValue).toBeTruthy();
    expect(modes?.defaultValue).toBeTruthy();
    const r1 = normalizeSystemConfigValue("enabled_activity_kinds", kinds!.defaultValue);
    const r2 = normalizeSystemConfigValue("enabled_participation_modes", modes!.defaultValue);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok) expect(r1.value).toBe(kinds!.enum!.join(","));
    if (r2.ok) expect(r2.value).toBe(modes!.enum!.join(","));
  });
});
