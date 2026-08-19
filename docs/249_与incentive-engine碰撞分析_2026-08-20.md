# cf-lottery × @usethink/incentive-engine 碰撞分析

> 文档版本：1.0.0
> 最后更新：2026-08-20
> 分析对象：cf-lottery（多租户活动引擎）与 @usethink/incentive-engine（领域无关激励计算引擎）
> 关注点：业务、核心功能实现（技术栈差异 express+sequelize vs drizzle 不构成障碍）

---

## 一、两个项目的本质定位（先对齐认知）

| 维度 | cf-lottery | @usethink/incentive-engine |
|------|-----------|---------------------------|
| 定位 | **多租户、白标、可嵌入的活动引擎平台** | **领域无关的通用营销激励计算引擎（npm 库）** |
| 形态 | 完整应用（后端 + 前端 + DB + 支付） | 纯计算库（无 HTTP、无 DB、无 UI） |
| 技术栈 | Express + Drizzle + Turso/SQLite + Vue | 纯 JS + decimal.js（可选 joi/sequelize） |
| 核心能力 | 活动创建/参与/开奖/秒杀/支付/裂变 | 奖励分配（DIRECT/LEVEL/FIXED/CUSTOM）+ 封顶 + 等级 + 流水线 |
| 奖励机制 | 概率抽奖（奖品/卡密/加权/保底） | 配置驱动的金额/次数奖励计算 |
| 配置方式 | 活动配置 + promotionConfig + policy_version | 纯配置驱动（rewardDefs/rankDefs/capDefs/pipelineDef） |
| 数据模型 | 有完整 DB schema（lottery_draws 等） | 纯内存模型（EngineNode/EngineEvent/RewardDef） |

**一句话**：cf-lottery 是"活动怎么跑起来"（参与、开奖、支付、裂变的**编排与状态机**），incentive-engine 是"奖励怎么算出来"（金额/次数/等级的**纯计算**）。两者是**编排层 × 计算层**的关系，天然互补，几乎不重叠。

---

## 二、碰撞点全景图（核心结论）

```
┌─────────────────────────────────────────────────────────────┐
│                    cf-lottery（编排层）                        │
│  活动状态机 · 参与 · 开奖 · 秒杀支付 · 裂变 · 导流 · 事件漏斗     │
└───────────────┬───────────────────────────────┬─────────────┘
                │ ① 奖励计算（当前硬编码/散落）      │ ② 结算落账（当前无）
                ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│              @usethink/incentive-engine（计算层）              │
│  DIRECT/LEVEL/FIXED/CUSTOM · 封顶 · 预算 · 等级 · 流水线 · 幂等 │
└─────────────────────────────────────────────────────────────┘
```

**碰撞的本质**：cf-lottery 目前所有"奖励"都是**活动内嵌的、写死的、单一维度的**（抽奖次数、卡密、排行榜 spins）。而 incentive-engine 提供的是**配置驱动的、可组合的、多维度（金额/次数/等级）的奖励计算底座**。把后者接入前者，能让 cf-lottery 从"抽奖活动引擎"升级为"**规则驱动的激励活动引擎**"——这正是 AGENTS.md 里"抽奖是第一种玩法，不是唯一玩法"的架构愿景。

---

## 三、逐流程碰撞分析（活动 / 邀请 / 导流 / 秒杀 / 批发）

### 3.1 活动（lottery_draws）碰撞

**现状**：cf-lottery 的活动有 `activityKind`（lottery/signup_chain/vote/survey/checkin/claim/approval/reservation/waitlist）、`participationMode`、`experienceType`、`resultMode` 三个独立维度，`promotionConfig` 承载裂变/秒杀/保底/签到/里程碑等 JSON 配置。奖励发放逻辑散落在 `spin-quota.ts`、`leaderboard-rewards.ts`、`reward.ts`、`participation.ts` 中，**每种奖励都是手写 if/else 分支**。

