/**
 * 管理后台 API 请求工具
 *
 * 统一所有 L2/L3 管理页面的 fetch 调用，避免 8 个视图文件各自复制 adminRequest 函数。
 * 使用 readAdminToken() 确保 token 读取逻辑一致（含过期检查）。
 */
import { readAdminToken } from './useAdminAuth'

function buildAdminHeaders(options?: RequestInit): Headers {
  const headers = new Headers(options?.headers)
  const token = readAdminToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  // JSON 是管理端默认请求格式；FormData 上传必须让浏览器自动生成 multipart boundary。
  if (!(options?.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  return headers
}

/**
 * 发送带 JWT 认证的 API 请求。
 *
 * 自动附加 Authorization: Bearer <token> 头，并统一解析服务端 `{ ok, message }` 响应。
 * 这里同时支持 JSON 和 FormData，避免媒体上传页面重新复制一套 token/fetch 逻辑。
 *
 * @param path    API 路径（如 /api/admin/draws）
 * @param options 可选的 fetch 配置（method、body 等）
 * @returns       解析后的 JSON 数据
 * @throws        HTTP 错误或服务端返回的错误消息
 */
export async function adminRequest<T = any>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...options, headers: buildAdminHeaders(options) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.message || `请求失败: ${res.status}`)
  return data as T
}
