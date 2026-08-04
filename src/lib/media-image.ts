/**
 * 媒体图片：共享逻辑来自 @usethink/cf-core；产品注入 2MiB 上限与文案。
 */
import {
  MEDIA_IMAGE_CACHE_CONTROL,
  createMediaImageKey,
  detectMediaImage,
  getManagedMediaImageContentType,
  isManagedMediaImageKey,
  validateMediaImage as validateMediaImageCore,
  type SupportedMediaImage,
} from "@usethink/cf-core/media-image";
import { MEDIA_IMAGE_FILE_LIMIT_BYTES } from "./api-body-limit";

export {
  MEDIA_IMAGE_CACHE_CONTROL,
  createMediaImageKey,
  detectMediaImage,
  getManagedMediaImageContentType,
  isManagedMediaImageKey,
  type SupportedMediaImage,
};

export function validateMediaImage(file: File, bytes: Uint8Array): SupportedMediaImage {
  return validateMediaImageCore(file, bytes, {
    maxBytes: MEDIA_IMAGE_FILE_LIMIT_BYTES,
    oversizeMessage: "图片不能超过 2MiB",
  });
}
