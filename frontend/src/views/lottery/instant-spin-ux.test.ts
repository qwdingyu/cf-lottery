/**
 * instant 弱会话 / CTA / 客户端 spin 门禁硬断言（docs/116/119/120）
 */
import { describe, expect, it } from 'vitest'
import {
  accessCodePurposeForIntent,
  isInstantLottery,
  isPublicGameDisabled,
  isQueryResultPrimaryCta,
  isSpinAuthModal,
  joinedPrimaryCta,
  loginModalCopyKeys,
  resolveInstantSpinClientGate,
  shouldVerifyCodeGoToSpin,
} from './instant-spin-ux'

describe('isInstantLottery', () => {
  it('仅 lottery + instant', () => {
    expect(isInstantLottery({ activityKind: 'lottery', resultMode: 'instant' })).toBe(true)
    expect(isInstantLottery({ resultMode: 'instant' })).toBe(true) // kind 默认 lottery
    expect(isInstantLottery({ activityKind: 'lottery', resultMode: 'manual' })).toBe(false)
    expect(isInstantLottery({ activityKind: 'claim', resultMode: 'instant' })).toBe(false)
    expect(isInstantLottery(null)).toBe(false)
  })
})

describe('isPublicGameDisabled / joined CTA', () => {
  it('未参与 open 可点；delayed 已参与禁用；instant left=0 禁用', () => {
    expect(
      isPublicGameDisabled({ status: 'open', joined: false, isInstant: false }),
    ).toBe(false)
    expect(
      isPublicGameDisabled({ status: 'open', joined: true, isInstant: false }),
    ).toBe(true)
    expect(
      isPublicGameDisabled({
        status: 'open',
        joined: true,
        isInstant: true,
        spinsLeft: 2,
      }),
    ).toBe(false)
    expect(
      isPublicGameDisabled({
        status: 'open',
        joined: true,
        isInstant: true,
        spinsLeft: 0,
      }),
    ).toBe(true)
    // 未知 left：允许点（接口 409）
    expect(
      isPublicGameDisabled({
        status: 'open',
        joined: true,
        isInstant: true,
        spinsLeft: null,
      }),
    ).toBe(false)
    expect(
      isPublicGameDisabled({ status: 'paused', joined: false, isInstant: true }),
    ).toBe(true)
    expect(
      isPublicGameDisabled({
        status: 'open',
        joined: true,
        isInstant: true,
        spinsLeft: 1,
        busy: true,
      }),
    ).toBe(true)
  })

  it('joined 主 CTA：left>0 再抽；否则查结果；未知 left 不伪造成再抽', () => {
    expect(joinedPrimaryCta({ isInstant: true, spinsLeft: 1 })).toBe('spin_again')
    expect(joinedPrimaryCta({ isInstant: true, spinsLeft: 0 })).toBe('query_result')
    expect(joinedPrimaryCta({ isInstant: true, spinsLeft: null })).toBe('query_result')
    expect(joinedPrimaryCta({ isInstant: false, spinsLeft: 5 })).toBe('query_result')
    expect(isQueryResultPrimaryCta({ isInstant: true, spinsLeft: 2 })).toBe(false)
    expect(isQueryResultPrimaryCta({ isInstant: true, spinsLeft: 0 })).toBe(true)
  })
})

