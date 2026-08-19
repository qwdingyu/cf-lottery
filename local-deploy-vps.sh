#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# local-deploy-vps.sh — 本地构建 VPS 部署包并上传到指定服务器
#
# 背景：当前生产部署已从 Cloudflare Workers 暂停，改为 VPS 模式。
# 本脚本只负责「构建 + 打包 + 上传」，不会在服务器上解压或重启服务，
# 避免把上传与远端发布动作耦合在一起。
#
# 必填：
#   VPS_SSH_KEY  SSH 私钥路径。私钥只从环境变量读取，禁止写入仓库。
#
# 默认目标：
#   VPS_HOST=38.47.198.72
#   VPS_USER=root
#   VPS_PATH=/root
#   VPS_SSH_PORT=22
#
# 最常用用法：
#   VPS_SSH_KEY=~/.ssh/jp_72_scp-key bash local-deploy-vps.sh
#
# 可选覆盖：
#   VPS_HOST=38.47.198.72 VPS_USER=root VPS_PATH=/root VPS_SSH_KEY=~/.ssh/key bash local-deploy-vps.sh
#   VPS_SSH_PORT=22 VPS_BUILD_FLAGS="--obfuscate" VPS_SSH_KEY=~/.ssh/key bash local-deploy-vps.sh
#
# 上传后的服务器侧操作（本脚本不自动执行）：
#   ssh -i ~/.ssh/cf-lottery-vps.pem -o ServerAliveInterval=5 root@38.47.198.72
#   cd /root/cf-lottery
#   tar -xzf /root/cf-lottery-deploy-YYYYMMDD-HHMMSS.tar.gz
#   npm ci --omit=dev        # 若 SSH 不稳定，改用: nohup bash -c "npm ci --omit=dev && systemctl restart cf-lottery" > /tmp/deploy.log 2>&1 &
#   systemctl restart cf-lottery
#
# 注意 1：本脚本上传前已在 VPS 执行 rm -rf public/assets（永久方案，docs/245），
#   确保 tar 解压时不会累积旧 hash 文件，浏览器始终加载最新 chunk。
# 注意 2：server.js 启动时自动执行数据库迁移，无需单独 npm run db:migrate
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[vps-deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[vps-deploy]${NC} $*"; }
err()   { echo -e "${RED}[vps-deploy]${NC} $*" >&2; }
shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

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

# 展开常见的 ~/ 私钥路径，避免 ssh -i 收到未展开的字符串。
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

PACKAGE_FILE="$(ls -t cf-lottery-deploy-*.tar.gz 2>/dev/null | head -1 || true)"
if [ -z "$PACKAGE_FILE" ] || [ ! -f "$PACKAGE_FILE" ]; then
  err "未找到 cf-lottery-deploy-*.tar.gz 部署包"
  exit 1
fi

REMOTE_DIR="$(shell_quote "$VPS_PATH")"
REMOTE_PACKAGE_PATH="$(shell_quote "${VPS_PATH%/}/$PACKAGE_FILE")"

info "步骤 2/2：上传 $PACKAGE_FILE 到 $VPS_USER@$VPS_HOST:$VPS_PATH/ ..."
# 清理旧 assets 后创建目录（永久方案，docs/245）：每次部署先清理 public/assets，
# 避免 tar -xzf 解压到已有目录时旧 hash 文件累积，导致浏览器可能加载旧 chunk。
# 本地构建脚本 build-for-vps.sh 已在构建前 rm -rf public/assets，此处确保 VPS 侧同步。
ssh -i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" -o ServerAliveInterval=5 "$VPS_USER@$VPS_HOST" "rm -rf ${REMOTE_DIR%/}/public/assets && mkdir -p $REMOTE_DIR"

# 上传：cat + SSH pipe（scp 在部分 VPS 配置下存在连接重置问题）
# 该 VPS SSH 会话不稳，加入自动重试（最多 3 次）+ 远端文件大小校验，防止半包误判成功
LOCAL_SIZE=$(stat -f%z "$PACKAGE_FILE" 2>/dev/null || stat -c%s "$PACKAGE_FILE")
UPLOAD_OK=0
for attempt in 1 2 3; do
  if cat "$PACKAGE_FILE" | ssh -i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" -o ServerAliveInterval=5 -o ServerAliveCountMax=10 "$VPS_USER@$VPS_HOST" "cat > $REMOTE_PACKAGE_PATH" 2>/dev/null; then
    REMOTE_SIZE=$(ssh -i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" -o ConnectTimeout=10 "$VPS_USER@$VPS_HOST" "stat -c%s $REMOTE_PACKAGE_PATH 2>/dev/null || echo 0" 2>/dev/null || echo 0)
    if [ "$REMOTE_SIZE" = "$LOCAL_SIZE" ]; then
      info "上传成功（${LOCAL_SIZE} 字节，大小校验一致）"
      UPLOAD_OK=1
      break
    fi
    warn "文件大小不一致（本地 $LOCAL_SIZE / 远端 $REMOTE_SIZE），5 秒后重试..."
  else
    warn "上传连接中断（第 $attempt 次），5 秒后重试..."
  fi
  sleep 5
done
if [ "$UPLOAD_OK" != "1" ]; then
  err "上传失败（已重试 3 次）"
  exit 1
fi

echo ""
info "✅ 上传完成"
info "服务器文件: $VPS_USER@$VPS_HOST:$VPS_PATH/$PACKAGE_FILE"
warn "本脚本未在 VPS 上解压、安装依赖或重启服务；需要发布时请在服务器上执行对应部署步骤。"
