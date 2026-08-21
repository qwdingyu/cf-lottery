/**
 * 本地磁盘媒体存储（VPS/本地模式的 R2 fallback，2026-08 上线补充）。
 *
 * 为什么需要：media.ts 上传/读取仅支持 Cloudflare Workers 的 R2 binding（LOTTERY_MEDIA）；
 * VPS 生产模式（当前默认部署）无 R2 → 运营上传活动图/奖品图/秒杀商品图会 503，公开页只能用默认图。
 *
 * 设计约束：
 * - 存储目录固定 data/media/（systemd cf-lottery.service 的 ReadWritePaths=/root/cf-lottery/data 已可写）。
 * - key 是服务端生成的 `images/{uuid}.{ext}`（createMediaImageKey），扩展名经
 *   getManagedMediaImageContentType 白名单校验；本模块再做一次路径穿越防御（纵深）。
 * - 与 R2 路径共用同一 public URL（/api/media/images/{filename}），读取端先试 R2 再回退磁盘，
 *   保证域名迁移/云上云下切换无需改库内 URL。
 * - 磁盘文件不自动清理（低频、量小）；运营若需清理可手动删除 data/media/（后续迭代可加 cron）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { logError } from "./logger";

/**
 * 本地媒体根目录（相对进程 cwd；systemd WorkingDirectory=/root/cf-lottery）。
 * 支持 LOCAL_MEDIA_DIR 环境变量覆盖（测试隔离用临时目录；生产默认 data/media）。
 */
function localMediaRoot(): string {
  return process.env.LOCAL_MEDIA_DIR || "data/media";
}

/** 是否启用本地磁盘存储（无 R2 binding 时）。由调用方传入 hasR2 判定，避免依赖全局状态。 */
export function isLocalMediaMode(hasR2: boolean): boolean {
  return !hasR2;
}

/**
 * 校验媒体 key 安全（路径穿越防御）：
 * - 只允许 images/ 前缀下的单层文件名
 * - 规范化后不得逃逸 LOCAL_MEDIA_DIR
 * - 扩展名必须通过白名单（getManagedMediaImageContentType 已校验，此处二次防御）
 */
export function isSafeLocalMediaKey(key: string, safeContentType: string | null): boolean {
  if (!key || !safeContentType) return false;
  if (!key.startsWith("images/")) return false;
  if (key.includes("..") || key.includes("/") !== (key.indexOf("/") === key.lastIndexOf("/"))) return false;
  const normalized = normalize(join(localMediaRoot(), key));
  const root = normalize(localMediaRoot());
  if (!normalized.startsWith(root + "/")) return false;
  return true;
}

/** 保存媒体到本地磁盘；返回是否成功。 */
export async function saveLocalMedia(key: string, bytes: Uint8Array): Promise<boolean> {
  const safe = isSafeLocalMediaKey(key, getManagedContentTypeForLocal(key));
  if (!safe) return false;
  const filePath = join(localMediaRoot(), key);
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    return true;
  } catch (err) {
    logError("local-media", `保存失败 ${key}`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** 读取本地媒体；不存在返回 null。 */
export async function readLocalMedia(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const contentType = getManagedContentTypeForLocal(key);
  if (!contentType || !isSafeLocalMediaKey(key, contentType)) return null;
  try {
    const bytes = await readFile(join(localMediaRoot(), key));
    return { bytes: new Uint8Array(bytes), contentType };
  } catch {
    return null;
  }
}

/** 本地模式扩展名白名单（与 R2 侧 getManagedMediaImageContentType 同源，防写任意文件）。 */
function getManagedContentTypeForLocal(key: string): string | null {
  const ext = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1).toLowerCase() : "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  return map[ext] || null;
}
