import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './assets/base.css'
import './assets/admin.css'
import i18n from './i18n'

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
  // 监听主题变化
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