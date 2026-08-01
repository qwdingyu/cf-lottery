/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(process.cwd(), "src");
const ALLOWED_FILES = new Set(["src/test-setup.ts", "src/test-db-usage-sanity.test.ts"]);

function listTypeScriptFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      listTypeScriptFiles(fullPath, out);
      continue;
    }
    if (name.endsWith(".test.ts") || name === "test-setup.ts") out.push(fullPath);
  }
  return out;
}

describe("测试数据库使用规范", () => {
  it("业务测试文件不得自建数据库或维护建表 DDL", () => {
    const violations: Array<{ file: string; pattern: string }> = [];
    const patterns = [
      "CREATE TABLE",
      "ALTER TABLE",
      "DROP TABLE",
      "createClient(",
      "file:test-",
    ];

    for (const file of listTypeScriptFiles(SRC_DIR)) {
      const rel = relative(process.cwd(), file);
      if (ALLOWED_FILES.has(rel)) continue;
      const content = readFileSync(file, "utf-8");
      for (const pattern of patterns) {
        if (content.includes(pattern)) violations.push({ file: rel, pattern });
      }
    }

    expect(violations).toEqual([]);
  });
});
