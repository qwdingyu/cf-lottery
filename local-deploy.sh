#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# local-deploy.sh — cf-lottery 本地部署到 Cloudflare Workers
#
# 前提：已通过 `npx wrangler login` 登录 Cloudflare
# 用法：bash local-deploy.sh
#
# 流程：
#   0. 安装依赖
#   1. 构建前端
#   2. 数据库迁移（增量，跳过 DOWN 段）
#   3. 部署 Worker
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()   { echo -e "${RED}[deploy]${NC} $*" >&2; }

cd "$ROOT"

# ── 前置检查 ──
if ! npx wrangler whoami &>/dev/null; then
  err "请先执行 npx wrangler login 登录 Cloudflare"
  exit 1
fi
info "Wrangler 已登录"

# 检查 .env 凭证文件
ENV_FILE="$ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
  err "缺少 .env 凭证文件，请参考 .env.example 创建"
  exit 1
fi

cred_load() {
  local name="$1"
  if [ -f "$ENV_FILE" ]; then
    grep "^${name}=" "$ENV_FILE" | head -1 | cut -d'=' -f2-
    return 0
  fi
  return 1
}

# ── 步骤 0：安装依赖 ──
if [ ! -d "node_modules" ]; then
  info "步骤 0/4：安装依赖..."
  npm install
  info "依赖安装完成"
else
  info "步骤 0/4：node_modules 已存在"
fi

# ── 步骤 1：构建前端 ──
info "步骤 1/4：构建前端..."
# 传递 VITE_LOGTO_* 变量给 Vite 构建（docs/051 方案）
LOGTO_ENDPOINT="$(cred_load LOGTO_ENDPOINT 2>/dev/null || true)"
LOGTO_APP_ID="$(cred_load LOGTO_APP_ID 2>/dev/null || true)"
if [ -n "$LOGTO_ENDPOINT" ]; then
  export VITE_LOGTO_ENDPOINT="$LOGTO_ENDPOINT"
fi
if [ -n "$LOGTO_APP_ID" ]; then
  export VITE_LOGTO_APP_ID="$LOGTO_APP_ID"
fi
npm run frontend:build
info "前端构建完成"

# ── 步骤 2：数据库迁移 ──
# 使用 drizzle-kit 增量迁移，仅应用未执行的迁移文件
info "步骤 2/4：数据库迁移..."
TURSO_URL="$(cred_load TURSO_URL || true)"
TURSO_TOKEN="$(cred_load TURSO_TOKEN || true)"
if [ -n "$TURSO_URL" ] && [ -n "$TURSO_TOKEN" ]; then
  export TURSO_URL TURSO_TOKEN
  # 安全检查：确认数据库可连接
  node -e "
    const { createClient } = require('@libsql/client');
    const c = createClient({ url: '$TURSO_URL', authToken: '$TURSO_TOKEN' });
    (async () => {
      try {
        const r = await c.execute('SELECT 1 as ok');
        console.log('数据库连接正常');
        process.exit(0);
      } catch(e) {
        console.log('无法连接数据库: ' + (e.message || e).substring(0, 80));
        process.exit(1);
      }
    })();
  " 2>&1 || warn "⚠️ 数据库连接检查失败，请确认 TURSO_URL/TURSO_TOKEN 正确"

  # 使用仓库内固定版本的 drizzle-kit，避免 npx 自动拉取新版导致配置不兼容。
  npm run db:migrate
  info "数据库迁移完成"
else
  warn "跳过迁移：缺少 TURSO_URL 或 TURSO_TOKEN"
fi

# ── 步骤 3：部署 Worker ──
info "步骤 3/4：部署到 Cloudflare Workers..."

SECRETS_FILE="$(mktemp)"
trap 'rm -f "$SECRETS_FILE"' EXIT

append_secret() {
  local name="$1" value
  value="$(cred_load "$name" 2>/dev/null || true)"
  if [ -n "$value" ]; then
    echo "${name}=${value}" >> "$SECRETS_FILE"
  fi
}

# 写入 wrangler 需要的 secrets
for name in TURSO_URL TURSO_TOKEN JWT_SECRET PASSWORD_PEPPER RESEND_API_KEY EMAIL_FROM CRON_SECRET CREDENTIALS_ENCRYPTION_KEY LOGTO_ENDPOINT LOGTO_APP_ID; do
  append_secret "$name"
done

# APP_ORIGIN
DOMAIN="$(cred_load DOMAIN 2>/dev/null || true)"
if [ -n "$DOMAIN" ]; then
  APP_ORIGIN="https://${DOMAIN}"
else
  APP_ORIGIN="$(cred_load APP_ORIGIN 2>/dev/null || echo 'https://lottery.example.com')"
fi

DEPLOY_ARGS=(--secrets-file="$SECRETS_FILE" --var "APP_ORIGIN:$APP_ORIGIN")
info "执行: npx wrangler deploy"
npx wrangler deploy "${DEPLOY_ARGS[@]}"

info "✅ 部署完成！"
info "访问地址: $APP_ORIGIN"
