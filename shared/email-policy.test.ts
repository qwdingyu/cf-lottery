import { describe, expect, it } from "vitest";
import {
  emailHasPlusAlias,
  evaluateBuyerEmailPolicy,
  extractEmailDomain,
  normalizeEmailDomainWhitelistInput,
  parseEmailDomainWhitelist,
  type EmailPolicyConfig,
} from "./email-policy";

const openPolicy: EmailPolicyConfig = {
  domainRestrictionEnabled: false,
  aliasBlockEnabled: false,
  allowedDomains: [],
};

describe("email-policy", () => {
  it("parses whitelist lines and commas", () => {
    expect(parseEmailDomainWhitelist("qq.com\nGmail.com\n\nqq.com, outlook.com")).toEqual([
      "qq.com",
      "gmail.com",
      "outlook.com",
    ]);
  });

  it("normalizes whitelist and rejects invalid domains", () => {
    expect(normalizeEmailDomainWhitelistInput("@QQ.com\ngmail.com\n")).toEqual({
      ok: true,
      value: "qq.com\ngmail.com",
    });
    expect(normalizeEmailDomainWhitelistInput("not a domain").ok).toBe(false);
    const empty = normalizeEmailDomainWhitelistInput("");
    expect(empty).toEqual({ ok: true, value: "" });
  });

  it("detects plus aliases and domains", () => {
    expect(emailHasPlusAlias("user+tag@gmail.com")).toBe(true);
    expect(emailHasPlusAlias("user@gmail.com")).toBe(false);
    expect(extractEmailDomain("Buyer@Example.COM")).toBe("example.com");
  });

  it("allows any email when both switches are off", () => {
    expect(evaluateBuyerEmailPolicy("user+x@tempmail.com", openPolicy)).toEqual({ ok: true });
  });

  it("blocks plus aliases only when enabled", () => {
    const policy: EmailPolicyConfig = { ...openPolicy, aliasBlockEnabled: true };
    expect(evaluateBuyerEmailPolicy("user+x@gmail.com", policy)).toMatchObject({
      ok: false,
      code: "EMAIL_ALIAS_BLOCKED",
    });
    expect(evaluateBuyerEmailPolicy("user@gmail.com", policy)).toEqual({ ok: true });
  });

  it("enforces domain whitelist when restriction is on", () => {
    const policy: EmailPolicyConfig = {
      domainRestrictionEnabled: true,
      aliasBlockEnabled: false,
      allowedDomains: ["qq.com", "gmail.com"],
    };
    expect(evaluateBuyerEmailPolicy("a@qq.com", policy)).toEqual({ ok: true });
    expect(evaluateBuyerEmailPolicy("a@gmail.com", policy)).toEqual({ ok: true });
    // googlemail.com 与 gmail.com 在策略层等价
    expect(evaluateBuyerEmailPolicy("a@googlemail.com", policy)).toEqual({ ok: true });
    expect(evaluateBuyerEmailPolicy("a@163.com", policy)).toMatchObject({
      ok: false,
      code: "EMAIL_DOMAIN_NOT_ALLOWED",
    });
  });

  it("rejects all when restriction is on but whitelist is empty", () => {
    const policy: EmailPolicyConfig = {
      domainRestrictionEnabled: true,
      aliasBlockEnabled: false,
      allowedDomains: [],
    };
    expect(evaluateBuyerEmailPolicy("a@qq.com", policy)).toMatchObject({
      ok: false,
      code: "EMAIL_DOMAIN_WHITELIST_EMPTY",
    });
  });

  it("checks alias before domain so UX is deterministic", () => {
    const policy: EmailPolicyConfig = {
      domainRestrictionEnabled: true,
      aliasBlockEnabled: true,
      allowedDomains: ["gmail.com"],
    };
    expect(evaluateBuyerEmailPolicy("a+1@gmail.com", policy)).toMatchObject({
      ok: false,
      code: "EMAIL_ALIAS_BLOCKED",
    });
  });
});
