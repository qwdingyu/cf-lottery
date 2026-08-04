import { describe, expect, it } from "vitest";
import {
  countLotteryEmailFailures,
  countLotteryEmailPending,
  drawDoneFeedbackKind,
  emailStatusClass,
  isWinnerEmailFailed,
  isWinnerEmailPending,
  isWinnerEmailSent,
} from "./ops-utils";
import type { LotteryWinner } from "./types";

function w(partial: Partial<LotteryWinner>): LotteryWinner {
  return {
    id: "1",
    drawId: "d",
    tierId: "t",
    entryId: "e",
    identityType: "email",
    identityValue: "a@b.c",
    prizeCodeId: "",
    drawnAt: "",
    notificationStatus: "pending",
    notificationError: "",
    ...partial,
  };
}

describe("ops-utils email status", () => {
  it("以 notificationStatus 为准，不误用空 emailSent", () => {
    expect(isWinnerEmailFailed(w({ notificationStatus: "failed" }))).toBe(true);
    expect(isWinnerEmailSent(w({ notificationStatus: "sent" }))).toBe(true);
    expect(isWinnerEmailPending(w({ notificationStatus: "pending" }))).toBe(true);
    // 关键点：旧逻辑 Number(emailSent)!==1 && !emailError 会把 failed 也算 pending
    expect(isWinnerEmailPending(w({ notificationStatus: "failed", emailError: undefined }))).toBe(false);
    expect(countLotteryEmailFailures([w({ notificationStatus: "failed" }), w({ notificationStatus: "sent" })])).toBe(1);
    expect(countLotteryEmailPending([w({ notificationStatus: "pending" }), w({ notificationStatus: "failed" })])).toBe(1);
  });

  it("emailStatusClass 与失败计数同源", () => {
    expect(emailStatusClass(w({ notificationStatus: "failed" }))).toBe("tag-danger");
    expect(emailStatusClass(w({ notificationStatus: "sent" }))).toBe("tag-success");
    expect(emailStatusClass(w({ notificationStatus: "pending" }))).toBe("tag-warning");
  });

  it("开奖完成反馈档：失败 > 待发 > 成功", () => {
    expect(drawDoneFeedbackKind([])).toBe("empty");
    expect(drawDoneFeedbackKind([w({ notificationStatus: "sent" })])).toBe("ok");
    expect(drawDoneFeedbackKind([w({ notificationStatus: "pending" })])).toBe("email_pending");
    expect(
      drawDoneFeedbackKind([
        w({ notificationStatus: "sent" }),
        w({ id: "2", notificationStatus: "failed" }),
      ]),
    ).toBe("email_failed");
  });
});
