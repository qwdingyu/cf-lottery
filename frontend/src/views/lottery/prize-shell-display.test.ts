import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RITUAL_PHRASES,
  buildPublicPrizeShellPayload,
  buildShellLabels,
  parseExperienceShellConfig,
  resolvePrizePanelMode,
  sanitizeRitualPhrases,
} from './prize-shell-display'

describe('prize-shell-display (frontend)', () => {
  it('与后端契约：auto 模式分支', () => {
    expect(resolvePrizePanelMode('instant', 'auto')).toBe('full_on_shell')
    expect(resolvePrizePanelMode('manual', 'auto')).toBe('shell_ritual_pool_full')
    expect(resolvePrizePanelMode('scheduled', 'auto')).toBe('shell_ritual_pool_full')
  })

  it('docs/128 红线：delayed + 显式 full_on_shell 降级（与服务端对称）', () => {
    expect(resolvePrizePanelMode('manual', 'full_on_shell')).toBe('shell_ritual_pool_full')
    expect(resolvePrizePanelMode('scheduled', 'full_on_shell')).toBe('shell_ritual_pool_full')
    expect(resolvePrizePanelMode('', 'full_on_shell')).toBe('shell_ritual_pool_full')
    expect(resolvePrizePanelMode('instant', 'full_on_shell')).toBe('full_on_shell')
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

  it('服务端缺模式时丢弃 labels 并本地重建（防旧版响应误用）', () => {
    const p = buildPublicPrizeShellPayload({
      resultMode: 'manual',
      promotionConfig: {},
      serverShell: {
        // 无 prizePanelMode：模拟旧版响应/中间层漏传——labels 不可信
        shellLabels: ['蓝牙耳机', 'iPhone'],
        prizePoolDisplay: 'full',
      },
      prizes: [{ name: '蓝牙耳机', tierName: '一等奖', winnerCount: 1 }],
    })
    // 本地按 manual+auto 解析为仪式壳，labels 重建为默认仪式短语
    expect(p.prizePanelMode).toBe('shell_ritual_pool_full')
    expect(p.shellUsesRealPrizes).toBe(false)
    expect(p.shellLabels.some((l) => l.includes('耳机'))).toBe(false)
  })

  it('full_on_shell 拿到仪式短语 labels 时重建为真奖名（防「仪式词+真奖图」错配）', () => {
    const p = buildPublicPrizeShellPayload({
      resultMode: 'instant',
      promotionConfig: {},
      serverShell: {
        prizePanelMode: 'full_on_shell',
        // 中间层篡改/旧缓存：labels 是默认仪式短语，与模式不配套
        shellLabels: [...DEFAULT_RITUAL_PHRASES],
      },
      prizes: [{ name: '蓝牙耳机', imageUrl: 'https://x/a.png' }],
    })
    expect(p.shellLabels[0]).toBe('蓝牙耳机')
    expect(p.shellPrizeItems[0]?.imageUrl).toBe('https://x/a.png')
  })

  it('奖名恰好为默认仪式词时不误伤（如奖品真的叫「好运连连」）', () => {
    const p = buildPublicPrizeShellPayload({
      resultMode: 'instant',
      promotionConfig: {},
      serverShell: {
        prizePanelMode: 'full_on_shell',
        shellLabels: ['好运连连', '蓝牙耳机'],
      },
      prizes: [{ name: '好运连连', imageUrl: '' }, { name: '蓝牙耳机', imageUrl: '' }],
    })
    // labels 含真奖名 → 不触发重建，保持服务端原样
    expect(p.shellLabels).toEqual(['好运连连', '蓝牙耳机'])
  })

  it('parseExperienceShellConfig 兼容 JSON 字符串配置（中间层序列化兜底）', () => {
    const cfg = parseExperienceShellConfig(
      '{"experience":{"prizePanelMode":"ritual_only","ritualPhrases":["好运"]}}',
    )
    expect(cfg.prizePanelMode).toBe('ritual_only')
    expect(cfg.ritualPhrases).toEqual(['好运'])
  })
})
