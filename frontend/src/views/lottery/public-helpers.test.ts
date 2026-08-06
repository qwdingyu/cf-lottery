/**
 * 公开页纯辅助：氛围时长 / 主 CTA 提示 key / 体验解析。
 */
import { describe, expect, it } from "vitest";
import {
  ambienceMsForExperience,
  buildPublicDrawRequestInit,
  gamePrimaryCtaHintKey,
  isLotteryResultFamilyKind,
  resolveExperienceType,
  shouldShowInviteShareCta,
  shouldShowNotWonRecordTag,
  statusHintDrawnI18nKey,
  statusHintDrawingI18nKey,
  publicStatusTagI18nKey,
  resultModeTagI18nKey,
} from "./public-helpers";

describe("public-helpers experience UX", () => {
  it("ambienceMsForExperience 与游戏 celebrate 时长大致对齐", () => {
    // wheel celebrate = 2800ms；弹窗略晚，避免盖住尾帧（docs/115）
    expect(ambienceMsForExperience("wheel", "open")).toBe(2900);
    expect(ambienceMsForExperience("slot", "open")).toBe(2000);
    expect(ambienceMsForExperience("grid", "open")).toBe(700);
    expect(ambienceMsForExperience("submit", "open")).toBe(0);
    // 未配置 experience：open 默认 wheel
    expect(ambienceMsForExperience(undefined, "open")).toBe(2900);
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
    // 非抽奖别名：与 GameRegistry 壳对齐
    expect(gamePrimaryCtaHintKey("ballot", "open")).toBe("gamePrimaryCtaHintForm");
    expect(gamePrimaryCtaHintKey("list", "open")).toBe("gamePrimaryCtaHintSubmit");
    expect(gamePrimaryCtaHintKey("queue", "open")).toBe("gamePrimaryCtaHintSubmit");
    expect(gamePrimaryCtaHintKey("calendar", "open")).toBe("gamePrimaryCtaHintSubmit");
    expect(gamePrimaryCtaHintKey("checkin", "open")).toBe("gamePrimaryCtaHintSubmit");
    // 未知体验回退通用 hint
    expect(gamePrimaryCtaHintKey("unknown_xyz", "open")).toBe("gamePrimaryCtaHint");
  });

  it("shouldShowInviteShareCta：已开奖/取消不推邀请，进行中可分享", () => {
    expect(shouldShowInviteShareCta("drawn")).toBe(false);
    expect(shouldShowInviteShareCta("cancelled")).toBe(false);
    expect(shouldShowInviteShareCta("closed")).toBe(false);
    expect(shouldShowInviteShareCta("DRAWN")).toBe(false);
    expect(shouldShowInviteShareCta("open")).toBe(true);
    expect(shouldShowInviteShareCta("drawing")).toBe(true);
    expect(shouldShowInviteShareCta("paused")).toBe(true);
    expect(shouldShowInviteShareCta("")).toBe(true);
    expect(shouldShowInviteShareCta(undefined)).toBe(true);
  });

  it("isLotteryResultFamilyKind / shouldShowNotWonRecordTag：非抽奖不标未中奖", () => {
    expect(isLotteryResultFamilyKind("lottery")).toBe(true);
    expect(isLotteryResultFamilyKind("claim")).toBe(true);
    expect(isLotteryResultFamilyKind("signup_chain")).toBe(false);
    expect(isLotteryResultFamilyKind("survey")).toBe(false);
    expect(isLotteryResultFamilyKind("")).toBe(false);

    expect(
      shouldShowNotWonRecordTag({ drawStatus: "drawn", activityKind: "lottery", won: false }),
    ).toBe(true);
    expect(
      shouldShowNotWonRecordTag({ drawStatus: "drawn", activityKind: "lottery", won: true }),
    ).toBe(false);
    expect(
      shouldShowNotWonRecordTag({ drawStatus: "open", activityKind: "lottery", won: false }),
    ).toBe(false);
    expect(
      shouldShowNotWonRecordTag({ drawStatus: "drawn", activityKind: "signup_chain", won: false }),
    ).toBe(false);
    // 缺 kind：保守不标未中奖
    expect(shouldShowNotWonRecordTag({ drawStatus: "drawn", activityKind: undefined, won: false })).toBe(
      false,
    );
  });

  it("statusHintDrawnI18nKey：抽奖说中奖，其它玩法中性", () => {
    expect(statusHintDrawnI18nKey("lottery")).toBe("statusHintDrawn");
    expect(statusHintDrawnI18nKey("claim")).toBe("statusHintDrawn");
    expect(statusHintDrawnI18nKey("signup_chain")).toBe("statusHintDrawnGeneric");
    expect(statusHintDrawnI18nKey("survey")).toBe("statusHintDrawnGeneric");
    // 缺 kind：公开页多为抽奖深链，仍用抽奖文案
    expect(statusHintDrawnI18nKey(undefined)).toBe("statusHintDrawn");
    expect(statusHintDrawnI18nKey("")).toBe("statusHintDrawn");
  });

  it("statusHintDrawingI18nKey：抽奖说开奖中，其它玩法中性", () => {
    expect(statusHintDrawingI18nKey("lottery")).toBe("statusHintDrawing");
    expect(statusHintDrawingI18nKey("claim")).toBe("statusHintDrawing");
    expect(statusHintDrawingI18nKey("signup_chain")).toBe("statusHintDrawingGeneric");
    expect(statusHintDrawingI18nKey("survey")).toBe("statusHintDrawingGeneric");
    expect(statusHintDrawingI18nKey(undefined)).toBe("statusHintDrawing");
    expect(statusHintDrawingI18nKey("")).toBe("statusHintDrawing");
  });

  it("publicStatusTagI18nKey：drawing 按 kind；其它 status 固定", () => {
    expect(publicStatusTagI18nKey("drawing", "lottery")).toBe("statusDrawing");
    expect(publicStatusTagI18nKey("drawing", "signup_chain")).toBe("statusDrawingTagGeneric");
    expect(publicStatusTagI18nKey("drawing", undefined)).toBe("statusDrawing");
    expect(publicStatusTagI18nKey("open")).toBe("statusOpen");
    expect(publicStatusTagI18nKey("drawn")).toBe("ended");
    expect(publicStatusTagI18nKey("unknown")).toBe("");
  });

  it("resultModeTagI18nKey：覆盖抽奖与非抽奖 mode", () => {
    expect(resultModeTagI18nKey("instant")).toBe("resultModeInstantTag");
    expect(resultModeTagI18nKey("scheduled")).toBe("resultModeScheduledTag");
    expect(resultModeTagI18nKey("manual")).toBe("resultModeManualTag");
    expect(resultModeTagI18nKey("review_decision")).toBe("adminResultReview");
    expect(resultModeTagI18nKey("vote_tally")).toBe("adminResultVoteTally");
    expect(resultModeTagI18nKey("")).toBe("");
  });

  it("buildPublicDrawRequestInit 禁止缓存动态公开详情", () => {
    const init = buildPublicDrawRequestInit();
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    });
  });
});
