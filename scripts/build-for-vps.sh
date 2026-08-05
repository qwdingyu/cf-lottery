#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# build-for-vps.sh —— VPS/云服务器 编译打包脚本
#
# 产出物（一次性打包）：
#   dist/server.js    后端单文件 bundle（esbuild 编译+minify）
#   dist/server.obs.js 混淆版（如启用 --obfuscate）
#   public/           前端静态资源（由 npm run frontend:build 生成）
#
# 为什么不用 javascript-obfuscator 直接混淆 src/？
# ─────────────────────────────────────────────────
# src/ 是 TypeScript 源码，混淆器不认识 TS。正确顺序：
#   tsc 类型检查 → esbuild 编译 TS→JS → javascript-obfuscator 混淆 JS
# 混淆 JS 而不是 TS——混淆后的代码是纯 ES 模块，Node.js 直接可执行。
#
# 为什么用 esbuild 而不是 tsc --emit？
# ─────────────────────────────────────
#   - esbuild 比 tsc 快 100 倍
#   - tree-shaking 删除未使用代码
#   - 单文件 bundle 便于部署（一个文件 vs 目录树）
#   - 内置 minify（缩短变量名、删除注释）
#   - --external 排除原生模块（@libsql/client 的 SQLite 绑定不适合打包）
#
# 为什么 @libsql/client 要 external？
# ──────────────────────────────────
#   @libsql/client 依赖原生 SQLite 扩展（Node.js addon），
#   这些 .node 文件不能被打包进 JavaScript bundle。
#   标记为 external 后，VPS 上通过 npm ci --omit=dev 安装。
#
# 用法：
#   bash scripts/build-for-vps.sh              # 编译 + minify
#   bash scripts/build-for-vps.sh --obfuscate  # 编译 + minify + 混淆
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DO_OBFUSCATE=false
for arg in "$@"; do
  case "$arg" in --obfuscate) DO_OBFUSCATE=true ;; esac
done

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[build]${NC} $*"; }
warn()  { echo -e "${YELLOW}[build]${NC} $*"; }

# ── 步骤 0：清理上次产物 ──
rm -rf dist && mkdir -p dist
info "步骤 0/4：清理 dist/"

# ── 步骤 1：TypeScript 类型检查 ──
info "步骤 1/4：TypeScript 类型检查..."
npx tsc --noEmit
info "tsc 通过"

# ── 步骤 2：前端构建 ──
info "步骤 2/4：构建前端..."
npm run frontend:build
info "前端构建完成 → public/"

# ── 步骤 3：后端编译打包 ──
# esbuild 参数说明：
#   --bundle              将所有 import 内联到单个文件
#   --platform=node       Node.js 环境（非浏览器）
#   --target=node20       最低 Node.js 20（广泛兼容）
#   --format=esm          输出 ES 模块（与 package.json "type":"module" 一致）
#   --minify              删除注释、缩短变量名、压缩空白
#   --external            不打包原生/动态加载模块
#   --outfile             输出单文件
info "步骤 3/4：esbuild 编译打包..."
npx esbuild src/server.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=esm \
  --minify \
  --external:@libsql/client \
  --external:dotenv \
  --outfile=dist/server.js

RAW_SIZE=$(stat -f%z dist/server.js 2>/dev/null || stat -c%s dist/server.js 2>/dev/null || echo 0)
info "后端编译完成 → dist/server.js ($(echo "scale=1; $RAW_SIZE/1024" | bc 2>/dev/null || echo -n "?")KB)"

# ── 步骤 4：（可选）代码混淆 ──
if [ "$DO_OBFUSCATE" = true ]; then
  info "步骤 4/4：javascript-obfuscator 混淆..."
  
  # 混淆参数选择原则（针对服务端代码）：
  #   ✅ string-array-encoding rc4    字符串加密，体积增加小
  #   ✅ compact + simplify           与 esbuild 已有的 minify 互补
  #   ❌ control-flow-flattening      严重降低运行时性能（20-50%），服务端禁用
  #   ❌ dead-code-injection          显著增大体积（50-100%），接近 Workers 1MB 限制
  #   ✅ rename-globals false         保留 process.env / globalThis 等全局引用
  npx javascript-obfuscator dist/server.js \
    --output dist/server.js \
    --string-array-encoding rc4 \
    --compact true \
    --simplify true \
    --rename-globals false \
    --control-flow-flattening false \
    --dead-code-injection false 2>&1 || {
      warn "混淆失败（可能是工具未安装），跳过混淆，继续使用 dist/server.js"
      warn "如需混淆请先安装：npm install -D javascript-obfuscator"
    }

  OBS_SIZE=$(stat -f%z dist/server.js 2>/dev/null || stat -c%s dist/server.js 2>/dev/null || echo 0)
  info "混淆完成 → dist/server.js ($(echo "scale=1; $OBS_SIZE/1024" | bc 2>/dev/null || echo -n "?")KB)"
else
  warn "跳过混淆（使用 --obfuscate 启用）"
fi

# ── 产出物清单 ──
echo ""
info "✅ VPS 构建完成"
echo "   后端:  dist/server.js"
echo "   前端:  public/"
echo "   部署:  将 dist/server.js + public/ + package.json + package-lock.json 上传到 VPS"
echo "   安装:  npm ci --omit=dev"
echo "   运行:  PORT=8787 node dist/server.js"
echo "   守护:  pm2 start dist/server.js --name lottery -- --port 8787"
echo ""
if [ "$DO_OBFUSCATE" = false ]; then
  echo "   💡 如需启用代码混淆，重新运行: bash scripts/build-for-vps.sh --obfuscate"
fi
