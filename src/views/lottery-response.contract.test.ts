/**
 * 抽奖用户端响应与体验契约：
 * - 后端 ok() 为 { ok: true, ...data } 顶层展开，禁止前端再套 data.data
 * - 导航可达、我的记录、history 模式查单链接、个人状态响应式
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const viewSource = readFileSync(new URL('./LotteryView.vue', import.meta.url), 'utf8')
const headerSource = readFileSync(new URL('../components/HeaderBar.vue', import.meta.url), 'utf8')
const httpCore = readFileSync(
  new URL('../../../node_modules/@usethink/cf-core/dist/src/http.js', import.meta.url),
  'utf8',
)
const routeSource = readFileSync(
  new URL('../../../src/routes/lottery-draws.ts', import.meta.url),
  'utf8',
)
const zhSource = readFileSync(new URL('../i18n/zh-CN.ts', import.meta.url), 'utf8')
const enSource = readFileSync(new URL('../i18n/en.ts', import.meta.url), 'utf8')

describe('lottery user-facing response contract', () => {
  it('cf-core ok() spreads payload at top level (no data wrapper)', () => {
    expect(httpCore).toContain('{ ok: true, ...data }')
    expect(httpCore).not.toMatch(/ok:\s*true,\s*data\s*:/)
  })

  it('LotteryView reads top-level fields, never data.data', () => {
    expect(viewSource).not.toMatch(/data\.data\.(draws|token|entries|winners)/)
    expect(viewSource).not.toMatch(/\.\.\.data\.data\b/)
    expect(viewSource).not.toMatch(/data\.data\s*\?/)
    // 列表
    expect(viewSource).toContain('data.draws')
    // 登录 session
    expect(viewSource).toContain('data.token')
    // 个人记录
    expect(viewSource).toContain('data.entries')
    expect(viewSource).toContain('data.winners')
  })

  it('exposes my-records UI and reactive personal state (not Map.set in place)', () => {
    expect(viewSource).toContain('my-records')
    expect(viewSource).toContain("$t('lottery.myRecords')")
    expect(viewSource).toContain('myEntryList')
    expect(viewSource).toContain('myWonById')
    expect(viewSource).toContain('myJoinedById')
    // 禁止原地 Map.set 导致 Vue 不刷新「已参与」
    expect(viewSource).not.toMatch(/myJoinedDraws\.value\.set\(/)
    expect(viewSource).not.toMatch(/new Map</)
    // 参与成功后替换对象引用
    expect(viewSource).toMatch(/myJoinedById\.value\s*=\s*\{\s*\.\.\.myJoinedById\.value/)
  })

  it('uses history-mode order links (no hash-router order path)', () => {
    // 真实链接不得写成 hash 伪路径；注释里的说明字符串也避免匹配
    expect(viewSource).not.toMatch(/['"`]\/#\/order/)
    expect(viewSource).not.toMatch(/href\s*=\s*['"`][^'"`]*\/#\/order/)
    expect(viewSource).toContain("path: '/order'")
    expect(viewSource).toContain('query: { token:')
    expect(viewSource).toContain('RouterLink')
  })

  it('supports login-then-auto-join and countdown on open draws', () => {
    expect(viewSource).toContain('pendingJoinDrawId')
    expect(viewSource).toContain('countdownText')
    expect(viewSource).toContain('handleLogout')
    expect(viewSource).toContain('LOTTERY_EMAIL_KEY')
  })

  it('deep-link /lottery/:id offers back-to-all and copy share link', () => {
    expect(viewSource).toContain('isDeepLinked')
    expect(viewSource).toContain('backToAllDraws')
    expect(viewSource).toContain('handleCopyPublicLink')
    expect(viewSource).toContain('buildLotteryPublicShareUrl')
    expect(viewSource).toContain('to="/lottery"')
  })

  it('my-records sort winners first; card quick-share; focus navigates when missing', () => {
    expect(viewSource).toContain('sortLotteryMyEntries')
    expect(viewSource).toContain('sortedMyEntries')
    expect(viewSource).toContain('handleCopyPublicLink(draw.id)')
    expect(viewSource).toContain("router.push('/lottery/'")
  })

  it('shows productTitle from public list/detail payload', () => {
    expect(viewSource).toContain('productTitle')
    expect(viewSource).toContain("$t('lottery.product')")
    expect(viewSource).toMatch(/draw\.productTitle \|\| draw\.productId/)
  })

  it('nav exposes lottery entry on all HeaderBar surfaces', () => {
    expect(headerSource).toContain('to="/lottery"')
    expect(headerSource).toContain("$t('nav.lottery')")
    // TG 底栏 + TG 桌面 + H5 三处都要有
    expect(headerSource.match(/to="\/lottery"/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('i18n ships nav.lottery and my-records copy in zh + en', () => {
    expect(zhSource).toContain('lottery: "抽奖"')
    expect(enSource).toContain('lottery: "Lottery"')
    expect(zhSource).toContain('myRecords:')
    expect(enSource).toContain('myRecords:')
    expect(zhSource).toContain('pageHint:')
    expect(enSource).toContain('pageHint:')
    expect(zhSource).toContain('loginBanner:')
    expect(enSource).toContain('loginBanner:')
  })

  it('public join catches service errors as 400 (not unhandled 500)', () => {
    expect(routeSource).toContain('joinDraw')
    expect(routeSource).toMatch(/try\s*\{[\s\S]*?joinDraw[\s\S]*?\}\s*catch/)
    expect(routeSource).toContain('加入失败')
  })

  it('admin lottery path stays off public lotteryDrawRoute', () => {
    expect(routeSource).not.toMatch(/adminLotteryRoute|\/admin\/lottery/)
    expect(routeSource).toContain('/lottery/draws')
    expect(routeSource).toContain('/lottery/entries')
    expect(routeSource).toContain('/lottery/my')
  })

  it('listPublicDraws and getDrawDetail expose productTitle for user UI', () => {
    const serviceSource = readFileSync(
      new URL('../../../src/services/lottery-service.ts', import.meta.url),
      'utf8',
    )
    expect(serviceSource).toMatch(/export async function listPublicDraws[\s\S]*?productTitle: products\.title/)
    expect(serviceSource).toMatch(/export async function getDrawDetail[\s\S]*?productTitle: productRow/)
  })

})
