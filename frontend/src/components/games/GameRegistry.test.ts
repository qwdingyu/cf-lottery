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
    expect(hasRegisteredGameExperience("unknown_xyz")).toBe(false);
    expect(hasRegisteredGameExperience("")).toBe(false);
  });

  it("大小写不敏感；未知体验仍返回组件（Submit 回退）", () => {
    expect(getGameComponent("Wheel")).not.toBeNull();
    expect(getGameComponent("LIST")).not.toBeNull();
    expect(getGameComponent("totally_unknown")).not.toBeNull();
    expect(getGameComponent("")).not.toBeNull();
  });
});