**碰撞火花**：
- **奖励规则配置化**：incentive-engine 的 `rewardDefs` 天然适合表达"活动奖励规则"。cf-lottery 的 `promotionConfig` 里那些 `referralRewards`、`leaderboardRewards`、`pity`、`dailyFreeSpins` 本质都是"奖励定义"，但目前是**散落的、各自为政的 JSON 结构**。可以统一收敛为 incentive-engine 的 `rewardDefs` 配置，让"活动奖励"成为一等公民。
- **等级评估（RANK）**：cf-lottery 目前**没有会员等级/用户等级概念**。incentive-engine 的 `RankDef` + `RANK` 流水线阶段（v3.2.0）可以给 cf-lottery 引入"用户等级"，例如：参与次数达到 N 升 V1、邀请人数达到 M 升 V2，不同等级在抽奖中享受不同权重/次数/折扣。这是 cf-lottery 目前完全空白的能力。
- **活动期加成（CAMPAIGN）**：incentive-engine 路线图缺口 3（活动期加成）正好是 cf-lottery 的强项——cf-lottery 有完整的活动起止时间。两者结合：cf-lottery 提供"活动期"，incentive-engine 提供"活动期内的奖励系数"，实现"双十一加佣/限时翻倍"。

### 3.2 邀请（viral）碰撞

**现状**：cf-lottery 的邀请机制已经相当完善——`refCode` 归因、`shareRecords`、`ViralLeaderboard`、`computeViralSpinGrant`（单次邀请加次）、`evaluateReferralMilestones`（里程碑阶梯）、`grantLeaderboardRewards`（排行榜奖励）。但**奖励出口单一**：目前只支持 `bonus_spin`（额外抽奖次数），且**只对 lottery 类型生效**（记忆：flash_sale/claim 无奖励出口）。

**碰撞火花**：
- **奖励出口多样化**：incentive-engine 的 `FIXED`（固定金额）、`CUSTOM`（动态金额）、`DIRECT`（百分比）可以让邀请奖励从"只加抽奖次数"扩展为"送优惠券/折扣码/现金/积分"。这正是记忆里"邀请奖励按 activityKind 分支"的落地方式——lottery 保留加权票，flash_sale 送优惠券，claim 送额外领取次数，signup_chain 送优先名额。
- **多级邀请（LEVEL 链式）**：cf-lottery 目前只有**一级邀请**（邀请人 + 被邀请人）。incentive-engine 的 `LEVEL` 链式水位差可以支持**多级邀请**（A 邀请 B，B 邀请 C，A 也能从 C 的参与中获益）。这是裂变增长的重要升级。
- **邀请奖励的封顶/预算**：cf-lottery 的邀请奖励目前靠 `maxExtraSpins` 双封顶硬编码。incentive-engine 的 `capDefs`（平台日封顶/单用户日封顶）+ `applyBudgetGuard`（预算兜底）可以提供更精细的防刷/防超发控制，且是**配置驱动**的，运营可调。

### 3.3 导流（traffic/productLink）碰撞

**现状**：cf-lottery 有 `productLink` 导流商品卡、`activityEvents` 事件漏斗（page_view/cta_click/share_click/attributed_join/external_conversion_reported）、`externalConversions` 外部转化回传。但**导流本身没有激励闭环**——用户点击导流商品卡跳转外部，但"导流带来的转化"没有反哺给活动/用户。

**碰撞火花**：
- **导流转化激励**：incentive-engine 的 `DIRECT`（按 eventValue 百分比）可以给"导流带来的成交"计算返佣。cf-lottery 已有 `external_conversion_reported` 事件和 `externalConversions` 表，**缺的只是"转化 → 奖励"的计算层**。接入 incentive-engine 后，外部转化回传即可触发返佣/积分/优惠券奖励，形成"曝光→点击→转化→奖励"的完整闭环（记忆里的导流缺口）。
- **CUSTOM 动态取数**：incentive-engine 的 `CUSTOM` + `amountFrom: "event.attrs.<path>"` 可以从导流转化事件里动态取数（如按成交金额、按商品类目），实现差异化返佣。

### 3.4 秒杀（flash_sale）碰撞

**现状**：cf-lottery 的秒杀是 `flash-sale-rush` 模板（claim + flash_sale 体验 + instant 结果），有 `flashSale` 配置（stockLimit/maxPerUser/priceCents/pricingTiers 阶梯价）、`activeParticipantCount` CAS 计数器、`paymentOrders` 支付闭环、`paymentOrderItems` 明细履约。**秒杀本身是"直付购买"，没有激励加成**。

