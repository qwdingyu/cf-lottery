/**
 * 管理端抽奖 API 薄封装。
 *
 * 为什么单独成文件：把 HTTP 路径与 AdminLotteryView 编排解耦，
 * 列表/中奖/分析弹窗共用同一套请求，避免 SFC 内重复拼 URL。
 */
import { adminRequest } from '@/composables/useAdminRequest'
import type {
  DrawAnalyticsStats,
  ExternalConversion,
  ExternalConversionSummary,
  LotteryDraw,
  LotteryWinner,
  PublishCheckResult,
} from './types'

export async function fetchLotteryDraws(params: {
  limit: number
  offset: number
  status?: string
  query?: string
  activityKind?: string
  createdFrom?: string
  createdTo?: string
}) {
  const search = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) })
  if (params.status) search.set('status', params.status)
  if (params.query) search.set('query', params.query)
  if (params.activityKind) search.set('activityKind', params.activityKind)
  if (params.createdFrom) search.set('createdFrom', params.createdFrom)
  if (params.createdTo) search.set('createdTo', params.createdTo)
  return adminRequest<{ draws: LotteryDraw[]; total: number }>(`/api/admin/draws?${search}`)
}

export const createLotteryDraw = async (body: unknown) =>
  adminRequest<{ id: string; publicSlug: string }>('/api/admin/draws', { method: 'POST', body: JSON.stringify(body) })

export const updateLotteryDraw = async (id: string, body: unknown) =>
  adminRequest(`/api/admin/draws/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

export const fetchPublishCheck = async (id: string) =>
  adminRequest<PublishCheckResult>(`/api/admin/draws/${id}/publish-check`)

export const openLotteryDraw = async (id: string) =>
  adminRequest(`/api/admin/draws/${id}/publish`, { method: 'POST' })

/** open → paused */
export const pauseLotteryDraw = async (id: string) =>
  adminRequest(`/api/admin/draws/${id}/pause`, { method: 'POST' })

/** paused → open */
export const resumeLotteryDraw = async (id: string) =>
  adminRequest(`/api/admin/draws/${id}/resume`, { method: 'POST' })

export const performLotteryDraw = async (id: string) =>
  adminRequest(`/api/admin/draws/${id}/draw`, { method: 'POST' })

export const cancelLotteryDraw = async (id: string) =>
  adminRequest(`/api/admin/draws/${id}/cancel`, { method: 'POST' })

export const deleteLotteryDraw = async (id: string) =>
  adminRequest(`/api/admin/draws/${id}`, { method: 'DELETE' })

export const fetchLotteryWinners = async (id: string) =>
  adminRequest<{ winners: LotteryWinner[] }>(`/api/admin/draws/${id}/winners`)

export const fetchDrawAnalyticsStats = async (id: string) =>
  adminRequest<DrawAnalyticsStats>(`/api/admin/draws/${id}/stats`)

export const fetchDrawConversions = async (id: string) =>
  adminRequest<{ conversions: ExternalConversion[]; summary: ExternalConversionSummary }>(
    `/api/admin/draws/${id}/conversions?limit=50`,
  )

export const fetchAdminLottery = async (path: string, method: string) => adminRequest(path, { method })

export const retryAdminLotteryEmail = async (id: string) =>
  adminRequest<{ sent: number; failed: number }>(`/api/admin/draws/${id}/retry-email`, { method: 'POST' })

export const recoverLotteryDraw = async (id: string) =>
  adminRequest<{ healed: 'drawn' | 'open' }>(`/api/admin/draws/${id}/recover`, { method: 'POST' })
