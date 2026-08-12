/**
 * GameRegistry：体验别名与未知回退，避免公开页无主 CTA 壳。
 */
import { describe, expect, it } from "vitest";
import { getGameComponent, hasRegisteredGameExperience } from "./GameRegistry";

describe("GameRegistry", () => {
  it("显式映射含 list/queue/ballot 等别名", () => {
    expect(hasRegisteredGameExperience("wheel")).toBe(true);
    expect(hasRegisteredGameExperience("list")).toBe(true);
    expect(hasRegisteredGameExperience("queue")).toBe(true);
    expect(hasRegisteredGameExperience("calendar")).toBe(true);
    expect(hasRegisteredGameExperience("checkin")).toBe(true);
    expect(hasRegisteredGameExperience("ballot")).toBe(true);
    expect(hasRegisteredGameExperience("form")).toBe(true);
    expect(hasRegisteredGameExperience("submit")).toBe(true);
    expect(hasRegisteredGameExperience("flash_sale")).toBe(true);
    expect(hasRegisteredGameExperience("unknown_xyz")).toBe(false);
    expect(hasRegisteredGameExperience("")).toBe(false);
  });

  it("大小写不敏感；未知体验仍返回组件（Submit 回退）", () => {
    expect(getGameComponent("Wheel")).not.toBeNull();
    expect(getGameComponent("LIST")).not.toBeNull();
    expect(getGameComponent("totally_unknown")).not.toBeNull();
    expect(getGameComponent("")).not.toBeNull();
  });

  it("同一体验多次调用返回同一组件引用（防刮刮卡重渲染被卸载复位）", () => {
    // 回归：LotteryView 静默刷新（30s 轮询/focus/visibilitychange）会重渲染模板并
    // 重新调用 getGameComponent。若每次新建 defineAsyncComponent，Vue 的 :is 按引用
    // 比较会误判组件「变了」→ 卸载重挂 → canvas 涂层复位、永远刮不开。
    // 现在必须缓存同一引用，重渲染时复用组件实例。
    const a = getGameComponent("scratch");
    const b = getGameComponent("scratch");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toBe(b);

    // 大小写归一后也应命中同一缓存
    expect(getGameComponent("Scratch")).toBe(a);

    // 未知 key 回退 Submit，同样应稳定复用同一引用
    const u1 = getGameComponent("totally_unknown");
    const u2 = getGameComponent("totally_unknown_2");
    expect(u1).not.toBeNull();
    expect(u2).toBe(u1);
  });
});
