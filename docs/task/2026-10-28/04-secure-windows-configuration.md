---
task_id: "4"
date: 2026-10-28
status: deprecated
plan: ../../../superpowers/plans/2026-10-28-electron-shell.md
spec: ../../../electron-desktop-shell-product-spec-v2.0.md
---

### Task 4: 实现窗口、远程页面安全和配置窗口

**Files:**
- Create: `src/main/window/window-manager.ts`
- Create: `src/main/window/navigation-guard.ts`
- Create: `src/preload/config-preload.ts`
- Modify: `src/renderer/config/index.html`
- Test: `tests/unit/window/navigation-guard.test.ts`
- Test: `tests/integration/window-manager.test.ts`

**Interfaces:**
- `WindowManager.createMainWindow(config: AppConfig): BrowserWindow`。
- `WindowManager.openConfigWindow(): BrowserWindow`。
- `WindowManager.showAndFocus(): void`。
- `WindowManager.hide(): void`。
- `WindowManager.reload(): void`。
- `WindowManager.applyWindowPolicy(config: WindowConfig): void`。
- `installNavigationGuards(window: BrowserWindow, security: SecurityConfig): void`。

- [ ] **Step 1: Write failing navigation security tests**

  覆盖：允许目标源、阻止未授权重定向、默认阻止新窗口、外部链接按配置交给系统浏览器、权限请求默认拒绝。

- [ ] **Step 2: Run security tests to verify failure**

  Run: `npm test -- --run tests/unit/window/navigation-guard.test.ts`

  Expected: FAIL because navigation guard functions are absent.

- [ ] **Step 3: Implement secure window creation**

  远程业务窗口关闭 Node 集成并启用上下文隔离、沙箱；配置窗口使用最小权限 preload；所有 IPC channel 显式白名单。

- [ ] **Step 4: Write failing window policy tests**

  覆盖 `window`、`fullscreen`、`kiosk`、置顶层级、`primary` 显示器、关闭按钮 `hide` 行为和配置窗口复用。

- [ ] **Step 5: Implement `WindowManager`**

  主窗口只负责远程页面，配置窗口只负责本地界面；窗口策略应用集中在 `applyWindowPolicy`，便于保存配置后受控重启和真实 Windows 验收。

- [ ] **Step 6: Run tests**

  Run: `npm test -- --run tests/unit/window tests/integration/window-manager.test.ts`

  Expected: PASS。

- [ ] **Step 7: Commit**

  `git add src/main/window src/preload src/renderer/config tests && git commit -m "feat: add secure windows and navigation policy"`


