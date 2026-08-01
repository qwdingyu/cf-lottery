import { describe, expect, it } from "vitest";
import { baseCompile } from "@intlify/message-compiler";
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
  it("消息目录中的文案必须能被 vue-i18n 编译，避免运行时报 SyntaxError", () => {
    const strings = [...collectStrings(zhCN), ...collectStrings(en)];
    const failures: Array<{ path: string; value: string; code?: number; message: string }> = [];

    for (const item of strings) {
      try {
        // vue-i18n 会把 @、{}、| 等字符作为消息语法解析；测试必须使用同一编译器主动抛错。
        baseCompile(item.value, {
          onError: (err) => {
            throw err;
          },
        });
      } catch (err) {
        failures.push({
          path: item.path,
          value: item.value,
          code: err && typeof err === "object" && "code" in err ? Number(err.code) : undefined,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    expect(failures).toEqual([]);
  });
});
