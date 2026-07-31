import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMemberShareReferralCode,
  resolveOutboundShareAttribution,
  setMemberShareReferralCode,
} from './member-share-referral'

describe('member-share-referral', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
  })

  it('stores normalized own referral code', () => {
    setMemberShareReferralCode('  MyCode  ')
    expect(getMemberShareReferralCode()).toBe('mycode')
  })

  it('outbound share uses only own code, never empty object fields from inbound', () => {
    expect(resolveOutboundShareAttribution()).toEqual({})
    setMemberShareReferralCode('alice')
    expect(resolveOutboundShareAttribution()).toEqual({ referralCode: 'alice' })
    setMemberShareReferralCode('')
    expect(resolveOutboundShareAttribution()).toEqual({})
  })
})
