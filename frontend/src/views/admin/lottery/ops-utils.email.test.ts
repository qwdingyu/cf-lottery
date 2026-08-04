import { describe, expect, it } from "vitest";
import {
  buildLotteryWinnersCsvRows,
  countLotteryEmailFailures,
  countLotteryEmailPending,
  drawDoneFeedbackKind,
  emailStatusClass,
  isWinnerEmailFailed,
  isWinnerEmailPending,
  isWinnerEmailSent,
  winnersPollSettleKind,
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

  it("轮询收敛：pending→failed 报失败；pending→sent 报成功；触顶仍 pending", () => {
    expect(
      winnersPollSettleKind({ prevPending: 2, nextFail: 1, nextPending: 0, hitMaxRefreshes: false }),
    ).toBe("became_failed");
    expect(
      winnersPollSettleKind({ prevPending: 2, nextFail: 0, nextPending: 0, hitMaxRefreshes: false }),
    ).toBe("all_sent");
    expect(
      winnersPollSettleKind({ prevPending: 1, nextFail: 0, nextPending: 1, hitMaxRefreshes: true }),
    ).toBe("still_pending");
    expect(
      winnersPollSettleKind({ prevPending: 1, nextFail: 0, nextPending: 1, hitMaxRefreshes: false }),
    ).toBe("none");
  });

  it("buildLotteryWinnersCsvRows 导出奖品与卡密/人工履约", () => {
    const rows = buildLotteryWinnersCsvRows(
      [
        w({
          identityValue: "a@t.com",
          prizeName: "周边",
          prizeCode: "C1:S1",
          cardAccountLabel: "C1",
          notificationStatus: "sent",
        }),
        w({
          id: "2",
          identityValue: "b@t.com",
          prizeName: "礼品",
          prizeType: "manual_fulfillment",
          fulfillmentKind: "manual",
          fulfillmentNote: "线下领",
          notificationStatus: "pending",
        }),
      ],
      {
        email: "邮箱",
        prize: "奖品",
        fulfillment: "履约",
        emailStatus: "邮件",
        sent: "已发送",
        pending: "待发送",
        failed: "失败",
        manual: "人工发放",
        codeMissing: "未锁定卡密",
      },
    );
    expect(rows[0]).toEqual(["邮箱", "奖品", "履约", "邮件"]);
    expect(rows[1]).toEqual(["a@t.com", "周边", "C1:S1", "已发送"]);
    expect(rows[2]![2]).toContain("人工发放");
    expect(rows[2]![2]).toContain("线下领");
  });
});
