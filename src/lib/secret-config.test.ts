import { describe, expect, it } from "vitest";
import {
  decryptSecretConfigResult,
  decryptSecretConfigValue,
  encryptSecretConfigValue,
  isValidSecretEncryptionKey,
} from "./secret-config";
import {
  encryptSecretConfigValueLegacyRaw,
  encryptSecretConfigValueLegacyV1CoreJson,
} from "@usethink/cf-core/secret-config";

describe("lottery secret-config via cf-core", () => {
  const key = "a".repeat(64);

  it("new writes use v2 and round-trip", async () => {
    const encrypted = await encryptSecretConfigValue("lottery-api-key", key);
    expect(encrypted).toMatch(/^enc:v2:corejson:/);
    await expect(decryptSecretConfigValue(encrypted, key)).resolves.toBe("lottery-api-key");
  });

  it("dual-reads historical raw enc:v1 layout", async () => {
    const legacy = await encryptSecretConfigValueLegacyRaw("legacy-raw-secret", key);
    const detailed = await decryptSecretConfigResult(legacy, key);
    expect(detailed).toEqual({ ok: true, value: "legacy-raw-secret", layout: "v1-raw" });
  });

  it("dual-reads shop-style v1 core-json", async () => {
    const legacy = await encryptSecretConfigValueLegacyV1CoreJson("shop-style", key);
    const detailed = await decryptSecretConfigResult(legacy, key);
    expect(detailed.ok).toBe(true);
    if (detailed.ok) {
      expect(detailed.value).toBe("shop-style");
      expect(detailed.layout).toBe("v1-corejson");
    }
  });

  it("validates key shape", () => {
    expect(isValidSecretEncryptionKey(key)).toBe(true);
    expect(isValidSecretEncryptionKey("z".repeat(64))).toBe(false);
  });
});
