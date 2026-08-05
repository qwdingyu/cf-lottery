/**
 * instant spin / 弱会话 OTP 公开页纯决策（docs/116/119）。
 *
 * 从 LotteryView 抽出：门禁、主 CTA、发码 purpose 不依赖 Vue 实例，
 * 便于 vitest 硬锁「禁止假一键 / spin 不走 join / 次数用尽走查结果」。
 */

export type LoginModalIntent = 'join' | 'spin' | 'login'

export type JoinedPrimaryCta = 'spin_again' | 'query_result'

/** lottery + resultMode=instant（其它 kind 即使写 instant 也不走 spin 机） */
export function isInstantLottery(
  draw: { activityKind?: string | null; resultMode?: string | null } | null | undefined,
): boolean {
  if (!draw) return false
  const kind = String(draw.activityKind || 'lottery')
  return kind === 'lottery' && String(draw.resultMode || '') === 'instant'
}

/**
 * 游戏区是否禁用。
 * - 未参与：可点（走 join）
 * - delayed 已参与：禁用
 * - instant 已参与：已知 left=0 禁用；未知 left 仍允许点（由接口 409）
 */
export function isPublicGameDisabled(input: {
  status: string
  joined: boolean
  isInstant: boolean
  /** null/undefined = 未知次数 */
  spinsLeft?: number | null
  busy?: boolean
}): boolean {
  if (input.busy) return true
  if (String(input.status || '') !== 'open') return true
  if (!input.joined) return false
  if (input.isInstant) {
    if (input.spinsLeft === 0) return true
    return false
  }
  return true
}

/**
 * 已参与底部主 CTA：instant 且 left>0 → 再抽；否则查结果。
 * 未知 left（null）不展示再抽主按钮（与模板 `(spinsLeft ?? 0) > 0` 一致）。
 */
export function joinedPrimaryCta(input: {
  isInstant: boolean
  spinsLeft?: number | null
}): JoinedPrimaryCta {
  if (input.isInstant && (input.spinsLeft ?? 0) > 0) return 'spin_again'
  return 'query_result'
}

/** 查结果主按钮是否应 primary 样式（无「再抽」时突出查结果） */
export function isQueryResultPrimaryCta(input: {
  isInstant: boolean
  spinsLeft?: number | null
}): boolean {
  return joinedPrimaryCta(input) !== 'spin_again'
}

/**
 * access-code 发码 purpose：
 * - spin 补码 → query（已参与也可发，避免 join 409）
 * - join → 默认 join 路径（不传 purpose 或非 query）
 */
export function accessCodePurposeForIntent(intent: LoginModalIntent): 'query' | 'join' {
  return intent === 'spin' ? 'query' : 'join'
}

/** 弹窗是否为 instant 弱会话补码（标题/主按钮分流） */
export function isSpinAuthModal(intent: LoginModalIntent, hasPendingDrawId: boolean): boolean {
  return intent === 'spin' && Boolean(hasPendingDrawId)
}

/**
 * 弹窗文案 i18n key（lottery.* 短名）。
 * 与 LotteryView loginModalTitle / Hint / 主按钮文案分支对齐。
 */
export function loginModalCopyKeys(input: {
  intent: LoginModalIntent
  isRegisteredJoin: boolean
  isLoginOnly: boolean
}): { titleKey: string; hintKey: string; primaryVerifyKey: string } {
  if (input.isRegisteredJoin) {
    return {
      titleKey: 'loginAndJoin',
      hintKey: 'registeredRequired',
      primaryVerifyKey: 'verifyAndJoin',
    }
  }
  if (input.intent === 'spin') {
    return {
      titleKey: 'spinVerifyTitle',
      hintKey: 'spinVerifyHint',
      primaryVerifyKey: 'spinVerifyAndGo',
    }
  }
  if (input.isLoginOnly) {
    return {
      titleKey: 'emailVerify',
      hintKey: 'loginToViewRecords',
      primaryVerifyKey: 'verifyAndJoin',
    }
  }
  return {
    titleKey: 'emailVerify',
    hintKey: 'emailVerifyHint',
    primaryVerifyKey: 'verifyAndJoin',
  }
}

export type InstantSpinClientGate =
  | { action: 'noop' }
  | { action: 'exhausted' }
  | { action: 'open_login'; intent: 'join' | 'spin'; reason: 'registered_no_token' | 'no_session' | 'need_otp' }
  | {
      action: 'proceed'
      withBearer: boolean
      body: { email?: string; code?: string }
    }

/**
 * 发起 /spin 前的客户端门禁（无网络）。
 * 与 LotteryView.handleInstantSpin 对齐：
 * - 次数用尽 → exhausted（UI 开 my-result）
 * - registered 无 JWT → join 弹窗
 * - open 弱会话无邮箱 → spin 弹窗
 * - open 无 Bearer 无 OTP → spin 弹窗（禁止假一键）
 * - 有 Bearer：body 可带 email、不带 code
 */
export function resolveInstantSpinClientGate(input: {
  isInstant: boolean
  status: string
  /** 未知时按 1 处理（允许点，与现网 spinsLeftById ?? 1 一致） */
  spinsLeft?: number | null
  participationMode?: string | null
  hasBearer: boolean
  sessionEmail?: string | null
  otpCode?: string | null
}): InstantSpinClientGate {
  if (!input.isInstant || String(input.status || '') !== 'open') return { action: 'noop' }
  if ((input.spinsLeft ?? 1) <= 0) return { action: 'exhausted' }

  const isReg = String(input.participationMode || '') === 'registered'
  const email = String(input.sessionEmail || '')
    .trim()
    .toLowerCase()
  const code = String(input.otpCode || '').trim()

  if (isReg && !input.hasBearer) {
    return { action: 'open_login', intent: 'join', reason: 'registered_no_token' }
  }
  if (!isReg && !input.hasBearer && !email) {
    return { action: 'open_login', intent: 'spin', reason: 'no_session' }
  }
  if (!isReg && !input.hasBearer && !code) {
    return { action: 'open_login', intent: 'spin', reason: 'need_otp' }
  }

  const body: { email?: string; code?: string } = {}
  if (!isReg) {
    body.email = email
    if (!input.hasBearer && code) body.code = code
  }
  return { action: 'proceed', withBearer: input.hasBearer, body }
}

/**
 * verify 弹窗主按钮：spin 意图不走 verify-join，把码交给 /spin。
 */
export function shouldVerifyCodeGoToSpin(intent: LoginModalIntent): boolean {
  return intent === 'spin'
}
