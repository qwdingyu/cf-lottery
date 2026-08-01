import { describe, expect, it } from "vitest";
import zhCN from "../frontend/src/i18n/zh-CN";
import en from "../frontend/src/i18n/en";

function collectStrings(value: unknown, path = "", out: Array<{ path: string; value: string }> = []): Array<{ path: string; value: string }> {
  if (typeof value === "string") {
    out.push({ path, value });
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectStrings(child, path ? `${path}.${key}` : key, out);
  }
  return out;
}

describe("i18n 文案安全性", () => {
  it("消息目录中不应出现未转义的 @，避免 vue-i18n 解析报错", () => {
    const strings = [...collectStrings(zhCN), ...collectStrings(en)];
    const hits = strings.filter((item) => item.value.includes("@"));
    expect(hits).toEqual([]);
  });
});
