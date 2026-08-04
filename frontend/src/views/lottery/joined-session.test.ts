import { describe, expect, it } from "vitest";
import {
  clearJoinedHints,
  isAlreadyJoinedResponse,
  isSilentFetchOption,
  joinResultHintI18nKey,
  joinedOpenStatusHintKey,
  joinedHintKey,
  readJoinedHints,
  removeJoinedHintsForKeys,
  resolvePublicDrawPathKey,
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
    expect(isAlreadyJoinedResponse({ message: "Already joined" })).toBe(true);
    expect(isAlreadyJoinedResponse({ message: "验证码错误" }, 400)).toBe(false);
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
    expect(joinedOpenStatusHintKey("no_result")).toBe("statusHintJoinedNoResult");
    expect(joinedOpenStatusHintKey("instant")).toBe("statusHintJoinedInstant");
    expect(joinedOpenStatusHintKey("manual")).toBe("statusHintJoinedPending");
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
