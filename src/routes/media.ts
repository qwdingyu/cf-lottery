import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { auditLogs } from "../db/schema";
import { requireAuth, requireTenantMember } from "../middleware/auth";
import { fail, getDb, ok } from "../lib/http";
import { waitUntil } from "../lib/platform";
import {
  MEDIA_IMAGE_CACHE_CONTROL,
  createMediaImageKey,
  getManagedMediaImageContentType,
  validateMediaImage,
} from "../lib/media-image";

export const mediaRoute = new Hono<AppEnv>();
export const adminMediaRoute = new Hono<AppEnv>();

function publicMediaUrl(key: string): string {
  // 保存站内相对 URL，避免 localhost 或生产域名进入数据库，迁移域名时无需批量改数据。
  return `/api/media/${key}`;
}

function getMediaBucket(c: { env: AppEnv["Bindings"] }): R2Bucket | undefined {
  // 运行时检查用于给未完成 R2 初始化的部署返回明确错误，而不是抛出 undefined.put。
  return c.env.LOTTERY_MEDIA;
}

// 租户侧媒体上传属于后台写操作：viewer 可以看活动，但不能上传或改奖品图。
adminMediaRoute.use("*", requireAuth, requireTenantMember(), async (c, next) => {
  const role = c.get("tenantRole");
  if (role !== "owner" && role !== "admin") return fail(c, "权限不足", 403);
  await next();
});

adminMediaRoute.post("/images", async (c) => {
  const bucket = getMediaBucket(c);
  if (!bucket) return fail(c, "图片存储未配置，请先创建并绑定 R2 Bucket", 503);

  const contentType = c.req.header("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return fail(c, "图片上传必须使用 multipart/form-data", 415);
  }

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return fail(c, "无法解析图片上传请求", 400);
  }

  const entry: unknown = form.get("file");
  if (!entry || typeof entry !== "object" || !("arrayBuffer" in entry) || typeof entry.arrayBuffer !== "function") {
    return fail(c, "缺少图片文件", 400);
  }
  const file = entry as File;

  let bytes: Uint8Array;
  let image: ReturnType<typeof validateMediaImage>;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    image = validateMediaImage(file, bytes);
  } catch (error) {
    return fail(c, error instanceof Error ? error.message : "图片校验失败", 400);
  }

  const key = createMediaImageKey(image.extension);
  const stored = await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: image.contentType,
      contentDisposition: "inline",
      cacheControl: MEDIA_IMAGE_CACHE_CONTROL,
    },
  });
  if (!stored) return fail(c, "图片保存失败，请重试", 500);

  // 上传是低频后台动作，写一条租户审计可帮助后续定位异常图片或滥用。
  await getDb(c).insert(auditLogs).values({
    id: crypto.randomUUID(),
    tenantId: c.get("tenantId") as string,
    actorUserId: c.get("userId") as string,
    action: "upload_media_image",
    targetType: "media_image",
    targetId: key,
    metadataJson: JSON.stringify({ contentType: image.contentType, size: file.size }),
  });

  return ok(c, {
    key,
    url: publicMediaUrl(key),
    contentType: image.contentType,
    size: file.size,
  });
});

mediaRoute.get("/media/images/:filename", async (c) => {
  const bucket = getMediaBucket(c);
  if (!bucket) return fail(c, "图片存储未配置", 503);

  // 路由只开放 images 命名空间，避免未来同一 Bucket 中的其他对象被意外公开。
  const encodedKey = `images/${c.req.param("filename")}`;
  let key: string;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return fail(c, "图片地址无效", 404);
  }
  const safeContentType = getManagedMediaImageContentType(key);
  if (!safeContentType) return fail(c, "图片不存在", 404);

  const cacheUrl = new URL(c.req.url);
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const edgeCache = typeof caches === "undefined" ? undefined : caches.default;
  const cached = await edgeCache?.match(cacheKey);
  if (cached) return cached;

  const object = await bucket.get(key);
  if (!object) return fail(c, "图片不存在", 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", safeContentType);
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", MEDIA_IMAGE_CACHE_CONTROL);
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");

  const response = new Response(object.body, { headers });
  if (edgeCache) {
    waitUntil(c, edgeCache.put(cacheKey, response.clone()).catch((error) => {
      console.warn("[media-cache-put]", error instanceof Error ? error.message : String(error));
    }));
  }
  return response;
});
