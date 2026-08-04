/**
 * 产品侧 body 上限常量 + 解析；共享逻辑来自 @usethink/cf-core。
 */
import {
  createApiBodyLimitResolver,
  mediaUploadRequestLimitBytes,
} from "@usethink/cf-core/api-body-limit";

/** 普通 JSON API 的请求体上限，保持管理接口轻量。 */
export const DEFAULT_API_BODY_LIMIT_BYTES = 100 * 1024;

/** 奖品图、活动图等单文件上限；Cloudflare 免费层优先控制存储和带宽成本。 */
export const MEDIA_IMAGE_FILE_LIMIT_BYTES = 2 * 1024 * 1024;

/** multipart/form-data 包含 boundary 和字段头，预留协议开销。 */
export const MEDIA_UPLOAD_REQUEST_LIMIT_BYTES = mediaUploadRequestLimitBytes(MEDIA_IMAGE_FILE_LIMIT_BYTES);

const MEDIA_UPLOAD_PATH = "/api/admin/media/images";

const resolveApiBodyLimitBytes = createApiBodyLimitResolver({
  defaultBytes: DEFAULT_API_BODY_LIMIT_BYTES,
  mediaUploadBytes: MEDIA_UPLOAD_REQUEST_LIMIT_BYTES,
  mediaUploadPath: MEDIA_UPLOAD_PATH,
});

/**
 * 只有经过管理员鉴权的图片上传端点允许较大的请求体。
 * 其他 API 继续保持 100KB，避免为了图片能力扩大整个系统的攻击面。
 */
export function getApiBodyLimitBytes(path: string): number {
  return resolveApiBodyLimitBytes(path);
}
