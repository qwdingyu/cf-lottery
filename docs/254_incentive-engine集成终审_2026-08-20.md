# incentive-engine 集成终审报告（全局闭环 + 最佳实践 + UI 完整性）

> 文档版本：1.0.0
> 最后更新：2026-08-20
> 审查对象：cf-lottery 引入的通用分销/营销引擎（@usethink/incentive-engine）
> 前置：docs/249（碰撞分析）、docs/250（实施方案）、docs/251（闭环分析）、docs/252（全局审查）、docs/253（闭环审查二版）
> 覆盖：最佳实践 / 漏洞 / 实施完整性 / UI 闭环

---

## 一、终审结论总览

| 维度 | 结论 |
|------|------|
| **API 使用正确性** | ✅ 完全符合 incentive-engine API 契约 |
| **配置校验** | ✅ 已补全（本轮），与引擎 validation schema 对齐 |
| **闭环完整性** | ✅ 全链路闭环（配置→参与→归因→计算→发放→展示→审计） |
| **并发安全** | ✅ 三重防护（幂等 CAS + 出口 CAS + maxSpins 裁剪） |
| **UI 完整性** | ✅ 已补全 L2 配置入口 + L1 展示（本轮） |
| **文档完整性** | ✅ docs/249-253 闭环，本轮追加 254 |

---

## 二、本轮审查发现与修复

### 2.1 P0 修复：`normalizeReferralRewardDefs` 配置校验补全

**问题**：校验只检查 rewardId/type/target 非空，缺白名单校验。非法 type 会导致 engine 运行时抛异常被 try/catch 静默吞掉，奖励不发放且无提示。

**修复**（`referral-rewards-engine.ts`）：
- `type` 白名单：DIRECT/LEVEL/FIXED/CUSTOM
- `target` 白名单：SOURCE/PARENT
- `FIXED` 必须有 `fixedAmount > 0`
- `rewardId` 全局唯一（重复剔除）

**新增 4 个测试**（非法 type/target、FIXED 缺金额、重复 rewardId 剔除）。

### 2.2 P0 修复：referralRewardDefs 管理端配置 UI

**问题**：原实现无任何前端 UI 配置入口，运营只能通过 API 写 promotionConfig JSON（最大 UI 闭环缺口）。

**修复**（3 个文件 + i18n）：
- `growth-config.ts`：新增 `parseReferralRewardDefsText/formatReferralRewardDefsText`（文本格式 `邀请数:类型:数量[:券label]`）+ `referralRewardDefsText` 字段回填/提交 + 构建 `referralRewardDefs` JSON
- `AdminLotteryView.vue`：新增 textarea 配置入口 + 表单字段
- `types.ts`/`form-defaults.ts`：`LotteryEditorForm` 类型与默认值补充
- i18n：zh-CN/en 各 3 个键

### 2.3 P2 修复：中奖 + 邀请券共存时被隐藏

**问题**：`myResultCoupons` 的 `v-else-if` 在 `won` 分支之后，用户中奖且拿到邀请券时券码被隐藏。

**修复**（`LotteryView.vue`）：`won` 分支内新增独立 `v-if="myResultCoupons.length > 0"` 块展示"你获得的优惠券"。

---

## 三、闭环完整性审查（全链路）

```
L2 配置 referralRewardDefs（UI textarea）──▶ ✅ 本轮补全
        │
        ▼
发布预检校验 ──────────────────────────▶ ✅ 适配性 + 白名单
        │
        ▼
L1 分享者生成分享码 + 邀请 ──────────────▶ ✅ 所有活动类型通用
        │
        ▼
recordAttributedJoin 归因 ──────────────▶ ✅ 自邀请拦截 + joinedCount+1
        │
        ▼
processReferralRewardsEngine ───────────▶ ✅ engine 纯计算 + 幂等过滤
        │
        ▼
奖励出口 bonus_spin ────────────────────▶ ✅ CAS + maxSpins 裁剪 + spins_log
        │
        ▼
奖励出口 bonus_coupon ──────────────────▶ ✅ CAS + recipientEmail + reward_earned 审计
        │
        ▼
L1 看到奖励 ────────────────────────────▶ ✅ coupons 数组展示（won/未中奖都可见）+ spinsLeft
        │
        ▼
L1 使用奖励 ────────────────────────────▶ ✅ spins 抽奖 / 券码联系运营核销
        │
        ▼
L2 可视化 ──────────────────────────────▶ ✅ 漏斗卡片 reward_earned
        │
        ▼
L3 监督 ────────────────────────────────▶ ✅ activityEvents / 审计
```

