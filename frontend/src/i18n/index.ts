/**
 * vue-i18n 初始化
 *
 * 语言检测策略：
 * 1. localStorage 用户偏好
 * 2. navigator.language 浏览器语言
 * 3. 回退 zh-CN
 */
import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN";
import en from "./en";

function detectBrowserLanguage(): string {
  try {
    const saved = localStorage.getItem("lottery_lang");
    if (saved === "zh-CN" || saved === "en") return saved;
  } catch {
    /* ignore */
  }
  try {
    const lang = navigator.language || "zh-CN";
    if (lang.startsWith("zh")) return "zh-CN";
    if (lang.startsWith("en")) return "en";
  } catch {
    /* ignore */
  }
  return "zh-CN";
}

const initialLocale = detectBrowserLanguage() as "zh-CN" | "en";

const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: "zh-CN",
  messages: { "zh-CN": zhCN, en },
});

export default i18n;

export function switchLanguage(lang: "zh-CN" | "en"): void {
  i18n.global.locale.value = lang;
  try {
    localStorage.setItem("lottery_lang", lang);
  } catch {
    /* ignore */
  }
}