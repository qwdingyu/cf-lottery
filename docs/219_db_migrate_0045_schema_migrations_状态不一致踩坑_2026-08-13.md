# 踩坑记录：db:migrate 报错 prize_code_id 列不存在 — 迁移 0045 已应用但未记录到 schema_migrations

## 背景

执行 `npm run db:migrate` 时报错：

```
SQLite input error: no such column: prize_code_id (at offset 121)
SQL: SELECT 1 / CASE WHEN (SELECT COUNT(*) FROM payment_orders
  WHERE status IN ('paid', 'paid_fulfillment_failed')
    AND (prize_code_id IS NULL OR prize_code_id = '')) > 0
  THEN 0 ELSE 1 END;
```

## 原因

迁移 0045_v2_independent_orders.sql 的作用是：
1. 新建 `payment_order_items` 表
2. 将存量数据从 `payment_orders` 迁移到 `payment_order_items`
3. **重建 `payment_orders` 表**，移除 `prize_code_id` 列

在远程 Turso 数据库中：
- `payment_order_items` 表已存在（由 0045 创建）
- `payment_orders` 已是 V2 版本（无 `prize_code_id` 列，有 `buyer_identity_type` 等新列）
- **但 `schema_migrations` 表中没有 version=0045 的记录**

状态输出显示 `0045_v2_independent_orders.sql` 为 `○ pending`，但实际上 0045 已被手动/通过其他方式应用到数据库，却未在 `schema_migrations` 记录。

当重新运行 `npm run db:migrate` 时：
1. 前几条语句（CREATE TABLE IF NOT EXISTS payment_order_items、CREATE INDEX）是幂等操作，成功
2. 数据迁移的 fail-closed 检查（`SELECT 1 / CASE WHEN ... prize_code_id IS NULL`）引用了已不存在的 `prize_code_id` 列，失败

## 排查过程

1. 查看 `--status` 输出：0045 为 `○ pending`
2. 查看 `PRAGMA table_info(payment_orders)`：发现列结构已是 V2（无 `prize_code_id`，有 `buyer_identity_type` 等）
3. 查看 `sqlite_master` 表列表：`payment_order_items` 表已存在
4. 确认 `payment_order_items` 只由 0045 创建，因此 0045 必然已被应用
5. 查看 `schema_migrations` 表：版本 0001-0028（缺 0029）、0030-0044 共 42 条记录，**无 0045**

## 解决方案

在 `schema_migrations` 表中插入 0045 记录，使其跳过该迁移：

```sql
INSERT INTO schema_migrations (version, name) VALUES ('0045', 'v2_independent_orders');
```

重新运行 `npm run db:migrate`，0045 被跳过，0046-0062 共 17 个迁移全部成功。

## 建议

1. **迁移脚本应增加幂等性检查**：对于涉及表重建的迁移，在入口处检查目标表/列是否存在，避免因状态不一致而报错。
2. **记录迁移时使用事务**：将迁移执行和记录操作放在同一个事务中，确保原子性（当前 migrate.mjs 的 `executeMigrationFile` 和 `recordMigration` 是分开的，若 `recordMigration` 失败，迁移已执行但未记录）。
3. **定期检查 schema_migrations 与实际 schema 的一致性**：可增加一个 `--verify` 命令，比对 `schema_migrations` 记录与实际表结构。