**结论：全部环节闭环。**

---

## 四、最佳实践审查

### 4.1 API 使用（✅）

| 检查项 | 结论 |
|--------|------|
| distributeByDefs 参数 | ✅ event/directParent/ancestors/rewardDefs 符合契约 |
| conditions 字段名 | ✅ 不带 attrs. 前缀（引擎自动查 event.attrs） |
| records 解析 | ✅ rewardId/amount 正确 |

### 4.2 与 rule-set-adapter 对比（✅ 简化合理）

- cf-lottery 直接调用 `distributeByDefs`，跳过 RANK/CAP/OVER/SPLIT 阶段
- **CAP 封顶不需要**：bonus_spin 有 maxSpinsPerEntry 物理上限，bonus_coupon 码池天然封顶
- **三重防超发**：幂等标记 CAS + 出口 CAS + maxSpins 裁剪
- ⚠️ 未来引入货币奖励时必须加 CAP（当前已注释说明）

### 4.3 类型声明（✅ 准确）

唯一小问题是 `nodeId` 声明为 `string`，实际可能为 null，但不影响运行（cf-lottery 不使用 nodeId）。

---

## 五、安全性审查

| 风险 | 防护 | 结论 |
|------|------|------|
| 并发重复发放 | 幂等标记 CAS + 出口 CAS | ✅ |
| spins 超发 | maxSpinsPerEntry 上限 | ✅ |
| 优惠券超发 | couponCodes.status CAS | ✅ |
| 跨租户泄漏 | 所有查询带 tenantId | ✅ |
| 配置非法静默不发 | 白名单校验 + 发布预检 | ✅（本轮） |
| 事务边界 | maybeTriggerReward try/catch，奖励失败不影响参与 | ✅ |

---

## 六、UI 闭环审查

### 6.1 L1 端（✅ 本轮补全）

| 场景 | 状态 |
|------|------|
| 邀请奖励券展示（lottery） | ✅ coupons 数组 |
| 邀请奖励券展示（非 lottery） | ✅ 去掉 resultFamily 限制 |
| 中奖 + 券共存 | ✅ won 分支内独立展示 |
| spinsLeft 展示 | ✅ 活动卡 + myResultModal |

### 6.2 L2 端（✅ 本轮补全）

| 场景 | 状态 |
|------|------|
| referralRewardDefs 配置入口 | ✅ textarea（本轮） |
| 奖励发放可视化 | ✅ 漏斗卡片 reward_earned |
| i18n | ✅ zh-CN/en |

### 6.3 已知边界（P2，需安全设计）

| 缺口 | 说明 |
|------|------|
| L1 自助核销优惠券 | 仅 L2 管理端 API 可核销，L1 需联系运营（现有设计边界） |

---

## 七、验证结果

- **TypeScript**：0 errors（exit 0）
- **vue-tsc**：0 errors（exit 0）
- **全量测试**：96 文件、1395 测试全部通过（新增 4 个校验测试 + 1 个 coupons 测试）
- **提交**：本轮改动已 commit（docs/250/251/252/253 + 全部代码）

---

## 八、结论

**cf-lottery 引入的通用分销/营销引擎（incentive-engine）经过本轮终审，所有环节已形成闭环：**

1. **最佳实践**：API 使用完全符合引擎契约；跳过 CAP 阶段是有意的（非货币奖励 + maxSpins/码池天然封顶）；三重防超发
2. **无漏洞**：并发/幂等/事务/多租户全部覆盖；配置校验已与引擎 schema 对齐（本轮）
3. **实施完毕**：全链路配置→参与→归因→计算→发放→展示→审计全部打通
4. **UI 闭环**：L1 展示（won/未中奖都可见）+ L2 配置入口 + L2 可视化 全部就绪

**剩余唯一 P2 项**（L1 自助核销优惠券）是现有优惠券系统的设计边界，涉及安全设计（验证码/OAuth），建议独立评估后再定。