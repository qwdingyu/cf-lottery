# 营销功能闭环全链路审查 与 incentive-engine 集成最优性评估（第二版·已修订）

日期：2026-08-22
编号：docs/259
关联：docs/111（奖励意图）、docs/126（VPS 默认部署切换）、docs/255（裂变链路整理）、docs/256（v4 动态 require 生产宕机）
审查范围：配置下发 → 发布预检 → 运行时发放 → 用户可见/可用 → 事件与看板，共 5 段闭环
外部对照：`/Users/dingyuwang/0-X/2-node/rbb_nodejs/incentive-engine`（npm 包 `@usethink/incentive-engine@4.0.0`）与其主消费方 `rbb`

> **本版为修订版。** 第一版（同编号）存在 4 处方向性错误，其中 2 处如果照单执行会造成生产事故。
> 全部更正见 §0。核心结论已变化：CF 构建问题不是 P0、引擎的取舍理由不是体积、`package-lock.json` 不可删除。

---

## 〇、第一版的错误与更正（务必先读）

| # | 第一版的说法 | 实际情况 | 危害等级 |
|---|---|---|---|
| 1 | 深导入方案「体积 103.7 KB」，相比包根导入「差 21.6 倍」 | **量纲错误**：103.7 KB 是引擎单独探针的体积，2241.50 KiB 是整个 Worker 产物体积，两者不可比。同口径实测：包根 2241.50 KiB → 深导入 2097.29 KiB，引擎净开销 **144.21 KiB（gzip 34.57 KiB，约 6.4%）** | 结论虚高约 20 倍，会误导优先级 |
| 2 | 「深导入」与「开启 `nodejs_compat`」是两个可选方案，推荐深导入 | **二者不是替代关系**。`src/lib/local-media.ts:16-17` 静态导入 `node:fs/promises` / `node:path`，经 `src/routes/media.ts:15` ← `src/index.ts:29` 进入 Worker 依赖图。wrangler 对 `node:` 前缀只报 **WARNING**，构建是绿的，但**运行时 Worker 启动即抛错**。CF 目标下 `nodejs_compat` 是**必需项**，深导入只是 6.4% 的优化 | **高**：照第一版执行会得到「构建通过、上线即挂」——正是要避免的灾难 |
| 3 | CF 构建失败是 **P0 阻断级** | CF 生产**自 2026-08-06 已暂停**（docs/126；`local-deploy-cloudeflare.sh` 脚本头自述「仅用于明确需要回退/测试」）。VPS 是唯一生产目标。正确定性是 **P1：声明保留的回退通道实际已失效**，且需要一次明确的架构决策而非补丁 | 中：错误优先级会挤占真实缺陷的排期 |
| 4 | 仓库存在 `package-lock.json` 违反铁律 3，建议转 pnpm 并删除 | **该文件是 VPS 部署流水线的载荷文件**：`scripts/build-for-vps.sh:164` 复制它、`:178` 打进部署包，VPS 上靠 `npm ci --omit=dev` 安装运行时依赖。删除会**直接打断唯一的生产部署路径** | **高**：机械执行铁律会造成生产不可部署 |

| 5 | 已按第一版建议把代码改成深导入（工作区未提交改动） | **该改动会静默摧毁全部引擎奖励发放。** 深导入模块 `module.exports = { distributeByDefs, calculateDirect, ... }`，**没有 `Distribute` 这一层**；而调用点 `src/services/lottery/referral-rewards-engine.ts:515` 写的是 `engine.Distribute.distributeByDefs(...)` → 运行时 `TypeError`。同时手写的 `src/types/incentive-engine.d.ts` 把深导入模块的 default 声明成 `{ Distribute: {...} }`，**类型声明说了谎**，所以 `tsc` 全绿。而 `maybeTriggerReward` 对路径[4] 做了 try-catch 吞异常 → **线上表现为「奖励一条都不发、只有一行日志、无任何报警」** | **最高**：已实测复现，本次已回滚 |

第 2、4、5 条是本次复审的核心价值：它们都属于「单条规则局部正确、全局执行即事故」，正是「不要无止境地打补丁」要防的东西。其中第 5 条是已经写进工作区的代码，若被提交上线即为资损级故障。

**本次已执行的处置：**
- 回滚深导入改动（`src/services/lottery/referral-rewards-engine.ts`、`src/types/incentive-engine.d.ts`），被否决的补丁存档于 `/tmp/259.deep-import.rejected.patch`。
- 顺带发现同一次改动往 `package.json` 里写入了 `//` 注释，使其成为非法 JSON，**vitest 整体无法启动**（`ERROR: JSON does not support comments`）——已清除。
- 保留其中唯一正确的部分：`"@usethink/incentive-engine": "^4.0.0"` → `"4.0.0"`（精确锁版本），并用 `npm install --package-lock-only` 同步 lockfile 根 spec，`npm ci --dry-run --omit=dev` 校验通过。
- **新增护栏测试** `src/services/lottery/incentive-engine-contract.test.ts`（4 个用例）：断言运行时形状 `engine.Distribute.distributeByDefs` 为函数、调用点必须从包根导入（静态校验禁止 `/src/engine/`）、cf-lottery 实际形态（FIXED + SOURCE + 单条 GTE）的行为、依赖版本精确锁定。已用「注入坏改动 → 测试变红 → 还原 → 变绿」验证护栏本身有效。
- 回归验证：`tsc --noEmit` 通过；`vitest run` **106 个文件 / 1528 个用例全通过**。

**由此得出一条护栏结论（比任何单点修复都重要）**：手写第三方包的 `.d.ts` 会让类型系统失去发现导入形状错误的能力。任何改动引擎导入路径的提案，都必须附带一条**运行时形状断言测试**，例如：

```ts
expect(typeof engine.Distribute?.distributeByDefs).toBe("function");
```

否则 `tsc` 绿 + 测试绿 + 上线全炸的组合会再次发生。

---

## 一、总体结论

**营销功能没有全部闭环。** 但缺口不是散落的十个 bug，而是 **3 个悬而未决的架构决策** + **1 组独立的真实缺陷**。

### 三个必须先做的决策

