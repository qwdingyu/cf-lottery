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
  readCfAuthPendingJoin,
  resolveCfAuthReturnPath,
  saveCfAuthPendingJoin,
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
});
