import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
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