| 决策 | 问题本质 | 不决策的代价 |
|---|---|---|
| **D1 · 部署目标** | CF Workers 通道声明保留、实际已坏（引擎 `require("crypto")` + `local-media.ts` 的 node 内建）。是正式归档，还是作为一揽子工作恢复？ | 「以为有回退，真要回退时发现没有」 |
| **D2 · 裂变奖励模型** | `viral.extraSpinsPerInvite`（路径[1]）与 `referralRewardDefs`（路径[4]）被预检判为**互斥二选一**，但二者其实是**互补**的：路径[1] 独占进度 UI／排行榜／延迟开奖权重，路径[4] 独占阈值阶梯与券码出口。运营只能在「有进度反馈的裂变」和「有阶梯奖励的裂变」之间挑一个 | 引擎阶梯奖励**永久处于断链状态**——能发放，但用户看不到进度、收不到通知 |
| **D3 · 引擎集成形态** | cf-lottery 用了引擎 53 个公开函数中的 **1 个**，却承担整包的运行时假设（CJS/Node/Sequelize/joi）。已实际付出：1 次 VPS 生产宕机（docs/256）、1 个部署目标失效、651+62 行胶水 | 引擎每次为主消费方 `rbb` 演进，都是 cf-lottery 的一次未知风险 |

### 一组与决策无关、可独立修的真实缺陷

`grantBonusCoupon` 空收件人静默烧券（P1）、奖励发放失败无重试/补发通道（P1）、路径[3] 无任何管理端入口（P1）、`reward_earned` 缺 `source` 字段导致四个生产者混在一起（P1）、看板口径失真（P2）、`my-rewards` N+1（P2）、`rewardId` 与阈值强耦合（P2）。

---

## 二、营销能力闭环矩阵

五段闭环：**配置下发 → 发布预检 → 运行时发放 → 用户可见/可用 → 事件与看板**。

| # | 能力 | 配置下发 | 发布预检 | 运行时发放 | 用户可见/可用 | 事件与看板 | 闭环 |
|---|---|---|---|---|---|---|---|
| 1 | 分享归因（`shareRecords` / refCode） | ✅ | ✅ | ✅ 自邀防御 + `joinedCount` | ✅ 分享入口仅按活动状态开放 | ✅ `attributed_join` | ✅ |
| 2 | 裂变加抽奖次数（路径[1] `viral.extraSpinsPerInvite`） | ✅ | ✅ | ✅ CAS + 上限 | ✅ 进度条 + 排行榜 | ✅ | ✅ |
| 3 | **引擎阶梯奖励（路径[4] `referralRewardDefs`）** | ✅ | ⚠️ **与路径[1] 判为互斥** | ✅ 三层防超发 | ❌ **零进度、零通知** | ✅ `reward_earned` | **断链（D2）** |
| 4 | 奖励出口 `bonus_spin` | ✅ | ✅ | ✅ CAS `spinsLeft` | ✅ | ✅ | ✅ |
| 5 | 奖励出口 `bonus_coupon` | ✅ | ⚠️ 仅 warning | ⚠️ **空收件人烧券** | ⚠️ 空 key 永久不可见 | ✅ | **有缺陷（§6 P1-1）** |
| 6 | 奖励意图 Webhook（路径[3] `reward.perInviteAmount`） | ❌ **无管理端 UI** | ❌ 无校验 | ✅ 配额 + 入队 | ✅ 中转站兑换码 | ✅ | **不可发现（§6 P1-3）** |
| 7 | 出站平台消息（QQ 群） | ✅ | ✅ | ✅ 入队后异步投递 | ✅ | ✅ | ✅ |
| 8 | 防超发（幂等标记 / CAS / 总量上限） | — | — | ✅ 三层 | — | ✅ | ✅ |
| 9 | 发放失败后的补偿 | — | — | ❌ **无重试、无补发** | ❌ | ⚠️ 仅日志 | **断链（§6 P1-2）** |
| 10 | 漏斗看板 | — | — | — | — | ⚠️ 四个生产者混算 | **失真（§6 P1-4/P2-1）** |

---

## 三、决策 D1：Cloudflare Workers 目标的去留

### 3.1 事实基线

- **CF 生产已暂停**：docs/126（2026-08-06）「项目生产部署已暂停 Cloudflare Workers，切换到 VPS 模式」；`local-deploy-cloudeflare.sh` 脚本头自述「保留本脚本仅用于明确需要回退/测试 Cloudflare Workers 的场景」。
- **VPS 是唯一生产目标**（`38.47.198.72`），走 esbuild ESM 打包 + `--banner:js` createRequire（docs/256）。
- 因此 CF 通道当前的性质是「**声明保留的回退通道**」，而它已经坏了——问题不在于「今天上不了线」，而在于「以为有备份、真要用时没有」。

### 3.2 四组同口径实测（`wrangler deploy --dry-run --outdir`）

| 引擎导入方式 | `nodejs_compat` | 构建结果 | 产物体积 |
|---|---|---|---|
| 包根 `@usethink/incentive-engine` | 关 | ❌ **ERROR** `Could not resolve "crypto"`（`src/utils/version-select.js:14:23`） | — |
| 包根 | 开 | ✅ 通过 | 2241.50 KiB / gzip 442.90 KiB |
| 深导入 `.../src/engine/distribute/index.js` | 开 | ✅ 通过 | 2097.29 KiB / gzip 408.33 KiB |
| 深导入 | 关 | ⚠️ 构建通过，**仅 WARNING**（`node:fs/promises`、`node:path`） | 2097.29 KiB / gzip 408.33 KiB |

**引擎净开销 = 144.21 KiB raw / 34.57 KiB gzip ≈ 总产物的 6.4%。**（第一版的「21.6 倍」是量纲错误，见 §0-1。）

### 3.3 最后一行是陷阱

第四行看起来「构建通过」，但那两个 WARNING 来自项目自身代码，不是引擎：

```
src/lib/local-media.ts:16   import { mkdir, readFile, writeFile } from "node:fs/promises";
src/lib/local-media.ts:17   import { dirname, join, normalize } from "node:path";
```

依赖路径：`src/index.ts:29` → `src/routes/media.ts:15` → `src/lib/local-media.ts`。也就是说 **Worker 依赖图自带 node 内建依赖**，与引擎无关。wrangler 对 `node:` 前缀只告警不报错，所以「深导入 + 不开 `nodejs_compat`」会产出一个**绿色构建 + 启动即抛错的 Worker**。

（对照：`src/db/apply-migrations.ts`、`src/server.ts` 的 node 导入只在 VPS 入口，不在 Worker 依赖图内，不构成 CF 问题。）

**结论：CF 目标下 `nodejs_compat` 是必需项，不是可选项。深导入只是 6.4% 的体积优化。二者不构成「二选一」。**

### 3.4 两个候选决策（需要人来定，不要默认打补丁）

