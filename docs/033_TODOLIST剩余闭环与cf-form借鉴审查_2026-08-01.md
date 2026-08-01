# TODOLIST 剩余闭环与 cf-form 借鉴审查

> 文档编号：033  
> 日期：2026-08-01  
> 定位：回答“014 中还有哪些没有完成、cf-form 是否值得借鉴、问卷/投票等是否已形成闭环”。  
> 结论：当前不要继续加玩法。应先把“活动配置 -> 发布预检 -> 公开参与 -> 数据沉淀 -> 后台复盘 -> 承接导流 -> Webhook/API/导出”这条主链路打通。

---

## 一、总判断

当前系统已经具备轻量活动引擎的骨架：

```text
activity_kind       活动业务类型
participation_mode  谁能参加、如何校验
experience_type     前台交互皮肤
result_mode         结果如何产生
promotion_config    完成后的承接和导流
activity_events     漏斗事件
external_conversions 外部转化回传
```

但问卷、投票、资料领取、审核申请还没有达到“可作为 SaaS 客户正式购买能力”的闭环水平。它们现在更接近“有入口、有枚举、有默认模式”，不是完整产品能力。

最危险的点是：投票当前没有固定选项和投票提交表，`/api/admin/draws/:id/tally` 按 `lottery_entries.identity_value` 分组，而公开参与接口仍把邮箱写进 `identity_value`。如果直接把投票上线，统计出来的是邮箱分组，不是投票选项。

---

## 二、014 中仍未完成的事项

### 2.1 P0：发布闸门剩余项

| 项目 | 当前状态 | 必须补齐的验收 |
|------|----------|----------------|
| 公开事件治理 | 已有事件白名单、字段长度限制、内存限流 | 补正式测试；明确 `page_view` 采样/聚合策略；禁止把高频事件接入数据库级持久限流 |
| 首个 `platform_owner` 初始化 | `scripts/bootstrap-platform-owner.mjs` 已存在 | 部署文档写清：先注册用户，再运行脚本授予平台角色；在空库/新环境演练一次 |
| 发布回归矩阵 | `p0-flow.test.ts` 覆盖了核心创建、发布、参与链路 | 补媒体、Webhook、R2 未配置、静态 slug、投票/问卷配置预检等专项回归 |

P0 现在不是“大面积重构”，而是把发布前安全阀补严。

### 2.2 P1：受控 Beta 前必须补的产品闭环

| 项目 | 当前状态 | 缺口 |
|------|----------|------|
| 问卷字段配置器 | 只有 `activity_kind=survey`、`experience_type=form` 和硬编码表单组件 | 没有字段 schema、后台配置 UI、公开动态渲染、提交 payload、导出和统计 |
| 投票选项配置器 | 只有 `activity_kind=vote`、`experience_type=ballot` 默认值 | 没有 ballot 组件、没有固定选项、没有 vote submission、当前 tally 口径错误 |
| 发布前预检升级 | 已有基础 title/time/roster/invite/code pool 检查 | 缺问卷字段、投票选项、CTA、Webhook、容量、时间顺序和前端可见提示 |
| 奖品媒体治理 | R2 上传、2MiB、签名校验、公开读取已建 | 缺 media route 正式测试、`media_assets` 资产表、租户图片数量/容量治理 |
| 活动模板产品化 | 模板基础已建 | 模板还未穿透到“默认配置 + 预检 + 二维码/链接 + 承接动作”的 3 分钟创建体验 |
| 租户侧复盘 | 单活动漏斗卡片和关键比率基础已建 | 缺异常提示、来源治理、数据口径说明和测试 |
| 统一承接动作 | `promotion_config` 基础存在 | 还未覆盖未中奖、候补、提交成功、中奖、审核通过/拒绝等统一状态 |
| CORS/观测/导出边界 | 局部已有 | 管理接口来源收紧、路由耗时/错误观测、大导出分页边界仍需补强 |
| 平台运营后端 | 平台路由、用量快照、审计表基础已建 | 仍需租户状态/套餐调整审计、异常任务看板、Webhook 手动重跑审计 |

### 2.3 P2/P3 暂不应抢跑

