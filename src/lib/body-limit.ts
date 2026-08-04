/**
 * 请求体大小闸门中间件（#8）
 *
 * 背景：Cloudflare Workers 免费层不适合让任意 API 接收大请求体。
 * 只有 /api/admin/media/images 允许 2MiB 图片上传，其余接口保持 100KB。
 *
 * 流式计数 / content-length 判定来自 @usethink/cf-core/api-body-limit；
 * 本文件只绑定路径文案、Hono fail 与 AppEnv。
 */
import type { Context, Next } from "hono";
import type { AppEnv } from "../bindings";
import {
  isContentLengthOverLimit,
  readRequestBodyWithinLimit,
  rebuildRequestWithBody,
} from "@usethink/cf-core/api-body-limit";
import { getApiBodyLimitBytes } from "./api-body-limit";
import { fail } from "./http";

export async function enforceRequestBodyLimit(c: Context<AppEnv>, next: Next) {
  const limit = getApiBodyLimitBytes(c.req.path);
  const isMediaUpload = c.req.path === "/api/admin/media/images";
  const oversizedMessage = isMediaUpload
    ? "图片上传请求过大（图片最大 2MiB）"
    : "请求体过大（最大 100KB）";

  if (isContentLengthOverLimit(c.req.header("content-length"), limit)) {
    return fail(c, oversizedMessage, 413);
  }

  // chunked / 无 content-length 的写请求：流式读取并计数，杜绝绕过 content-length 闸门
  const rawBody = c.req.raw.body;
  if (
    !c.req.header("content-length") &&
    (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "PATCH") &&
    rawBody
  ) {
    const result = await readRequestBodyWithinLimit(rawBody, limit);
    if (!result.ok) {
      return fail(c, oversizedMessage, 413);
    }
    if (result.body) {
      c.req.raw = rebuildRequestWithBody(c.req.raw, result.body);
    }
  }

  await next();
}