| 方案 | 内容 | 代价 | 适用前提 |
|---|---|---|---|
| **D1-a 正式归档 CF** | 在 `local-deploy-cloudeflare.sh` 头部与 README 明确标注「已归档，不保证可构建」；`wrangler.jsonc` 保留但不再声称可用 | 近乎零 | 确认未来 12 个月不会回 CF |
| **D1-b 恢复为可用回退** | 一揽子（缺一不可）：① 引擎改深导入或移除依赖；② `wrangler.jsonc` 开 `nodejs_compat`；③ 处理 `local-media.ts`（CF 上本地文件系统无意义，应按环境切分到 R2/KV 或从 Worker 图中剥离）；④ 把 `wrangler deploy --dry-run` 加入 `verify:delivery`，否则会再次静默腐化 | 半天到一天，且 ③ 需要设计 | 需要多区域/边缘能力，或 VPS 单点风险不可接受 |

**不可接受的第三种做法**：只改引擎导入方式就宣布「CF 修好了」。那是把 ERROR 换成 WARNING，把构建期失败推迟到运行期。

---

## 四、决策 D2：裂变奖励模型 —— 从「二选一」到「基础 + 里程碑叠加」

### 4.1 四条推荐奖励路径的真实职责

| 路径 | 入口配置 | 触发条件 | 独占能力 | 用户可见性 |
|---|---|---|---|---|
| **[1]** `grantViralSpinsToSharer` | `viral.extraSpinsPerInvite` | 归因成功 **且** `resultMode === "instant"` | 进度条 UI、`ViralLeaderboard`、**延迟开奖权重 `computeViralDrawWeight`** | ✅ 完整 |
| **[2]** legacy `referralRewards` 里程碑 | — | 已按 docs/255 P1-2 删除 | — | — |
| **[3]** `triggerRewardEarned` | `activityConfig.reward.perInviteAmount` | 归因成功（全部活动） | 中转站兑换码 webhook、QQ 群通知 | ✅ 但**无管理端 UI** |
| **[4]** `processReferralRewardsEngine` | `promotionConfig.referralRewardDefs` | 归因成功 **且** 有 `shareRecordId` | **阈值阶梯**、**`bonus_coupon` 出口** | ❌ 零进度、零通知 |

关键判断：**路径[1] 与路径[4] 语义上有重叠（都能「每邀请 +N 次抽奖」），但谁都不是谁的超集。** 路径[1] 独占进度反馈与延迟开奖权重；路径[4] 独占阈值与券码。把它们建模成竞争关系，是这次审查里最深的一处设计错误。

### 4.2 预检把互补关系写成了互斥

`src/services/publish-check-service.ts`：

```ts
801: if (isViralEnabled(viral) && viral) {
806:   if (hasReferralRewardDefs) {
808:     const { perInvite } = readViralPerInvite(viral);
809:     if (perInvite > 0) {
810:       add(result.errors, "promotion", "viral.extra_entries.conflict_with_reward_defs",
              "裂变传播：已配置 referralRewardDefs 引擎奖励，不能再配置 viral 每邀请加次…请二选一");
816:   if (draw.activityKind === "lottery") {
819:     if (perInvite < 1) add(result.errors, ... "viral.extra_entries.invalid", "每邀请额外次数必须大于 0");
```

而管理端表单 `frontend/src/views/admin/lottery/growth-config.ts` 在 viral 开启时**必然**下发 `perInvite ≥ 1`：

```ts
660: const perInvite = form.viralExtraEntriesPerInvite || 1
661: const maxExtra   = form.viralMaxExtraEntries || 10
```

两条规则叠加 → **死锁**。

### 4.3 可达性矩阵（逐项代码核实）

| 配置组合 | 发布预检 | 用户侧邀请入口 | 阶梯进度 UI | 引擎奖励是否发放 |
|---|---|---|---|---|
| viral **关** + `referralRewardDefs` | ✅ 通过（viral 块整段跳过） | ✅ 可用 | ❌ `ViralLeaderboard` 不渲染，`my-viral-stats` 返回 400 | ✅ **会发** |
| viral **开** + defs（表单正常下发） | ❌ `conflict_with_reward_defs` | — | — | 不可发布 |
| viral 开 + 手改 `perInvite=0` + `lottery` | ❌ `viral.extra_entries.invalid` | — | — | 不可发布 |
| viral 开 + 手改 `perInvite=0` + 非 lottery | ✅ 通过（数值校验被 `activityKind` 跳过） | ✅ | ⚠️ 排行榜有、阶梯无 | ✅ 仅 `bonus_coupon` |

**重要且容易搞错的一点：邀请入口本身不受 viral 开关控制。** `frontend/src/views/LotteryView.vue` 的 `handleCopyPublicLink`（`:3888`）与 `shareMyWin`（`:3379`）只受活动状态约束（`shouldShowInviteShareCta`，`src/views/lottery/public-helpers.ts:137`，仅对 `drawn`/`cancelled`/`closed` 返回 false）；服务端 `recordAttributedJoin`（`src/services/lottery/participation.ts:948-1040`）纯粹由 refCode 驱动，全程无 viral 门禁。真正被 viral 门控的只有**展示层**：`ViralLeaderboard`（`LotteryView.vue:462`）与 `GameResultModal.vue:194-195`。

所以 viral 关闭时链路是「**能分享、能归因、能发奖，但用户全程看不到任何进度**」。这不是权限问题，是反馈缺失。

### 4.4 目标形态（一次决策，不要逐条放宽规则）

把两条路径从「二选一」改为**分层叠加**：

- **基础激励层** = `viral.extraSpinsPerInvite`：每邀请固定 +N，负责即时反馈、排行榜、延迟开奖权重。
- **里程碑加成层** = `referralRewardDefs`：达到阈值的一次性加成，负责阶梯与券码出口。
- **单一进度面**：`my-viral-stats` 同时返回基础进度与里程碑进度（当前阶梯、下一阶梯阈值、已发放列表），前端进度条与阶梯共用一个数据源。
- **收敛两条 spins 路径**：`bonus_spin` 出口最终只保留一处 CAS 写入，避免同一语义两套实现。
- 预检规则相应改为：**不再报 conflict**；只在「两层都配了 `bonus_spin` 且总量上限缺失」时告警。

**落地时对本节草案的两处修正（以代码为准，2026-08-22）：**

1. **里程碑层只受 `maxSpinsPerEntry` 约束，不受 `viral.maxExtraSpins` 约束。** 草案曾设想里程碑层也传裂变子顶。实际不传：子顶属于基础层的语义，若里程碑层也受它约束，会出现「配置合法但奖励被静默裁剪」，只能再加告警去圆场；且不传使 `spinsViralEarned` 的既有断言（`my-rewards.test.ts:262`）无条件保持成立，改动天然零回归。因此 `spinsViralEarned` 的口径明确为**只统计基础层**。
2. **告警码定为 `promotion.referralRewardDefs.bonus_spin.clipped_by_viral`**（warning，非 error）：当「基础层每邀请 +N」在里程碑阈值处已把 `maxSpinsPerEntry` 吃满时提示该档会被裁剪为 0。判定用共享的 `extractMilestoneThreshold`，阈值不可归约（OR/NOT）时不猜测、不告警——避免预检变噪音（docs/255 R-7）。
3. **基础层现在也写 `reward_earned` 审计事件**（`metadata.source = "viral"`）：这是出口收敛的副产物，与 docs/254 §4.2「奖励出口统一审计」一致，也补齐了 §6 P1-4 对 `source` 字段的要求。

