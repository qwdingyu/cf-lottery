#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# local-deploy-vps.sh — 本地构建 VPS 部署包并上传到指定服务器
#
# 背景：当前生产部署已从 Cloudflare Workers 暂停，改为 VPS 模式。
# 本脚本只负责「构建 + 打包 + scp 上传」，不会在服务器上解压或重启服务，
# 避免把上传与远端发布动作耦合在一起。
#
# 用法：
#   VPS_SSH_KEY=~/.ssh/cf-lottery-vps.pem bash local-deploy-vps.sh
#
# 可选覆盖：
#   VPS_HOST=38.47.198.72 VPS_USER=root VPS_PATH=/root VPS_SSH_KEY=~/.ssh/key bash local-deploy-vps.sh
#   VPS_SSH_PORT=22 VPS_BUILD_FLAGS="--obfuscate" VPS_SSH_KEY=~/.ssh/key bash local-deploy-vps.sh
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[vps-deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[vps-deploy]${NC} $*"; }
err()   { echo -e "${RED}[vps-deploy]${NC} $*" >&2; }

VPS_HOST="${VPS_HOST:-38.47.198.72}"
VPS_USER="${VPS_USER:-root}"
VPS_PATH="${VPS_PATH:-/root}"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_SSH_KEY="${VPS_SSH_KEY:-}"
VPS_BUILD_FLAGS="${VPS_BUILD_FLAGS:-}"

if [ -z "$VPS_SSH_KEY" ]; then
  err "缺少 VPS_SSH_KEY，请指定用于登录 $VPS_USER@$VPS_HOST 的私钥路径"
  echo "  示例: VPS_SSH_KEY=~/.ssh/cf-lottery-vps.pem bash local-deploy-vps.sh"
  exit 1
fi

# 展开常见的 ~/ 私钥路径，避免 scp -i 收到未展开的字符串。
case "$VPS_SSH_KEY" in
  ~/*) VPS_SSH_KEY="$HOME/${VPS_SSH_KEY#~/}" ;;
esac

if [ ! -f "$VPS_SSH_KEY" ]; then
  err "私钥文件不存在: $VPS_SSH_KEY"
  exit 1
fi

if [ ! -r "$VPS_SSH_KEY" ]; then
  err "私钥文件不可读: $VPS_SSH_KEY"
  exit 1
fi

info "步骤 1/2：构建 VPS 部署包..."
# shellcheck disable=SC2086 # VPS_BUILD_FLAGS 允许传入 --obfuscate 等简单 flags。
bash scripts/build-for-vps.sh $VPS_BUILD_FLAGS --package

PACKAGE_FILE="$(ls -t deploy-*.tar.gz 2>/dev/null | head -1 || true)"
if [ -z "$PACKAGE_FILE" ] || [ ! -f "$PACKAGE_FILE" ]; then
  err "未找到 deploy-*.tar.gz 部署包"
  exit 1
fi

info "步骤 2/2：上传 $PACKAGE_FILE 到 $VPS_USER@$VPS_HOST:$VPS_PATH/ ..."
ssh -i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" "$VPS_USER@$VPS_HOST" "mkdir -p '$VPS_PATH'"
scp -i "$VPS_SSH_KEY" -P "$VPS_SSH_PORT" "$PACKAGE_FILE" "$VPS_USER@$VPS_HOST:$VPS_PATH/"

echo ""
info "✅ 上传完成"
info "服务器文件: $VPS_USER@$VPS_HOST:$VPS_PATH/$PACKAGE_FILE"
warn "本脚本未在 VPS 上解压、安装依赖或重启服务；需要发布时请在服务器上执行对应部署步骤。"
