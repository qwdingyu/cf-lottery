# 124 · 管理端布局与 cf-admin-fe registry 依赖

日期：2026-08-05  
场景：发版部署前收口未提交改动，保证 Cloudflare 构建可复现。

## 变更

### 1. `@usethink/cf-admin-fe` 改用 npm registry

| 之前 | 之后 |
|:-----|:-----|
| `file:../../cf-admin-fe`（本机 link） | `^0.2.6`（`registry.npmjs.org`） |

**原因**：Workers/CI/他人机器无相邻 `cf-admin-fe` 目录时，`file:` 依赖会装失败或装到错误版本；registry 保证发版可复现。

### 2. Admin / Platform 布局

- 侧栏底部用户区 + 退出 → **顶栏**用户头像/名称 + 退出
- 退出按钮样式与顶栏语言选择对齐（高度 28px、边框）
- Platform 布局同步同一交互位置

## 验证

```bash
npx tsc --noEmit
npx vitest run   # 43 files / 469 passed
bash local-deploy.sh
```

## 关联

- tip 前序：`b6b5574`（cf-admin-fe offset/复制与批量 toast）
- 部署 Runbook：docs/123