只放宽 `conflict_with_reward_defs` 这一条规则是典型的打补丁——放宽之后，运营依然拿不到阶梯进度反馈，第 3 行能力仍然断链。

---

## 五、决策 D3：incentive-engine 集成是否最优

### 5.1 用量：1 / 53

| 维度 | 实测 |
|---|---|
| 引擎公开函数总数 | 53 |
| cf-lottery 实际调用 | **1**（`distributeByDefs`） |
| 引擎导入点 | **1 处** — `src/services/lottery/referral-rewards-engine.ts:29`：`import engine, { type RewardDef } from "@usethink/incentive-engine";` |
| 实际执行的引擎代码路径 | `targetGated = false` → `_meetsRewardCondition(def, event, {event})` → `Decimal.gt(fixedAmount, "0")` → push 一条 FIXED 记录 |
| 引擎侧相关文件规模 | `reward-distributor.js` 363 行、`condition-evaluator.js` 214 行、`chain-calculator.js` 240 行、`direct-calculator.js` 202 行（后两者本项目**从不进入**） |
| cf-lottery 侧胶水 | 约 651 行（含白名单/规范化/幂等/出口分发）+ 62 行适配 |
| 精度需求 | **无**。适配层最终 `Math.floor(Number(record.amount))`，`decimal.js` 的价值被抹平 |

管理端只会下发一种形态：`type: 'FIXED'` + `target: 'SOURCE'` + 单条 `GTE` 条件，`rewardId` 由阈值拼出（`invite_${requireCount}`）。LEVEL/链式分配、多条件树、`source:"target"` 等能力从未被触达。

### 5.2 运行时错配（这才是真实成本所在）

| 引擎的运行时假设 | cf-lottery 的实际运行时 | 已发生的后果 |
|---|---|---|
| CJS，`main: src/index.js` | ESM，esbuild 单文件打包 | 需要 `--banner:js` createRequire 兜底（docs/256） |
| 模块级 `require("crypto")` | Workers 默认无 node 内建；ESM 无全局 `require` | **VPS 生产 auto-restart 宕机一次**（docs/256）；CF 构建 ERROR |
| optional peer `sequelize` / `joi` | 都不安装（Drizzle + libSQL） | 靠引擎内部 try-catch 降级，属于「运行时才知道有没有」 |
| 长驻 Node 进程 | 边缘/短生命周期（CF）或长驻（VPS） | 双目标下假设不一致 |

**已付出的实际代价：1 次生产宕机 + 1 个部署目标失效 + 713 行胶水，换来 1 个函数的复用。** 第一版把理由归到「体积」是找错了靶子——6.4% 的体积从来不是问题，**依赖风险才是**。

### 5.3 组织视角：引擎的主场是 rbb，不是 cf-lottery

这一点决定了正确答案的形状：

- **`rbb`（`/Users/dingyuwang/0-X/2-node/rbb_nodejs/rbb`）是引擎的天然宿主**：`package.json:22` 声明 `"@usethink/incentive-engine": "^4.0.0"`，配套 `express ^5.1.0` + `sequelize ^6.37.5` + `sequelize-cli`，`main: src/server.js`。它**广泛**使用引擎：`Utils.normalizePagination`、整体转出 `Decimal`、业务日期工具、`Validation.createRuleSetValidation`、`songrong-reward-adapter.js`、`member-node-adapter.js`。CJS + 长驻 Node + 装了 sequelize/joi —— 引擎的每一条设计假设在 rbb 都成立。
- **cf-lottery 是唯一的异类消费方**：eforge monorepo 内 `grep -rl "incentive-engine" --include=package.json` 只命中 `templates/cf-lottery/package.json`。

因此结论不是「引擎不好」，而是：**引擎是为 rbb 量身定制的，cf-lottery 是错配的消费方**。而且这个错配是**结构性、会持续复发**的——引擎未来每一次为 rbb 演进（新增 Sequelize 服务层、joi 校验、node 内建），都是 cf-lottery 的一次未知风险。v4.0.0 已经完整演示过一遍（docs/256）。

这与本仓库 CLAUDE.md 铁律 1 是同一个道理：`cf-core` 之所以只允许 5 张基础设施表、禁止业务代码，正是因为**被多方共享的包必须是窄而稳定的契约**。引擎目前从相反方向违反了同一条原则：它把 rbb 专属的 service/validation/util 层，打包进了 cf-lottery 也要 import 的入口。

### 5.4 三条路径

| 路径 | 内容 | 收益 | 代价/风险 |
|---|---|---|---|
| **A. 深导入 + 锁版本**（止血） | 改 `.../src/engine/distribute/index.js`，**并同步把调用点从 `engine.Distribute.distributeByDefs` 改为 `engine.distributeByDefs`**（见 §0-5，漏改即静默全失败）；`^4.0.0` → 精确 `4.0.0` | 绕开 `version-select.js` 的 `require("crypto")`；产物 −144 KiB；可评估移除 docs/256 的 banner hack | 依赖非公开路径（`exports: null` + `files: ["src/"]` 使其**合法**但无稳定性承诺）；导入形状与包根不一致，易被手写 `.d.ts` 掩盖；**且仍不解决** CF 的 `local-media.ts` 问题与结构性错配 |
| **B. 上游拆出零依赖纯计算入口**（正解） | 引擎发布 `@usethink/incentive-engine/pure` 子入口（或独立 `@usethink/incentive-core`）：纯 ESM+CJS 双格式、零 node 内建、只含 `evaluate` + `distribute` | **rbb 与 cf-lottery 同时受益**；组织级复用得以真正成立；契约变窄变稳，符合铁律 1 的精神 | 需要跨仓协调 + 一次引擎发版 |
| **C. 内联替换**（退出） | cf-lottery 内自实现求值器，删除依赖。**规模需按「运行时受理面」而非「表单下发面」估算**：`normalizeReferralRewardDefs` 放行 DIRECT/FIXED/CUSTOM 三种 type、`amountFrom` 2 值、条件树 4 种节点（COMPARE/AND/OR/NOT）× 6 算子 × 4 字段 × 深度 ≤5，因此约 **150 行 + 约 30 个用例**（早前「40–60 行」的估算只覆盖了表单实际下发的 FIXED+单条 GTE，偏低） | 依赖归零；CF/VPS 双目标假设统一；`decimal.js` 一并移除 | 放弃组织级复用；奖励语义与 rbb 永久分叉；未来要 LEVEL/链式分配需重新引入 |

