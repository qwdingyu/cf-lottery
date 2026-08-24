#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# local-deploy-vps.sh — 本地构建 VPS 部署包并上传到指定服务器
#
# 背景：当前生产部署已从 Cloudflare Workers 暂停，改为 VPS 模式。
# 本脚本执行完整部署流程：构建 → 打包 → 上传 → 远端解压 → 重启服务 → 清理临时文件。
#
# ⚠️ 解压路径铁律：tar 包内是相对路径（dist/server.js、public/），必须解压到
#    /root/cf-lottery/（服务 WorkingDirectory），绝不能在 /root/ 解压——
#    否则文件散落在 /root/dist/、/root/public/，服务读不到新文件，CSS MIME 类型报 HTML。
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
#   SKIP_RESTART=1 VPS_SSH_KEY=~/.ssh/key bash local-deploy-vps.sh   # 只上传不重启（排查用）
#
# 部署流程（自动化）：
#   1. 本地构建 + 打包 tar.gz
#   2. 上传到 VPS /root/cf-lottery-deploy-*.tar.gz
#   3. VPS 上：清理旧 assets → cd /root/cf-lottery → tar -xzf 解压 → npm ci → 重启服务
#   4. 清理 VPS 上的临时 tar.gz 文件（防止磁盘堆积）
#
# 注意 1：server.js 启动时自动执行数据库迁移，无需单独 npm run db:migrate
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

info "步骤 1/5：构建 VPS 部署包..."
# shellcheck disable=SC2086 # VPS_BUILD_FLAGS 允许传入 --obfuscate 等简单 flags。
bash scripts/build-for-vps.sh $VPS_BUILD_FLAGS --package

PACKAGE_FILE="$(ls -t cf-lottery-deploy-*.tar.gz 2>/dev/null | head -1 || true)"
if [ -z "$PACKAGE_FILE" ] || [ ! -f "$PACKAGE_FILE" ]; then
  err "未找到 cf-lottery-deploy-*.tar.gz 部署包"
  exit 1
fi

REMOTE_DIR="$(shell_quote "$VPS_PATH")"
REMOTE_PACKAGE_PATH="$(shell_quote "${VPS_PATH%/}/$PACKAGE_FILE")"

info "步骤 2/5：上传 $PACKAGE_FILE 到 $VPS_USER@$VPS_HOST:$VPS_PATH/ ..."
# 清理旧 assets 后创建目录（docs/245）：每次部署先清理 public/assets，
# 避免 tar -xzf 解压到已有目录时旧 hash 文件累积，导致浏览器可能加载旧 chunk。
# 注意：部署目录是 /root/cf-lottery（不是 VPS_PATH=/root），要清理的是 /root/cf-lottery/public/assets。
ssh -i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" -o ServerAliveInterval=5 "$VPS_USER@$VPS_HOST" "rm -rf ${REMOTE_DIR%/}/cf-lottery/public/assets && mkdir -p $REMOTE_DIR"

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

# ── 步骤 3/5：远端解压 ──
# ⚠️ 铁律：必须 cd 到 /root/cf-lottery 再解压！tar 包内是相对路径（dist/、public/），
# 在 /root/ 解压会导致文件散落到 /root/dist/、/root/public/（错误位置），
# 服务仍从 /root/cf-lottery/ 读旧文件 → CSS MIME 类型报 HTML（docs/273 教训）。
DEPLOY_DIR="${REMOTE_DIR%/}/cf-lottery"
info "步骤 3/5：在远端解压到 $DEPLOY_DIR ..."
ssh -i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" -o ServerAliveInterval=5 "$VPS_USER@$VPS_HOST" \
  "cd $DEPLOY_DIR && tar -xzf $REMOTE_PACKAGE_PATH && echo '解压完成'" || {
    err "解压失败！请 SSH 到服务器检查：cd $DEPLOY_DIR && tar -xzf $REMOTE_PACKAGE_PATH"
    exit 1
  }
info "解压完成"

# ── 步骤 4/5：安装生产依赖 ──
# server.js 启动时自动执行数据库迁移，无需单独 npm run db:migrate。
# 若 SSH 不稳定，可改用 nohup 后台执行。
info "步骤 4/5：安装生产依赖（npm ci --omit=dev）..."
ssh -i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" -o ServerAliveInterval=5 "$VPS_USER@$VPS_HOST" \
  "cd $DEPLOY_DIR && npm ci --omit=dev" || {
    warn "npm ci 失败，尝试 nohup 后台安装..."
    ssh -i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" -o ServerAliveInterval=5 "$VPS_USER@$VPS_HOST" \
      "nohup bash -c 'cd $DEPLOY_DIR && npm ci --omit=dev && systemctl restart cf-lottery' > /tmp/cf-lottery-deploy.log 2>&1 &"
    warn "nohup 后台安装已启动，可通过 tail -f /tmp/cf-lottery-deploy.log 查看进度"
    warn "安装完成后服务将自动重启"
  }

# ── 步骤 5/5：重启服务 ──
if [ "${SKIP_RESTART:-}" != "1" ]; then
  info "步骤 5/5：重启 cf-lottery 服务..."
  ssh -i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" -o ServerAliveInterval=5 "$VPS_USER@$VPS_HOST" \
    "systemctl restart cf-lottery && sleep 2 && systemctl is-active cf-lottery" || {
      err "服务重启失败！请 SSH 检查: journalctl -u cf-lottery -n 50 --no-pager"
      exit 1
    }
  info "服务已重启并正常运行"
else
  warn "步骤 5/5：跳过重启（SKIP_RESTART=1）"
fi

# ── 清理临时文件 ──
# 部署完成后删除 VPS 上的 tar.gz 临时文件，防止磁盘堆积。
# 保留最近 1 个备份（用于回滚排查），删除其余旧版本。
info "清理 VPS 临时文件..."
ssh -i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" -o ServerAliveInterval=5 "$VPS_USER@$VPS_HOST" \
  "cd $VPS_PATH && ls -t cf-lottery-deploy-*.tar.gz 2>/dev/null | tail -n +2 | xargs -r rm -f && echo '清理完成'" || \
  warn "临时文件清理失败（不影响部署结果）"

echo ""
info "✅ 部署完成"
info "服务地址: https://lucky.eforge.xyz/"
info "服务状态: ssh -i $VPS_SSH_KEY $VPS_USER@$VPS_HOST 'systemctl status cf-lottery'"
