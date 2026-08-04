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
      // 公开页体验氛围时长 / 主 CTA 文案 key（docs/095）
      "frontend/src/views/lottery/public-helpers.test.ts",
      // docs/082：管理台批量顺序写 + 进度
      "frontend/src/composables/useAdminBatchOperation.test.ts",
      // 中奖邮件状态与开奖反馈档
      "frontend/src/views/admin/lottery/ops-utils.email.test.ts",
      // docs/086 复查：批量选中/可见性/列表筛选空态
      "frontend/src/views/admin/lottery/ops-utils.bulk.test.ts",
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
