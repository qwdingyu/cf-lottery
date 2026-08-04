/**
 * 公开页纯辅助：氛围时长 / 主 CTA 提示 key / 体验解析。
 */
import { describe, expect, it } from "vitest";
import {
  ambienceMsForExperience,
  gamePrimaryCtaHintKey,
  resolveExperienceType,
} from "./public-helpers";

describe("public-helpers experience UX", () => {
  it("ambienceMsForExperience 与游戏 celebrate 时长大致对齐", () => {
    expect(ambienceMsForExperience("wheel", "open")).toBe(3000);
    expect(ambienceMsForExperience("slot", "open")).toBe(2000);
    expect(ambienceMsForExperience("grid", "open")).toBe(700);
    expect(ambienceMsForExperience("submit", "open")).toBe(0);
    // 未配置 experience：open 默认 wheel
    expect(ambienceMsForExperience(undefined, "open")).toBe(3000);
  });

  it("resolveExperienceType 归一化大小写与默认", () => {
    expect(resolveExperienceType("Wheel", "open")).toBe("wheel");
    expect(resolveExperienceType(undefined, "invite_code")).toBe("slot");
    expect(resolveExperienceType("", "password")).toBe("scratch");
  });

  it("gamePrimaryCtaHintKey 按体验细分，避免转盘文案套老虎机", () => {
    expect(gamePrimaryCtaHintKey("wheel", "open")).toBe("gamePrimaryCtaHintWheel");
    expect(gamePrimaryCtaHintKey("slot", "open")).toBe("gamePrimaryCtaHintSlot");
    expect(gamePrimaryCtaHintKey("scratch", "open")).toBe("gamePrimaryCtaHintScratch");
    expect(gamePrimaryCtaHintKey("card", "open")).toBe("gamePrimaryCtaHintCard");
    expect(gamePrimaryCtaHintKey("grid", "open")).toBe("gamePrimaryCtaHintGrid");
    expect(gamePrimaryCtaHintKey("form", "open")).toBe("gamePrimaryCtaHintForm");
    expect(gamePrimaryCtaHintKey("reveal", "open")).toBe("gamePrimaryCtaHintReveal");
    expect(gamePrimaryCtaHintKey("submit", "open")).toBe("gamePrimaryCtaHintSubmit");
    // 未知体验回退通用 hint
    expect(gamePrimaryCtaHintKey("unknown_xyz", "open")).toBe("gamePrimaryCtaHint");
  });
});
