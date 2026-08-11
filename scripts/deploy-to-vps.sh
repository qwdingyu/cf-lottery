#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# deploy-to-vps.sh —— 一键构建 + 上传 + VPS 部署（针对 SSH 断连的增强版）
#
# ██ 解决的问题 ██
# 该 VPS（38.47.198.72）的 SSH 会话偶发被远端关闭（根因：sshd MaxStartups 3:80:10
# 并发连接限制 + 跨国链路波动），传统同步部署会卡在 npm install 或上传环节数十分钟。
# 本脚本通过「自动重试 + nohup 后台 + 轮询验证」彻底规避该问题：
#
#   1. 所有 SSH 命令统一带保活参数（ServerAliveInterval=30 等），降低空闲断开概率；
#   2. 上传用 cat+ssh pipe + 自动重试 + 文件大小校验（防止断连导致半包）；
#   3. VPS 侧长任务（解压 + npm install + 重启）用 nohup 后台执行，
#      SSH 断开不影响部署继续执行；
#   4. 部署完成后本地轮询验证 health，成功才退出（不再需要人工 SSH 确认）。
#
# 用法（推荐，替代手动 SSH 三步操作）：
#   VPS_SSH_KEY=~/.ssh/jp_72_scp-key bash scripts/deploy-to-vps.sh
#
# 可选环境变量：
#   VPS_HOST / VPS_USER / VPS_PATH / VPS_SSH_PORT / VPS_SSH_KEY
#   MAX_UPLOAD_RETRY=3    上传重试次数
#   MAX_POLL=36           轮询次数（每 10 秒一次，默认最长 6 分钟）
#
# 前置条件：dist/server.js 与 public/ 已构建（bash scripts/build-for-vps.sh）
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()  { echo -e "${RED}[deploy]${NC} $*" >&2; }

# ── 配置 ──
VPS_HOST="${VPS_HOST:-38.47.198.72}"
VPS_PATH="${VPS_PATH:-/root/cf-lottery}"
VPS_USER="${VPS_USER:-root}"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_SSH_KEY="${VPS_SSH_KEY:-}"
MAX_UPLOAD_RETRY="${MAX_UPLOAD_RETRY:-3}"
MAX_POLL="${MAX_POLL:-36}"          # 每 10 秒轮询一次，36 次 = 最长 6 分钟

if [ -z "$VPS_SSH_KEY" ]; then
  err "缺少 VPS_SSH_KEY（私钥只从环境变量读取，禁止写入仓库）"
  echo "  示例: VPS_SSH_KEY=~/.ssh/jp_72_scp-key bash scripts/deploy-to-vps.sh"
  exit 1
