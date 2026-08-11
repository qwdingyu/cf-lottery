/**
 * SQLite 容量基准脚本
 *
 * 目标：
 * 1. 验证 lottery_entries 按活动 COUNT 是否命中覆盖索引，并记录 p50/p95/p99。
 * 2. 验证直付秒杀的「活动计数器 CAS + entry 写入」在多连接竞争下不超发、不丢写。
 * 3. 验证 tenant_usage_snapshots 最新快照汇总的查询成本。
 * 4. 输出 BUSY 重试次数和端到端延迟，为单 VPS 实测提供可重复的基线。
 *
 * 安全边界：
 * - 始终创建系统临时目录下的独立 SQLite 文件，不读取 TURSO_URL 或其他环境变量。
 * - 默认结束后删除临时目录；只有 --keep-db 才保留数据库供 EXPLAIN/文件分析。
 * - 这是数据库微基准，不会调用 Hono 路由、支付网关、邮件或任何外部服务。
 *
 * 用法：
 *   npm run benchmark:sqlite
 *   npm run benchmark:sqlite -- --rows=10000,50000,100000 --cas-requests=500
 *   npm run benchmark:sqlite -- --busy-timeout-ms=5000 --cas-requests=50
 *   npm run benchmark:sqlite -- --keep-db
 */