### 5.5 结论

**当前形态不是最优。** 按优劣排序：**B > C > A > 现状**。

- **B 是真正的解**，因为它同时修好了 rbb 的封装质量与 cf-lottery 的运行时匹配，且不牺牲复用。
- **C 优于 A**：用 1/53 的复用率换整包的运行时风险，本就不划算；A 只是把风险从「构建期可见」挪到「深导入路径无承诺」。
- 若短期无法推动上游，**立刻可做且必须做的最小动作是把 `^4.0.0` 改为精确 `4.0.0`**：`^` 允许 4.x 漂移，而 4.x 的演进方向由 rbb 决定。（注：VPS 走 `npm ci`，`package-lock.json` 已把版本钉在 4.0.0，因此当前**没有**线上漂移风险；风险在本地 `npm install` 与后续人工升版——docs/256 的宕机正是一次人工升版 `d9e8e83` 造成的。）

---

## 六、独立的真实缺陷（与上述三个决策解耦，可单独排期）

### P1-1 · 空收件人静默烧掉券码

`src/services/lottery/reward-exits.ts` — `grantBonusCoupon` 的收件人解析：

```ts
let recipientEmail = "";
if (sharer) {
  if (sharer.identityType === "user_id" && sharer.identityValue) {
    const [user] = await tx.select({ email: users.email }).from(users)
      .where(eq(users.id, sharer.identityValue)).limit(1);
    recipientEmail = user?.email || "";
  } else { recipientEmail = sharer.identityValue || ""; }
}
```

`recipientEmail` 为空时**依然**执行 CAS 把券置为 `issued`，同时幂等标记按「已发放」写入 `shareRecords.rewardMilestonesGranted`。读侧 `src/routes/public-lottery.ts:1370-1390` 有防越权保护：

```ts
const issuedCoupons = couponMatchKey ? await db.select(...)... : [];
```

→ 空 key 直接返回 `[]`。**净效果：券码被消耗、被标记已发放、用户永久看不到、且无法重发。**

命中条件（已收窄，不要夸大）：
- ✅ 会命中：IdP 用户 token 无 email claim（`src/services/idp-user-provision.ts:169` → `email: email || ""`）；`users` 行缺失。
- ❌ **不会**命中 QQ/Telegram 平台用户：`src/services/platform/inbound.ts:84` 写入 `identityType: event.platform`（`"qq"`），走 `else` 分支取 `identityValue`，与读侧一致。（`src/services/platform/user-provision.ts:99` 的 `email: ""` 因此不构成问题。）
- schema 允许空邮箱：`src/db/schema.ts:45` `email: text("email").notNull().default("")`。

修法：`recipientEmail` 为空时**不消耗券码**，改为记录一条可补发的失败事件；`grantLoserRewards` 同源问题一并处理。

### P1-2 · 奖励发放失败没有重试或补发通道

`maybeTriggerReward`（`src/services/lottery/participation.ts:738-795`）对三条路径全部 try-catch 吞掉异常——这个设计本身正确（奖励失败不应阻断参与主流程），但**catch 之后没有落地任何可重放的记录**，只有日志。需要一张失败队列（或复用 `activityEvents` 记 `reward_failed`）+ 管理端补发入口。

### P1-3 · 路径[3] 无任何管理端入口

`activityConfig.reward.perInviteAmount` / `currency` / `quota.perUserPerDay` / `quota.globalPerDay` 全部只能手改 JSON，发布预检也不校验（`src/services/lottery/reward.ts` 自身是宽容解析，`perInviteAmount <= 0` 静默跳过）。要么补 UI + 预检，要么明确标注为内部/已弃用能力。

### P1-4 · `reward_earned` 缺少 `source` 字段

四个生产者（路径[1]/[3]/[4] + 败者奖励）写同一个 `eventType`，只能靠 `metadata` 的 key 形状反推来源。加一个显式 `source` 枚举，看板与对账才可信。

### P2-1 · 漏斗看板「奖励发放」口径失真

直接源于 P1-4：四个来源混算，且失败不计入，导致「发放数」既不是意图数也不是到手数。

### P2-2 · `my-rewards` 存在 N+1 查询

按奖励逐条查询关联实体，应改为批量 `IN` 查询。

### P2-3 · `rewardId` 与阈值强耦合

`growth-config.ts` 用 `rewardId: \`invite_${r.requireCount}\`` 生成 ID。**运营一旦调整阈值（如 5 → 6），`rewardId` 随之改变，旧幂等标记失效，已达标用户会被重复发放。** 应改为与阈值无关的稳定 ID（如创建时生成的 slug/序号），阈值只作为条件值。这是一个**会造成资损**的隐患，优先级建议提到 P1。

### 关于 `package-lock.json`（更正第一版）

**不要删除，而且它并不违反强制规则。** 三条实测事实：

1. **它是部署载荷**：`scripts/build-for-vps.sh:164` 复制、`:178` 打进部署包，VPS 靠 `npm ci --omit=dev` 安装运行时依赖（docs/256 已验证）。删除会打断唯一的生产部署路径。
2. **架构校验脚本本来就不检查它**：`scripts/validate-architecture.mjs:283-296` 的 `checkSubprojectPackageManager` 只扫描仓库根 + `dtc` + `eshop`，**从不扫描 `templates/*`**。也就是说**工具层已经承认了这条例外**，只有 CLAUDE.md 的散文和提交前检查清单第 4 项没写。
3. **上下文**：`pnpm-workspace.yaml` 包含 `templates/*`（cf-lottery 是 workspace 成员），但其本地 `node_modules` 由 npm 安装（存在 `node_modules/.package-lock.json`，无 `node_modules/.pnpm`）。根 `package.json` 的 `preinstall` 阻断只在仓库根生效，不影响 `templates/*` 内的 npm 操作。

因此真实待办只有一条**文档修订**：把铁律 3 写成「开发期依赖管理用 pnpm；`templates/*` 的 VPS 部署包用 npm lockfile，属显式例外（已在 validate-architecture.mjs 中体现）」，并同步提交前检查清单第 4 项。

**另有一处真实违规，但不在本次范围内**：`node scripts/validate-architecture.mjs` 当前 13 通过 / 1 失败，失败项是 `dtc/package-lock.json 存在（npm 违规！）` —— 属 `dtc` 项目的既有问题，与 cf-lottery 无关，建议单独处理。

---

## 七、建议执行顺序

