# Cloudflare 免费版与 Turso 约束下认证和运行安全方案

> 文档编号：023  
> 日期：2026-08-01  
> 背景：项目当前目标是使用免费的 Cloudflare Workers + Turso/libSQL 组合推进 MVP。必须在安全性、可用性、CPU 时间和数据库配额之间做清晰取舍，不能照搬服务器环境的重 CPU 密码方案。

---

## 一、官方限制事实

### 1.1 Cloudflare Workers Free

截至 2026-08-01 核对 Cloudflare Workers 官方限制页，免费层关键约束如下。后续如果官方套餐变更，以官方页面为准：

| 项 | Free |
|---|---:|
| HTTP 请求 CPU 时间 | 10 ms |
| Cron Trigger CPU 时间 | 10 ms |
| 每日请求数 | 100,000/day |

重要细节：

- CPU time 只计算 Worker 代码主动执行 CPU 的时间。
- 等待 `fetch()`、KV、数据库查询等网络 I/O 不计入 CPU time。
- 但 JSON 解析、循环、加密哈希、CSV 拼接、大数组排序、复杂统计都会消耗 CPU。

官方参考：

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/

### 1.2 Turso/libSQL Free

截至 2026-08-01 核对 Turso 官方价格页和 Usage & Billing 文档，Free 层关键约束如下。后续如果官方套餐变更，以官方页面为准：

| 项 | Free |
|---|---:|
| 数据库数量 | 100 |
| 存储 | 5GB |
| Monthly Rows Read | 500 Million |
| Monthly Rows Written | 10 Million |

Turso Usage & Billing 文档说明，带配额的 plan 会按 rows read、rows written、storage 统计；超限查询会失败并返回 `BLOCKED`。该文档还明确：`count`、`avg`、`min`、`max`、`sum` 等聚合函数会对参与聚合的每一行产生 row scan。

官方参考：

- https://turso.tech/pricing
- https://docs.turso.tech/help/usage-and-billing

---

## 二、直接结论

### 2.1 不能做什么

在 Workers Free + Turso Free 组合上，以下做法风险很高：

1. 注册/登录请求内做 `PBKDF2 x 100000`、bcrypt、Argon2 这类高 CPU 密码 KDF。
2. 单个请求内批量处理大量邮件、Webhook、CSV、导入解析。
3. 对大表做无索引扫描、全量统计、全量排序；这主要消耗 Turso rows read 和数据库计算，不直接计入 Worker CPU，但会拖慢请求并耗尽数据库配额。
4. 在公开页每次访问都实时聚合事件表。
5. 用 Durable Objects 规避 CPU 限制。Durable Objects 仍运行在 Workers runtime，并不是免费 CPU 放大器。

### 2.2 可以做什么

当前 MVP 应采用：

1. 认证：低 CPU、带服务端 pepper 的 HMAC-SHA256 存储。
2. 验证码：SHA-256 存储，验证码短期有效。
3. 统计：后台按活动查看，分页/限制行数，不在公开页做重聚合。
4. Webhook：delivery 表 + 幂等键 + Cron 小批量处理。
5. 导出：限制最大行数，必要时拆批。
6. 高并发抢名额：先靠唯一索引/事务，真出现高并发再引入每活动 Durable Object。

---

## 三、认证方案修正

### 3.1 为什么不继续使用 PBKDF2 x 100000

PBKDF2、bcrypt、Argon2 的价值是故意消耗 CPU，降低离线撞库速度。这个思路在传统服务器上正确，但和 Workers Free 的 10ms CPU/request 冲突。

如果每次注册和登录都做高迭代 PBKDF2，风险是：

- 正常用户登录可能触发 CPU 超限。
- 攻击者只要撞登录接口，就能用极低成本消耗 Worker CPU。
- 免费额度下会出现不可预测的 500/1102 类运行错误。

### 3.2 当前采用的 MVP 方案

当前代码采用：

```text
hmac_sha256_v1:<16-byte random salt hex>:<HMAC-SHA256 hex>
```

HMAC key 来源：

```text
PASSWORD_PEPPER || JWT_SECRET
```

设计含义：

- 数据库泄漏但 Worker secret 未泄漏时，攻击者不能只靠数据库离线验证密码。
- 单次 HMAC-SHA256 CPU 成本低，适合 Workers Free。
- 随机 salt 防止相同密码得到相同存储值。
- 登录成功后会把旧 SHA-256 或旧低迭代 PBKDF2 `salt:hash` 升级为当前格式。

