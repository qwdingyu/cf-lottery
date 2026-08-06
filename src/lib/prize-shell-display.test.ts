import { describe, expect, it } from "vitest";
import {
  DEFAULT_RITUAL_PHRASES,
  buildPublicPrizeShellPayload,
  buildShellLabels,
  isInstantLotteryResultMode,
  parseExperienceShellConfig,
  resolvePrizePanelMode,
  sanitizeRitualPhrases,
  shellUsesRealPrizes,
  showPrizePoolStrip,
} from "./prize-shell-display";

describe("prize-shell-display", () => {
  it("result_mode 判定：instant 识别（其余为 delayed 语义）", () => {
    expect(isInstantLotteryResultMode("instant")).toBe(true);
    expect(isInstantLotteryResultMode("INSTANT")).toBe(true);
    expect(isInstantLotteryResultMode("manual")).toBe(false);
    expect(isInstantLotteryResultMode("scheduled")).toBe(false);
    expect(isInstantLotteryResultMode("")).toBe(false);
  });

  it("auto：instant→full_on_shell；manual/scheduled→shell_ritual_pool_full", () => {
    expect(resolvePrizePanelMode("instant", "auto")).toBe("full_on_shell");
    expect(resolvePrizePanelMode("manual", "auto")).toBe("shell_ritual_pool_full");
    expect(resolvePrizePanelMode("scheduled", "auto")).toBe("shell_ritual_pool_full");
    expect(resolvePrizePanelMode("manual", "ritual_only")).toBe("ritual_only");
    expect(resolvePrizePanelMode("instant", "shell_ritual_pool_full")).toBe("shell_ritual_pool_full");
  });

  it("docs/128 红线：delayed + 显式 full_on_shell 降级为仪式短语；instant 仍放行", () => {
    expect(resolvePrizePanelMode("manual", "full_on_shell")).toBe("shell_ritual_pool_full");
    expect(resolvePrizePanelMode("scheduled", "full_on_shell")).toBe("shell_ritual_pool_full");
    expect(resolvePrizePanelMode("", "full_on_shell")).toBe("shell_ritual_pool_full");
    expect(resolvePrizePanelMode(null, "full_on_shell")).toBe("shell_ritual_pool_full");
    expect(resolvePrizePanelMode("instant", "full_on_shell")).toBe("full_on_shell");
  });

  it("sanitizeRitualPhrases：截断、去重、拒绝中奖语义", () => {
    expect(sanitizeRitualPhrases([" 好运连连 ", "好运连连", "恭喜中奖", "一等奖", "参与有礼呀呀呀呀呀"])).toEqual([
      "好运连连",
      "参与有礼呀呀呀呀",
    ]);
    expect(sanitizeRitualPhrases("not-array")).toEqual([]);
    expect(sanitizeRitualPhrases([null, "", "  "])).toEqual([]);
  });

  it("parseExperienceShellConfig：读 promotion.experience", () => {
    const cfg = parseExperienceShellConfig({
      version: 1,
      experience: {
        prizePanelMode: "shell_ritual_pool_summary",
        ritualPhrases: ["期待开奖", "中奖啦"],
      },
    });
    expect(cfg.prizePanelMode).toBe("shell_ritual_pool_summary");
    expect(cfg.ritualPhrases).toEqual(["期待开奖"]);
  });

  it("buildShellLabels：instant 用奖名；delayed 用短语且不出现奖品名", () => {
    const instant = buildShellLabels({
      mode: "full_on_shell",
      prizeNames: ["蓝牙耳机", "谢谢参与"],
    });
    expect(instant).toEqual(["蓝牙耳机", "谢谢参与"]);

    const delayed = buildShellLabels({
      mode: "shell_ritual_pool_full",
      prizeNames: ["蓝牙耳机", "iPhone"],
      ritualPhrases: ["好运连连", "感谢参与"],
      minSlots: 4,
    });
    expect(delayed).toEqual(["好运连连", "感谢参与", "好运连连", "感谢参与"]);
    expect(delayed.join("")).not.toContain("iPhone");
    expect(delayed.join("")).not.toContain("蓝牙");
  });

  it("delayed 无配置短语时用默认中性词", () => {
    const labels = buildShellLabels({
      mode: "shell_ritual_pool_full",
      prizeNames: ["A", "B"],
      ritualPhrases: [],
      minSlots: 2,
    });
    expect(labels[0]).toBe(DEFAULT_RITUAL_PHRASES[0]);
    expect(shellUsesRealPrizes("shell_ritual_pool_full")).toBe(false);
    expect(shellUsesRealPrizes("full_on_shell")).toBe(true);
    expect(showPrizePoolStrip("ritual_only")).toBe("hidden");
    expect(showPrizePoolStrip("shell_ritual_pool_summary")).toBe("summary");
    expect(showPrizePoolStrip("shell_ritual_pool_full")).toBe("full");
  });

  it("buildPublicPrizeShellPayload：manual 默认仪式壳 + full 奖池", () => {
    const payload = buildPublicPrizeShellPayload({
      resultMode: "manual",
      promotionConfig: "{}",
      prizes: [
        { name: "耳机", tierName: "一等奖", winnerCount: 1 },
        { name: "券", tierName: "二等奖", winnerCount: 3 },
      ],
    });
    expect(payload.prizePanelMode).toBe("shell_ritual_pool_full");
    expect(payload.shellUsesRealPrizes).toBe(false);
    expect(payload.prizePoolDisplay).toBe("full");
    expect(payload.shellLabels.length).toBeGreaterThanOrEqual(2);
    expect(payload.shellLabels.some((l) => l.includes("耳机"))).toBe(false);
  });

  it("buildPublicPrizeShellPayload：instant 默认真奖上壳", () => {
    const payload = buildPublicPrizeShellPayload({
      resultMode: "instant",
      promotionConfig: {},
      prizes: [{ name: "耳机", tierName: "一等奖", winnerCount: 1 }],
    });
    expect(payload.prizePanelMode).toBe("full_on_shell");
    expect(payload.shellUsesRealPrizes).toBe(true);
    expect(payload.shellLabels[0]).toBe("耳机");
  });
});
