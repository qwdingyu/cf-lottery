# esbuild ESM 打包 incentive-engine v4 动态 require 崩溃与修复

日期：2026-08-21
编号：docs/256
关联：docs/255 G-1（cf-core 导入）、commit d9e8e83（incentive-engine ^3.4.10 → ^4.0.0）

## 背景

2026-08-21 部署新版到 VPS 生产（`38.47.198.72`）时，`systemctl restart cf-lottery` 后服务进入
auto-restart 循环，持续崩溃：

```
Error: Dynamic require of "crypto" is not supported
    at file:///root/cf-lottery/dist/server.js:1:383
    at file:///root/cf-lottery/dist/server.js:80:91582
```

生产瞬时不可用，回滚到备份（`cf-lottery.bak-20260821`，部署前的旧版 dist/public）后恢复。

## 原因

1. **incentive-engine v4.0.0 引入 CJS 风格的 `require()` 调用**：
   - `module-level: var kj = require("crypto")`（模块加载即执行 → 立即崩溃）
   - `lazy: require("sequelize")`（`_handleSettleError` 中 try-catch 捕获 MODULE_NOT_FOUND 降级）
   - `lazy: require("joi")`（配置校验传入后 try-catch 降级）
   - `crypto` 是 Node 内置、`sequelize`/`joi` 是 optional peerDependencies（npm ci 不安装）

2. **esbuild `--format=esm` 打包限制**：
   - esbuild 把 CJS 模块包进 `ut()` CJS 包装器，其内部 `require()` 无法静态转换为 ESM import
   - 对无法静态分析的 require，esbuild 注入 `sf()` 动态 require 辅助函数
   - 纯 ESM（无全局 `require`）下，`sf()` 执行即抛 "Dynamic require of X is not supported"
   - `--external:crypto` 无效：external 只影响顶层 import 解析，不处理已嵌入 CJS 包装器内的 require

## 排查过程

1. 本地复现：`node dist/server.js` 报相同错误（确认是构建产物问题，非 VPS 环境问题）
2. 定位动态 require：搜索 dist 产物发现 3 处 `sf("crypto")` / `sf("sequelize")` / `sf("joi")`
3. 确认来源：`node_modules/@usethink/incentive-engine/package.json` — sequelize/joi 是
   **optional peerDependencies**，且引擎内均为 try-catch 懒加载降级路径
4. 确认触发点：只有 `crypto` 在**模块级立即求值**导致崩溃；sequelize/joi 是懒加载不会在启动期触发

## 解决方案

在 `scripts/build-for-vps.sh` 的 esbuild 命令中注入 `--banner:js`，用 Node ESM 的
`createRequire(import.meta.url)` 恢复 CJS 兼容的 `require` 环境：

```bash
--banner:js="import{createRequire as __createRequire}from'module';var require=__createRequire(import.meta.url);"
```

原理与效果：
- `sf()` 辅助函数判断 `typeof require < "u"` → 现在为 true，走原生 require 路径
- `crypto`（Node 内置）→ require 可直接 resolve，模块级加载正常
- `sequelize`/`joi`（未安装）→ require 抛 MODULE_NOT_FOUND → 引擎内 try-catch 捕获 → 优雅降级
- 完全匹配 incentive-engine v4 的设计意图（其在 CJS 环境就是依赖运行时 require + try-catch）

本地验证：`node dist/server.js` 正常启动（`cf-lottery on http://localhost:8787`），无 Dynamic require 错误。

## 部署验证

1. `VPS_SSH_KEY=~/.ssh/jp_72_scp-key bash local-deploy-vps.sh` → 构建 + 上传成功（752376 字节，大小校验一致）
2. VPS 后台解压 + `npm ci --omit=dev`（需显式 `export PATH=/root/.nvm/versions/node/v24.18.0/bin:$PATH`，
   因为 nohup 非交互 shell 不加载 .bashrc 的 nvm）
3. `systemctl restart cf-lottery` → active running，端口 8787 监听，`curl http://127.0.0.1:8787/` → HTTP 200
4. 日志确认：`数据库 schema 已是最新（本地 SQLite）`、无 Dynamic require 错误

## 建议

1. **升级 incentive-engine 到 v4 后必须本地冒烟**：`node dist/server.js` 至少要能启动。本次如果
   部署前本地跑一次就能提前发现，避免生产宕机。
2. **构建脚本加启动冒烟检查**：`scripts/build-for-vps.sh` 可在 esbuild 打包后加一个
   `timeout 5 node dist/server.js` 的 smoke check（可考虑后续列入 build 步骤）。
3. 部署包上传/解压/npm ci/restart 四步建议固化到 deploy 文档，避免本次手工程序散落记忆。