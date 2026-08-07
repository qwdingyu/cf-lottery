/**
 * 活动模板契约（docs/115）：体验壳 ≠ 结果机。
 * 锁住 lottery 模板不得默认 instant，避免运营看到「即时」却 join 无结果。
 */
import { describe, expect, it } from "vitest";
import { ACTIVITY_TEMPLATES } from "./activity-templates";

describe("ACTIVITY_TEMPLATES 抽奖体验诚实性（docs/115）", () => {
  const wheel = ACTIVITY_TEMPLATES.find((t) => t.id === "lottery-wheel");
  const scratch = ACTIVITY_TEMPLATES.find((t) => t.id === "lottery-scratch");

  it("大转盘：lottery + wheel + manual（非 instant）", () => {
    expect(wheel).toBeTruthy();
    expect(wheel!.defaults).toMatchObject({
      activityKind: "lottery",
      experienceType: "wheel",
      resultMode: "manual",
    });
    expect(wheel!.defaults.resultMode).not.toBe("instant");
  });

  it("刮刮卡：lottery + scratch + manual（非 instant）", () => {
    expect(scratch).toBeTruthy();
    expect(scratch!.defaults).toMatchObject({
      activityKind: "lottery",
      experienceType: "scratch",
      resultMode: "manual",
    });
    expect(scratch!.defaults.resultMode).not.toBe("instant");
  });

  it("lottery 类模板描述不承诺「转即中 / 刮即揭晓中奖」类即时发奖", () => {
    // 允许谈「开奖」「候选池」「登记」；禁止旧营销句残留
    for (const t of [wheel!, scratch!]) {
      expect(t.description).not.toMatch(/随机获得奖品/);
      expect(t.description).not.toMatch(/即时揭晓是否中奖/);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("claim 与 lottery-wheel-instant 可默认 instant；延迟大转盘/刮刮仍禁止", () => {
    const claim = ACTIVITY_TEMPLATES.find((t) => t.id === "claim-download");
    expect(claim?.defaults.resultMode).toBe("instant");
    expect(claim?.defaults.activityKind).toBe("claim");

    const instantWheel = ACTIVITY_TEMPLATES.find((t) => t.id === "lottery-wheel-instant");
    expect(instantWheel?.defaults).toMatchObject({
      activityKind: "lottery",
      experienceType: "wheel",
      resultMode: "instant",
    });
    // 旧模板不得被改成 instant（防运营误选）
    expect(wheel!.defaults.resultMode).toBe("manual");
    expect(scratch!.defaults.resultMode).toBe("manual");
  });

  it("docs/130：限时抢购模板为 claim + flash_sale + instant，不暗示本系统收款", () => {
    const flash = ACTIVITY_TEMPLATES.find((t) => t.id === "flash-sale-rush");
    expect(flash).toBeTruthy();
    expect(flash!.defaults).toMatchObject({
      activityKind: "claim",
      experienceType: "flash_sale",
      resultMode: "instant",
      participationMode: "open",
    });
    expect(flash!.description).toMatch(/不收款|cf-shop|导流/);
    expect(flash!.description).not.toMatch(/在本系统完成支付/);
  });
});
