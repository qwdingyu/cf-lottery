#!/bin/bash
# ============================================================
# cf-lottery Debian 云服务器一键部署脚本
#
# 用法（在服务器上执行）：
#   curl -fsSL https://your-git-host/cf-lottery/scripts/setup-cloud-server.sh | bash
#   或：
#   git clone ... && cd cf-lottery && bash scripts/setup-cloud-server.sh
#
# 前置条件：
#   - Debian 11/12 (bullseye/bookworm)
#   - 已安装 git、curl、nginx、sqlite3
#   - 域名 DNS A 记录已指向本服务器 IP
# ============================================================

set -e

APP_DIR="/opt/cf-lottery"
NODE_ENV="production"
PORT="8787"

echo "╔══════════════════════════════════════════════╗"
echo "║   cf-lottery Debian 云服务器部署           ║"
echo "╚══════════════════════════════════════════════╝"

# ── 1. 系统依赖 ──
echo ""
echo "[1/6] 安装系统依赖..."
apt-get update -qq
apt-get install -y -qq nodejs npm nginx sqlite3 certbot python3-certbot-nginx 2>/dev/null || {
  echo "  ⚠️  部分包可能已安装，继续..."
}

# Node.js 版本检查（需要 18+）
NODE_VER=$(node -v 2>/dev/null | grep -oP '\d+' | head -1)
if [ -z "$NODE_VER" ] || [ "$NODE_VER" -lt 18 ]; then
  echo "  ⚠️  Node.js >= 18 未找到，安装 Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  ✅ Node.js: $(node -v)"

# ── 2. 项目部署 ──
echo ""
echo "[2/6] 部署项目代码..."

if [ ! -d "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
fi

# 如果当前目录有代码则复制，否则提示用户先 clone
if [ -f "package.json" ]; then
  cp -r . "$APP_DIR/"
else
  echo "  请先 clone 项目到当前目录："
  echo "    git clone https://github.com/qwdingyu/cf-lottery.git /tmp/cf-lottery"
  echo "    cd /tmp/cf-lottery && bash scripts/setup-cloud-server.sh"
  exit 1
fi

cd "$APP_DIR"

# 安装依赖（生产模式）
npm install --omit=dev 2>/dev/null || npm install

# ── 3. 构建前端 ──
echo ""
echo "[3/6] 构建前端..."
cd frontend && npm install && npm run build && cd ..
# Vite 默认输出到 frontend/dist/，创建 symlink 供 server.ts 使用
ln -sf frontend/dist public
echo "  ✅ 前端构建完成"

# ── 4. 准备本地数据库 ──
echo ""
echo "[4/6] 准备本地 SQLite 数据库..."
mkdir -p data
if [ ! -f "data/local.db" ]; then
  sqlite3 data/local.db "VACUUM;"
  echo "  ⚠️  数据库为空，请手动导入数据："
  echo "     npm run db:export  （从 Turso 导出到本地）"
fi

# ── 5. 配置 .env ──
echo ""
echo "[5/6] 配置环境变量..."
if [ ! -f ".env" ]; then
  cat > .env << 'EOF'
# 本地 SQLite（云服务器用本机文件）
TURSO_URL=file:./data/local.db
TURSO_TOKEN=

# JWT 签名密钥（请修改为随机字符串！）
JWT_SECRET=change-me-to-random-64-chars

# 邮箱（可选，测试期间可不配）
RESEND_API_KEY=
EMAIL_FROM=onboarding@resend.dev
EMAIL_FROM_NAME=抽奖平台

# 服务端口
PORT=8787

# cf-auth OAuth RP（可选；生产 IdP 如 https://auth.eforge.xyz）
CF_AUTH_ENABLED=false
CF_AUTH_ISSUER=
CF_AUTH_CLIENT_ID=
CF_AUTH_CLIENT_SECRET=
CF_AUTH_REDIRECT_URI=

# Cron 密钥
CRON_SECRET=
EOF
  echo "  ⚠️  已生成 .env 模板，请编辑 JWT_SECRET 为随机值"
fi

# ── 6. 启动服务 ──
echo ""
echo "[6/6] 配置服务..."

# systemd 服务
cp scripts/cf-lottery.service /etc/systemd/system/cf-lottery.service
systemctl daemon-reload
systemctl enable cf-lottery
systemctl restart cf-lottery
echo "  ✅ systemd 服务已启动"

# nginx 反向代理
cp scripts/nginx-lucky.eforge.xyz.conf /etc/nginx/sites-available/lucky.eforge.xyz.conf
ln -sf /etc/nginx/sites-available/lucky.eforge.xyz.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
echo "  ✅ nginx 反向代理已配置"

# SSL 证书（可选）
echo ""
echo "══════════════════════════════════════════════"
echo "  部署完成！"
echo ""
echo "  验证: curl http://localhost:$PORT/api/health"
echo "  SSL:  certbot --nginx -d lucky.eforge.xyz"
echo ""
echo "  Cloudflare DNS 配 A 记录 → 服务器 IP"
echo "══════════════════════════════════════════════"
