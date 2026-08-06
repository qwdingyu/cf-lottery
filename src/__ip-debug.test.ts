import { describe, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getClientIp } from "./lib/platform";

describe("getClientIp debug", () => {
  it("check behavior", async () => {
    const isNode = typeof (globalThis as any).process !== "undefined" && Boolean((globalThis as any).process?.versions?.node);
    // eslint-disable-next-line no-console
    console.log("isNode:", isNode);
    const app = new Hono<AppEnv>();
    app.get("/ip", (c) => c.text(getClientIp(c)));
    const res = await app.request("/ip", {
      headers: { "X-Forwarded-For": "203.0.113.1, 10.0.0.1" },
    });
    // eslint-disable-next-line no-console
    console.log("result:", await res.text());
  });
});
