/**
 * incentive-engine 导入契约测试（docs/259 §0-5）
 *
 * 存在理由：本项目为 @usethink/incentive-engine 手写了 src/types/incentive-engine.d.ts。
 * 手写声明可以给「不存在的形状」编造类型，因此 tsc 对导入形状错误完全失明。
 * 叠加两个事实后会产生最糟的故障模式：
 *   ① 调用点 referral-rewards-engine.ts 用 engine.Distribute.distributeByDefs(...)；
 *   ② 该调用被 try/catch 包裹，失败只 logError 后 return（奖励不影响参与主流程）。
 * 结果：一旦导入形状不匹配，tsc 绿、构建绿、上线后邀请奖励一条都不发且无任何报警。
 *
 * 实测反例：深导入 @usethink/incentive-engine/src/engine/distribute/index.js 时，
 * 该模块 module.exports = { distributeByDefs, ... } —— 没有 Distribute 这一层，
 * engine.Distribute 为 undefined，全部引擎奖励静默失效。
 *
 * 因此这里断言的是「运行时形状」而非类型，且额外静态校验导入路径。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import engine from "@usethink/incentive-engine/pure";

describe("incentive-engine 导入契约", () => {
  it("pure 子入口必须提供 Distribute.distributeByDefs（调用点依赖的形状）", () => {
    expect(engine).toBeTruthy();
    expect(typeof engine.Distribute).toBe("object");
    expect(typeof engine.Distribute.distributeByDefs).toBe("function");
  });

  it("调用点必须从 /pure 导入，不得深导入 src/engine/**（深导入无 Distribute 层）", () => {
    const src = readFileSync(
      join(process.cwd(), "src/services/lottery/referral-rewards-engine.ts"),
      "utf8",
    );
    const importLine = src
      .split("\n")
      .find((line) => /^import\s+engine\b/.test(line.trim()));
    expect(importLine, "未找到 engine 的 import 语句").toBeDefined();
    expect(importLine).toContain('from "@usethink/incentive-engine/pure"');
    expect(importLine).not.toContain("/src/engine/");
  });

  it("cf-lottery 实际使用的形态（FIXED + SOURCE + 单条 GTE）行为稳定", () => {
    const records = engine.Distribute.distributeByDefs({
      event: {
        sourceNodeId: "entry-1",
        eventValue: "1",
        eventType: "referral",
        attrs: { totalJoinedCount: 3 },
      },
      sourceNode: { id: "entry-1", attrs: { totalJoinedCount: 3 } },
      directParent: null,
      ancestors: [],
      rewardDefs: [
        {
          rewardId: "invite_3",
          type: "FIXED",
          target: "SOURCE",
          fixedAmount: "2",
          conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "3" }],
        },
        {
          rewardId: "invite_5",
          type: "FIXED",
          target: "SOURCE",
          fixedAmount: "5",
          conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "5" }],
        },
      ],
    });

    // 只有已达标的阈值会产出记录；未达标的 invite_5 不得出现
    expect(records.map((r: { rewardId: string }) => r.rewardId)).toEqual(["invite_3"]);
    expect(Number(records[0].amount)).toBe(2);
  });

  it("依赖版本必须精确锁定（引擎的演进由主消费方 rbb 驱动，^ 会引入未知风险）", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.dependencies["@usethink/incentive-engine"]).toBe("4.1.0");
  });
});
