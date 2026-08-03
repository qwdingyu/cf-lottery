/**
 * cf-auth 浏览器会话纯逻辑：驱动 shipped 的 apply/save/consume，禁止假成功。
 */
import { describe, expect, it } from "vitest";
import {
  CF_AUTH_PENDING_JOIN_KEY,
  CF_AUTH_RETURN_KEY,
  LOTTERY_REGISTERED_TOKEN_KEY,
  LOTTERY_SESSION_EMAIL_KEY,
  applyCfAuthSessionToLottery,
  buildCfAuthVerifyJoinBody,
  clearAllCfAuthBrowserState,
  consumeCfAuthPendingJoin,
  missingJoinCredentialForMode,
  readCfAuthPendingJoin,
  readTenantIdFromBusinessJwt,
  resolveAdminPathAfterCfAuth,
  resolveCfAuthReturnPath,
  saveCfAuthPendingJoin,
  shouldResumeCfAuthJoin,
  type SessionStore,
} from "./cf-auth-session";

function memoryStore(init: Record<string, string> = {}): SessionStore {
  const map = new Map<string, string>(Object.entries(init));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/** 构造可被 atob 解析的假 JWT（不验签，仅测 payload 粗读） */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const body = btoa(JSON.stringify(payload))
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${body}.sig`;
}

describe("cf-auth-session（参与闭环）", () => {
  it("applyCfAuthSessionToLottery 写入 lottery_registered_token 而非仅邮箱", () => {
    const store = memoryStore();
    const out = applyCfAuthSessionToLottery(store, {
      token: "biz.jwt.token",
      email: "rp@example.com",
    });
    expect(out.token).toBe("biz.jwt.token");
    expect(store.getItem(LOTTERY_REGISTERED_TOKEN_KEY)).toBe("biz.jwt.token");
    expect(store.getItem(LOTTERY_SESSION_EMAIL_KEY)).toBe("rp@example.com");
    // 关键：参与路径可读到 Bearer，与 admin_token 隔离（本函数不写 admin_token）
    expect(store.getItem("admin_token")).toBeNull();
  });

  it("apply 缺 token 抛错", () => {
    const store = memoryStore();
    expect(() => applyCfAuthSessionToLottery(store, { token: "  " })).toThrow(/token/);
  });

  it("save/read/consume pendingJoin 跨往返", () => {
    const store = memoryStore();
    saveCfAuthPendingJoin(store, {
      drawId: "act-slug-1",
      accessPassword: "pw",
      inviteCode: "INV",
      refCode: "ref9",
      returnPath: "/lottery/act-slug-1",
    });
    const read = readCfAuthPendingJoin(store);
    expect(read?.drawId).toBe("act-slug-1");
    expect(read?.accessPassword).toBe("pw");
    expect(store.getItem(CF_AUTH_PENDING_JOIN_KEY)).toBeTruthy();

    const once = consumeCfAuthPendingJoin(store);
    expect(once?.inviteCode).toBe("INV");
    expect(readCfAuthPendingJoin(store)).toBeNull();
  });

  it("空 drawId 不写 pending", () => {
    const store = memoryStore();
    saveCfAuthPendingJoin(store, { drawId: "  " });
    expect(readCfAuthPendingJoin(store)).toBeNull();
  });

  it("resolveCfAuthReturnPath 优先 pending.returnPath", () => {
    const store = memoryStore({ [CF_AUTH_RETURN_KEY]: "/admin" });
    expect(
      resolveCfAuthReturnPath(store, {
        drawId: "x",
        returnPath: "/lottery/x",
      }),
    ).toBe("/lottery/x");
    expect(resolveCfAuthReturnPath(store, null)).toBe("/admin");
  });

  it("buildCfAuthVerifyJoinBody 空 code + 附加凭证", () => {
    const body = buildCfAuthVerifyJoinBody({
      email: "a@b.c",
      pending: { drawId: "d1", accessPassword: "p", refCode: "r" },
    });
    expect(body.code).toBe("");
    expect(body.email).toBe("a@b.c");
    expect(body.accessPassword).toBe("p");
    expect(body.refCode).toBe("r");
  });

  it("clearAllCfAuthBrowserState 清 transit + pending", () => {
    const store = memoryStore();
    saveCfAuthPendingJoin(store, { drawId: "d" });
    store.setItem(CF_AUTH_RETURN_KEY, "/lottery/d");
    clearAllCfAuthBrowserState(store);
    expect(readCfAuthPendingJoin(store)).toBeNull();
    expect(store.getItem(CF_AUTH_RETURN_KEY)).toBeNull();
  });

  it("shouldResumeCfAuthJoin 需 pending + token；失败路径可只 read 不 consume", () => {
    expect(shouldResumeCfAuthJoin({ pending: null, token: "t" })).toBe(false);
    expect(shouldResumeCfAuthJoin({ pending: { drawId: "d" }, token: "" })).toBe(false);
    expect(shouldResumeCfAuthJoin({ pending: { drawId: "d" }, token: "jwt" })).toBe(true);

    // 模拟 resume 失败：只 read，pending 仍在
    const store = memoryStore();
    saveCfAuthPendingJoin(store, { drawId: "slug-keep" });
    const p = readCfAuthPendingJoin(store);
    expect(shouldResumeCfAuthJoin({ pending: p, token: "jwt" })).toBe(true);
    expect(readCfAuthPendingJoin(store)?.drawId).toBe("slug-keep");
  });

  it("missingJoinCredentialForMode password/invite 拦空凭证", () => {
    expect(
      missingJoinCredentialForMode({ participationMode: "password", accessPassword: "" }),
    ).toBe("password");
    expect(
      missingJoinCredentialForMode({
        participationMode: "password",
        accessPassword: "x",
      }),
    ).toBeNull();
    expect(
      missingJoinCredentialForMode({ participationMode: "invite_code", inviteCode: "  " }),
    ).toBe("invite");
    expect(missingJoinCredentialForMode({ participationMode: "open" })).toBeNull();
  });

  it("readTenantIdFromBusinessJwt + resolveAdminPathAfterCfAuth 空租户进 onboarding", () => {
    const emptyTenant = fakeJwt({ sub: "u1", tenantId: "", email: "a@b.c" });
    const withTenant = fakeJwt({ sub: "u1", tenantId: "ten-1", email: "a@b.c" });
    expect(readTenantIdFromBusinessJwt(emptyTenant)).toBe("");
    expect(readTenantIdFromBusinessJwt(withTenant)).toBe("ten-1");

    // 管理端回跳：无租户 → onboarding
    expect(
      resolveAdminPathAfterCfAuth({ token: emptyTenant, returnPath: "/admin" }),
    ).toBe("/admin/onboarding");
    expect(
      resolveAdminPathAfterCfAuth({ token: withTenant, returnPath: "/admin" }),
    ).toBe("/admin");
    // 参与页不改写（join 闭环优先）
    expect(
      resolveAdminPathAfterCfAuth({
        token: emptyTenant,
        returnPath: "/lottery/act-1",
      }),
    ).toBe("/lottery/act-1");
  });
});
