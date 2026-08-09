#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# backup-vps-cf-lottery.sh —— 将 VPS 上 cf-lottery 的配置、服务、数据库等备份到本地
#
# 用途：
#   避免 VPS 配置丢失，确保下次部署灾难性故障时可快速恢复。
#
# 备份内容：
#   1. systemd unit: /etc/systemd/system/cf-lottery.service
#   2. Nginx 完整配置（nginx -T 导出）
#   3. cf-lottery 运行目录关键文件：
#      - .env（敏感，脚本可加密保存）
#      - package.json / package-lock.json
#      - data/data.db（本地 SQLite 数据库）
#   4. /root/cf-lottery/configs/ 目录（如有）
#   5. 关键依赖版本快照：@usethink/cf-core/package.json
#
# 使用方式：
#   bash scripts/backup-vps-cf-lottery.sh
#
# 输出：
#   ./backups/vps-cf-lottery-backup-YYYY-MM-DD/
#
# 恢复方式：
#   见 backups/ 目录下的 README.txt
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── 配置区（按实际环境修改） ──────────────────────────────────────────────────
VPS_HOST="root@38.47.198.72"
SSH_KEY="$HOME/.ssh/jp_72_scp-key"              # ⚠️ 必须使用私钥，禁止密码登录
VPS_CF_DIR="/root/cf-lottery"                   # VPS 上 cf-lottery 运行目录
LOCAL_BACKUP_ROOT="./backups"                   # 本地备份根目录
BACKUP_NAME="vps-cf-lottery-backup-$(date +%Y-%m-%d)"
BACKUP_DIR="$LOCAL_BACKUP_ROOT/$BACKUP_NAME"
# ── 敏感文件加密（可选） ──────────────────────────────────────────────────────
# 如果设置 ENCRYPTION_KEY，.env 将用 openssl aes-256-cbc 加密保存为 .env.enc
# 留空则不加密，直接保存为 .env（注意 .gitignore 必须包含 backups/）
ENCRYPTION_KEY=""  # 示例：ENCRYPTION_KEY="MySecretPass123!"  （建议使用强密码）
# ─────────────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[backup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[backup]${NC} $*"; }
fail()  { echo -e "${RED}[backup]${NC} $*"; exit 1; }

# ── 前置检查 ──────────────────────────────────────────────────────────────────
info "前置检查..."

# 检查 SSH 私钥
if [ ! -f "$SSH_KEY" ]; then
  fail "SSH 私钥不存在: $SSH_KEY"
fi
chmod 600 "$SSH_KEY" 2>/dev/null || true

# 检查 VPS 连通性
if ! ssh -i "${SSH_KEY}" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "${VPS_HOST}" 'echo VPS_OK' >/dev/null 2>&1; then
  fail "无法连接到 VPS (${VPS_HOST})，请检查网络和 SSH 密钥"
fi

# 检查 VPS 上 cf-lottery 目录
if ! ssh -i "$SSH_KEY" "$VPS_HOST" "test -d $VPS_CF_DIR"; then
  fail "VPS 上 cf-lottery 目录不存在: $VPS_CF_DIR"
fi

mkdir -p "$BACKUP_DIR"
info "备份目录: $BACKUP_DIR"

# ── 1. 备份 systemd unit ──────────────────────────────────────────────────────
info "备份 systemd unit..."
ssh -i "$SSH_KEY" "$VPS_HOST" "cat /etc/systemd/system/cf-lottery.service" > "$BACKUP_DIR/cf-lottery.service"
if [ ! -s "$BACKUP_DIR/cf-lottery.service" ]; then
  fail "systemd unit 备份失败或为空"
fi
info "  ✓ cf-lottery.service ($(wc -l < "$BACKUP_DIR/cf-lottery.service") 行)"

# ── 2. 备份 Nginx 完整配置 ────────────────────────────────────────────────────
info "备份 Nginx 完整配置..."
ssh -i "$SSH_KEY" -o ServerAliveInterval=5 "$VPS_HOST" "nginx -T 2>/dev/null" > "$BACKUP_DIR/nginx-full.conf"
if [ ! -s "$BACKUP_DIR/nginx-full.conf" ]; then
  fail "Nginx 配置备份失败或为空"
fi
info "  ✓ nginx-full.conf ($(wc -l < "$BACKUP_DIR/nginx-full.conf") 行)"

# ── 3. 备份 cf-lottery 运行目录关键文件 ───────────────────────────────────────
info "备份 cf-lottery 运行目录..."

