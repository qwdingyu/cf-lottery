import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RITUAL_PHRASES,
  buildPublicPrizeShellPayload,
  buildShellLabels,
  resolvePrizePanelMode,
  sanitizeRitualPhrases,
} from './prize-shell-display'

describe('prize-shell-display (frontend)', () => {
  it('与后端契约：auto 模式分支', () => {
    expect(resolvePrizePanelMode('instant', 'auto')).toBe('full_on_shell')
    expect(resolvePrizePanelMode('manual', 'auto')).toBe('shell_ritual_pool_full')
    expect(resolvePrizePanelMode('scheduled', 'auto')).toBe('shell_ritual_pool_full')
  })

  it('sanitize 拒绝中奖语义', () => {
    expect(sanitizeRitualPhrases(['好运', '恭喜中奖', '一等奖'])).toEqual(['好运'])
  })

  it('delayed 壳不含奖品名；奖池条 full 仍有真名', () => {
    const p = buildPublicPrizeShellPayload({
      resultMode: 'scheduled',
      promotionConfig: {},
      prizes: [
        { name: '蓝牙耳机', tierName: '一等奖', winnerCount: 1, imageUrl: 'https://x/a.png' },
        { name: '优惠券', tierName: '二等奖', winnerCount: 5 },
      ],
    })
    expect(p.shellUsesRealPrizes).toBe(false)
    expect(p.shellPrizeItems.every((i) => !i.imageUrl)).toBe(true)
    expect(p.shellPrizeItems.some((i) => i.name.includes('耳机'))).toBe(false)
    expect(p.prizePoolDisplay).toBe('full')
    expect(p.poolStripItems.some((i) => i.name.includes('耳机'))).toBe(true)
  })

  it('instant 壳用真名与图', () => {
    const p = buildPublicPrizeShellPayload({
      resultMode: 'instant',
      promotionConfig: {},
      prizes: [{ name: '蓝牙耳机', imageUrl: 'https://x/a.png', valueText: '¥99' }],
    })
    expect(p.shellUsesRealPrizes).toBe(true)
    expect(p.shellPrizeItems[0]?.name).toBe('蓝牙耳机')
    expect(p.shellPrizeItems[0]?.imageUrl).toBe('https://x/a.png')
  })

  it('优先服务端 shell 字段', () => {
    const p = buildPublicPrizeShellPayload({
      resultMode: 'manual',
      promotionConfig: {},
      serverShell: {
        prizePanelMode: 'shell_ritual_pool_summary',
        shellLabels: ['期待开奖', '感谢参与'],
        prizePoolDisplay: 'summary',
      },
      prizes: [{ name: 'A', tierName: '一等奖', winnerCount: 1 }],
    })
    expect(p.prizePanelMode).toBe('shell_ritual_pool_summary')
    expect(p.shellLabels).toEqual(['期待开奖', '感谢参与'])
    expect(p.prizePoolDisplay).toBe('summary')
    expect(p.poolStripItems[0]?.name).toBe('一等奖')
  })

  it('buildShellLabels 默认短语', () => {
    const labels = buildShellLabels({
      mode: 'shell_ritual_pool_full',
      prizeNames: ['X'],
      ritualPhrases: [],
      minSlots: 1,
    })
    expect(labels[0]).toBe(DEFAULT_RITUAL_PHRASES[0])
  })
})
