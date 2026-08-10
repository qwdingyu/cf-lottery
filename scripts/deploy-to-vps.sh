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
shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

VPS_HOST="${VPS_HOST:-38.47.198.72}"
VPS_PATH="${VPS_PATH:-/root/cf-lottery}"
VPS_USER="${VPS_USER:-root}"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_SSH_KEY="${VPS_SSH_KEY:-}"
SSH_ARGS=(-p "$VPS_SSH_PORT" -o ServerAliveInterval=5)

if [ -n "$VPS_SSH_KEY" ]; then
  case "$VPS_SSH_KEY" in
    ~/*) VPS_SSH_KEY="$HOME/${VPS_SSH_KEY#~/}" ;;
  esac
  if [ ! -f "$VPS_SSH_KEY" ]; then
    err "私钥文件不存在: $VPS_SSH_KEY"
    exit 1
  fi
  SSH_ARGS+=(-i "$VPS_SSH_KEY")
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
#   migrations/       启动自动迁移所需 SQL 文件
#   configs/          systemd 服务与维护 timer 模板
info "步骤 1/3：打包部署产物..."
PACKAGE_FILE="cf-lottery-deploy-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$PACKAGE_FILE" \
  dist/server.js \
  public/ \
  package.json \
  package-lock.json \
  configs/ \
  migrations/ \
  --exclude='.DS_Store'
info "打包完成 → $PACKAGE_FILE ($(du -h "$PACKAGE_FILE" | cut -f1))"

# ── 步骤 3：上传 + 部署 ──
REMOTE_DIR="$(shell_quote "$VPS_PATH")"
REMOTE_PACKAGE_PATH="$(shell_quote "${VPS_PATH%/}/$PACKAGE_FILE")"
info "步骤 2/3：上传到 $VPS_USER@$VPS_HOST:$VPS_PATH ..."
ssh "${SSH_ARGS[@]}" "$VPS_USER@$VPS_HOST" "mkdir -p $REMOTE_DIR"
cat "$PACKAGE_FILE" | ssh "${SSH_ARGS[@]}" "$VPS_USER@$VPS_HOST" "cat > $REMOTE_PACKAGE_PATH"

info "步骤 3/3：VPS 上安装依赖 + 重启服务..."
ssh "${SSH_ARGS[@]}" "$VPS_USER@$VPS_HOST" << DEPLOY_SCRIPT
set -euo pipefail
cd $REMOTE_DIR

# 备份旧版本
if [ -f dist/server.js ]; then
  cp dist/server.js "dist/server.js.bak-\$(date +%Y%m%d-%H%M%S)" || true
fi

# 解压新版本
tar -xzf $(shell_quote "$PACKAGE_FILE")
rm $(shell_quote "$PACKAGE_FILE")

# 安装运行时依赖（仅 production，不装 devDependencies）
npm ci --omit=dev

# 安装维护定时器：VPS 模式没有 Cloudflare scheduled handler，必须由 systemd timer 触发维护闭环。
install -m 0644 configs/cf-lottery-maintenance.service /etc/systemd/system/cf-lottery-maintenance.service
install -m 0644 configs/cf-lottery-maintenance.timer /etc/systemd/system/cf-lottery-maintenance.timer
systemctl daemon-reload
systemctl enable --now cf-lottery-maintenance.timer

# 重启 systemd 服务（启动时自动执行数据库迁移）
systemctl restart cf-lottery
echo "[deploy] systemd 已重启 cf-lottery"
DEPLOY_SCRIPT

# ── 清理本地打包文件 ──
rm "$PACKAGE_FILE"
echo ""
info "✅ 部署完成！"
info "访问地址: http://$VPS_HOST:8787"