预约、签到、核销、白标、复杂分享裂变、自定义域名、Durable Objects 都不是现在的主线。它们应该等问卷/投票/资料领取等低成本高价值入口闭环后再做。

---

## 三、cf-form 值得借鉴什么

`/Users/dingyuwang/0-X/github_workflow/templates/cf-form` 有价值，但不能整套搬。

### 3.1 应该借鉴

| 来源 | 可借鉴点 | 在 cf-lottery 中的落点 |
|------|----------|------------------------|
| `src/config/forms.ts` | `FieldType`、`FormField`、字段级校验、必填/长度/选项白名单 | 做成 `ActivityConfigV1` 的 survey 字段定义和校验 helper |
| `validateBusinessFields()` | 从配置驱动提交校验，而不是信任前端 | 公开参与时先校验 payload，再同事务写 entry + submission |
| `submissions.payload_json` | JSON 存动态表单答案 | 新增 `activity_submissions.payload_json` |
| `idempotency-key` | 防止网络重试导致重复提交 | P1 可先依赖 entry 唯一约束；P2 对 Webhook/表单提交补幂等键 |
| Turnstile 思路 | 公开表单防刷的可选外层保护 | 作为 Free 阶段可选配置，不作为 P1 必须项 |

### 3.2 不应该直接搬

| 不搬内容 | 原因 |
|----------|------|
| 独立 `forms` 主表 | cf-lottery 的主实体是活动 `lottery_draws`，再建一套表单产品会破坏统一活动链路 |
| 独立 `/:slug/submissions` 提交流 | 会产生“已参与但未提交”或“已提交但未参与”的半成功数据 |
| `@usethink/cf-core` 依赖 | 当前项目没有该依赖，直接引入会扩大依赖和迁移成本 |
| 每次公开提交都写 DB 限流日志 | 在 Cloudflare + Turso Free 下容易放大 rows written，不能照搬 |
| `number/date/hidden/divider/heading` 全量字段 | P1 只需要低成本获客字段，字段越多 UI/校验/导出越复杂 |

---

## 四、问卷/投票是否闭环

### 4.1 问卷

| 环节 | 当前状态 | 结论 |
|------|----------|------|
| 模板入口 | 有 `survey-feedback` | 基础已建 |
| 后台配置 | 只有活动类型/描述文本 | 未闭环 |
| 公开渲染 | `FormGame.vue` 固定姓名/邮箱 | 未闭环 |
| 提交保存 | `join/verify-join` 只保存参与记录 | 未闭环 |
| 后台查看/导出 | 无问卷答案表 | 未闭环 |
| 承接导流 | `promotion_config` 可复用 | 基础可用 |
| Webhook | 事件体系可复用 | 需要 submission payload |

结论：问卷不能作为正式功能上线，只能作为未来能力入口展示。

### 4.2 投票

| 环节 | 当前状态 | 结论 |
|------|----------|------|
| 模板入口 | 有 `vote-pick` | 基础已建 |
| 后台配置 | 没有固定选项配置 | 未闭环 |
| 公开渲染 | `GameRegistry` 没有 `ballot` 组件 | 未闭环 |
| 提交保存 | 公开接口只接收 email/code/ref | 未闭环 |
| 计票 | 当前按 `identity_value` 分组 | 口径错误 |
| 结果展示 | 无配置化展示口径 | 未闭环 |

结论：投票当前不能对外宣传为可用功能。必须先做固定选项、提交表和按 `optionId` 聚合。

### 4.3 资料领取/审核申请/签到

| 类型 | 当前状态 | 发布建议 |
|------|----------|----------|
| 资料领取 `claim` | 模板和 `reveal` 体验有基础，但缺资料配置和领取记录 payload | 作为 P1.19 的表单提交能力复用，不单独开新系统 |
| 审核申请 `approval` | 有后端审核 outcome 基础，但缺申请表单字段 | 复用 `activity_submissions`，审核结果写 `activity_outcomes` |
| 签到 `checkin` | 服务层通过日期后缀支持每日一次 | 需要公开签到记录展示和后台统计后再推广 |
| 接龙 `signup_chain` | 参与、容量、候补 outcome 基础已通 | P2 补候补转正、通知、导出和后台状态操作 |

---

## 五、不要堆代码的最优实施路径

