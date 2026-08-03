import { describe, expect, it } from "vitest";
import {
  CF_AUTH_PENDING_JOIN_KEY,
  CF_AUTH_PKCE_KEY,
  CF_AUTH_RETURN_KEY,
  LOTTERY_REGISTERED_TOKEN_KEY,
  LOTTERY_REGISTERED_USERNAME_KEY,
  LOTTERY_SESSION_EMAIL_KEY,
  type SessionStore,
} from "./cf-auth-session";
import {
  ADMIN_TOKEN_KEY,
  IMPERSONATION_TOKEN_KEY,
  PLATFORM_ROLE_KEY,
  clearAdminAuthStorage,
  clearFullBusinessBrowserSession,
  clearLotteryBrowserSessionOnly,
  clearLotteryParticipationSession,
} from "./business-session";

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

describe("business-session 登出清理", () => {
  it("clearLotteryParticipationSession 只清参与三键", () => {
    const store = memoryStore({
      [LOTTERY_REGISTERED_TOKEN_KEY]: "jwt",
      [LOTTERY_REGISTERED_USERNAME_KEY]: "u",
      [LOTTERY_SESSION_EMAIL_KEY]: "a@b.c",
      [CF_AUTH_PKCE_KEY]: "pkce",
      other: "keep",
    });
    clearLotteryParticipationSession(store);
    expect(store.getItem(LOTTERY_REGISTERED_TOKEN_KEY)).toBeNull();
    expect(store.getItem(LOTTERY_REGISTERED_USERNAME_KEY)).toBeNull();
    expect(store.getItem(LOTTERY_SESSION_EMAIL_KEY)).toBeNull();
    expect(store.getItem(CF_AUTH_PKCE_KEY)).toBe("pkce");
    expect(store.getItem("other")).toBe("keep");
  });

  it("clearAdminAuthStorage 清 admin / 模拟 / 平台角色", () => {
    const store = memoryStore({
      [ADMIN_TOKEN_KEY]: "a",
      [IMPERSONATION_TOKEN_KEY]: "i",
      [PLATFORM_ROLE_KEY]: "owner",
      noise: "x",
    });
    clearAdminAuthStorage(store);
    expect(store.getItem(ADMIN_TOKEN_KEY)).toBeNull();
    expect(store.getItem(IMPERSONATION_TOKEN_KEY)).toBeNull();
    expect(store.getItem(PLATFORM_ROLE_KEY)).toBeNull();
    expect(store.getItem("noise")).toBe("x");
  });

  it("clearFullBusinessBrowserSession 双边全清，含 pending join", () => {
    const local = memoryStore({
      [ADMIN_TOKEN_KEY]: "admin-jwt",
      [IMPERSONATION_TOKEN_KEY]: "imp",
      [PLATFORM_ROLE_KEY]: "op",
    });
    const session = memoryStore({
      [LOTTERY_REGISTERED_TOKEN_KEY]: "part-jwt",
      [LOTTERY_SESSION_EMAIL_KEY]: "e@x.com",
      [CF_AUTH_PKCE_KEY]: "v",
      [CF_AUTH_PENDING_JOIN_KEY]: JSON.stringify({ drawId: "d1" }),
      [CF_AUTH_RETURN_KEY]: "/lottery/d1",
    });
    clearFullBusinessBrowserSession({ localStorage: local, sessionStorage: session });
    expect(local.getItem(ADMIN_TOKEN_KEY)).toBeNull();
    expect(local.getItem(IMPERSONATION_TOKEN_KEY)).toBeNull();
    expect(local.getItem(PLATFORM_ROLE_KEY)).toBeNull();
    expect(session.getItem(LOTTERY_REGISTERED_TOKEN_KEY)).toBeNull();
    expect(session.getItem(LOTTERY_SESSION_EMAIL_KEY)).toBeNull();
    expect(session.getItem(CF_AUTH_PKCE_KEY)).toBeNull();
    expect(session.getItem(CF_AUTH_PENDING_JOIN_KEY)).toBeNull();
    expect(session.getItem(CF_AUTH_RETURN_KEY)).toBeNull();
  });

  it("clearLotteryBrowserSessionOnly 保留 admin_token", () => {
    const local = memoryStore({ [ADMIN_TOKEN_KEY]: "keep-admin" });
    const session = memoryStore({
      [LOTTERY_REGISTERED_TOKEN_KEY]: "p",
      [LOTTERY_REGISTERED_USERNAME_KEY]: "n",
      [CF_AUTH_PENDING_JOIN_KEY]: JSON.stringify({ drawId: "x" }),
    });
    clearLotteryBrowserSessionOnly(session);
    expect(local.getItem(ADMIN_TOKEN_KEY)).toBe("keep-admin");
    expect(session.getItem(LOTTERY_REGISTERED_TOKEN_KEY)).toBeNull();
    expect(session.getItem(CF_AUTH_PENDING_JOIN_KEY)).toBeNull();
  });
});