1. **先做决策，不要先写代码**：D1（CF 归档 or 一揽子恢复）、D2（叠加模型）、D3（推动上游拆纯计算入口 or 内联替换）。三者都是一次性定调，定完再排期。
2. **本次已完成**：回滚深导入改动（§0-5）；`^4.0.0` → `4.0.0` 锁版本 + lockfile 同步；清除 `package.json` 里的非法注释。**待办（零争议）**：修订铁律 3 的 npm 例外说明。（引擎导入的运行时形状断言测试已在本次补齐。）
3. **本周**：P2-3（`rewardId` 阈值耦合，资损隐患）、P1-1（空收件人烧券）。
4. **两周内**：按 D2 落地叠加模型 + `my-viral-stats` 统一进度面（这是让第 3 行能力真正闭环的唯一途径）；P1-2 失败补发通道。
5. **随后**：P1-3、P1-4、P2-1、P2-2。
6. **护栏（三条，缺一不可）**：
   - ✅ 引擎导入的**运行时形状断言**测试（§0-5，本次已补 `incentive-engine-contract.test.ts`）——手写 `.d.ts` 已证明能让 `tsc` 对导入形状错误完全失明；
   - `node dist/server.js` 启动冒烟（docs/256 建议 2）纳入 `verify:delivery`；
   - 若 D1 选 D1-b，把 `wrangler deploy --dry-run` 也纳入，否则修好的 CF 通道会再次静默腐化。

---

## 八、审查方法与可复现命令（均已实测）

```bash
# 1. 复现 CF 构建 ERROR（包根导入 + 无 nodejs_compat）
npx wrangler deploy --dry-run --outdir /tmp/cfout
# → ERROR Could not resolve "crypto"
#    node_modules/@usethink/incentive-engine/src/utils/version-select.js:14:23

# 2. 四组同口径测量：分别切换 wrangler.jsonc 的 nodejs_compat
#    与 src/services/lottery/referral-rewards-engine.ts:29 的导入路径，
#    每次执行上面的 dry-run 并读取 "Total Upload" 行。
#    结果见 §3.2。测量后务必还原两个文件（本次已还原并用 git diff 验证为空）。

# 3. 定位 Worker 图内的 node 内建依赖（第一版遗漏、本版关键证据）
grep -rn "node:" src/lib/local-media.ts
grep -n "local-media" src/routes/media.ts
grep -n "routes/media" src/index.ts

# 4. 确认 CF 已暂停
sed -n '1,15p' local-deploy-cloudeflare.sh
grep -n "暂停" docs/126_VPS默认部署脚本切换_2026-08-06.md

# 5. 确认 package-lock.json 是部署载荷（第一版判断错误的来源）
grep -n "package-lock\|npm ci" scripts/build-for-vps.sh

# 6. 枚举引擎 API 面与实际用量
node -e "const e=require('@usethink/incentive-engine');console.log(Object.keys(e).length)"
grep -rn "incentive-engine" src/ --include=*.ts

# 7. 确认深导入受发布产物支持
node -e "const p=require('@usethink/incentive-engine/package.json');console.log(p.exports,p.files)"
# → undefined  [ 'src/', 'README.md', 'CHANGELOG.md' ]

# 8. 确认引擎的组织级消费方
grep -rl "incentive-engine" --include=package.json /Users/dingyuwang/0-X/github_workflow
grep -n "incentive-engine" /Users/dingyuwang/0-X/2-node/rbb_nodejs/rbb/package.json

# 9. 复现 §0-5 的静默故障（深导入的导入形状不匹配）
node -e "const m=require('@usethink/incentive-engine/src/engine/distribute/index.js'); console.log(Object.keys(m)); console.log('Distribute:', typeof m.Distribute)"
# → [ 'distributeByDefs', 'calculateDirect', ... ]   Distribute: undefined
node -e "const e=require('@usethink/incentive-engine'); console.log('Distribute:', typeof e.Distribute, '| fn:', typeof e.Distribute.distributeByDefs)"
# → Distribute: object | fn: function      ← 调用点 engine.Distribute.distributeByDefs 只在包根成立
grep -n "engine.Distribute" src/services/lottery/referral-rewards-engine.ts

# 10. 裂变互斥死锁的两处证据
sed -n '795,825p' src/services/publish-check-service.ts
sed -n '655,665p' frontend/src/views/admin/lottery/growth-config.ts
```

---

## 九、执行方案（专业建议 · 决策稿）

### 9.0 新增的四个决定性事实（本节结论的依据）

| 事实 | 证据 | 对决策的影响 |
|---|---|---|
| **引擎是自有仓库，且已有 npm 发布流水线** | `/Users/dingyuwang/0-X/2-node/rbb_nodejs/incentive-engine`，`d0254b9 新增 npm publish workflow（tag 触发 + version check 保护）` | 「推动上游」不是跨组织协调，成本接近于零 → 路径 B 的最大障碍消失 |
| **`crypto` 在整个引擎里只用了一次** | `src/utils/version-select.js:14` `require("crypto")`；`:31` `createHash("md5")` 给 routingKey 分桶。全仓 `grep` 确认这是**唯一**的 node 内建依赖 | 缺陷是 1 行模块级 require，不是架构问题 → 不值得为它放弃复用 |
| **rbb 在用 md5 分桶** | `rbb/src/services/incentive-rule-set.service.js:19,191` 使用 `selectVersionByRoutingKey` | **不能改哈希算法**（会把 rbb 已有的 A/B 分桶全部重排）→ 只能改成惰性 require |
| **rbb 有 0 处深导入** | `grep -rn "@usethink/incentive-engine/" rbb/src \| wc -l` → `0`；17 处全部走包根 | 给引擎加 `exports` 映射对 rbb **安全** → 路径 B 可以放心做 |

### 9.1 结论：保留引擎，在上游修（路径 B）。今天不动生产代码。

理由：真实缺陷是**一行模块级 require**，不是架构错配到无法挽救；上游在自己手里；而内联要写约 150 行 + 30 个用例，并让奖励语义与 rbb 永久分叉。深导入已被证伪（§0-5）。

**今天正确的动作是「什么都不改」**：维持包根导入。VPS 有 docs/256 的 banner 兜底、CF 已暂停，没有任何时间压力去冒险。

### 9.2 引擎侧改动（发 v4.1.0，向后兼容）

