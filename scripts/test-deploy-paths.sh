#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# test-deploy-paths.sh — 验证 VPS 部署路径逻辑的正确性
#
# 测试场景：
#   1. tar 包内文件路径是相对路径（无前缀目录）
#   2. tar -xzf -C <dir> 解压到正确位置
#   3. 清理逻辑：保留最近 1 个 tar.gz，删除旧版本
#   4. 边界场景：VPS_PATH 默认值、目录不存在、tar 包损坏
#   5. 端到端模拟：构建 → 解压 → 验证文件位置
#
# 用法：bash scripts/test-deploy-paths.sh
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
FAILURES=0
pass() { echo -e "  ${GREEN}✓${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

echo "═══════════════════════════════════════════════════════════════"
echo " deploy 路径逻辑测试"
echo "═══════════════════════════════════════════════════════════════"

# ── 测试 1：tar 包内路径结构 ──
echo ""
echo "测试 1：tar 包内路径结构"
TARBALL="$(ls -t /Users/dingyuwang/0-X/github_workflow/templates/cf-lottery/cf-lottery-deploy-*.tar.gz 2>/dev/null | head -1 || true)"
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  warn "未找到 cf-lottery-deploy-*.tar.gz，跳过 tar 包结构测试"
else
  ABS_COUNT=$(tar -tzf "$TARBALL" 2>/dev/null | grep -c '^/' || echo 0)
  ABS_COUNT=$(echo "$ABS_COUNT" | tr -dc '0-9')
  ABS_COUNT="${ABS_COUNT:-0}"

  if [ "$ABS_COUNT" -gt 0 ]; then
    fail "tar 包包含绝对路径（${ABS_COUNT} 个），解压会写到系统根目录"
  else
    pass "tar 包无绝对路径（全部为相对路径）"
  fi

  TOP_DIRS=$(tar -tzf "$TARBALL" 2>/dev/null | sed 's|/.*||' | sort -u | xargs)
  pass "顶层目录：$TOP_DIRS"

  if tar -tzf "$TARBALL" 2>/dev/null | grep -q '^dist/server\.js$'; then
    pass "dist/server.js 存在（服务入口）"
  else
    fail "dist/server.js 不存在"
  fi

  if tar -tzf "$TARBALL" 2>/dev/null | grep -q '^public/index\.html$'; then
    pass "public/index.html 存在（前端入口）"
  else
    fail "public/index.html 不存在"
  fi
fi

# ── 测试 2：tar -xzf -C 解压位置验证 ──
echo ""
echo "测试 2：tar -xzf -C 解压位置验证"

if [ -n "${TARBALL:-}" ] && [ -f "${TARBALL:-}" ]; then
  # 2a. 不带 -C：文件解压到当前目录（错误方式）
  WRONG_DIR="$TMPDIR_TEST/wrong"
  mkdir -p "$WRONG_DIR"
  (cd "$WRONG_DIR" && tar -xzf "$TARBALL" 2>/dev/null)
  if [ -f "$WRONG_DIR/dist/server.js" ]; then
    pass "不带 -C 时文件散落到当前目录（旧 bug 根因复现）"
  fi
  rm -rf "$WRONG_DIR"

  # 2b. 带 -C：文件解压到指定目录（正确方式）
  RIGHT_DIR="$TMPDIR_TEST/right"
  mkdir -p "$RIGHT_DIR"
  tar -xzf "$TARBALL" -C "$RIGHT_DIR" 2>/dev/null

  OK=1
  for f in dist/server.js public/index.html configs; do
    if [ -e "$RIGHT_DIR/$f" ]; then
      pass "带 -C 解压：$f → $RIGHT_DIR/$f"
    else
      fail "带 -C 解压：$f 缺失"
      OK=0
    fi
  done

  if [ ! -d "$RIGHT_DIR/node_modules" ]; then
    pass "node_modules 不在 tar 包内（需 npm ci）"
  fi
else
  warn "跳过解压测试（无 tar.gz）"
fi

# ── 测试 3：清理逻辑 ──
echo ""
echo "测试 3：tar.gz 清理逻辑"
CLEAN_DIR="$TMPDIR_TEST/clean"
mkdir -p "$CLEAN_DIR"

# 用 sleep 保证时间戳递增（macOS APFS 纳秒精度）
for i in 1 2 3 4 5; do
  echo "pkg-$i" > "$CLEAN_DIR/cf-lottery-deploy-20260824-18000${i}.tar.gz"
  sleep 0.3
done

BEFORE=$(ls -1 "$CLEAN_DIR"/cf-lottery-deploy-*.tar.gz 2>/dev/null | wc -l | tr -dc '0-9')
BEFORE="${BEFORE:-0}"
pass "创建了 ${BEFORE} 个模拟 tar.gz"

# 执行清理（与部署脚本完全一致的逻辑）
ls -t "$CLEAN_DIR"/cf-lottery-deploy-*.tar.gz 2>/dev/null | tail -n +2 | xargs -r rm -f

AFTER=$(ls -1 "$CLEAN_DIR"/cf-lottery-deploy-*.tar.gz 2>/dev/null | wc -l | tr -dc '0-9')
AFTER="${AFTER:-0}"

if [ "$AFTER" -eq 1 ]; then
  pass "清理后保留 1 个 tar.gz"
elif [ "$AFTER" -eq 0 ]; then
  fail "清理后 0 个（应保留最新 1 个）"
else
  fail "清理后 ${AFTER} 个（应保留 1 个）"
fi

# 空目录清理不报错
rm -f "$CLEAN_DIR"/cf-lottery-deploy-*.tar.gz
ls -t "$CLEAN_DIR"/cf-lottery-deploy-*.tar.gz 2>/dev/null | tail -n +2 | xargs -r rm -f 2>/dev/null || true
pass "空目录清理不报错"

# ── 测试 4：边界场景 ──
echo ""
echo "测试 4：边界场景"

# 4a. VPS_PATH 默认值
DEFAULT_PATH=$(grep 'VPS_PATH:-' local-deploy-vps.sh | head -1 | sed 's/.*VPS_PATH:-\([^}]*\)}.*/\1/')
if [ "$DEFAULT_PATH" = "/root/cf-lottery" ]; then
  pass "VPS_PATH 默认值 = /root/cf-lottery（与服务 WorkingDirectory 一致）"
else
  fail "VPS_PATH 默认值 = ${DEFAULT_PATH}（应为 /root/cf-lottery）"
fi

# 4b. 脚本逻辑中无硬编码 /root 路径（注释行、默认值除外）
# grep -n 输出 "行号:内容"，注释行格式为 "数字: # ..."，用 ^[0-9]+:\s*# 排除
HARDCODED=$(grep -n '/root' local-deploy-vps.sh | grep -vE '^[0-9]+:\s*#' | grep -v 'VPS_PATH:-' || true)
if [ -z "$HARDCODED" ]; then
  pass "脚本逻辑中无硬编码 /root 路径"
else
  fail "脚本中存在硬编码路径：$HARDCODED"
fi

# 4c. mkdir -p 创建深层目录
DEEP="$TMPDIR_TEST/a/b/c/d"
mkdir -p "$DEEP"
if [ -d "$DEEP" ]; then
  pass "mkdir -p 创建深层目录正常"
else
  fail "mkdir -p 创建深层目录失败"
fi

# 4d. 损坏的 tar.gz 正确报错
CORRUPT="$TMPDIR_TEST/corrupt.tar.gz"
echo "not a tar" > "$CORRUPT"
if ! tar -xzf "$CORRUPT" -C "$TMPDIR_TEST" 2>/dev/null; then
  pass "损坏的 tar.gz 正确报错（非零退出码）"
else
  fail "损坏的 tar.gz 未报错"
fi

# ── 测试 5：端到端模拟 ──
echo ""
echo "测试 5：端到端模拟（构建 → 解压 → 验证）"

if [ -n "${TARBALL:-}" ] && [ -f "${TARBALL:-}" ]; then
  VPS_ROOT="$TMPDIR_TEST/vps-root"
  DEPLOY="$VPS_ROOT/cf-lottery"
  mkdir -p "$DEPLOY"

  # 5a. 模拟上传到正确位置
  cp "$TARBALL" "$DEPLOY/"
  REMOTE_PKG="$DEPLOY/$(basename "$TARBALL")"
  if [ -f "$REMOTE_PKG" ]; then
    pass "模拟上传 tar.gz → $DEPLOY/"
  else
    fail "模拟上传失败"
  fi

  # 5b. 清理旧 assets
  mkdir -p "$DEPLOY/public/assets"
  echo "old" > "$DEPLOY/public/assets/old.css"
  rm -rf "$DEPLOY/public/assets"
  if [ ! -d "$DEPLOY/public/assets" ]; then
    pass "清理旧 assets 完成"
  else
    fail "清理旧 assets 失败"
  fi

  # 5c. 解压（使用 -C）
  tar -xzf "$REMOTE_PKG" -C "$DEPLOY" 2>/dev/null

  ALL_OK=1
  for f in dist/server.js public/index.html configs; do
    if [ -e "$DEPLOY/$f" ]; then
      pass "解压后 $f 在正确位置"
    else
      fail "解压后 $f 缺失"
      ALL_OK=0
    fi
  done

  # 5d. 验证文件不在错误位置（上级目录）
  if [ ! -f "$VPS_ROOT/dist/server.js" ] && [ ! -f "$VPS_ROOT/public/index.html" ]; then
    pass "文件未散落到上级目录 $VPS_ROOT/"
  else
    fail "文件错误地出现在上级目录"
    ALL_OK=0
  fi

  # 5e. 模拟清理 tar.gz
  ls -t "$DEPLOY"/cf-lottery-deploy-*.tar.gz 2>/dev/null | tail -n +2 | xargs -r rm -f
  PKG_COUNT=$(ls -1 "$DEPLOY"/cf-lottery-deploy-*.tar.gz 2>/dev/null | wc -l | tr -dc '0-9')
  PKG_COUNT="${PKG_COUNT:-0}"
  if [ "$PKG_COUNT" -eq 1 ]; then
    pass "清理后保留 1 个 tar.gz（可用于回滚）"
  else
    fail "清理后 tar.gz 数量：${PKG_COUNT}"
  fi

  if [ "$ALL_OK" -eq 1 ]; then
    pass "端到端模拟完整通过"
  fi
else
  warn "跳过端到端测试（无 tar.gz）"
fi

# ── 汇总 ──
echo ""
echo "═══════════════════════════════════════════════════════════════"
if [ "$FAILURES" -eq 0 ]; then
  echo -e " ${GREEN}全部测试通过 ✓${NC}"
else
  echo -e " ${RED}失败 ${FAILURES} 项 ✗${NC}"
fi
echo "═══════════════════════════════════════════════════════════════"
exit "$FAILURES"