### 3.3 这个方案的边界

必须明确：这不是 OWASP 理想密码存储方案的终局。

它依赖服务端 pepper 保密。如果数据库和 Worker secret 同时泄漏，离线防护弱于高成本 KDF。因此后续升级路线是：

1. 短期：保持强随机 `JWT_SECRET`，生产环境单独配置 `PASSWORD_PEPPER`。
2. 中期：优先支持邮箱验证码/魔法链接等 passwordless 登录，减少密码存储风险。
3. 长期：升级 Workers Paid 或外部认证服务后，再迁移到 Argon2id、bcrypt 或高迭代 PBKDF2。

---

## 四、Turso/libSQL 使用约束

### 4.1 读写模式

适合：

- 按 `tenant_id + id` 查询单条记录。
- 按 `tenant_id + draw_id` 查询活动参与、事件、结果。
- 有索引的分页列表。
- 小批量后台操作。
- 后台低频概览中的租户级 `COUNT`，但必须接受 rows read 成本，并准备迁移到快照表。

避免：

- 管理后台首页实时扫描全部活动事件。
- 每次公开页打开都 count 大表。
- 用户参与热路径中做租户级累计 `COUNT`。
- 无上限导出。
- 无索引按 JSON 字段查询。

### 4.2 当前项目必须坚持的索引原则

核心事实表必须始终有租户和活动维度索引：

| 表 | 必须索引 |
|---|---|
| `lottery_draws` | `tenant_id/status/created_at` |
| `lottery_entries` | `tenant_id/draw_id/identity_type/identity_value` |
| `activity_events` | `tenant_id/draw_id/event_type/created_at` |
| `external_conversions` | `tenant_id/draw_id/conversion_type/created_at`，`tenant_id/source/external_event_id` |
| `webhook_deliveries` | `tenant_id/status/created_at`，`webhook_config_id/event_id` |

---

## 五、免费组合下的开发红线

### 5.1 Worker CPU 红线

任何新功能都要先判断是否会在单请求内做：

- 大循环。
- 大 JSON stringify/parse。
- 大 CSV 生成。
- 复杂随机排序。
- 高迭代加密。
- 多次 sequential WebCrypto。
- 大量同步字符串拼接。

如果答案是 yes，必须改成：

- 小批量。
- 分页。
- 后台任务。
- 预聚合。
- 外部服务。
- 付费 Workers 后再做。

### 5.2 数据库红线

任何新查询都要避免：

- 没有 `tenant_id` 条件。
- 没有 limit 的列表。
- 对事件表做全表 count。
- 在 where 中依赖 JSON 字符串模糊搜索。
- 把外部订单、支付、库存塞进活动库。

---

## 六、当前代码状态

已完成：

- 注册密码改为 `hmac_sha256_v1:<salt>:<mac>`。
- 验证码继续 SHA-256 存储。
- 旧 SHA-256 密码兼容登录，并在登录成功后升级。
- 旧低迭代 PBKDF2 `salt:hash` 兼容验证并升级；不在默认登录热路径尝试 `PBKDF2 x 100000`。
- 活动漏斗和外部转化查询均按单活动读取，不在公开页做实时重统计。
- 后台 `/api/admin/stats` 允许低频展示租户累计参与人数；这是 Turso rows read/延迟成本，不是 Worker CPU 热点。
- `PASSWORD_PEPPER` 已写入 `.env.example`、`README.md` 和 `local-deploy-cloudeflare.sh`。

仍需补：

- 登录失败限流持久化。当前内存限流在 Worker 多实例下不是强保证。
- 平台级慢查询/高 CPU 观测。
- 高并发活动的每活动协调单元。
- 如生产库已经存在高迭代 PBKDF2 历史账号，应通过离线脚本、临时付费 Worker 或外部认证迁移，不要让免费 Worker 在线登录接口逐次尝试高迭代校验。

---

## 七、最终建议

当前免费组合最优路线不是“牺牲安全”或“硬上高成本 KDF”，而是：

```text
低 CPU pepper HMAC
  + 强 secret 管理
  + 邮箱验证
  + 速率限制
  + 旧格式渐进升级
  + 后续迁移 passwordless / 外部认证 / 付费 Workers
```

这能让 MVP 在 Cloudflare Free + Turso Free 上稳定运行，同时不把密码直接降级成无盐 SHA-256 或自定义简单 hash。