| # | 改动 | 说明 |
|---|---|---|
| 1 | `src/utils/version-select.js`：把 `require("crypto")` 移进函数体（惰性） | md5 与分桶行为完全不变 → rbb 零影响。ESM 打包后 `sf("crypto")` 只在调用时触发，cf-lottery 从不调用 `selectVersion` → **模块级崩溃根除**，docs/256 的 `--banner:js` 兜底可退役 |
| 2 | 新增 `src/pure.js` 子入口：只含领域无关纯原语，**保持与包根完全相同的嵌套形状** `{ Distribute: {...}, Evaluate: {...} }` | 「保持同形状」是本条最关键的约束：§0-5 的事故根因正是深导入把 `Distribute` 这一层拍平了。同形状 ⇒ 消费方调用点 `engine.Distribute.distributeByDefs` **一个字都不用改** |
| 3 | 随包发布 `src/pure.d.ts` 官方类型 | 让 cf-lottery **删掉手写 `.d.ts`** —— 那是类型系统对导入形状失明的根因 |
| 4 | 加 `exports` 映射：`"." / "./pure" / "./package.json"` | rbb 0 深导入 → 安全；副作用是**从此封死所有深导入路径**，正好杜绝 §0-5 复发 |
| 5 | 引擎自带打包冒烟：用 esbuild 以 `--format=esm --platform=browser` 打 `./pure`，断言产物内 0 个动态 require | **护栏应该由引擎自己持有**，而不是让每个消费方各自防守 |

### 9.3 cf-lottery 侧改动（v4.1.0 发布之后，一次做完）

1. `src/services/lottery/referral-rewards-engine.ts` 改 `from "@usethink/incentive-engine/pure"` —— **仅此一行**，调用点不变。
2. **删除 `src/types/incentive-engine.d.ts`**，改用随包类型。
3. 更新 `incentive-engine-contract.test.ts`：允许 `/pure`、继续禁止 `/src/engine/`，保留运行时形状断言与行为断言。
4. 保持精确版本锁定（`4.1.0`），升级必须是显式动作。
5. 验证 `node dist/server.js` 冒烟通过后，再从 `scripts/build-for-vps.sh` 移除 `--banner:js`（**两步分开做**，不要和导入改动同批上线）。

### 9.4 兜底：若上游三个月内发不出来

再走路径 C（内联 ~150 行 + ~30 用例）。**不要走深导入**——已证伪，且 §0-5 的失败模式是静默的。

### 9.5 与另外两个决策的排期关系

**先修资损，再改架构。** `rewardId` 与阈值强耦合（§6 P2-3，建议升 P1）是**当前唯一会直接造成资损**的缺陷，且与引擎决策完全解耦：

- 病灶：`growth-config.ts` 用 `rewardId: \`invite_${r.requireCount}\`` 生成 ID，而 ID 同时是幂等键（存 `shareRecords.rewardMilestonesGranted`）。运营把阈值 5 调成 6 → ID 变成 `invite_6` → 已领过 `invite_5` 的人**再领一次**。
- 修法（一次性，不可回避）：`rewardId` 改为**创建时一次性生成、之后永不随可变字段派生**；配套一次**幂等的存量回填**——把现有配置显式写入与当前派生值完全相同的 ID（`invite_5` 仍是 `invite_5`），使已有幂等标记继续有效；表单模型携带既有 ID，编辑阈值不重算 ID；预检增加「缺 ID / ID 重复」报错（重复已有校验）。
- 修完后语义变正确：调高阈值 = 已发放的人保留、不重发；调低阈值 = 新达标的人可领。

裂变模型（D2）最小改动集：① 删除预检的 `viral.extra_entries.conflict_with_reward_defs`，改为「两层都用 `bonus_spin` 且缺总量上限」时告警；② `my-viral-stats` 同时返回基础进度与里程碑进度，并去掉「viral 关闭 + 有 defs」时的 400；③ **收敛两条 `bonus_spin` 写入路径**——`grantViralSpinsToSharer`（`participation.ts:800`）与 `grantBonusSpin`（`reward-exits.ts`）各自对同两列 `spinsLeft` / `spinsTotalGranted` 做 read-then-CAS，属同语义双实现，应统一到 `grantBonusSpin`。

### 9.6 推荐顺序

| 阶段 | 动作 | 前置 |
|---|---|---|
| 立即 | 维持包根导入不动；`rewardId` 稳定化 + 存量回填（资损） | 无 |
| 并行 | 引擎发 v4.1.0（§9.2 五条） | 无（自有仓库） |
| v4.1.0 后 | cf-lottery 切 `/pure` + 删手写 `.d.ts`（§9.3） | v4.1.0 已发布 |
| 之后 | D2 裂变叠加模型 + 统一进度面 + 收敛 spins 写入 | 资损修复已上线 |
| 之后 | D1 决定 CF 归档或恢复（恢复必须含 `local-media.ts` 处理 + `nodejs_compat`） | 与引擎解耦，可随时决策 |

---

## 十、执行进展（2026-08-22 记录）

### 10.1 阶段一（资损）— ✅ 已完成并提交

提交 `e8333e2b`。三处残孔（主修在此之前的 `8fb3aedd` 已完成 `#rewardId` 文本携带）：

| 位置 | 改动 |
|---|---|
| `src/lib/promotion-config-schema.ts` | `referralRewardDefsSchema` 加 `superRefine` 唯一性校验 —— `rewardId` 重复直接在保存期拦住（新建 `admin-lottery.ts:723` 与 patch `:901` 都过这条，`:901` 校验的是 merge 后的配置，故所有客户端全覆盖） |
| `frontend/.../growth-config.ts` | 新增 `sanitizeCouponLabel`（券名去 `#`，避免与 `#rewardId` 分隔符冲突）；新建行 ID 生成改为两遍扫描避让存量 ID（`invite_5` → `invite_5_2`） |
| `frontend/.../AdminLotteryView.vue` | 行内 `couponLabel` 变更时就地归一，运营立刻看到 `#` 被拒，而不是显示 `vip#a` 却存 `vipa` |

验证：后端 `tsc --noEmit` 0 + 1536 用例全绿；前端 `vue-tsc` 0 + 284 用例全绿。

### 10.2 阶段二（引擎 v4.1.0）— ✅ 已发布到 npm

引擎仓库 `/Users/dingyuwang/0-X/2-node/rbb_nodejs/incentive-engine` 提交 `6536973`，已于 2026-08-22 发布到 npmjs（tag `v4.1.0`，GitHub Actions workflow 32559971245）。cf-lottery 侧已完成升级并提交 `5b98c17a`。

