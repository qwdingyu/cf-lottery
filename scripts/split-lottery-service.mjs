/**
 * lottery-service.ts 渐进式拆分工具（第一轮：类型定义 + 套餐配额 + 纯工具）
 *
 * 背景：lottery-service.ts 2656 行，单体过重（docs/049 #17）。
 * 本脚本按行区间把三个最独立的模块切到 src/services/lottery/ 子目录，
 * 并从原文件删除对应区间；随后人工补齐新文件的 imports 与原文件的
 * import / re-export（保持外部 API 不变）。
 *
 * 安全：脚本内置行边界断言——任何断言失败即终止且不写文件，
 * 防止行号漂移时静默切出错误内容（破坏性操作零容忍）。
 *
 * 用法：node scripts/split-lottery-service.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILE = path.join(ROOT, "src/services/lottery-service.ts");

const lines = fs.readFileSync(FILE, "utf8").split("\n");

/** 行边界断言：行号（1-based）内容必须包含期望子串（当前阶段：第二轮） */
const ASSERTIONS = [
  { line: 75, expect: "export async function recordActivityEvent" },
  { line: 591, expect: "查询函数" },
];

for (const { line, expect } of ASSERTIONS) {
  const actual = (lines[line - 1] || "").trim();
  if (!actual.includes(expect)) {
    console.error(`❌ 行 ${line} 断言失败：期望包含 "${expect}"，实际为 "${actual}"`);
    console.error("   行号已漂移，中止拆分（未写入任何文件）");
    process.exit(1);
  }
}

// 1-based 闭区间 [start, end]，含端点（当前阶段：第二轮——集成/事件域）
// 历史：第一轮（types 54-190 / plan 192-373 / utils 890-968）已完成并提交。
const SECTIONS = [
  { file: "src/services/lottery/integration.ts", start: 75, end: 590, label: "集成/事件域（活动事件、API key、外部转化、Webhook）" },
];

// 收集删除行（0-based）
const toRemove = new Set();
for (const { start, end } of SECTIONS) {
  for (let i = start; i <= end; i++) toRemove.add(i - 1);
}

// 写新文件（先写后删：若写失败则原文件保持完整）
for (const { file, start, end, label } of SECTIONS) {
  const body = lines.slice(start - 1, end).join("\n");
  const target = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body + "\n");
  console.log(`✅ 写入 ${file}（行 ${start}-${end}，${label}，${end - start + 1} 行）`);
}

// 重写原文件（保留未删除行）
const kept = lines.filter((_, idx) => !toRemove.has(idx));
fs.writeFileSync(FILE, kept.join("\n") + "\n");
console.log(`✅ 重写 ${path.relative(ROOT, FILE)}：${lines.length} → ${kept.length} 行（移除 ${lines.length - kept.length} 行）`);
console.log("下一步：人工补齐新文件 imports，并在 lottery-service.ts 补 import + re-export");
