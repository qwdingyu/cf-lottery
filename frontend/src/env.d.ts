/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare global {
  interface Window {
    Telegram?: {
      WebApp: unknown
    }
    turnstile?: {
      render: (container: string | HTMLElement, options?: { sitekey: string; callback?: (token: string) => void; 'error-callback'?: () => void }) => number
      getResponse: (widgetId?: number) => string | null
      reset: (widgetId?: number) => void
    }
  }
}

declare module 'vue' {
  interface ComponentCustomProperties {
    $t: (key: string, params?: Record<string, unknown>) => string
  }
}

export {}
