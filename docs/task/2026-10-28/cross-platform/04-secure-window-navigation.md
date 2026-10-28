---
task_id: "4"
date: 2026-10-28
status: pending
owner: unassigned
depends_on: [2, 6]
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 4: 实现安全窗口与导航防护

**Files:**
- Create: `src/main/window/window-manager.ts`
- Create: `src/main/window/navigation-guard.ts`
- Create: `src/preload/config-preload.ts`
- Test: `tests/unit/window/navigation-guard.test.ts`
- Test: `tests/integration/window-manager.test.ts`

**Interfaces:**
- `WindowManager.createMainWindow(config: AppConfig): Promise<BrowserWindow>`
- `WindowManager.openConfigWindow(): BrowserWindow`
- `WindowManager.applyWindowPolicy(config: WindowConfig, capabilities: PlatformCapabilities): void`
- `installNavigationGuards(window: BrowserWindow, config: SecurityConfig): void`

- [ ] **Step 1: Write failing navigation tests**

  Cover allowed origin, unauthorized redirect, popup denial, external link policy, download policy, and permission denial.

- [ ] **Step 2: Implement secure window creation**

  Remote windows use `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Config windows use only the minimal preload.

- [ ] **Step 3: Write failing window policy tests**

  Cover normal/fullscreen/kiosk, close-to-hide, display selection, config-window reuse, and security settings on all window creations.

- [ ] **Step 4: Implement `WindowManager`**

  Apply platform capability results rather than assuming Windows behavior.

- [ ] **Step 5: Run window tests**

  Run: `npm test -- --run tests/unit/window tests/integration/window-manager.test.ts`

- [ ] **Step 6: Commit**

  `git add src/main/window src/preload tests && git commit -m "feat: add secure windows and navigation policy"`

