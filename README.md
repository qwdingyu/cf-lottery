# cf-lottery 项目索引

> 最后更新：2026-08-01
> 项目：https://github.com/qwdingyu/cf-lottery
> 线上：https://lucky.eforge.xyz

---

## 项目定位

**轻量多租户抽奖 SaaS** — 面向社群运营、门店促销、企业年会等场景，3 分钟创建活动，自动发奖，公平开奖。

## 技术栈

| 层 | 技术 |
|------|------|
| 后端 | Cloudflare Workers + Hono + Drizzle ORM |
| 数据库 | Turso（libSQL） |
| 前端 | Vue 3 + Vite + TypeScript |
| 邮件 | Resend |
| 部署 | Wrangler + Cloudflare Pages |

## 文档索引

| 编号 | 文档 | 内容 |
|------|------|------|
| 003 | 抽奖系统独立孵化方案 | 084 原文，产品定位、架构设计 |
| 004 | 084/085 文档对齐审查 | 实施对齐状态 |
| 008 | 首次部署踩坑记录 | 9 个问题 + 最佳实践 |
| 009 | 导流模式实现方案 | 借力 cf-shop 模式 |
| 010 | 前端体验升级方案 | 可插拔游戏引擎架构 |
| 011 | 首页与活动页产品设计决策 | 三种定位分析 |

## 快速开始

```bash
# 安装
npm install

# 本地开发
cd frontend && npx vite

# 部署
cd frontend && npx vite build && cd ..
npx wrangler deploy
```

## 必需 Secrets

```bash
wrangler secret put TURSO_URL
wrangler secret put TURSO_TOKEN
wrangler secret put JWT_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put EMAIL_FROM
wrangler secret put CRON_SECRET
```