**碰撞火花**：
- **秒杀返佣/分销**：秒杀商品可以接入 incentive-engine 的 `DIRECT`/`LEVEL`，让"推广秒杀商品的人"获得佣金。cf-lottery 已有完整的支付订单数据（`paymentOrders` 含 quantity/amount），可以作为 `eventValue` 输入引擎计算返佣。
- **秒杀阶梯价 × 批发**：见 3.5。
- **秒杀限购的封顶**：cf-lottery 的 `maxPerUser` 是硬编码限购。incentive-engine 的 `capDefs` 可以提供更灵活的"单用户日封顶/平台日封顶"。

### 3.5 批发（wholesale）碰撞

**现状**：cf-lottery 的"批发"不是独立模块，而是**秒杀直付的批量购买模式**（`direct_bulk`）——`paymentOrders.quantity` 支持多件、`flashSalePricingTiers` 阶梯定价（5 件起 8.9 折）、`paymentOrderItems` 明细级履约。**批发目前是纯交易，无激励**。

**碰撞火花**：
- **批发返佣/代理等级**：批发场景天然适合 incentive-engine 的**等级评估（RANK）+ 链式水位差（LEVEL）**。可以定义代理等级（V1-V5），不同等级拿不同批发返佣比例，多级代理链极差佣金。这是 incentive-engine 的 `demo/01-ecommerce.js`（电商分销）和 `demo/03-gaming.js`（等级评估）已经验证过的场景。
- **批发预算控制**：批发返佣涉及大额资金，incentive-engine 的 `applyBudgetGuard`（预算兜底）+ `applyCaps`（封顶）正好解决"批发返佣超发"的资金安全风险。

---

## 四、最值得落地的 5 个碰撞点（按 ROI 排序）

### 🔥 P0-1：邀请奖励出口多样化（最高 ROI，直接补记忆缺口）

**现状痛点**：邀请奖励只支持 `bonus_spin`，且只对 lottery 生效。flash_sale/claim/signup_chain 无奖励出口。

**碰撞方案**：用 incentive-engine 的 `rewardDefs` 统一表达邀请奖励，按 `activityKind` 分支：
- lottery → `bonus_spin`（保留现有加权票）
- flash_sale → `FIXED` 送优惠券/折扣码
- claim → `CUSTOM` 送额外领取次数
- signup_chain → `CUSTOM` 送优先名额

**落地成本**：中。需要把 `spin-quota.ts` 的 `computeViralSpinGrant`/`evaluateReferralMilestones` 与 incentive-engine 的 `distributeByDefs` 对接，但**纯计算层可复用**，不碰状态机。

### 🔥 P0-2：导流转化返佣闭环（补记忆缺口）

**现状痛点**：导流有曝光/点击/转化事件，但无激励闭环。

**碰撞方案**：`external_conversion_reported` 事件 → 触发 incentive-engine `DIRECT`（按成交金额返佣）→ 落账。cf-lottery 已有 `externalConversions` 表和 `recordExternalConversion()`，**只差计算层**。

**落地成本**：低。incentive-engine 的 `GenericSettlementService` 的 `settle()` 幂等落账模式可直接复用。

### 🔥 P0-3：秒杀/批发返佣 + 代理等级

**现状痛点**：秒杀/批发是纯交易，无激励。

**碰撞方案**：`paymentOrders`（含 quantity/amount）作为 `eventValue` → incentive-engine `RANK`（评估代理等级）+ `DIRECT`/`LEVEL`（返佣）→ 落账。批发场景用 `LEVEL` 链式极差支持多级代理。

**落地成本**：中。需要新增"代理/推广员"关系建模（cf-lottery 目前无此概念），但计算层完全复用。

### 🔥 P1-4：奖励规则配置化 + 封顶/预算

**现状痛点**：cf-lottery 的奖励规则散落在多个文件，硬编码 if/else，无统一配置。

**碰撞方案**：把 `promotionConfig` 里的奖励相关配置（referralRewards/leaderboardRewards/pity/dailyFreeSpins）统一收敛为 incentive-engine 的 `rewardDefs` + `capDefs` + `pipelineDef`，让运营通过配置调整奖励，而非改代码。`capDefs` 提供平台日封顶/单用户日封顶防刷。

**落地成本**：中高。涉及配置结构重构，但**纯计算层可先行**，不阻塞现有功能。

### 🔥 P1-5：用户等级体系（RANK）

**现状痛点**：cf-lottery 无用户等级概念。

**碰撞方案**：用 incentive-engine 的 `RankDef` + `RANK` 流水线阶段引入用户等级（V1-V5），不同等级在抽奖/秒杀/批发中享受不同权重/折扣/返佣比例。

