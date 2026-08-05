#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# deploy-to-vps.sh —— 打包并部署到 VPS
#
# 前提：
#   1. 已执行 bash scripts/build-for-vps.sh（或 bash scripts/build-for-vps.sh --obfuscate）
#   2. VPS 已配置 SSH 免密登录
#   3. VPS 上已安装 Node.js 20+
#
# 用法：
#   VPS_HOST=1.2.3.4 VPS_PATH=/opt/lottery bash scripts/deploy-to-vps.sh
#
# VPS 环境变量建议配置在 /etc/systemd/system/lottery.service 或 .env 中：
#   TURSO_URL=https://...
#   TURSO_TOKEN=...
#   JWT_SECRET=...
#   APP_ORIGIN=https://lucky.eforge.xyz
#   ...
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()   { echo -e "${RED}[deploy]${NC} $*" >&2; }

VPS_HOST="${VPS_HOST:-}"
VPS_PATH="${VPS_PATH:-/opt/cf-lottery}"
VPS_USER="${VPS_USER:-root}"

if [ -z "$VPS_HOST" ]; then
  err "请设置 VPS_HOST 环境变量"
  echo "  用法: VPS_HOST=1.2.3.4 VPS_PATH=/opt/lottery bash scripts/deploy-to-vps.sh"
  exit 1
fi

# ── 步骤 1：确认构建产物存在 ──
if [ ! -f dist/server.js ]; then
  err "dist/server.js 不存在"
  echo "  请先执行: bash scripts/build-for-vps.sh"
  exit 1
fi

# ── 步骤 2：打包 ──
# 仅打包运行时需要的文件：
#   dist/server.js    后端 bundle
#   public/           前端静态资源
#   package.json      依赖声明（VPS 上 npm ci --omit=dev）
#   package-lock.json 锁定版本
info "步骤 1/3：打包部署产物..."
PACKAGE_FILE="deploy-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$PACKAGE_FILE" \
  dist/server.js \
  public/ \
  package.json \
  package-lock.json \
  --exclude='.DS_Store'
info "打包完成 → $PACKAGE_FILE ($(du -h "$PACKAGE_FILE" | cut -f1))"

# ── 步骤 3：上传 + 部署 ──
info "步骤 2/3：上传到 $VPS_USER@$VPS_HOST:$VPS_PATH ..."
ssh "$VPS_USER@$VPS_HOST" "mkdir -p $VPS_PATH"
scp "$PACKAGE_FILE" "$VPS_USER@$VPS_HOST:$VPS_PATH/"

info "步骤 3/3：VPS 上安装依赖 + 重启服务..."
ssh "$VPS_USER@$VPS_HOST" << DEPLOY_SCRIPT
set -e
cd "$VPS_PATH"

# 备份旧版本
if [ -f dist/server.js ]; then
  cp dist/server.js "dist/server.js.bak-\$(date +%Y%m%d-%H%M%S)" || true
fi

# 解压新版本
tar -xzf "$PACKAGE_FILE"
rm "$PACKAGE_FILE"

# 安装运行时依赖（仅 production，不装 devDependencies）
npm ci --omit=dev 2>&1 | tail -3

# 平滑重启（0 秒停机）
if command -v pm2 &>/dev/null && pm2 list 2>/dev/null | grep -q lottery; then
  PORT=\${PORT:-8787} pm2 restart lottery --update-env
  echo "[deploy] PM2 已重启 lottery"
else
  echo "[deploy] PM2 未找到 lottery 进程，手动启动："
  echo "  cd $VPS_PATH && PORT=8787 pm2 start dist/server.js --name lottery"
fi
DEPLOY_SCRIPT

# ── 清理本地打包文件 ──
rm "$PACKAGE_FILE"
echo ""
info "✅ 部署完成！"
info "访问地址: http://$VPS_HOST:8787"
