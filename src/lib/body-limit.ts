/**
 * 请求体大小闸门中间件（#8）
 *
 * 背景：Cloudflare Workers 免费层不适合让任意 API 接收大请求体。
 * 只有 /api/admin/media/images 允许 2MiB 图片上传，其余接口保持 100KB。
 *
 * #8 加固：仅检查 content-length 头可被 chunked 编码绕过（无该头时 length=0 直接放行）。
 * 本中间件对无 content-length 的写请求流式读取计数，超限即 413；
 * 未超限时用读到的字节重建请求体（hono 的 c.req.raw 为 public 字段可替换），
 * 保证下游 c.req.json() 等仍可正常解析。已核实项目不依赖 request.cf 属性，重建无副作用。
 */
import type { Context, Next } from "hono";
import type { AppEnv } from "../bindings";
import { getApiBodyLimitBytes } from "./api-body-limit";
import { fail } from "./http";

export async function enforceRequestBodyLimit(c: Context<AppEnv>, next: Next) {
  const length = Number(c.req.header("content-length") || "0");
  const limit = getApiBodyLimitBytes(c.req.path);
  const isMediaUpload = c.req.path === "/api/admin/media/images";
  const oversizedMessage = isMediaUpload ? "图片上传请求过大（图片最大 2MiB）" : "请求体过大（最大 100KB）";

  if (Number.isFinite(length) && length > limit) {
    return fail(c, oversizedMessage, 413);
  }

  // chunked / 无 content-length 的写请求：流式读取并计数，杜绝绕过 content-length 闸门
  // 注意：HonoRequest 无 body getter，必须读底层 Request 的 c.req.raw.body
  const rawBody = c.req.raw.body;
  if (
    !c.req.header("content-length") &&
    (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "PATCH") &&
    rawBody
  ) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = rawBody.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        return fail(c, oversizedMessage, 413);
      }
      chunks.push(value);
    }
    // 重建请求体，供下游解析
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers = new Headers(c.req.raw.headers);
    headers.set("content-length", String(total));
    c.req.raw = new Request(c.req.url, { method: c.req.method, headers, body: buf });
  }

  await next();
}
