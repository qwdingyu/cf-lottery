import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './assets/base.css'
import './assets/admin.css'
import i18n from './i18n'
import { buildStaleAssetRecoveryUrl, clearStaleAssetRecoveryParam, isStaleAssetLoadError } from './lib/stale-asset-recovery'

// 部署期间已经打开的旧页面可能引用上一版不存在的 hash chunk（docs/242）。
// 只允许刷新一次：刷新后若新版本仍缺少资源，保留错误现场，避免无限刷新掩盖真正的部署问题。
let staleAssetReloadStarted = false
function recoverFromStaleAsset(error: unknown, href: string): boolean {
  if (staleAssetReloadStarted || !isStaleAssetLoadError(error)) return false
  const recoveryUrl = buildStaleAssetRecoveryUrl(href, window.location.href)
  if (!recoveryUrl) return false
  staleAssetReloadStarted = true
  window.location.replace(recoveryUrl)
  return true
}

window.addEventListener('vite:preloadError', (event) => {
  if (!isStaleAssetLoadError(event.payload)) return
  // Vite 会在动态 import 失败时派发可取消事件；取消默认抛错后交给一次性刷新恢复。
  event.preventDefault()
  window.setTimeout(() => { recoverFromStaleAsset(event.payload, window.location.href) }, 100)
})

router.onError((error, to) => {
  const targetUrl = router.resolve(to).href
  recoverFromStaleAsset(error, targetUrl)
})

router.afterEach((_to, _from, failure) => {
  if (failure) return
  const cleanUrl = clearStaleAssetRecoveryParam(window.location.href)
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== cleanUrl) {
    window.history.replaceState(window.history.state, '', cleanUrl)
  }
})

// Telegram Mini App 主题适配
const tg = (window as any).Telegram?.WebApp
if (tg) {
  tg.ready()
  tg.expand()
  const p = tg.themeParams
  if (p) {
    const root = document.documentElement.style
    if (p.bg_color) root.setProperty('--tg-bg', p.bg_color)
    if (p.text_color) root.setProperty('--tg-text', p.text_color)
    if (p.hint_color) root.setProperty('--tg-hint', p.hint_color)
    if (p.link_color) root.setProperty('--tg-link', p.link_color)
    if (p.button_color) root.setProperty('--tg-btn', p.button_color)
    if (p.button_text_color) root.setProperty('--tg-btn-text', p.button_text_color)
    if (p.secondary_bg_color) root.setProperty('--tg-surface', p.secondary_bg_color)
  }
  tg.onEvent('themeChanged', () => {
    const p2 = tg.themeParams
    if (p2?.bg_color) document.documentElement.style.setProperty('--tg-bg', p2.bg_color)
    if (p2?.text_color) document.documentElement.style.setProperty('--tg-text', p2.text_color)
    if (p2?.hint_color) document.documentElement.style.setProperty('--tg-hint', p2.hint_color)
    if (p2?.link_color) document.documentElement.style.setProperty('--tg-link', p2.link_color)
    if (p2?.button_color) document.documentElement.style.setProperty('--tg-btn', p2.button_color)
    if (p2?.button_text_color) document.documentElement.style.setProperty('--tg-btn-text', p2.button_text_color)
    if (p2?.secondary_bg_color) document.documentElement.style.setProperty('--tg-surface', p2.secondary_bg_color)
  })
}

const app = createApp(App)
app.use(router)
app.use(i18n)
app.mount('#app')
