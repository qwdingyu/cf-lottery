# esbuild-kit 版本冲突导致 npm ci --omit=dev 失败

## 背景

VPS 部署执行 `npm ci --omit=dev` 时，`@esbuild-kit/core-utils` 的 postinstall 脚本报错：

```
Expected "0.18.20" but got "0.25.12"
```

导致安装过程非零退出，但服务实际仍能正常运行（`dist/server.js` 是预编译产物，运行时不需要 esbuild）。

## 原因

`tsx`（纯 TypeScript 运行时）被错误地放在 `dependencies`（生产依赖）中。`tsx` 依赖 `esbuild@0.25.12`，而 `@esbuild-kit/core-utils`（`drizzle-kit` 的传递依赖）期望嵌套安装 `esbuild@0.18.20`。两者版本冲突导致 postinstall 校验失败。

关键事实：
- `tsx` 在 `src/` 中**零 import**——仅用于 `dev:local`（tsx src/server.ts）和 `benchmark:hono`
- 生产构建使用 `npx esbuild` 直接编译 TypeScript，不经过 `tsx`
- `tsx` 作为生产依赖是多余的

## 排查过程

1. **错误现象**：VPS `npm ci --omit=dev` 报 esbuild 版本不匹配
2. **依赖追踪**：`npm ls tsx --omit=dev` 显示 tsx 通过 `better-auth → drizzle-kit → tsx` 链路被引入
3. **根因确认**：`tsx` 在 package.json 的 `dependencies` 中，`npm ci --omit=dev` 仍会安装它
4. **lock 文件分析**：VPS 的 package-lock.json 包含三层 esbuild（0.18.20 / 0.25.12 / 0.28.1），但实际都未安装
5. **验证**：将 `tsx` 移到 `devDependencies` 后，重新生成 lock 文件，`npm ci --omit=dev` 成功（EXIT:0）

## 解决方案

将 `tsx` 从 `dependencies` 移到 `devDependencies`。

**修改前**：
```json
{
  "dependencies": {
    "tsx": "^4.23.5",
    ...
  }
}
```

**修改后**：
```json
{
  "dependencies": {
    // tsx 已移除
  },
  "devDependencies": {
    "tsx": "^4.23.5",
    ...
  }
}
```

同时需要删除 `package-lock.json` 并重新 `npm install` 以清理残留的 `@esbuild-kit/core-utils` 和 `@esbuild-kit/esm-loader` extraneous 条目。

## 建议

1. **依赖分类审查**：定期检查 `dependencies` 中是否有仅用于开发的包（如 tsx、ts-node、nodemon），确保生产依赖最小化
2. **更好的实践**：构建脚本（build-for-vps.sh）应明确声明其使用的工具链（esbuild）版本，避免隐式依赖冲突
3. **VPS 部署验证**：部署后检查 `npm ci --omit=dev` 的退出码，非零退出码意味着依赖安装有问题，即使服务仍能运行
4. **better-auth 依赖声明**：better-auth 将 `drizzle-kit` 和 `vitest` 声明为 peerDependencies，导致 npm 自动将其提升为生产依赖。这是 better-auth 的设计问题，当前不影响功能但增加了生产依赖体积