### 5.1 统一主链路

所有玩法必须复用同一条链：

```text
activity_config
  -> publish-check
  -> public render
  -> join / verify-and-join
  -> lottery_entries
  -> activity_submissions 或 activity_outcomes
  -> activity_events
  -> promotion_config
  -> webhook / export / analytics
```

不要为问卷做一套 `/forms`，不要为投票做一套 `/votes`，不要为资料领取再做一套 `/claims`。它们都是活动的不同配置和结果形态。

### 5.2 第一批只做两个结构

建议只新增：

```text
lottery_draws.activity_config
activity_submissions
```

`media_assets` 也需要，但可以作为媒体治理批次独立做，不和问卷/投票混在一起。

### 5.3 P1 字段边界

问卷 P1 只支持：

```text
text / email / phone / textarea / select / radio / checkbox
```

投票 P1 只支持：

```text
固定选项
单选
每人一次
结果展示：不展示 / 提交后展示 / 活动结束后展示
```

明确不做：

```text
条件逻辑
拖拽表单设计器
多页表单
用户侧上传文件
任意报表
复杂反作弊
复杂多选计权
```

---

## 六、Cloudflare + Turso Free 下的落地边界

以官方限制页面为准，免费层设计必须保守：

- Workers Free 的关键约束是请求量、CPU 时间、内存和 subrequest 数；公开热路径应少读少写。
- Turso/libSQL 的核心风险是 rows read/write、存储和响应延迟；后台低频 `COUNT` 可以接受，公开热路径累计统计不能每次扫表。
- R2 免费层适合少量运营图片，不适合让用户上传大量图片或把图片代理做成高流量热路径。

当前可承诺的运营规模应保守：

| 场景 | 建议口径 |
|------|----------|
| 日常测试/内测 | 100-500 次完成参与/日 |
| 受控 Beta | 1,000-3,000 次完成参与/日 |
| 优化后稳健运营 | 5,000-10,000 次完成参与/日，需要观察 rows read/write 和 Worker requests |
| 单活动爆发 | 超 5,000 人应提前压测和人工监控 |
| 正式商业 SLA | 不应承诺在 Free 层完成，应升级 Workers Paid 并做用量快照/采样/必要时独立 DB |

这些不是平台极限，而是避免免费层资源灾难的运营边界。

---

## 七、最终建议

下一阶段只排 4 个实施包：

1. **发布闸门包**：公开事件测试/采样策略、首个 owner 初始化演练、完整回归矩阵。
2. **ActivityConfig 包**：冻结 `ActivityConfigV1`，把 survey/vote/claim/approval 的轻量配置统一进去。
3. **Submission 包**：新增 `activity_submissions`，扩展 `join/verify-and-join`，保证 entry + submission 原子写入。
4. **运营闭环包**：发布前预检、后台 submissions/tally/export、漏斗异常提示、Webhook payload。

完成这 4 包前，不建议继续加新玩法。真正的产品价值不是玩法数量，而是 SaaS 客户能在几分钟内低错误率地创建活动，并且能复盘、承接和接系统。

---

## 八、核对来源

- 本仓库：`docs/014_全局TODOLIST_2026-08-01.md`
- 本仓库：`docs/031_P1运营闭环完善详细方案_2026-08-01.md`
- 本仓库：`src/lib/activity-templates.ts`
- 本仓库：`frontend/src/components/games/FormGame.vue`
- 本仓库：`frontend/src/components/games/GameRegistry.ts`
- 本仓库：`src/routes/admin-lottery.ts`
- 本仓库：`src/routes/public-lottery.ts`
- 旁路项目：`/Users/dingyuwang/0-X/github_workflow/templates/cf-form/src/config/forms.ts`
- 旁路项目：`/Users/dingyuwang/0-X/github_workflow/templates/cf-form/src/routes/forms.ts`
- 旁路项目：`/Users/dingyuwang/0-X/github_workflow/templates/cf-form/src/db/schema.ts`
- Cloudflare Workers Limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare R2 Pricing: https://developers.cloudflare.com/r2/pricing/
- Turso Pricing: https://turso.tech/pricing
- Turso Usage and Billing: https://docs.turso.tech/help/usage-and-billing.md
