import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTRIBUTION_STORAGE_KEY,
  CAMPAIGN_QUERY_KEY,
  CAMPAIGN_QUERY_LONG_ALIASES,
  REFERRAL_QUERY_KEY,
  REFERRAL_QUERY_LONG_ALIASES,
  applyAttributionToSearchParams,
  attributionForPayPayload,
  attributionRouteQueryHasLongAliases,
  captureAttributionFromQuery,
  canonicalizeAttributionRouteQuery,
  clearCheckoutAttribution,
  hasAttributionCodes,
  mergeAttribution,
  normalizeAttributionCode,
  parseAttributionFromLocationSearch,
  parseAttributionFromQuery,
  queryHasAttributionKey,
  readCheckoutAttribution,
  resetCheckoutAttributionMemoryForTests,
  resolveAttributionForCheckout,
  stripAttributionQuery,
} from './checkout-attribution'

/** Node vitest 无 DOM sessionStorage；与 usePayment.contract 同构轻量 mock */
function installSessionStorageMock(options?: { throwOnSet?: boolean }) {
  const store = new Map<string, string>()
  const mock = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (options?.throwOnSet) throw new Error('quota exceeded')
      store.set(key, String(value))
    },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  }
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: mock,
    configurable: true,
    writable: true,
  })
  return mock
}

