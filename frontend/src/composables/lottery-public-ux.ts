/**
 * 公开参与页状态路径启发式（纯函数，可 vitest）。
 *
 * docs/076：draft/paused 不能只显示灰字「暂不可参与」——要有可执行下一步。
 * 不推导 participation/experience/result；只根据 status + 是否已参与。
 */

export type PublicStatusCta =
  | 'none'
  | 'refresh'
  | 'query_result'
  | 'login_to_check'
  | 'copy_link'

export type PublicStatusBannerTone = 'info' | 'warn' | 'muted' | 'success'

/**
 * 非 open 状态下底部主 CTA（参与按钮不可用时的替代动作）。
 */
export function publicNonOpenPrimaryCta(input: {
  status: string
  joined: boolean
  hasSession: boolean
}): PublicStatusCta {
  const status = String(input.status || '')
  if (status === 'drawn') {
    if (input.joined || input.hasSession) return 'query_result'
    return 'login_to_check'
  }
  if (status === 'drawing') {
    if (input.joined || input.hasSession) return 'query_result'
    return 'refresh'
  }
  if (status === 'draft' || status === 'paused') {
    return 'refresh'
  }
  if (status === 'cancelled') {
    return input.joined ? 'query_result' : 'none'
  }
  return 'none'
}

/** 次要 CTA：draft/paused 可复制链接方便稍后再进 */
export function publicNonOpenSecondaryCta(status: string): PublicStatusCta {
  if (status === 'draft' || status === 'paused') return 'copy_link'
  return 'none'
}

export function publicStatusBannerTone(status: string): PublicStatusBannerTone {
  if (status === 'draft' || status === 'paused') return 'warn'
  if (status === 'drawing') return 'info'
  if (status === 'drawn') return 'muted'
  if (status === 'cancelled') return 'muted'
  if (status === 'open') return 'success'
  return 'info'
}
