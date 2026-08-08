/**
 * 有界并发执行工具测试
 *
 * 验收标准：
 * 1. 并发数不超过上限
 * 2. 所有任务全部完成
 * 3. 单个任务失败不影响其他任务
 * 4. 空数组不报错
 * 5. 并发数 > 任务数时全部立即执行
 */
import { describe, expect, it } from "vitest";
import { runBounded } from "./concurrency";

describe("runBounded 有界并发执行", () => {
  it("并发数不超过上限（跟踪最大并发）", async () => {
    let maxConcurrent = 0;
    let current = 0;

    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    await runBounded(items, 3, async (n) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      // 模拟异步工作
      await new Promise((r) => setTimeout(r, 10));
      current--;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(1); // 实际跑了至少 2 并发
  });

  it("所有任务全部完成", async () => {
    const completed = new Set<number>();
    const items = [1, 2, 3, 4, 5];

    await runBounded(items, 2, async (n) => {
      await new Promise((r) => setTimeout(r, 5));
      completed.add(n);
    });

    expect(completed.size).toBe(5);
    expect([...completed].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("单个任务失败不影响其他任务", async () => {
    const results = await runBounded([1, 2, 3, 4, 5], 2, async (n) => {
      await new Promise((r) => setTimeout(r, 5));
      if (n === 3) throw new Error("任务 3 失败");
      return n * 10;
    });

    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1]).toEqual({ ok: true, value: 20 });
    expect(results[2]).toEqual({ ok: false, error: expect.any(Error) });
    expect(results[3]).toEqual({ ok: true, value: 40 });
    expect(results[4]).toEqual({ ok: true, value: 50 });
  });

  it("空数组不报错返回空数组", async () => {
    const results = await runBounded([], 5, async () => "x");
    expect(results).toEqual([]);
  });

  it("并发数 > 任务数时全部立即执行", async () => {
    let maxConcurrent = 0;
    let current = 0;

    await runBounded([1, 2, 3], 10, async (n) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 10));
      current--;
    });

    expect(maxConcurrent).toBe(3); // 3 个任务全部同时执行
  });

  it("并发数小于 1 时自动调整到 1", async () => {
    let maxConcurrent = 0;
    let current = 0;

    await runBounded([1, 2, 3], 0, async (n) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 10));
      current--;
    });

    expect(maxConcurrent).toBe(1);
  });

  it("返回结果按原顺序排列", async () => {
    const items = ["a", "b", "c", "d"];

    const results = await runBounded(items, 2, async (item, idx) => {
      // 故意让中间任务耗时不同，验证结果顺序与输入顺序一致
      await new Promise((r) => setTimeout(r, idx === 1 ? 30 : 5));
      return item.toUpperCase();
    });

    expect(results.map((r) => r.value)).toEqual(["A", "B", "C", "D"]);
  });
});