import { createClient } from "@libsql/client";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { availableParallelism, cpus, freemem, platform, release, totalmem, type, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_ROWS = [10_000, 50_000, 100_000];
const DEFAULT_COUNT_ITERATIONS = 50;
const DEFAULT_CAS_REQUESTS = 500;
const DEFAULT_SNAPSHOT_TENANTS = 500;
const DEFAULT_SNAPSHOT_DAYS = 14;
const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 50;

function usage() {
  console.log(`
SQLite 容量基准脚本

参数：
  --rows=10000,50000,100000  每个独立活动的参与记录数
  --count-iterations=50      每个 COUNT 样本的重复次数
  --cas-requests=500         同一活动并发 CAS 请求数；0 表示跳过
  --snapshot-tenants=500     usage snapshots 汇总基准的租户数
  --snapshot-days=14         每个租户保留的快照天数
  --busy-timeout-ms=0        每个 CAS 连接设置的 SQLite busy_timeout
  --keep-db                  保留临时数据库，便于人工 EXPLAIN/文件检查
  --help                     显示帮助

注意：默认 busy_timeout=0 用于观察应用层指数退避。要评估当前 5000ms
配置，请单独使用小并发运行；busy_timeout 会改变排队形态，不能与默认结果混为一谈。
`);
}

function parsePositiveInteger(raw, name, { allowZero = false } = {}) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${name} 必须是${allowZero ? "非负" : "正"}整数`);
  }
  return value;
}

function parseRows(raw) {
  const rows = String(raw)
    .split(",")
    .map((part) => parsePositiveInteger(part.trim(), "--rows"))
    .sort((a, b) => a - b);
  if (rows.length === 0 || new Set(rows).size !== rows.length) {
    throw new Error("--rows 必须是无重复的正整数列表");
  }
  return rows;
}

function parseOptions(args) {
  const options = {
    rows: DEFAULT_ROWS,
    countIterations: DEFAULT_COUNT_ITERATIONS,
    casRequests: DEFAULT_CAS_REQUESTS,
    snapshotTenants: DEFAULT_SNAPSHOT_TENANTS,
    snapshotDays: DEFAULT_SNAPSHOT_DAYS,
    busyTimeoutMs: 0,
    keepDb: false,
  };

  for (const arg of args) {
    if (arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--keep-db") {
      options.keepDb = true;
      continue;
    }
    if (arg.startsWith("--rows=")) {
      options.rows = parseRows(arg.slice("--rows=".length));
      continue;
    }
    if (arg.startsWith("--count-iterations=")) {
      options.countIterations = parsePositiveInteger(
        arg.slice("--count-iterations=".length),
        "--count-iterations",
      );
      continue;
    }
    if (arg.startsWith("--cas-requests=")) {
      options.casRequests = parsePositiveInteger(
        arg.slice("--cas-requests=".length),
        "--cas-requests",
        { allowZero: true },
      );
      continue;
    }
    if (arg.startsWith("--snapshot-tenants=")) {
      options.snapshotTenants = parsePositiveInteger(
        arg.slice("--snapshot-tenants=".length),
        "--snapshot-tenants",
      );
      continue;
    }
    if (arg.startsWith("--snapshot-days=")) {
      options.snapshotDays = parsePositiveInteger(
        arg.slice("--snapshot-days=".length),
        "--snapshot-days",
      );
      continue;
    }
    if (arg.startsWith("--busy-timeout-ms=")) {
      options.busyTimeoutMs = parsePositiveInteger(
        arg.slice("--busy-timeout-ms=".length),
        "--busy-timeout-ms",
        { allowZero: true },
      );
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  return options;
}

function statement(sql, args = []) {
  return { sql, args };
}

function nowNs() {
  return process.hrtime.bigint();
}

function elapsedMs(startedAt) {
  return Number(nowNs() - startedAt) / 1_000_000;
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.min(
    sortedValues.length - 1,
    Math.ceil(sortedValues.length * fraction) - 1,
  )];
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function runtimeEnvironment() {
  const cpuModels = [...new Set(cpus().map((cpu) => cpu.model).filter(Boolean))];
  return {
    node: process.version,
    platform: platform(),
    arch: process.arch,
    osType: type(),
    osRelease: release(),
    logicalCpuCores: cpus().length,
    availableParallelism: availableParallelism(),
    cpuModels,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
    label: process.env.BENCHMARK_LABEL?.trim() || null,
  };
}

function isSqliteBusyError(error) {
  const err = error || {};
  const message = [
    err.code,
    err.message,
    err.cause?.message,
  ].filter(Boolean).join(" ");
  return [
    "SQLITE_BUSY",
    "SQLITE_LOCKED",
    "database is locked",
    "database table is locked",
    "database busy",
  ].some((pattern) => message.includes(pattern));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createBenchmarkSchema(client) {
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute(`
    CREATE TABLE lottery_draws (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL,
      active_participant_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  await client.execute(`
    CREATE TABLE lottery_entries (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      draw_id TEXT NOT NULL,
      identity_type TEXT NOT NULL DEFAULT 'email',
      identity_value TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      invite_code_id TEXT NOT NULL DEFAULT '',
      ip_hash TEXT NOT NULL DEFAULT '',
      joined_at TEXT NOT NULL,
      spins_left INTEGER NOT NULL DEFAULT 0,
      spins_total_granted INTEGER NOT NULL DEFAULT 0,
      spins_viral_earned INTEGER NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT ''
    )
  `);
  await client.execute(`
    CREATE UNIQUE INDEX idx_entries_unique
    ON lottery_entries(tenant_id, draw_id, identity_type, identity_value)
  `);
  await client.execute(`
    CREATE INDEX idx_entries_identity
    ON lottery_entries(tenant_id, identity_type, identity_value)
  `);
  await client.execute(`
    CREATE INDEX idx_entries_tenant_draw_payment_status
    ON lottery_entries(tenant_id, draw_id, payment_status)
  `);
  await client.execute(`
    CREATE TABLE tenant_usage_snapshots (
      tenant_id TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      activity_count INTEGER NOT NULL DEFAULT 0,
      participant_count INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      winner_count INTEGER NOT NULL DEFAULT 0,
      webhook_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await client.execute(`
    CREATE UNIQUE INDEX pk_tenant_usage_snapshots
    ON tenant_usage_snapshots(tenant_id, snapshot_date)
  `);
}

async function seedCountRows(client, rowsPerDraw) {
  const tenantId = "benchmark-tenant";
  const joinedAt = "2026-08-08T00:00:00.000Z";

  for (const rowCount of rowsPerDraw) {
    const drawId = `count-draw-${rowCount}`;
    await client.execute({
      sql: "INSERT INTO lottery_draws (id, tenant_id, status) VALUES (?, ?, 'open')",
      args: [drawId, tenantId],
    });

    for (let offset = 0; offset < rowCount; offset += 1_000) {
      const batch = [];
      const upperBound = Math.min(offset + 1_000, rowCount);
      for (let index = offset; index < upperBound; index += 1) {
        batch.push(statement(
          `INSERT INTO lottery_entries (
            id, tenant_id, draw_id, identity_type, identity_value, joined_at, payment_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            `${drawId}-entry-${index}`,
            tenantId,
            drawId,
            "email",
            `${drawId}-user-${index}@example.test`,
            joinedAt,
            index % 3 === 0 ? "pending" : "",
          ],
        ));
      }
      await client.batch(batch, "write");
    }
  }
}