| # | 条目 | 状态 |
|---|---|---|
| 1 | `version-select.js` crypto 惰性化 | ✅ 分桶结果与 4.0.0 逐键一致（2000+ key 对比 + 测试钉死基线） |
| 2 | `src/pure.js` 子入口，形状与包根完全一致 | ✅ 7 个键、同引用、同子键集合 |
| 3 | 随包发布 `src/pure.d.ts`；另给 `index.d.ts` 补默认导出 | ✅ 负向用例证明 `engine.Utils` 在 `/pure` 上会被类型检查拦住 |
| 4 | `exports` 映射 `"." / "./pure" / "./package.json"` | ✅ 深导入实测抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`；`rbb/scripts/verify-engine-version.js` 需要的 `/package.json` 已保留并实测可 resolve |
| 5 | 引擎自带打包冒烟 `scripts/smoke-pure.js` | ✅ 已接入 `npm run smoke` 与 `prepublishOnly`，发布前全部通过 |

关键实测（消除了原先仅停留在推断的两处）：

- `./pure` 以 `--format=esm --platform=browser` 打包**成功**，160.7kb，0 动态 require、0 内建导入。
- 包根同条件**仍报** `Could not resolve "crypto"` —— 证明「惰性化解决不了 CF 场景」，`/pure` 不是可选优化而是必需。
- 此前那条「产物里疑似残留 crypto / Dynamic require」的观察已查清：命中的是 `src/pure.js` 文档块里的示例文本，因该块带 `@license` 被 esbuild 当作 legal comment 保留。产物里 0 个真实 `require(` 调用、0 个 `__require` 辅助函数定义。冒烟脚本已用 `legalComments: "none"` 规避该假阳性，并内置正/负对照自检。
- 反例验证：向 `src/engine/model/index.js` 注入 `require("crypto")`、以及把 `pure.js` 的 `Distribute` 层抹平，冒烟均如期失败并指名病灶。

### 10.3 cf-lottery 侧升级记录（2026-08-22，commit 5b98c17a）

| # | 改动 | 说明 |
|---|---|---|
| 1 | `package.json` / `package-lock.json` | `@usethink/incentive-engine` 从 `4.0.0` 升级到 `4.1.0` |
| 2 | `referral-rewards-engine.ts` | 导入路径从 `@usethink/incentive-engine` 切换到 `@usethink/incentive-engine/pure`；`RewardDef` 改为 `RewardDefLike`（值类未导出，interface 可透传） |
| 3 | `incentive-engine-contract.test.ts` | 测试导入同步切换到 `/pure`；版本断言更新为 `4.1.0`；records 映射增加类型标注 |
| 4 | `src/types/incentive-engine.d.ts` | 删除整文件（63 行），改用随包官方类型声明 |
| 5 | `scripts/build-for-vps.sh` | 移除 `--banner:js` createRequire hack（pure 入口零 Node 依赖，不再需要） |

验证结果：
- `npx tsc --noEmit` 通过（0 错误）
- `npx vitest run` 通过（43/43 套件，985 通过）
- `npm view @usethink/incentive-engine@4.1.0` 确认已发布到 npmjs
2. `rbb/scripts/verify-engine-version.js` 的 `EXPECTED_ENGINE_VERSION` 仍锁 `3.4.10`，而 rbb 实际装的是 4.0.0 —— **本次改动之前即已漂移**，属既有问题，未在本次一并改（rbb 走 registry 安装，不受本地引擎改动影响）。

### 10.4 阶段四（D2 裂变叠加模型）— ✅ 已完成并提交

按 §9.5 的最小改动集执行，实施顺序为 ③ → ② → ①（先有共享的阈值提取器，预检告警才能复用它），每个文件一提交，共 9 个提交。

| 项 | 改动 | 文件 |
|---|---|---|
| ③ | 抽出唯一裁剪公式 `computeBonusSpinGrant`（双封顶：总量顶 + 可选裂变子顶），删除同语义的 `computeViralSpinGrant` | `src/services/lottery/spin-quota.ts` |
| ③ | `grantBonusSpin` 第 8 参改为 options 对象（`source` / `maxViralExtra` / `refId`），并读写 `spinsViralEarned` | `src/services/lottery/reward-exits.ts` |
| ③ | `grantViralSpinsToSharer` 收敛为 `grantBonusSpin` 的薄封装——两条 `bonus_spin` 写入路径合并为**一处 CAS、一处 spins_log、一处审计** | `src/services/lottery/participation.ts` |
| ② | 新增零引擎依赖纯计算模块：幂等标记解析（唯一实现）、`extractMilestoneThreshold`、`buildMilestoneProgress` | `src/services/lottery/referral-milestones.ts`（新） |
| ② | `my-viral-stats` 同时返回基础进度与里程碑进度（`viralEnabled` / `milestones` / `nextMilestone` / `milestonesUnlocked` / `milestonesGranted`），并去掉「viral 关闭 + 有 defs」时的 400 | `src/routes/public-lottery-share.ts` |
| ① | 删除 `viral.extra_entries.conflict_with_reward_defs` 阻断，改为裁剪告警 | `src/services/publish-check-service.ts` |

发放侧与展示侧共用同一份幂等标记解析，杜绝「进度条说已达标、实际未发放」的漂移。

**验证**：`npx tsc --noEmit` 干净；后端全量 vitest 全绿（**107 文件 / 1560 测试**，基线 106 / 1536，净 +24）。新增测试：`spin-quota` 双封顶 7 例、`referral-milestones` 16 例（新文件）、`publish-check-service` 裁剪告警 3 例（替换原互斥断言 2 例）、`auth-and-public` 里程碑进度 2 例、`lottery-service` 两层叠加端到端 1 例。

端到端叠加轨迹（`lottery-service.test.ts`，`maxSpinsPerEntry: 10`、基础层每邀请 +1 子顶 5、里程碑 `invite_2` 阈值 2 加成 +2）：

| 事件 | spinsTotalGranted | spinsViralEarned | spinsLeft |
|---|---|---|---|
| 参与 | 1 | 0 | 1 |
| 第 1 次邀请（仅基础层） | 2 | 1 | 2 |
| 第 2 次邀请（基础层 +1、里程碑 +2） | 5 | 2 | 5 |
| 第 3 次邀请（里程碑已幂等，仅基础层） | 6 | 3 | 6 |

同时断言 `spins_log` 三条 `refId: share:*` + 一条 `refId: engine:invite_2`，以及 `reward_earned` 三条 `source: viral` + 一条 `source: engine`；`publishDraw` 在两层同时配置下成功（① 的直接回归证明）。

**⚠️ 尚未闭环的一环（前端，独立交付物）**：`ViralLeaderboard.vue:374` 与 `GameResultModal.vue:195-197` 仍在 `viral.enabled === true` 时才渲染，新增的 `milestones` / `nextMilestone` 目前对用户不可见；`frontend/src/views/admin/lottery/growth-config.ts:698-699` 仍无条件下发 `perInvite = form.viralExtraEntriesPerInvite || 1`（旧发布死锁的成因）。后端已就绪，前端阶梯 UI 需单独排期。