describe('spin 弱会话 OTP 意图', () => {
  it('spin 发码 purpose=query；join 为 join', () => {
    expect(accessCodePurposeForIntent('spin')).toBe('query')
    expect(accessCodePurposeForIntent('join')).toBe('join')
    expect(accessCodePurposeForIntent('login')).toBe('join')
  })

  it('verify 主路径：spin 不走 verify-join', () => {
    expect(shouldVerifyCodeGoToSpin('spin')).toBe(true)
    expect(shouldVerifyCodeGoToSpin('join')).toBe(false)
    expect(shouldVerifyCodeGoToSpin('login')).toBe(false)
  })

  it('isSpinAuthModal 与文案 key', () => {
    expect(isSpinAuthModal('spin', true)).toBe(true)
    expect(isSpinAuthModal('spin', false)).toBe(false)
    expect(isSpinAuthModal('join', true)).toBe(false)

    const spin = loginModalCopyKeys({
      intent: 'spin',
      isRegisteredJoin: false,
      isLoginOnly: false,
    })
    expect(spin).toEqual({
      titleKey: 'spinVerifyTitle',
      hintKey: 'spinVerifyHint',
      primaryVerifyKey: 'spinVerifyAndGo',
    })

    const join = loginModalCopyKeys({
      intent: 'join',
      isRegisteredJoin: false,
      isLoginOnly: false,
    })
    expect(join.hintKey).toBe('emailVerifyHint')
    expect(join.primaryVerifyKey).toBe('verifyAndJoin')

    const reg = loginModalCopyKeys({
      intent: 'join',
      isRegisteredJoin: true,
      isLoginOnly: false,
    })
    expect(reg.titleKey).toBe('loginAndJoin')
  })
})

describe('resolveInstantSpinClientGate — 禁止假一键', () => {
  const base = {
    isInstant: true,
    status: 'open',
    spinsLeft: 1,
    participationMode: 'open',
  }

  it('非 instant / 非 open → noop', () => {
    expect(
      resolveInstantSpinClientGate({
        ...base,
        isInstant: false,
        hasBearer: true,
      }),
    ).toEqual({ action: 'noop' })
    expect(
      resolveInstantSpinClientGate({
        ...base,
        status: 'paused',
        hasBearer: true,
      }),
    ).toEqual({ action: 'noop' })
  })

  it('次数用尽 → exhausted', () => {
    expect(
      resolveInstantSpinClientGate({
        ...base,
        spinsLeft: 0,
        hasBearer: true,
      }),
    ).toEqual({ action: 'exhausted' })
  })

  it('registered 无 JWT → join 弹窗', () => {
    expect(
      resolveInstantSpinClientGate({
        ...base,
        participationMode: 'registered',
        hasBearer: false,
        sessionEmail: 'a@b.com',
      }),
    ).toEqual({
      action: 'open_login',
      intent: 'join',
      reason: 'registered_no_token',
    })
  })

  it('open 无邮箱 → spin 弹窗 need session', () => {
    expect(
      resolveInstantSpinClientGate({
        ...base,
        hasBearer: false,
        sessionEmail: '',
      }),
    ).toEqual({
      action: 'open_login',
      intent: 'spin',
      reason: 'no_session',
    })
  })

  it('open 有邮箱无 OTP 无 Bearer → spin 弹窗 need_otp（禁止假一键）', () => {
    expect(
      resolveInstantSpinClientGate({
        ...base,
        hasBearer: false,
        sessionEmail: 'User@Test.COM',
        otpCode: '',
      }),
    ).toEqual({
      action: 'open_login',
      intent: 'spin',
      reason: 'need_otp',
    })
  })

  it('open 弱会话 + OTP → proceed 带 email+code，无 Bearer', () => {
    expect(
      resolveInstantSpinClientGate({
        ...base,
        hasBearer: false,
        sessionEmail: 'User@Test.COM',
        otpCode: '123456',
      }),
    ).toEqual({
      action: 'proceed',
      withBearer: false,
      body: { email: 'user@test.com', code: '123456' },
    })
  })

  it('open + Bearer：proceed 可带 email、不带 code', () => {
    expect(
      resolveInstantSpinClientGate({
        ...base,
        hasBearer: true,
        sessionEmail: 'jwt@test.com',
        otpCode: '999999', // 有 Bearer 时不塞 code
      }),
    ).toEqual({
      action: 'proceed',
      withBearer: true,
      body: { email: 'jwt@test.com' },
    })
  })

  it('registered + Bearer：body 空（身份靠 JWT）', () => {
    expect(
      resolveInstantSpinClientGate({
        ...base,
        participationMode: 'registered',
        hasBearer: true,
        sessionEmail: 'reg@test.com',
        otpCode: '123456',
      }),
    ).toEqual({
      action: 'proceed',
      withBearer: true,
      body: {},
    })
  })
})
