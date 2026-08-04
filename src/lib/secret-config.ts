/**
 * 敏感配置加密封装：逻辑在 @usethink/cf-core/secret-config。
 * 新写入 enc:v2:corejson:；双读历史 lottery enc:v1: raw 与 shop enc:v1: core-json。
 * 读路径请优先 decryptSecretConfigValueObserved，以便解密失败可观测。
 */
export {
  isValidSecretEncryptionKey,
  encryptSecretConfigValue,
  decryptSecretConfigValue,
  decryptSecretConfigResult,
  decryptSecretConfigValueObserved,
  SECRET_CONFIG_PREFIX_V1,
  SECRET_CONFIG_PREFIX_V2_CORE_JSON,
  type SecretDecryptObserveEvent,
} from "@usethink/cf-core/secret-config";