# 3.1 .env（敏感文件）
ssh -i "$SSH_KEY" "$VPS_HOST" "cat $VPS_CF_DIR/.env" > "$BACKUP_DIR/.env"
if [ ! -s "$BACKUP_DIR/.env" ]; then
  warn ".env 备份为空，请检查 VPS 上是否存在"
else
  info "  ✓ .env ($(wc -l < "$BACKUP_DIR/.env") 行)"
fi

# 3.2 package.json
ssh -i "$SSH_KEY" "$VPS_HOST" "cat $VPS_CF_DIR/package.json" > "$BACKUP_DIR/package.json"
[ -s "$BACKUP_DIR/package.json" ] && info "  ✓ package.json" || fail "package.json 备份失败"

# 3.3 package-lock.json（可选）
ssh -i "$SSH_KEY" "$VPS_HOST" "cat $VPS_CF_DIR/package-lock.json" > "$BACKUP_DIR/package-lock.json" 2>/dev/null || true
[ -s "$BACKUP_DIR/package-lock.json" ] && info "  ✓ package-lock.json" || warn "  ✗ package-lock.json 不存在"

# 3.4 configs/ 目录（如有 Nginx 或其他配置）
if ssh -i "$SSH_KEY" -o ServerAliveInterval=5 "$VPS_HOST" "test -d $VPS_CF_DIR/configs"; then
  ssh -i "$SSH_KEY" -o ServerAliveInterval=5 "$VPS_HOST" "tar -czf /tmp/cf-lottery-configs.tar.gz -C $VPS_CF_DIR configs"
  scp -i "$SSH_KEY" -o ServerAliveInterval=5 -o StrictHostKeyChecking=accept-new "$VPS_HOST:/tmp/cf-lottery-configs.tar.gz" "$BACKUP_DIR/configs.tar.gz" 2>/dev/null || true
  [ -s "$BACKUP_DIR/configs.tar.gz" ] && info "  ✓ configs.tar.gz" || warn "  ✗ configs 备份失败"
  ssh -i "$SSH_KEY" -o ServerAliveInterval=5 "$VPS_HOST" "rm -f /tmp/cf-lottery-configs.tar.gz" 2>/dev/null || true
else
  warn "  ✗ configs/ 目录不存在"
fi

# ── 4. 备份数据库 ─────────────────────────────────────────────────────────────
info "备份数据库（本地 SQLite）..."
ssh -i "$SSH_KEY" "$VPS_HOST" "sqlite3 $VPS_CF_DIR/data/data.db '.dump'" > "$BACKUP_DIR/data.sql" 2>/dev/null || true
if [ -s "$BACKUP_DIR/data.sql" ]; then
  info "  ✓ data.sql（SQL dump, $(du -h "$BACKUP_DIR/data.sql" | cut -f1)）"
else
  # SQLite dump 失败则直接复制原始文件
  ssh -i "$SSH_KEY" "$VPS_HOST" "cat $VPS_CF_DIR/data/data.db" > "$BACKUP_DIR/data.db" 2>/dev/null || true
  if [ -s "$BACKUP_DIR/data.db" ]; then
    info "  ✓ data.db（原始文件, $(du -h "$BACKUP_DIR/data.db" | cut -f1)）"
  else
    warn "  ✗ 数据库备份失败"
  fi
fi

# ── 5. 备份迁移记录 ───────────────────────────────────────────────────────────
info "备份迁移状态..."
ssh -i "$SSH_KEY" "$VPS_HOST" "sqlite3 $VPS_CF_DIR/data/data.db 'SELECT * FROM _migrations ORDER BY id'" > "$BACKUP_DIR/migrations-applied.txt" 2>/dev/null || true
[ -s "$BACKUP_DIR/migrations-applied.txt" ] && info "  ✓ migrations-applied.txt" || warn "  ✗ 迁移记录获取失败"

# ── 6. 备份关键依赖版本 ───────────────────────────────────────────────────────
info "备份关键依赖版本..."
ssh -i "$SSH_KEY" "$VPS_HOST" "cat $VPS_CF_DIR/node_modules/@usethink/cf-core/package.json" > "$BACKUP_DIR/cf-core-version.json" 2>/dev/null || true
[ -s "$BACKUP_DIR/cf-core-version.json" ] && info "  ✓ cf-core-version.json" || warn "  ✗ cf-core-version.json 不存在"

# ── 7. 备份系统信息 ───────────────────────────────────────────────────────────
info "备份系统信息..."
ssh -i "$SSH_KEY" "$VPS_HOST" "node -v && npm -v && uname -a && cat /etc/os-release | head -2" > "$BACKUP_DIR/system-info.txt" 2>/dev/null || true
info "  ✓ system-info.txt"

