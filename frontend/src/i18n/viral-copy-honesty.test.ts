/**
 * 裂变文案诚实性（docs/115 skeptic）：禁止「再参与 / 额外抽奖机会」误读。
 * 直接断言 i18n 对象导出键，不 mock 被测文案。
 */
import { describe, expect, it } from 'vitest'
import zh from './zh-CN'
import en from './en'

/** 中文：旧营销残留，暗示「再参与一次 / 多一次抽奖」 */
const ZH_FORBIDDEN = [
  /额外开奖机会/,
  /多一次机会/,
  /额外获得抽奖机会/,
  /抽奖机会/,
]

/** 英文：extra entries / another chance to play 类误读（允许 “not another join” 诚实否定） */
const EN_FORBIDDEN = [
  /earn extra entries/i,
  /(?<!not\s)another (spin|join|chance to play)/i,
  /extra chance/i,
]

const KEYS = [
  'viralJoinFirstHint',
  'viralShareText',
  'viralHeadline',
  'viralInviteHint',
  'viralWeightExplain',
  'adminViralSectionDesc',
  'adminViralMaxSuffix',
  'adminViralPerInviteSuffix',
  'adminViralMaxLabel',
] as const

/**
 * 从 i18n lottery 对象中安全读取字符串键值。
 * lottery 对象含嵌套的 tpl 字段，不能整体断言为 Record<string, string>，
 * 用此辅助函数按需读取已知的字符串键。
 */
function lotString(lottery: typeof zh.lottery, key: string): string {
  const v = (lottery as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : ''
}

describe('裂变文案加权票语义（docs/115）', () => {
  it('zh-CN 关键键不含「机会/再参与」类误导', () => {
    for (const key of KEYS) {
      const text = lotString(zh.lottery, key)
      expect(text.length, key).toBeGreaterThan(0)
      for (const re of ZH_FORBIDDEN) {
        expect(text, `${key} matches ${re}`).not.toMatch(re)
      }
    }
    // 上限后缀必须是「票」不是「次」
    expect(lotString(zh.lottery, 'adminViralMaxSuffix')).toMatch(/票/)
    expect(lotString(zh.lottery, 'adminViralMaxSuffix')).not.toMatch(/次（/)
  })

  it('en 关键键用 weight/tickets，不用 extra entries 当再参与', () => {
    for (const key of KEYS) {
      const text = lotString(en.lottery, key)
      expect(text.length, key).toBeGreaterThan(0)
      for (const re of EN_FORBIDDEN) {
        expect(text, `${key} matches ${re}`).not.toMatch(re)
      }
    }
    expect(lotString(en.lottery, 'adminViralMaxSuffix').toLowerCase()).toMatch(/ticket/)
    expect(lotString(en.lottery, 'adminViralSectionDesc').toLowerCase()).toMatch(/weight|ticket/)
  })
})
