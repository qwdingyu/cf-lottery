import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const htmlSource = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const platformSource = readFileSync(new URL('./usePlatform.ts', import.meta.url), 'utf8')
const telegramSource = readFileSync(new URL('./useTelegram.ts', import.meta.url), 'utf8')

describe('platform SDK loading contract', () => {
  it('does not let the Telegram SDK block HTML parsing', () => {
    expect(htmlSource).toMatch(/telegram-web-app\.js" async/)
    expect(htmlSource).not.toMatch(/telegram-web-app\.js"><\/script>/)
  })

  it('detects the platform again after asynchronous SDK loading completes', () => {
    expect(platformSource).toContain("window.addEventListener('load'")
    expect(platformSource).toContain("{ once: true }")
    expect(platformSource.match(/detect\(\)/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('initializes Telegram WebApp again after the asynchronous SDK is available', () => {
    expect(telegramSource).toContain('let sdkLoadListenerRegistered = false')
    expect(telegramSource).toContain('let initializedWebApp: TelegramWebApp | null = null')
    expect(telegramSource).toContain("window.addEventListener('load'")
    expect(telegramSource).toContain("{ once: true }")
    expect(telegramSource).toContain('initializeTelegram()')
    expect(telegramSource).toContain('if (initializedWebApp !== webApp)')
  })
})
