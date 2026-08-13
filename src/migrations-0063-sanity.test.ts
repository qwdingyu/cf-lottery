/**
 * 迁移 0063 重复卡密去重语义回归测试。
 *
 * 为什么独立成文件（而非放入业务测试）：
 * - 本测试用 createClient 自建临时库 + CREATE TABLE 复现"含重复数据的生产库"场景，
 *   验证迁移语句可安全执行（去重 + PARTIAL 唯一索引）——这属于 DDL 级验证，
 *   会被 test-db-usage-sanity 的"业务测试不得自建库"纪律扫描到，故在 sanity 白名单登记。
 * - 背景（上线预演发现）：0063 若用全局 UNIQUE，被标记 revoked 的多余行之间仍重复，
 *   建索引失败 → server.ts 启动迁移失败 → 进程退出（生产不可用）。本测试锁死该回归。
 */
import { describe, expect, it } from "vitest";

describe("迁移 0063 重复卡密去重语义", () => {
it("重复数据上可执行：去重标记 revoked + PARTIAL 唯一索引创建成功", async () => {
    const { createClient } = await import("@libsql/client");
    const fs = await import("node:fs");
    const dbPath = `/tmp/migrate-0063-test-${crypto.randomUUID()}.db`;
    const c = createClient({ url: `file:${dbPath}` });
    try {
      await c.execute(`CREATE TABLE prize_codes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, prize_id TEXT NOT NULL, code TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'available', winner_id TEXT, payment_order_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
      const rows: Array<[string, string, string, string, string, string]> = [
        ["aaa", "tA", "pA", "DUP-1", "s1", "issued"],
        ["bbb", "tA", "pA", "DUP-1", "s2", "available"],
        ["ccc", "tA", "pA", "DUP-1", "s3", "issued"],
        ["ddd", "tA", "pA", "DUP-2", "s4", "available"],
        ["eee", "tA", "pA", "DUP-2", "s5", "available"],
        ["fff", "tB", "pB", "DUP-1", "s6", "available"], // 跨租户同码：不冲突
      ];
      for (const [id, t, p, code, secret, status] of rows) {
        await c.execute({ sql: `INSERT INTO prize_codes (id, tenant_id, prize_id, code, secret, status) VALUES (?,?,?,?,?,?)`, args: [id, t, p, code, secret, status] });
      }
      const migration = fs.readFileSync("migrations/0063_prize_codes_code_unique.sql", "utf8");
      const up = migration.split("-- UP")[1]!.split("-- DOWN")[0]!;
      for (const stmt of up.split(";").map((s) => s.trim()).filter(Boolean)) {
        await c.execute(stmt); // 不得抛错（上线预演：全局 UNIQUE 会在此失败）
      }
      const all = await c.execute(`SELECT id, status FROM prize_codes ORDER BY id`);
      const statuses = new Map(all.rows.map((r) => [r.id, r.status]));
      expect(statuses.get("aaa")).toBe("issued"); // 保留最早
      expect(statuses.get("bbb")).toBe("revoked");
      expect(statuses.get("ccc")).toBe("revoked");
      expect(statuses.get("ddd")).toBe("available");
      expect(statuses.get("eee")).toBe("revoked");
      expect(statuses.get("fff")).toBe("available"); // 跨租户不受影响

      // available/issued 重复插入 → 拒绝（PARTIAL 唯一约束生效）
      await expect(c.execute({ sql: `INSERT INTO prize_codes (id, tenant_id, prize_id, code, secret, status) VALUES (?,?,?,?,?,?)`, args: ["ggg", "tA", "pA", "DUP-2", "s9", "available"] })).rejects.toThrow();
      // revoked 终态重复插入 → 允许（不参与唯一性）
      await c.execute({ sql: `INSERT INTO prize_codes (id, tenant_id, prize_id, code, secret, status) VALUES (?,?,?,?,?,?)`, args: ["hhh", "tA", "pA", "DUP-1", "s9", "revoked"] });
    } finally {
      await c.close();
      const fs2 = await import("node:fs");
      for (const suffix of ["", "-wal", "-shm"]) { try { fs2.unlinkSync(`${dbPath}${suffix}`); } catch { /* 忽略 */ } }
    }
  });
});
