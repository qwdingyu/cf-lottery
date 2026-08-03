#!/bin/bash
# ============================================================
# cf-lottery 云服务器更新脚本
#
# 用法（在服务器上执行）：
#   cd /opt/cf-lottery && bash scripts/update.sh
# ============================================================
set -e

APP_DIR="/opt/cf-lottery"
cd "$APP_DIR"

echo "📦 拉取最新代码..."
git pull origin main

echo "🔧 安装依赖..."
npm install
cd frontend && npm install && npm run build && cd ..

echo "🔄 重启服务..."
systemctl restart cf-lottery

echo "✅ 更新完成"
systemctl status cf-lottery --no-pager -l
