---
task_id: "1"
date: 2026-10-28
status: pending
owner: unassigned
depends_on: []
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 1: 初始化跨平台 Electron 工程

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `src/main.ts`
- Create: `src/renderer/config/index.html`
- Create: `src/renderer/config/main.tsx`
- Test: `tests/smoke/project.test.ts`

**Interfaces:**
- Produces scripts: `dev`, `typecheck`, `test`, `lint`, `build:dir`, `build:win`, `build:mac`, `build:linux`, `verify:release`.
- Produces an Electron entry that starts the local configuration window and never auto-loads a remote URL before validation.

- [ ] **Step 1: Write the failing project smoke test**

  Assert that all cross-platform scripts, source entry files, and renderer entry files exist, and that the Electron version is pinned.

- [ ] **Step 2: Verify the test fails**

  Run: `npm test -- --run tests/smoke/project.test.ts`

- [ ] **Step 3: Implement the minimal scaffold**

  Lock dependency versions. Keep remote content disabled in this task; only the local config page is allowed.

- [ ] **Step 4: Run checks**

  Run: `npm run typecheck` and `npm test -- --run tests/smoke/project.test.ts`

- [ ] **Step 5: Commit**

  `git add package.json tsconfig*.json vite.config.ts src tests && git commit -m "build: initialize cross-platform electron shell"`

