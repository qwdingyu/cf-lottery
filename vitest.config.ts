import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      // 管理端 ops-utils 等用 @/ 导入 composables；邮件状态单测需解析
      "@": fileURLToPath(new URL("./frontend/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    testTimeout: 30_000,
    fileParallelism: false,
    // 含前端 cf-auth 会话纯模块（参与闭环，不依赖 Vue 运行时）
    include: [
      "src/**/*.test.ts",
      "shared/**/*.test.ts",
      "frontend/src/composables/cf-auth-session.test.ts",
      // 业务登出清理（admin + 参与 + cf-auth 临时键）纯函数
      "frontend/src/composables/business-session.test.ts",
      // 管理端/参与端 OTP 输入规范化
      "frontend/src/composables/otp-input.test.ts",
      // 上线前列表/Onboarding UX 启发式
      "frontend/src/composables/admin-list-ux.test.ts",
      // 公开页 draft/paused CTA
      "frontend/src/composables/lottery-public-ux.test.ts",
      // docs/131：直付支付状态/金额/会话恢复纯函数
      "frontend/src/views/lottery/payment-ux.test.ts",
      // docs/136：秒杀商品化展示价格/CTA 纯函数
      "frontend/src/views/lottery/flash-sale-merchandising.test.ts",
      // docs/137：公开首页活动矩阵卡片映射
      "frontend/src/views/landing-activity-feed.test.ts",
      // 公开页体验氛围时长 / 主 CTA 文案 key（docs/095）
      "frontend/src/views/lottery/public-helpers.test.ts",
      // docs/096：体验别名与未知→Submit 回退
      "frontend/src/components/games/GameRegistry.test.ts",
      // docs/098：本机已参与提示 / 409 / result hint keys
      "frontend/src/views/lottery/joined-session.test.ts",
      // docs/082：管理台批量顺序写 + 进度
      "frontend/src/composables/useAdminBatchOperation.test.ts",
      // 中奖邮件状态与开奖反馈档
      "frontend/src/views/admin/lottery/ops-utils.email.test.ts",
      // docs/086 复查：批量选中/可见性/列表筛选空态
      "frontend/src/views/admin/lottery/ops-utils.bulk.test.ts",
      // docs/114：邀请排行榜 UI 决策（门禁/高亮/底栏/错误解析）
      "frontend/src/views/lottery/viral-leaderboard-ui.test.ts",
      // docs/114：管理端裂变回填与 promotionConfig 提交防擦
      "frontend/src/views/admin/lottery/growth-config.test.ts",
      // docs/134/137：直付秒杀发布清单，避免商品/价格/码池路径继续断裂
      "frontend/src/views/admin/lottery/flash-sale-readiness.test.ts",
      // docs/115：drawAt ↔ drawTrigger 推断（定时开奖接线）
      "frontend/src/lib/activity-defaults.test.ts",
      "frontend/src/views/admin/lottery/ops-utils.schedule.test.ts",
      // docs/120/121：instant 弱会话 OTP / 主 CTA / 客户端 spin 门禁
      "frontend/src/views/lottery/instant-spin-ux.test.ts",
      // docs/121：管理端列表即时标签与「立即开奖」互斥
      "frontend/src/views/admin/lottery/ops-utils.instant-list.test.ts",
      // docs/115 skeptic：裂变 i18n 加权票诚实性
      "frontend/src/i18n/viral-copy-honesty.test.ts",
      // docs/128：delayed 仪式壳 / instant 真奖上壳
      "frontend/src/views/lottery/prize-shell-display.test.ts",
      // docs/145 P2：模板差异字段可见性白名单（此前漏登记，从未被执行）
      "frontend/src/views/admin/lottery/template-field-visibility.test.ts",
      // 平台路由门禁 fail-closed 纯函数（此前漏登记，从未被执行）
      "frontend/src/composables/platform-access.test.ts",
      // docs/162：模板文案 i18n 兜底 / 参数 chips
      "frontend/src/views/admin/lottery/template-i18n.test.ts",
      // docs/162 P2-2：canvas dpr 截断适配
      "frontend/src/components/games/canvas-utils.test.ts",
      // docs/162 P2-4：body 滚动锁定多弹窗计数器
      "frontend/src/composables/body-scroll-lock.test.ts",
    ],
    // 允许 vitest 从兄弟仓库 cf-auth 加载 createTestApp（OAuth 闭环）
    server: {
      deps: {
        inline: ["better-auth", "@better-auth/oauth-provider"],
      },
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/db/schema.ts",
        "src/db/client.ts",
        "src/bindings.ts",
        "src/index.ts",
      ],
    },
  },
});
