#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# deploy-to-vps.sh —— 从已构建产物打包并部署到 VPS（systemd 模式）
#
# 前提：
#   1. 已执行 bash scripts/build-for-vps.sh（或带 --obfuscate）
#   2. VPS 已配置 SSH 免密登录
#   3. VPS 已安装 Node.js 24, systemd 服务已配置（详见 docs/156）
#
# 用法：
#   VPS_HOST=38.47.198.72 VPS_PATH=/root/cf-lottery bash scripts/deploy-to-vps.sh
#
# 默认部署目标（与 local-deploy-vps.sh 一致）：
#   VPS_HOST=38.47.198.72
#   VPS_USER=root
#   VPS_PATH=/root/cf-lottery
#
# 推荐：使用 local-deploy-vps.sh（构建+上传一体），本脚本用于需要分离构建与部署的场景。
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()   { echo -e "${RED}[deploy]${NC} $*" >&2; }

VPS_HOST="${VPS_HOST:-38.47.198.72}"
VPS_PATH="${VPS_PATH:-/root/cf-lottery}"
VPS_USER="${VPS_USER:-root}"

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
PACKAGE_FILE="cf-lottery-deploy-$(date +%Y%m%d-%H%M%S).tar.gz"
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
cat "$PACKAGE_FILE" | ssh "$VPS_USER@$VPS_HOST" "cat > $VPS_PATH/$PACKAGE_FILE"

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

# 重启 systemd 服务（启动时自动执行数据库迁移）
systemctl restart cf-lottery
echo "[deploy] systemd 已重启 cf-lottery"
DEPLOY_SCRIPT

# ── 清理本地打包文件 ──
rm "$PACKAGE_FILE"
echo ""
info "✅ 部署完成！"
info "访问地址: http://$VPS_HOST:8787"
