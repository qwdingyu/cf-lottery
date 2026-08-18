# CSP nonce + stale asset recovery（docs/242）

## 背景

借鉴 cf-shop 的两个安全/体验优点到 cf-lottery：
1. **CSP nonce**：防御 XSS（script-src 不放行 unsafe-inline）
2. **stale asset recovery**：部署后旧页面 chunk 404 自动刷新

## 重合审查（cf-core）

| 能力 | cf-core 是否有 | 结论 |
|------|--------------|------|
| CSP nonce | ❌ 无（只有旧的 `buildSecurityHeaders` 静态 CSP，含 unsafe-inline）| 无重合，需自建 |
| stale asset recovery | ❌ 无（cf-core 不打包前端代码）| 无重合，需自建 |

**结论**：cf-core 无这两项能力，不重复造轮子。实现借鉴 cf-shop（纯函数，跨环境可复用）。

## 实现

### 1. CSP nonce（`src/lib/csp.ts` + `src/server.ts`）

- `createCspNonce()`：128bit 随机 base64
- `buildCsp(nonce)`：script-src 追加 nonce，彻底移除 unsafe-inline
- `injectCspNonce(html, nonce)`：给每个 `<script>` 补 nonce 属性
- server.ts 中间件：**必须放在 serveStatic 之前**（serveStatic 匹配到 index.html 直接返回，不调用 next，若在其后则永远不执行）

**运行时验证**（curl 实测）：
- `/` → CSP 头含 nonce + script 有 nonce 属性 + `cache-control: no-store` ✓
- SPA fallback 路径 → 同样注入 ✓
- 静态 JS/CSS → 无 CSP 头（不损耗性能）✓
- API → 无 CSP 头 ✓

### 2. stale asset recovery（`frontend/src/lib/stale-asset-recovery.ts` + `main.ts`）

- `isStaleAssetLoadError`：匹配动态 import 失败错误
- `buildStaleAssetRecoveryUrl`：加 `__asset_reload=1` 参数，已带则返回 null（防无限刷新）
- `clearStaleAssetRecoveryParam`：路由跳转后清理参数
- main.ts：监听 `vite:preloadError` + `router.onError`，一次性刷新；`router.afterEach` 清理参数

## 验证

```
tsc 0；vue-tsc 0；build 成功；vitest 1355 passed（新增 csp.test.ts 5 用例）
运行时：curl 实测 CSP 头 + nonce 注入 + 静态/API 不注入
```