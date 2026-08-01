# cf-lottery 项目规则

## 核心定位

cf-lottery 是一个**多租户、可白标、可嵌入的活动引擎平台**。抽奖是第一种玩法，不是唯一玩法。核心是"规则驱动的参与与结果分配"。

## 开发铁律

### 1. 代码提交
- 每次代码变更必须提交到 git 仓库
- commit 消息使用中文
- 提交前运行 `npx tsc --noEmit` 和 `npx vitest run` 确保通过

### 2. 文档同步
- 所有代码修改都要同步更新文档
- 文档保存在 `docs/` 目录下
- 命名规范：`序号_中文文件名_日期.md`
- 文件名不能含有空格

### 3. 架构原则
- 不要做大而全的系统，做小而美的瑞士军刀
- 不要过度设计，不要过度开发
- 所有改动必须在分析清楚全局和代码的基础上进行
- 确保所有环节形成闭环
- 对核心代码、变量、常量、业务流程补充详细中文注释

### 4. 测试
- 所有核心功能必须进行详细的单元测试
- 测试脚本要正式，不能写了删、删了写
- 使用正式的测试框架，建立知识沉淀

### 5. 技术选型
- 采用行业最优方案和算法
- 遵循行业最佳实践
- 不重复造轮子、不闭门造车
- 能够使用 ORM 的情况下不使用 SQL（防止 SQL 注入或数据库切换问题）

### 6. 文档管理
- 针对发现的问题、规范、规则、流程等保存到 `docs/` 目录
- 踩坑记录格式：背景、原因、排查过程、解决方案、建议

### 7. 效率
- 使用 rtk（节省 token）、mcp、skills 提高效率
- 围绕核心功能展开，不在细节上占用太长时间
- 细节可整理到 `docs/` 下的 todolist 中

## 模块结构

### 后端模块
- `src/routes/` — API 路由（auth、admin-lottery、public-lottery、system-config）
- `src/services/` — 业务逻辑（lottery-service、email-service）
- `src/middleware/` — 中间件（auth JWT 验证）
- `src/db/` — 数据库（schema、client、migrations）
- `src/lib/` — 工具库（http、token、secret-config、system-config-registry）

### 前端模块
- `frontend/src/views/` — 页面（AdminLotteryView、LotteryView、AdminLoginView）
- `frontend/src/components/` — 组件（AdminModal、ToastContainer、games/）
- `frontend/src/composables/` — 组合式函数（useToast、useAdminAuth）
- `frontend/src/router/` — 路由配置
- `frontend/src/i18n/` — 国际化

## 核心数据模型

### 活动表 (lottery_draws)
- `activity_kind` — 活动类型（lottery/signup_chain/vote/survey 等）
- `participation_mode` — 参与模式（open/roster/password/invite_code）
- `experience_type` — 体验类型（submit/wheel/slot/scratch/card）
- `result_mode` — 结果模式（manual/scheduled/instant）
- `policy_version` — 规则版本号
- `promotion_config` — 导流配置（JSON）

### 三个独立维度
- `participation_mode` 描述"谁可以参加、如何验证"
- `experience_type` 描述"用户看到什么交互"
- `result_mode` 描述"结果什么时候产生"

三者不能互相推导。它们是独立配置。

## 部署流程

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env 填写 TURSO_URL、JWT_SECRET、RESEND_API_KEY 等

# 2. 一键部署
bash local-deploy.sh
```

## 验收标准

- TypeScript 类型检查: 0 errors
- 单元测试: 全部通过
- 多租户隔离: 用户 A 看不到用户 B 的活动
- 卡密: 不会跨租户、不会重复发放
- 并发开奖: 不会重复中奖
- 邮件失败: 不回滚开奖结果
- 公开链接: 使用 public_slug，不暴露内部 ID