**落地成本**：中。需要新增用户等级字段和评估触发点，但评估逻辑（`getHighestQualifiedTier`）完全复用。

---

## 五、技术对接建议（express+sequelize vs drizzle 不构成障碍）

### 5.1 为什么技术栈差异不是问题

incentive-engine 是**纯计算库**，不依赖任何框架。它的 `distributeByDefs`/`executePipeline`/`applyCaps` 都是纯函数，输入输出都是普通对象。cf-lottery 无论用 drizzle 还是 sequelize，都只是"调用方"，引擎本身零耦合。

### 5.2 对接方式（推荐：薄适配层）

```
cf-lottery 业务事件（参与/转化/支付）
        │
        ▼
  [薄适配层 adapter]  ← 新增，约 100-200 行
  - 业务事件 → EngineEvent（sourceNodeId/eventValue/eventType）
  - 活动配置 → rewardDefs/capDefs/pipelineDef
  - 引擎输出 → cf-lottery 落账（lotteryEntries.spins / 优惠券 / 返佣记录）
        │
        ▼
  @usethink/incentive-engine（纯计算）
```

**关键点**：
- **幂等**：incentive-engine 的 `GenericSettlementService` 提供 `settle()`/`settleWithTransaction()`/`batchSettle()` 幂等落账，与 cf-lottery 现有的 `idempotencyKey` UNIQUE 约束模式一致，可直接借鉴。
- **事务**：cf-lottery 用 `withDbTransaction`，incentive-engine 的 `settleWithTransaction(event, tx)` 委托模式正好适配——把 cf-lottery 的事务传入引擎，引擎在事务内计算+落账。
- **金额精度**：incentive-engine 用 decimal.js 28 位精度，cf-lottery 的秒杀价格用 `priceCents`（分），对接时统一用"分"或统一用 decimal string，避免精度丢失。

### 5.3 需要新增的 cf-lottery 能力（引擎不提供）

incentive-engine 明确**不管理**：用户、团队树、幂等、定时任务、活动状态机。这些 cf-lottery 已有。**唯一需要新增的是"推广员/代理关系"建模**（谁是谁的上级），用于 `DIRECT+PARENT`/`LEVEL` 链式分配。cf-lottery 目前只有"邀请人-被邀请人"的一级关系，多级需要扩展。

---

## 六、风险与边界（诚实评估）

1. **不要过度设计**：cf-lottery 是"小而美的瑞士军刀"（AGENTS.md 铁律）。接入 incentive-engine 应**从 P0-1/P0-2 两个最小闭环开始**，验证价值后再扩展，不要一上来就做全量奖励配置化。
2. **奖励出口的落账**：incentive-engine 只算"金额/次数"，**不负责"发优惠券/发卡密/发积分"**。cf-lottery 需要自己实现"奖励出口"（优惠券生成、卡密发放、积分入账），引擎只提供"算多少"。
3. **多级邀请的合规**：多级分销（LEVEL 链式）涉及合规风险，需谨慎评估是否真的需要，还是保持一级邀请。
4. **配置复杂度**：incentive-engine 的配置驱动是双刃剑——灵活但复杂。cf-lottery 的运营是 L2 租户管理员，配置界面需要封装好，不能让运营直接面对 `rewardDefs` 原始 JSON。
5. **依赖引入**：incentive-engine 是 npm 库，引入会增加一个生产依赖。需确认其版本稳定性（当前 v3.4.10，196 测试全绿，健康度良好）。

---

## 七、结论

**cf-lottery 与 incentive-engine 的碰撞，本质是"活动编排层"与"奖励计算层"的互补，几乎零重叠，天然契合。**

最值得做的是三个闭环：
1. **邀请奖励出口多样化**（P0-1）——直接补上"邀请不能只局限在免费抽奖"的架构缺口
2. **导流转化返佣**（P0-2）——补上"导流无转化激励"的漏斗缺口
3. **秒杀/批发返佣 + 代理等级**（P0-3）——让批发从"纯交易"升级为"有激励的分销"

这三个都符合 AGENTS.md 的"所有环节形成闭环"铁律，且**计算层完全复用 incentive-engine，cf-lottery 只需加薄适配层**，不破坏现有状态机。

**建议下一步**：先做 P0-1（邀请奖励出口多样化），因为它直接补记忆里的缺口、ROI 最高、且不涉及新增"代理关系"建模，是风险最低的切入点。