async function benchmarkActivityCount(client, rowsPerDraw, iterations) {
  const tenantId = "benchmark-tenant";
  const results = [];

  for (const rowCount of rowsPerDraw) {
    const drawId = `count-draw-${rowCount}`;
    const plan = await client.execute({
      sql: "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM lottery_entries WHERE tenant_id = ? AND draw_id = ?",
      args: [tenantId, drawId],
    });
    const samples = [];

    for (let index = 0; index < iterations; index += 1) {
      const startedAt = nowNs();
      const result = await client.execute({
        sql: "SELECT COUNT(*) AS total FROM lottery_entries WHERE tenant_id = ? AND draw_id = ?",
        args: [tenantId, drawId],
      });
      const total = Number(result.rows[0]?.total ?? 0);
      if (total !== rowCount) {
        throw new Error(`COUNT 结果错误: ${drawId} 期望 ${rowCount}，实际 ${total}`);
      }
      samples.push(elapsedMs(startedAt));
    }

    samples.sort((a, b) => a - b);
    results.push({
      rowCount,
      queryPlan: String(plan.rows[0]?.detail || ""),
      p50Ms: rounded(percentile(samples, 0.5)),
      p95Ms: rounded(percentile(samples, 0.95)),
      p99Ms: rounded(percentile(samples, 0.99)),
      maxMs: rounded(samples.at(-1) || 0),
    });
  }

  return results;
}