# ── 8. 敏感文件加密处理 ───────────────────────────────────────────────────────
if [ -n "$ENCRYPTION_KEY" ] && [ -f "$BACKUP_DIR/.env" ]; then
  info "加密敏感文件 .env..."
  openssl aes-256-cbc -salt -in "$BACKUP_DIR/.env" -out "$BACKUP_DIR/.env.enc" -k "$ENCRYPTION_KEY" 2>/dev/null || {
    warn "openssl 加密失败，保留未加密 .env"
  }
  if [ -f "$BACKUP_DIR/.env.enc" ]; then
    if openssl aes-256-cbc -d -in "$BACKUP_DIR/.env.enc" -k "$ENCRYPTION_KEY" > /dev/null 2>&1; then
      rm -f "$BACKUP_DIR/.env"
      info "  ✓ .env 已加密为 .env.enc（原始 .env 已删除）"
    else
      warn "加密验证失败，保留原始 .env"
    fi
  fi
else
  [ -f "$BACKUP_DIR/.env" ] && warn "  .env 未加密（建议设置 ENCRYPTION_KEY）"
fi

# ── 9. 生成恢复说明 ───────────────────────────────────────────────────────────
cat > "$BACKUP_DIR/README.txt" << 'EOF'
# cf-lottery VPS 备份恢复说明

## 备份内容

- cf-lottery.service     : systemd 服务单元
- nginx-full.conf        : 完整 Nginx 配置
- .env / .env.enc        : 应用环境变量（⚠️ 敏感）
- package.json           : 依赖声明
- package-lock.json      : 依赖锁定
- data.sql / data.db     : SQLite 数据库（Dump 或原始文件）
- migrations-applied.txt : 已应用的迁移记录
- configs.tar.gz         : Nginx/其他配置文件
- cf-core-version.json   : @usethink/cf-core 版本快照
- system-info.txt        : Node/npm/系统版本信息

## 恢复步骤（同服务器灾难恢复）

```bash
# 0. 停止服务
systemctl stop cf-lottery

# 1. 恢复 systemd 配置
cp backups/YYYY-MM-DD/cf-lottery.service /etc/systemd/system/
systemctl daemon-reload

# 2. 恢复 .env
cp backups/YYYY-MM-DD/.env /root/cf-lottery/.env
chmod 600 /root/cf-lottery/.env

# 3. 恢复数据库
# 方式 A：SQL dump
sqlite3 /root/cf-lottery/data/data.db < backups/YYYY-MM-DD/data.sql
# 方式 B：原始文件
cp backups/YYYY-MM-DD/data.db /root/cf-lottery/data/data.db

# 4. 恢复依赖（如 node_modules 丢失）
cd /root/cf-lottery
cp backups/YYYY-MM-DD/package.json .
npm install --omit=dev

# 5. 恢复 Nginx 配置（按需合并）
# 参照 backups/YYYY-MM-DD/nginx-full.conf

# 6. 启动
systemctl restart cf-lottery
systemctl status cf-lottery
```

## 注意事项

1. **未使用 ecosystem.config.json**：cf-lottery 已全面采用 systemd
2. **数据库备份**：优先使用 `.sql` dump（文本格式，跨平台兼容）
3. **迁移状态**：`migrations-applied.txt` 记录已执行迁移，恢复后需对账
4. **cf-core 版本**：`cf-core-version.json` 记录当前使用的 cf-core 版本

## 备份时间

$(date '+%Y-%m-%d %H:%M:%S %Z')
EOF

# ── 10. 打包备份 ──────────────────────────────────────────────────────────────
info "打包备份..."
tar -czf "$BACKUP_DIR.tar.gz" -C "$LOCAL_BACKUP_ROOT" "$BACKUP_NAME"
info "  ✓ $BACKUP_DIR.tar.gz ($(du -h "$BACKUP_DIR.tar.gz" | cut -f1))"

# ── 11. 清理 VPS 临时文件 ────────────────────────────────────────────────────
ssh -i "$SSH_KEY" "$VPS_HOST" "rm -f /tmp/cf-lottery-configs.tar.gz" 2>/dev/null || true

# ── 完成 ──────────────────────────────────────────────────────────────────────
echo ""
info "✅ 备份完成"
echo "   本地目录: $BACKUP_DIR"
echo "   压缩包:   $BACKUP_DIR.tar.gz"
echo ""
info "备份内容清单："
ls -lah "$BACKUP_DIR"
echo ""
warn "请妥善保管 backups/ 目录，特别是 .env（含敏感信息）"
warn "建议将 backups/ 加入 .gitignore"
