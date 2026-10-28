---
task_id: "1"
date: 2026-10-28
status: deprecated
plan: ../../../superpowers/plans/2026-10-28-electron-shell.md
spec: ../../../electron-desktop-shell-product-spec-v2.0.md
---

### Task 1: 初始化 Electron + TypeScript 工程

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `src/main.ts`
- Create: `src/renderer/config/index.html`
- Create: `src/renderer/config/main.tsx`
- Create: `tests/smoke/project.test.ts`

**Interfaces:**
- Produces npm scripts: `dev`, `typecheck`, `test`, `lint`, `build:dir`, `build:win`。
- Produces an Electron entry that starts without a configured target URL and opens the local configuration window。

- [ ] **Step 1: Write the failing smoke test**

  在 `tests/smoke/project.test.ts` 验证 `package.json` 包含 `dev`、`typecheck`、`test`、`build:win` 脚本，且 `src/main.ts` 与配置页面入口存在。

- [ ] **Step 2: Run the smoke test to verify it fails**

  Run: `npm test -- --run tests/smoke/project.test.ts`

  Expected: FAIL because the project files and scripts do not yet exist.

- [ ] **Step 3: Implement the minimal project scaffold**

  锁定 Electron、TypeScript、Vite、React、Zod、Vitest 和 electron-builder 的版本；实现最小主进程入口和配置页面占位入口。主进程不得直接加载远程 URL。

- [ ] **Step 4: Run checks**

  Run: `npm run typecheck` and `npm test -- --run tests/smoke/project.test.ts`

  Expected: typecheck passes and the smoke test passes。

- [ ] **Step 5: Commit**

  `git add package.json tsconfig.json tsconfig.node.json vite.config.ts src tests && git commit -m "build: initialize electron typescript shell"`


