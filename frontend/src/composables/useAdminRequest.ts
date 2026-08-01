/**
 * 管理后台 API 请求工具
 *
 * 统一所有 L2/L3 管理页面的 fetch 调用，避免 8 个视图文件各自复制 adminRequest 函数。
 * 使用 readAdminToken() 确保 token 读取逻辑一致（含过期检查）。
 */
import { readAdminToken } from './useAdminAuth'

/**
 * 发送带 JWT 认证的 API 请求。
 *
 * 自动附加 Authorization: Bearer <token> 头。
 * 响应非 ok 时抛出 Error（含服务端 message）。
 *
 * @param path    API 路径（如 /api/admin/draws）
 * @param options 可选的 fetch 配置（method、body 等）
 * @returns       解析后的 JSON 数据
 * @throws        HTTP 错误或服务端返回的错误消息
 */
export async function adminRequest<T = any>(path: string, options?: RequestInit): Promise<T> {
  const token = readAdminToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(path, { ...options, headers })
  const data = await res.json()
  if (!data.ok) throw new Error(data.message || `请求失败: ${res.status}`)
  return data as T
}
