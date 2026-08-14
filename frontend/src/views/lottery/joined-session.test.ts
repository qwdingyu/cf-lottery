import { describe, expect, it } from "vitest";
import {
  clearJoinedHints,
  entryIdFromAlreadyJoined,
  isAlreadyJoinedResponse,
  isCheckinSignedToday,
  isSilentFetchOption,
  viralHeadlineI18nKey,
  joinResultHintI18nKey,
  joinSuccessModalHintI18nKey,
  joinedOpenStatusHintKey,
  joinedHintKey,
  readJoinedHints,
  removeJoinedHintsForKeys,
  resolvePublicDrawPathKey,
  shouldShowJoinResultQueryCta,
  upsertJoinedHint,
} from "./joined-session";

function memStore(init: Record<string, string> = {}) {
  const data = { ...init };
  return {
    getItem: (k: string) => (k in data ? data[k]! : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
  };
}

describe("joined-session", () => {
  it("upsert/read/clear 已参与提示（slug 与 id 双键）", () => {
    const store = memStore();
    upsertJoinedHint(store, ["Promo-Slug", "uuid-1"], {
      drawId: "uuid-1",
      entryId: "e1",
      drawName: "春日抽奖",
    });
    const map = readJoinedHints(store);
    expect(map[joinedHintKey("Promo-Slug")]?.entryId).toBe("e1");
    expect(map[joinedHintKey("uuid-1")]?.drawName).toBe("春日抽奖");
    clearJoinedHints(store);
    expect(readJoinedHints(store)).toEqual({});
  });

  it("isAlreadyJoinedResponse 认 409 与中英文案", () => {
    expect(isAlreadyJoinedResponse({}, 409)).toBe(true);
    expect(isAlreadyJoinedResponse({ message: "您已参与此活动" })).toBe(true);
    expect(isAlreadyJoinedResponse({ alreadyJoined: true, entryId: "e1" })).toBe(true);
    expect(isAlreadyJoinedResponse({ message: "ok" }, 409)).toBe(true);
    expect(isAlreadyJoinedResponse({ message: "Already joined" })).toBe(true);
    expect(isAlreadyJoinedResponse({ message: "验证码错误" }, 400)).toBe(false);
  });

  it("entryIdFromAlreadyJoined 从 409 载荷取 entryId", () => {
    expect(entryIdFromAlreadyJoined({ entryId: "e-abc" })).toBe("e-abc");
    expect(entryIdFromAlreadyJoined({ entryId: "  " })).toBeUndefined();
    expect(entryIdFromAlreadyJoined({})).toBeUndefined();
    expect(entryIdFromAlreadyJoined(null)).toBeUndefined();
  });

  it("resolvePublicDrawPathKey 优先 publicSlug", () => {
    expect(
      resolvePublicDrawPathKey("uuid-1", [{ id: "uuid-1", publicSlug: "spring" }]),
    ).toBe("spring");
    expect(resolvePublicDrawPathKey("spring", [{ id: "uuid-1", publicSlug: "spring" }])).toBe(
      "spring",
    );
    expect(resolvePublicDrawPathKey("only", [])).toBe("only");
  });

  it("result / joined 状态 hint key 按 mode 诚实分支", () => {
    expect(joinResultHintI18nKey("no_result")).toBe("joinResultHintNoResult");
    expect(joinResultHintI18nKey("vote_tally")).toBe("joinResultHintVoteTally");
    expect(joinResultHintI18nKey("ordered_assignment")).toBe("joinResultHintOrdered");
    expect(joinResultHintI18nKey("manual")).toBe("joinResultHintManual");
    expect(joinResultHintI18nKey("review_decision")).toBe("joinResultHintReview");
    expect(joinedOpenStatusHintKey("no_result")).toBe("statusHintJoinedNoResult");
    expect(joinedOpenStatusHintKey("instant")).toBe("statusHintJoinedInstant");
    // manual / scheduled 分键（docs/115），禁止都落 pending
    expect(joinedOpenStatusHintKey("manual")).toBe("statusHintJoinedManual");
    expect(joinedOpenStatusHintKey("scheduled")).toBe("statusHintJoinedScheduled");
    expect(joinedOpenStatusHintKey("review_decision")).toBe("statusHintJoinedReview");
    expect(joinedOpenStatusHintKey(undefined)).toBe("statusHintJoinedPending");
  });

  it("joinSuccessModalHint / 查结果 CTA：与 GameResultModal 契约一致", () => {
    expect(joinSuccessModalHintI18nKey("manual")).toBe("joinResultHintManual");
    expect(joinSuccessModalHintI18nKey("scheduled")).toBe("joinResultHintScheduled");
    expect(joinSuccessModalHintI18nKey("instant", null)).toBe("joinResultHintInstant");
    expect(joinSuccessModalHintI18nKey("instant", "第 1 位")).toBe("joinResultHintInstantDone");
    expect(joinSuccessModalHintI18nKey("no_result")).toBe("joinResultHintNoResult");
    // lottery+manual：必须展示查结果
    expect(shouldShowJoinResultQueryCta("manual", null)).toBe(true);
    expect(shouldShowJoinResultQueryCta("scheduled", "")).toBe(true);
    expect(shouldShowJoinResultQueryCta("instant", null)).toBe(true);
    // 仅 instant + 有 outcome 才隐藏
    expect(shouldShowJoinResultQueryCta("instant", "已领取")).toBe(false);
    expect(shouldShowJoinResultQueryCta("manual", "假标签也不应隐藏")).toBe(true);
  });

  it("isSilentFetchOption 忽略 DOM Event 形状", () => {
    expect(isSilentFetchOption({ silent: true })).toBe(true);
    expect(isSilentFetchOption({ silent: false })).toBe(false);
    expect(isSilentFetchOption(undefined)).toBe(false);
    // 模拟 click Event：无 silent 字段
    expect(isSilentFetchOption({ type: "click" } as unknown as Event)).toBe(false);
  });

  it("removeJoinedHintsForKeys 只删指定活动键", () => {
    const store = memStore();
    upsertJoinedHint(store, ["a-slug", "uuid-a"], { drawId: "uuid-a" });
    upsertJoinedHint(store, ["b-slug", "uuid-b"], { drawId: "uuid-b" });
    removeJoinedHintsForKeys(store, ["a-slug", "uuid-a"]);
    const map = readJoinedHints(store);
    expect(map[joinedHintKey("a-slug")]).toBeUndefined();
    expect(map[joinedHintKey("uuid-b")]?.drawId).toBe("uuid-b");
  });
});

// checkin 每日签到按天判断（2026-08 公开端准确性修复）
describe('isCheckinSignedToday', () => {
  it('checkin：今天签过 → true；昨天/更早 → false；无 joinedAt → false', () => {
    expect(isCheckinSignedToday('checkin', '2026-08-14T10:00:00Z', '2026-08-14')).toBe(true)
    expect(isCheckinSignedToday('checkin', '2026-08-13T23:59:00Z', '2026-08-14')).toBe(false)
    expect(isCheckinSignedToday('checkin', '', '2026-08-14')).toBe(false)
    expect(isCheckinSignedToday('checkin', undefined, '2026-08-14')).toBe(false)
  })
  it('非 checkin 活动：不按天判断（返回 true，由调用方决定 joined 语义）', () => {
    expect(isCheckinSignedToday('lottery', '2026-08-01T00:00:00Z', '2026-08-14')).toBe(true)
    expect(isCheckinSignedToday('signup_chain', '', '2026-08-14')).toBe(true)
    expect(isCheckinSignedToday(null, undefined, '2026-08-14')).toBe(true)
  })
})

// 结果弹窗分享引导话术按结果状态差异化（2026-08）
describe('viralHeadlineI18nKey', () => {
  it('有 outcome（接龙占位/预约确认）→ outcome 话术', () => {
    expect(viralHeadlineI18nKey('ordered_assignment', '第 3 位')).toBe('viralHeadlineOutcome')
    expect(viralHeadlineI18nKey('manual', '已预约')).toBe('viralHeadlineOutcome')
  })
  it('无 outcome + instant（防御兜底）→ instant 话术', () => {
    expect(viralHeadlineI18nKey('instant', '')).toBe('viralHeadlineInstant')
    expect(viralHeadlineI18nKey('instant', null)).toBe('viralHeadlineInstant')
  })
  it('无 outcome + delayed/manual → 一起参与话术', () => {
    expect(viralHeadlineI18nKey('manual', '')).toBe('viralHeadlineDelayed')
    expect(viralHeadlineI18nKey('scheduled', null)).toBe('viralHeadlineDelayed')
    expect(viralHeadlineI18nKey(undefined, undefined)).toBe('viralHeadlineDelayed')
  })
})
