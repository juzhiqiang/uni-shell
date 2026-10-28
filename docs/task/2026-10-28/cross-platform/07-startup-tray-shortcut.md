---
task_id: "7"
date: 2026-10-28
status: pending
owner: unassigned
depends_on: [3, 4, 6]
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 7: 实现登录自启、托盘和焦点快捷键

**Files:**
- Create: `src/main/startup/startup-manager.ts`
- Create: `src/main/tray/tray-manager.ts`
- Modify: `src/main/app-controller.ts`
- Test: `tests/unit/startup/startup-manager.test.ts`
- Test: `tests/unit/tray/tray-manager.test.ts`
- Test: `tests/integration/startup-flow.test.ts`

**Interfaces:**
- `detectLaunchContext(argv: string[]): 'manual' | 'login'`
- `setOpenAtLogin(enabled: boolean): Promise<LoginItemResult>`
- `runStartupDelay(config: StartupConfig, context: LaunchContext, onReady: () => void): CancelableDelay`
- `createTray(actions: TrayActions, capabilities: PlatformCapabilities): TrayResult`
- `installFocusedShortcut(window: BrowserWindow, binding: string, onInvoke: () => void): void`

- [ ] **Step 1: Write failing startup tests**

  Cover launch context, `delayOnlyOnLogin`, 0～3600 range, manual wake cancellation, and timer cleanup.

- [ ] **Step 2: Implement platform login items**

  Windows uses current-user startup registration, macOS uses LaunchAgent/login-item APIs, and Linux writes XDG autostart.

- [ ] **Step 3: Write failing tray and shortcut tests**

  Cover the four fixed menu actions, Linux no-tray degradation, macOS menu bar, disabled config shortcut, and focus-only key handling.

- [ ] **Step 4: Implement tray and focused shortcut**

  Do not use a system-wide global shortcut.

- [ ] **Step 5: Run startup flow tests**

  Run: `npm test -- --run tests/unit/startup tests/unit/tray tests/integration/startup-flow.test.ts`

- [ ] **Step 6: Commit**

  `git add src/main/startup src/main/tray src/main/app-controller.ts tests && git commit -m "feat: add cross-platform startup tray and maintenance controls"`

