#!/usr/bin/env bash
set -euo pipefail

# cf-lottery Turso 数据库备份脚本。
#
# 与 cf-shop 共享同样的 Turso 备份机制：
# 1. turso db export   → 导出平台快照（含 WAL）
# 2. sync-turso-backup → 同步远端最新帧（嵌入副本 SDK sync）
# 3. sqlite3 checkpoint → WAL 合并为单文件 SQLite
# 4. integrity_check   → 校验备份完整性
# 5. tar + openssl enc  → 压缩 + 加密归档
#
# 必需环境变量：
#   TURSO_API_TOKEN           Turso 平台 API Token（turso CLI 从环境变量读取）
#   TURSO_DB_NAME             Turso 数据库名称（非 libsql:// URL）
#   TURSO_URL / TURSO_TOKEN   数据库连接凭据（libsql:// URL + auth token）
#   BACKUP_ENCRYPTION_PASSPHRASE  至少 20 字符，用于加密备份文件
#
# 用法：
#   TURSO_API_TOKEN="<platform-token>" \
#   TURSO_DB_NAME="<db-name>" \
#   TURSO_URL="<libsql-url>" \
#   TURSO_TOKEN="<db-token>" \
#   BACKUP_ENCRYPTION_PASSPHRASE="<strong-passphrase>" \
#   bash scripts/backup-turso.sh

BACKUP_DIR="${BACKUP_DIR:-backups}"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
TEMP_BACKUP_FILES=()

cleanup_temp_backup_files() {
  if [[ ${#TEMP_BACKUP_FILES[@]} -gt 0 ]]; then
    rm -f -- "${TEMP_BACKUP_FILES[@]}"
  fi
}
trap cleanup_temp_backup_files EXIT INT TERM

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令：$1" >&2
    exit 1
  fi
}

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "缺少环境变量：${name}" >&2
    exit 1
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

require_command turso
require_command node
require_command sqlite3
require_command tar
require_command openssl
require_value TURSO_API_TOKEN
require_value TURSO_DB_NAME
require_value TURSO_URL
require_value TURSO_TOKEN
require_value BACKUP_ENCRYPTION_PASSPHRASE

if [[ ${#BACKUP_ENCRYPTION_PASSPHRASE} -lt 20 ]]; then
  echo "BACKUP_ENCRYPTION_PASSPHRASE 至少需要 20 个字符" >&2
  exit 1
fi
if [[ ! "${TURSO_DB_NAME}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "TURSO_DB_NAME 只能包含字母、数字、点、下划线和连字符" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
umask 077

local base="turso_${TURSO_DB_NAME}_${STAMP}"
local snapshot="${BACKUP_DIR}/${base}.db"
local wal="${snapshot}-wal"
local metadata="${snapshot}-info"
local shm="${snapshot}-shm"
local journal="${snapshot}-journal"
local manifest="${BACKUP_DIR}/${base}.manifest.txt"
local archive="${BACKUP_DIR}/${base}.tar.gz"
local encrypted="${archive}.enc"
TEMP_BACKUP_FILES=("${snapshot}" "${wal}" "${metadata}" "${shm}" "${journal}" "${manifest}" "${archive}")

# ── 步骤 1：导出 Turso 平台快照 ──
echo "开始导出 Turso 平台快照：${TURSO_DB_NAME}"
local platform_database_url
platform_database_url="$(turso db show "${TURSO_DB_NAME}" --url)"
if [[ -z "${platform_database_url}" ]]; then
  echo "无法读取 Turso 数据库 URL：${TURSO_DB_NAME}" >&2
  exit 1
fi
turso db export "${TURSO_DB_NAME}" --output-file "${snapshot}" --with-metadata --overwrite
echo "快照导出完成 → ${snapshot}"

# ── 步骤 2：同步远端最新帧 ──
# turso db export 可能不含最新提交；保留导出 metadata 后用嵌入式副本再拉取最新帧
TURSO_EXPECTED_URL="${platform_database_url}" node scripts/sync-turso-backup.mjs "${snapshot}"

# ── 步骤 3：WAL 合并为单文件 ──
local checkpoint
checkpoint="$(sqlite3 "${snapshot}" "PRAGMA wal_checkpoint(TRUNCATE);")"
if [[ "${checkpoint%%|*}" != "0" ]] || [[ -s "${wal}" ]]; then
  echo "SQLite WAL 合并失败：${checkpoint}" >&2
  exit 1
fi
rm -f -- "${wal}" "${metadata}" "${shm}" "${journal}"
echo "WAL 合并完成"

# ── 步骤 4：完整性校验 ──
local integrity
integrity="$(sqlite3 "${snapshot}" "PRAGMA integrity_check;")"
if [[ "${integrity}" != "ok" ]]; then
  echo "SQLite 完整性检查失败：${integrity}" >&2
  exit 1
fi

local table_count
table_count="$(sqlite3 "${snapshot}" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")"
if [[ ! "${table_count}" =~ ^[0-9]+$ ]] || [[ "${table_count}" -lt 1 ]]; then
  echo "导出快照不包含业务表，拒绝生成空备份" >&2
  exit 1
fi

local migration_version
migration_version="$(sqlite3 "${snapshot}" "SELECT COALESCE(MAX(version), 'unknown') FROM schema_migrations;" 2>/dev/null || printf 'unknown')"
local snapshot_sha
snapshot_sha="$(sha256_file "${snapshot}" | awk '{print $1}')"
echo "完整性校验通过 → ${table_count} 表, migration=${migration_version}"

# ── 步骤 5：生成清单文件 ──
{
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "database=${TURSO_DB_NAME}"
  echo "integrity_check=${integrity}"
  echo "table_count=${table_count}"
  echo "migration_version=${migration_version}"
  echo "snapshot_sha256=${snapshot_sha}"
} > "${manifest}"

# ── 步骤 6：压缩 + 加密 ──
local archive_files=("$(basename "${snapshot}")" "$(basename "${manifest}")")
tar -czf "${archive}" -C "${BACKUP_DIR}" "${archive_files[@]}"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -md sha256 \
  -in "${archive}" -out "${encrypted}" -pass env:BACKUP_ENCRYPTION_PASSPHRASE

local encrypted_name
encrypted_name="$(basename "${encrypted}")"
(
  cd "${BACKUP_DIR}"
  sha256_file "${encrypted_name}" > "${encrypted_name}.sha256"
)

rm -f -- "${snapshot}" "${wal}" "${metadata}" "${shm}" "${journal}" "${manifest}" "${archive}"
TEMP_BACKUP_FILES=()

echo "✅ 加密备份完成：${encrypted}"
echo "   校验文件：${encrypted}.sha256"
echo "   注意：Turso Free 的 PITR 覆盖最近 24 小时；离线导出仍须定期做恢复演练"
