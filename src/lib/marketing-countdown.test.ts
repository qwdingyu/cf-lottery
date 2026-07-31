import { describe, it, expect } from "vitest";
import { formatMarketingCountdown } from "./marketing-countdown";

function t(key: string, params?: Record<string, number>) {
  if (key === "productCard.marketingEndsMinutes") return `${params!.minutes} 分钟后结束`;
  if (key === "productCard.marketingEndsHours") return `${params!.hours} 小时后结束`;
  if (key === "productCard.marketingEndsDays") return `${params!.days} 天后结束`;
  return key;
}

describe("formatMarketingCountdown", () => {
  it("returns empty string when endsAt is in the past", () => {
    const now = Date.now();
    const past = new Date(now - 60000).toISOString();
    expect(formatMarketingCountdown(past, now, t)).toBe("");
  });

  it("returns minutes format when less than 60 minutes remaining", () => {
    const now = Date.now();
    const future = new Date(now + 5 * 60000).toISOString();
    expect(formatMarketingCountdown(future, now, t)).toBe("5 分钟后结束");
  });

  it("returns hours format when between 1 and 48 hours remaining", () => {
    const now = Date.now();
    const future = new Date(now + 3 * 3600000).toISOString();
    expect(formatMarketingCountdown(future, now, t)).toBe("3 小时后结束");
  });

  it("returns days format when 48+ hours remaining", () => {
    const now = Date.now();
    const future = new Date(now + 72 * 3600000).toISOString();
    expect(formatMarketingCountdown(future, now, t)).toBe("3 天后结束");
  });

  it("returns empty string when endsAt is empty", () => {
    expect(formatMarketingCountdown("", Date.now(), t)).toBe("");
  });

  it("returns empty string when endsAt is invalid", () => {
    expect(formatMarketingCountdown("not-a-date", Date.now(), t)).toBe("");
  });

  it("rounds up minutes (ceil)", () => {
    const now = Date.now();
    const future = new Date(now + 90 * 1000).toISOString(); // 1.5 minutes
    expect(formatMarketingCountdown(future, now, t)).toBe("2 分钟后结束");
  });

  it("returns empty string when endsAt equals now", () => {
    const now = Date.now();
    expect(formatMarketingCountdown(new Date(now).toISOString(), now, t)).toBe("");
  });
});