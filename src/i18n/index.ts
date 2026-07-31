/**
 * vue-i18n 初始化
 *
 * 语言检测策略：
 * 1. localStorage 用户偏好（手动切换）
 * 2. navigator.language 浏览器语言
 * 3. 回退 zh-CN
 *
 * 语言切换后自动响应式更新所有模板，无需刷新页面。
 */
import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN";
import en from "./en";

/** 根据浏览器语言自动检测，支持 zh-CN / zh-TW / zh-HK → zh-CN 回退 */
function detectBrowserLanguage(): string {
  try {
    const saved = localStorage.getItem("shop_lang");
    if (saved === "zh-CN" || saved === "en") return saved;
  } catch {
    /* localStorage 不可用时忽略 */
  }
  try {
    const lang = navigator.language || "zh-CN";
    if (lang.startsWith("zh")) return "zh-CN";
    if (lang.startsWith("en")) return "en";
  } catch {
    /* navigator 不可用时忽略 */
  }
  return "zh-CN";
}

const initialLocale = detectBrowserLanguage() as "zh-CN" | "en";

function applyDocumentLanguage(lang: "zh-CN" | "en"): void {
  try {
    document.documentElement.lang = lang;
  } catch {
    /* document 不可用时忽略 */
  }
}

applyDocumentLanguage(initialLocale);

const i18n = createI18n({
  legacy: false, // Composition API 模式
  locale: initialLocale,
  fallbackLocale: "zh-CN",
  messages: { "zh-CN": zhCN, en },
});

export default i18n;

/** 切换语言并持久化到 localStorage */
export function switchLanguage(lang: "zh-CN" | "en"): void {
  i18n.global.locale.value = lang;
  applyDocumentLanguage(lang);
  try {
    localStorage.setItem("shop_lang", lang);
  } catch {
    /* ignore */
  }
}