fi
case "$VPS_SSH_KEY" in
  ~/*) VPS_SSH_KEY="$HOME/${VPS_SSH_KEY#~/}" ;;
esac
if [ ! -f "$VPS_SSH_KEY" ]; then
  err "私钥文件不存在: $VPS_SSH_KEY"
  exit 1
fi

# 统一 SSH 保活参数（该 VPS SSH 会话不稳，必须带保活避免空闲/链路波动断开）
SSH_OPTS=(-i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" \
  -o ConnectTimeout=15 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=10 \
  -o TCPKeepAlive=yes \
  -o StrictHostKeyChecking=accept-new)

ssh_cmd() { ssh "${SSH_OPTS[@]}" "$VPS_USER@$VPS_HOST" "$@"; }

# ── 上传：cat+ssh pipe + 自动重试 + 文件大小校验 ──
# 该 VPS 的 scp 会间歇性报 Connection closed（文件可能半包），
# 因此用 cat+ssh pipe，并在每次尝试后校验远端文件大小是否等于本地。
upload_with_retry() {
  local local_file="$1" remote_file="$2"
  local local_size remote_size attempt
  # macOS stat 与 Linux stat 参数不同，兼容两者
  local_size=$(stat -f%z "$local_file" 2>/dev/null || stat -c%s "$local_file")

  for attempt in $(seq 1 "$MAX_UPLOAD_RETRY"); do
    if cat "$local_file" | ssh_cmd "cat > $remote_file" 2>/dev/null; then
      remote_size=$(ssh_cmd "stat -c%s $remote_file 2>/dev/null || echo 0" 2>/dev/null || echo 0)
      if [ "$remote_size" = "$local_size" ]; then
        info "上传成功：${local_file} -> ${remote_file}（${local_size} 字节，校验一致）"
        return 0
      fi
      warn "文件大小不一致（本地 ${local_size} / 远端 ${remote_size}），5 秒后重试..."
    else
      warn "上传连接中断（第 ${attempt} 次），5 秒后重试..."
    fi
    sleep 5
  done
  err "上传失败（已重试 $MAX_UPLOAD_RETRY 次）：$local_file"
  return 1
}

# ── 步骤 1：确认构建产物 + 打包 ──
if [ ! -f dist/server.js ]; then
  err "dist/server.js 不存在，请先执行: bash scripts/build-for-vps.sh"
  exit 1
fi

info "步骤 1/4：打包部署产物..."
PACKAGE_FILE="cf-lottery-deploy-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$PACKAGE_FILE" \
  --exclude='.DS_Store' \
  dist/server.js \
  public/ \
  package.json \
  package-lock.json \
  configs/ \
  migrations/
info "打包完成 → $PACKAGE_FILE ($(du -h "$PACKAGE_FILE" | cut -f1))"

# ── 步骤 2：上传（自动重试 + 大小校验）──
info "步骤 2/4：上传到 $VPS_USER@$VPS_HOST:$VPS_PATH ..."
ssh_cmd "mkdir -p $VPS_PATH" 2>/dev/null || true
upload_with_retry "$PACKAGE_FILE" "$VPS_PATH/$PACKAGE_FILE"

# ── 步骤 3：VPS 后台部署（nohup，SSH 断开不影响）──
# 关键：所有长任务（npm install 等）放入 nohup bash -c '...' 后台执行，
# SSH 返回后部署仍继续，彻底避免「SSH 断开导致部署卡死半小时」。
# ⚠️ 必须显式设置 PATH：nohup 的 bash -c 是非交互 shell，不加载 .bashrc，
#     nvm 安装的 node/npm 不会在 PATH 中（会报 npm: command not found）。
# ⚠️ 完成标记：部署脚本最后写入 DONE 标记文件；轮询必须等 DONE 出现才判定成功，
#     避免「旧进程仍在运行导致 health 正常」的假成功。
info "步骤 3/4：VPS 后台部署（解压 + npm install --omit=dev + 重启）..."
REMOTE_LOG="/tmp/cf-lottery-deploy-$(date +%Y%m%d-%H%M%S).log"
DONE_MARKER="${REMOTE_LOG%.log}.done"
DEPLOY_SCRIPT="bash -c '
set -e
export PATH=/root/.nvm/versions/node/v24.18.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd $VPS_PATH
# 1) 备份旧版本（回滚兜底）
[ -f dist/server.js ] && cp dist/server.js dist/server.js.bak-\$(date +%Y%m%d-%H%M%S) || true
# 2) 解压新版本
tar -xzf $PACKAGE_FILE
# 3) 安装生产依赖（必须 npm install --omit=dev，见 docs/156 §六）
npm install --omit=dev
# 4) 维护 timer（VPS 模式无 Cloudflare scheduled handler，由 systemd timer 触发维护）
install -m 0644 configs/cf-lottery-maintenance.service /etc/systemd/system/ 2>/dev/null || true
install -m 0644 configs/cf-lottery-maintenance.timer /etc/systemd/system/ 2>/dev/null || true
systemctl daemon-reload 2>/dev/null || true
systemctl enable --now cf-lottery-maintenance.timer 2>/dev/null || true
# 5) 重启服务（启动时自动执行数据库迁移）
systemctl restart cf-lottery
# 6) 清理部署包 + 写入完成标记
rm -f $PACKAGE_FILE
echo \"DEPLOY_OK \$(date +%F-%T)\" > $DONE_MARKER
echo DEPLOY_OK
'"
ssh_cmd "nohup $DEPLOY_SCRIPT > $REMOTE_LOG 2>&1 & echo 远端部署已后台启动: $REMOTE_LOG"

# ── 步骤 4：轮询验证（等 DONE 标记出现，避免旧进程假成功）──
info "步骤 4/4：轮询验证（每 10 秒，最长 $((MAX_POLL * 10 / 60)) 分钟）..."
for i in $(seq 1 "$MAX_POLL"); do
  sleep 10
  # 只认 DONE 标记：标记存在 = 新部署的 npm install + systemctl restart 已成功完成
  if ssh_cmd "test -f $DONE_MARKER" 2>/dev/null; then
    done_at=$(ssh_cmd "cat $DONE_MARKER" 2>/dev/null || echo "?")
    health=$(ssh_cmd "curl -s http://localhost:8787/api/health" 2>/dev/null || echo "")
    if echo "$health" | grep -q '"db":true'; then
      info "✅ 部署成功（第 ${i} 次轮询，完成于 ${done_at}）"
      info "   health: $health"
      info "   远端日志: $REMOTE_LOG"
      rm -f "$PACKAGE_FILE"
      exit 0
    fi
    err "DONE 标记已出现但 health 异常：$health"
    rm -f "$PACKAGE_FILE"
    exit 1
  fi
  # 每 6 次轮询（1 分钟）输出一次进度，避免"无输出卡住"的观感
  if [ $((i % 6)) -eq 0 ]; then
    warn "等待服务就绪...（第 ${i}/${MAX_POLL} 次轮询）"
  fi
done

err "部署超时（${MAX_POLL} 次轮询后服务未就绪）"
err "远端日志: $REMOTE_LOG （ssh 上去查看: ssh -i $VPS_SSH_KEY root@$VPS_HOST 'tail -50 $REMOTE_LOG'）"
rm -f "$PACKAGE_FILE"
exit 1