async function seedUsageSnapshots(client, tenantCount, days) {
  const rows = [];
  const baseDate = Date.UTC(2026, 7, 1);
  for (let tenantNo = 0; tenantNo < tenantCount; tenantNo += 1) {
    const tenantId = `snapshot-tenant-${String(tenantNo).padStart(5, "0")}`;
    for (let dayNo = 0; dayNo < days; dayNo += 1) {
      const snapshotDate = new Date(baseDate + dayNo * 86_400_000).toISOString().slice(0, 10);
      rows.push(statement(
        `INSERT INTO tenant_usage_snapshots (
          tenant_id, snapshot_date, activity_count, participant_count, event_count, winner_count, webhook_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantId,
          snapshotDate,
          tenantNo + dayNo + 1,
          tenantNo * 10 + dayNo + 10,
          tenantNo * 20 + dayNo + 20,
          tenantNo % 17 + dayNo,
          tenantNo % 11 + dayNo,
        ],
      ));
      if (rows.length >= 1_000) {
        await client.batch(rows.splice(0, rows.length), "write");
      }
    }
  }
  if (rows.length > 0) await client.batch(rows, "write");
}

async function benchmarkUsageSnapshotTotals(client, tenantCount, days, iterations) {
  const latestDayNo = days - 1;
  const expected = {
    tenantCount,
    activityCount: 0,
    participantCount: 0,
    eventCount: 0,
    winnerCount: 0,
    webhookCount: 0,
  };
  for (let tenantNo = 0; tenantNo < tenantCount; tenantNo += 1) {
    expected.activityCount += tenantNo + latestDayNo + 1;
    expected.participantCount += tenantNo * 10 + latestDayNo + 10;
    expected.eventCount += tenantNo * 20 + latestDayNo + 20;
    expected.winnerCount += tenantNo % 17 + latestDayNo;
    expected.webhookCount += tenantNo % 11 + latestDayNo;
  }

  const query = `
    SELECT
      COUNT(*) AS tenant_count,
      SUM(s.activity_count) AS activity_count,
      SUM(s.participant_count) AS participant_count,
      SUM(s.event_count) AS event_count,
      SUM(s.winner_count) AS winner_count,
      SUM(s.webhook_count) AS webhook_count,
      MAX(s.snapshot_date) AS latest_snapshot_date
    FROM tenant_usage_snapshots s
    INNER JOIN (
      SELECT tenant_id, MAX(snapshot_date) AS snapshot_date
      FROM tenant_usage_snapshots
      GROUP BY tenant_id
    ) latest
      ON latest.tenant_id = s.tenant_id
     AND latest.snapshot_date = s.snapshot_date
  `;
  const plan = await client.execute(`EXPLAIN QUERY PLAN ${query}`);
  const samples = [];
  let latestResult;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = nowNs();
    latestResult = await client.execute(query);
    samples.push(elapsedMs(startedAt));
  }

  const row = latestResult.rows[0] || {};
  for (const [key, value] of Object.entries(expected)) {
    if (Number(row[key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] ?? 0) !== value) {
      throw new Error(`usage snapshots 汇总错误: ${key}`);
    }
  }
  samples.sort((a, b) => a - b);
  return {
    tenantCount,
    days,
    snapshotRows: tenantCount * days,
    queryPlan: plan.rows.map((r) => String(r.detail || "")).filter(Boolean),
    latestSnapshotDate: String(row.latest_snapshot_date || ""),
    p50Ms: rounded(percentile(samples, 0.5)),
    p95Ms: rounded(percentile(samples, 0.95)),
    p99Ms: rounded(percentile(samples, 0.99)),
    maxMs: rounded(samples.at(-1) || 0),
  };
}

async function reserveFlashSaleSlot(url, requestNo, capacity, busyTimeoutMs) {
  const client = createClient({ url });
  const startedAt = nowNs();
  let retries = 0;

  try {
    if (busyTimeoutMs > 0) {
      // busy_timeout 属于连接级 PRAGMA。当前业务代码每个请求新建 client，
      // 因此基准也在每个 CAS 请求上单独设置，不能错误地只给种子连接设置。
      await client.execute(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    }

    for (;;) {
      let tx;
      try {
        tx = await client.transaction("write");
        const updated = await tx.execute({
          sql: `
            UPDATE lottery_draws
            SET active_participant_count = active_participant_count + 1
            WHERE id = ?
              AND tenant_id = ?
              AND status = 'open'
              AND active_participant_count < ?
          `,
          args: ["cas-draw", "benchmark-tenant", capacity],
        });
        if ((updated.rowsAffected ?? 0) === 0) {
          await tx.rollback();
          return { outcome: "sold_out", retries, latencyMs: elapsedMs(startedAt) };
        }

        await tx.execute({
          sql: `
            INSERT INTO lottery_entries (
              id, tenant_id, draw_id, identity_type, identity_value, joined_at, payment_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          args: [
            `cas-entry-${requestNo}`,
            "benchmark-tenant",
            "cas-draw",
            "email",
            `cas-user-${requestNo}@example.test`,
            "2026-08-08T00:00:00.000Z",
            "reserved",
          ],
        });
        await tx.commit();
        return { outcome: "success", retries, latencyMs: elapsedMs(startedAt) };
      } catch (error) {
        try {
          if (tx) await tx.rollback();
        } catch {
          // 原始异常决定是否重试；回滚失败不应覆盖它。
        }
        if (retries >= DEFAULT_RETRIES || !isSqliteBusyError(error)) {
          return {
            outcome: "error",
            retries,
            latencyMs: elapsedMs(startedAt),
            error: String(error?.message || error),
          };
        }
        await sleep(DEFAULT_RETRY_BASE_DELAY_MS * 2 ** retries);
        retries += 1;
      }
    }
  } finally {
    await client.close();
  }
}