describe('checkout attribution', () => {
  beforeEach(() => {
    installSessionStorageMock()
    resetCheckoutAttributionMemoryForTests()
    sessionStorage.clear()
  })
  afterEach(() => {
    resetCheckoutAttributionMemoryForTests()
    sessionStorage.clear()
  })

  it('normalizes codes like backend normalizeCode (trim + lower + max 80)', () => {
    expect(normalizeAttributionCode('  QQ-Group  ')).toBe('qq-group')
    expect(normalizeAttributionCode(undefined)).toBe('')
    expect(normalizeAttributionCode('A'.repeat(100)).length).toBe(80)
  })

  it('parses short and long query aliases', () => {
    expect(parseAttributionFromQuery({ campaign: 'ylb-a', ref: 'partner-1' })).toEqual({
      campaignCode: 'ylb-a',
      referralCode: 'partner-1',
    })
    expect(parseAttributionFromQuery({
      campaignCode: 'LongCamp',
      referralCode: 'LongRef',
    })).toEqual({
      campaignCode: 'longcamp',
      referralCode: 'longref',
    })
    // 短键优先于长键
    expect(parseAttributionFromQuery({
      campaign: 'short',
      campaignCode: 'long',
      ref: 'r1',
      referral: 'r2',
    })).toEqual({
      campaignCode: 'short',
      referralCode: 'r1',
    })
    expect(parseAttributionFromQuery({ product: 'useai' })).toEqual({
      campaignCode: undefined,
      referralCode: undefined,
    })
  })

  it('parses location.search the same way as route query', () => {
    expect(parseAttributionFromLocationSearch('?product=useai&campaign=QQ&ref=P1')).toEqual({
      campaignCode: 'qq',
      referralCode: 'p1',
    })
    expect(parseAttributionFromLocationSearch('')).toEqual({
      campaignCode: undefined,
      referralCode: undefined,
    })
  })

  it('captures into sessionStorage and merges partial URL updates', () => {
    const first = captureAttributionFromQuery({ campaign: 'qq-group' })
    expect(first?.campaignCode).toBe('qq-group')
    expect(first?.referralCode).toBe('')
    expect(JSON.parse(sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY) || '{}').campaignCode).toBe('qq-group')

    const second = captureAttributionFromQuery({ ref: 'partner-x' })
    expect(second?.campaignCode).toBe('qq-group')
    expect(second?.referralCode).toBe('partner-x')

    // 无归因 query 不触碰 storage
    expect(captureAttributionFromQuery({ product: 'useai' })).toBeNull()
    expect(readCheckoutAttribution().campaignCode).toBe('qq-group')
    expect(readCheckoutAttribution().referralCode).toBe('partner-x')
  })

  it('clears a dimension when URL explicitly passes empty attribution keys', () => {
    captureAttributionFromQuery({ campaign: 'sticky-camp', ref: 'sticky-ref' })
    expect(queryHasAttributionKey({ campaign: '' }, ['campaign', 'campaignCode'])).toBe(true)

    // 仅清空 campaign，保留 ref
    const afterClearCamp = captureAttributionFromQuery({ campaign: '', product: 'useai' })
    expect(afterClearCamp?.campaignCode).toBe('')
    expect(afterClearCamp?.referralCode).toBe('sticky-ref')

    // 两维都显式空 → 整段清除 storage
    expect(captureAttributionFromQuery({ campaign: '', ref: '' })).toBeNull()
    expect(sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull()
    expect(readCheckoutAttribution().campaignCode).toBe('')
    expect(readCheckoutAttribution().referralCode).toBe('')
  })

  it('clearCheckoutAttribution wipes session and memory', () => {
    captureAttributionFromQuery({ campaign: 'to-clear', ref: 'r1' })
    clearCheckoutAttribution()
    expect(sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull()
    expect(readCheckoutAttribution().campaignCode).toBe('')
    // URL 仍可 last-touch
    expect(resolveAttributionForCheckout({ campaign: 'from-url' })).toEqual({
      campaignCode: 'from-url',
    })
  })

  it('keeps attribution in memory when sessionStorage.setItem fails', () => {
    installSessionStorageMock({ throwOnSet: true })
    resetCheckoutAttributionMemoryForTests()
    const captured = captureAttributionFromQuery({ campaign: 'offline-mode', ref: 'partner' })
    expect(captured?.campaignCode).toBe('offline-mode')
    expect(sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull()
    // 同进程下单仍可读
    expect(readCheckoutAttribution().campaignCode).toBe('offline-mode')
    expect(readCheckoutAttribution().referralCode).toBe('partner')
    expect(resolveAttributionForCheckout({ product: 'x' })).toEqual({
      campaignCode: 'offline-mode',
      referralCode: 'partner',
    })
  })

  it('resolves checkout attribution with URL last-touch over session', () => {
    captureAttributionFromQuery({ campaign: 'session-camp', ref: 'session-ref' })
    // URL 只带新 campaign → 覆盖 campaign，保留 session ref
    expect(resolveAttributionForCheckout({ campaign: 'url-camp', product: 'useai' })).toEqual({
      campaignCode: 'url-camp',
      referralCode: 'session-ref',
    })
    // 纯函数合并
    expect(mergeAttribution(
      { campaignCode: 'a' },
      { campaignCode: 'b', referralCode: 'r' },
    )).toEqual({ campaignCode: 'a', referralCode: 'r' })
  })

  it('builds pay payload omitting empty codes', () => {
    expect(attributionForPayPayload({ campaignCode: 'a', referralCode: '' })).toEqual({
      campaignCode: 'a',
    })
    expect(attributionForPayPayload(null)).toEqual({})
    expect(hasAttributionCodes({ campaignCode: 'x' })).toBe(true)
    expect(hasAttributionCodes({})).toBe(false)
  })

  it('strips attribution keys and applies short keys to search params', () => {
    const stripped = stripAttributionQuery({
      product: 'useai',
      campaign: 'c1',
      campaignCode: 'c2',
      ref: 'r1',
      referral: 'r2',
      referralCode: 'r3',
      utm: 'keep',
    })
    expect(stripped).toEqual({ product: 'useai', utm: 'keep' })

    const params = new URLSearchParams('product=useai&campaignCode=legacy&referral=old&referralCode=old2')
    applyAttributionToSearchParams(params, { campaignCode: 'Camp', referralCode: 'Ref' })
    expect(params.get('product')).toBe('useai')
    expect(params.get(CAMPAIGN_QUERY_KEY)).toBe('camp')
    expect(params.get(REFERRAL_QUERY_KEY)).toBe('ref')
    // 出站仅短键：长别名全部剥离
    for (const key of CAMPAIGN_QUERY_LONG_ALIASES) expect(params.has(key)).toBe(false)
    for (const key of REFERRAL_QUERY_LONG_ALIASES) expect(params.has(key)).toBe(false)
  })

  it('canonicalizes route query: inbound long aliases → short keys only', () => {
    expect(attributionRouteQueryHasLongAliases({
      product: 'useai',
      campaignCode: 'Ylb',
      referralCode: 'Partner-A',
    })).toBe(true)
    expect(attributionRouteQueryHasLongAliases({
      product: 'useai',
      campaign: 'ylb',
      ref: 'partner-a',
    })).toBe(false)

    const canonical = canonicalizeAttributionRouteQuery({
      product: 'useai',
      campaignCode: 'Ylb',
      referral: 'Partner-A',
      referralCode: 'ignored-when-referral-first',
      utm: 'keep',
    })
    expect(canonical).toEqual({
      product: 'useai',
      utm: 'keep',
      campaign: 'ylb',
      ref: 'partner-a',
    })
    expect(canonical).not.toHaveProperty('campaignCode')
    expect(canonical).not.toHaveProperty('referral')
    expect(canonical).not.toHaveProperty('referralCode')

    // 短键优先于长别名
    expect(canonicalizeAttributionRouteQuery({
      campaign: 'short',
      campaignCode: 'long',
      ref: 'r-short',
      referralCode: 'r-long',
    })).toEqual({
      campaign: 'short',
      ref: 'r-short',
    })
  })

  it('accepts referral long alias alone and maps to referralCode field', () => {
    expect(parseAttributionFromQuery({ referral: '  Partner-A  ' })).toEqual({
      campaignCode: undefined,
      referralCode: 'partner-a',
    })
    expect(parseAttributionFromLocationSearch('?referralCode=X&campaignCode=Y')).toEqual({
      campaignCode: 'y',
      referralCode: 'x',
    })
  })
})