async function benchmarkFlashSaleCas(url, client, requestCount, busyTimeoutMs) {
  if (requestCount === 0) return null;

  await client.execute({
    sql: "INSERT INTO lottery_draws (id, tenant_id, status) VALUES (?, ?, 'open')",
    args: ["cas-draw", "benchmark-tenant"],
  });

  const startedAt = nowNs();
  const results = await Promise.all(
    Array.from(
      { length: requestCount },
      (_, requestNo) => reserveFlashSaleSlot(url, requestNo, requestCount, busyTimeoutMs),
    ),
  );
  const totalElapsedMs = elapsedMs(startedAt);

  // 不复用建表/种子连接做断言。WAL + libSQL client 下，长寿命连接可能保留旧读快照；
  // 使用全新连接读取提交后的事实，才能验证「所有成功 CAS 都已真实落库」。
  const verifier = createClient({ url });
  let draw;
  let entries;
  try {
    draw = await verifier.execute({
      sql: "SELECT active_participant_count FROM lottery_draws WHERE id = ?",
      args: ["cas-draw"],
    });
    entries = await verifier.execute({
      sql: "SELECT COUNT(*) AS total FROM lottery_entries WHERE tenant_id = ? AND draw_id = ?",
      args: ["benchmark-tenant", "cas-draw"],
    });
  } finally {
    await verifier.close();
  }

  const successes = results.filter((result) => result.outcome === "success");
  const soldOut = results.filter((result) => result.outcome === "sold_out");
  const errors = results.filter((result) => result.outcome === "error");
  const latencies = successes.map((result) => result.latencyMs).sort((a, b) => a - b);
  const retries = results.map((result) => result.retries).sort((a, b) => a - b);
  const activeCount = Number(draw.rows[0]?.active_participant_count ?? 0);
  const entryCount = Number(entries.rows[0]?.total ?? 0);

  if (errors.length > 0 || activeCount !== successes.length || entryCount !== successes.length) {
    throw new Error(
      `CAS 基准失败: success=${successes.length}, sold_out=${soldOut.length}, `
      + `errors=${errors.length}, active_count=${activeCount}, entries=${entryCount}`,
    );
  }

  return {
    requested: requestCount,
    busyTimeoutMs,
    completed: successes.length,
    soldOut: soldOut.length,
    errors: errors.length,
    activeParticipantCount: activeCount,
    persistedEntries: entryCount,
    elapsedMs: rounded(totalElapsedMs),
    effectiveCompletedTps: rounded(successes.length / (totalElapsedMs / 1_000)),
    latencyMs: {
      p50: rounded(percentile(latencies, 0.5)),
      p95: rounded(percentile(latencies, 0.95)),
      p99: rounded(percentile(latencies, 0.99)),
      max: rounded(latencies.at(-1) || 0),
    },
    retries: {
      p50: percentile(retries, 0.5),
      p95: percentile(retries, 0.95),
      max: retries.at(-1) || 0,
      total: retries.reduce((sum, retryCount) => sum + retryCount, 0),
    },
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const directory = await mkdtemp(join(tmpdir(), "cf-lottery-sqlite-capacity-"));
  const databasePath = join(directory, "benchmark.db");
  const url = `file:${databasePath}`;
  const client = createClient({ url });

  try {
    console.log(JSON.stringify({
      benchmark: "cf-lottery SQLite capacity",
      environment: runtimeEnvironment(),
      options,
    }));

    await createBenchmarkSchema(client);
    await seedCountRows(client, options.rows);
    await seedUsageSnapshots(client, options.snapshotTenants, options.snapshotDays);
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");

    const countResults = await benchmarkActivityCount(
      client,
      options.rows,
      options.countIterations,
    );
    const usageSnapshotTotals = await benchmarkUsageSnapshotTotals(
      client,
      options.snapshotTenants,
      options.snapshotDays,
      options.countIterations,
    );
    const databaseBytes = (await stat(databasePath)).size;
    const casResult = await benchmarkFlashSaleCas(
      url,
      client,
      options.casRequests,
      options.busyTimeoutMs,
    );

    console.log(JSON.stringify({
      count: countResults,
      usageSnapshotTotals,
      databaseBytes,
      bytesPerSeededRowApprox: rounded(
        databaseBytes / (
          options.rows.reduce((sum, rowCount) => sum + rowCount, 0)
          + options.snapshotTenants * options.snapshotDays
        ),
      ),
      flashSaleCas: casResult,
      limitations: [
        "仅覆盖 lottery_entries COUNT、tenant_usage_snapshots 汇总和直付秒杀计数器 CAS，不覆盖完整 Hono 请求、鉴权、限流、支付回调和发卡。",
        "结果受当前机器 CPU、磁盘、Node/libsql 版本影响，不能直接外推为生产 VPS 容量承诺。",
        "busy_timeout 会改变 SQLite 等锁与应用层退避的分工，必须使用相同参数做 A/B 对照。",
      ],
    }, null, 2));
  } finally {
    await client.close();
    if (options.keepDb) {
      console.log(`保留基准数据库: ${databasePath}`);
    } else {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`[benchmark:sqlite] ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
