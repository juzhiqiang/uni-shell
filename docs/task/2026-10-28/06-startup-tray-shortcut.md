---
task_id: "6"
date: 2026-10-28
status: deprecated
plan: ../../../superpowers/plans/2026-10-28-electron-shell.md
spec: ../../../electron-desktop-shell-product-spec-v2.0.md
---

### Task 6: 实现启动策略、托盘和焦点快捷键

**Files:**
- Create: `src/main/startup/startup-manager.ts`
- Create: `src/main/tray/tray-manager.ts`
- Modify: `src/main/app-controller.ts`
- Test: `tests/unit/startup/startup-manager.test.ts`
- Test: `tests/unit/tray/tray-manager.test.ts`
- Test: `tests/integration/startup-flow.test.ts`

**Interfaces:**
- `detectLaunchContext(argv: string[]): 'manual' | 'login'`。
- `setOpenAtLogin(enabled: boolean): void`。
- `runDelay(config: StartupConfig, context: LaunchContext, onReady: () => void): CancelableTimer`。
- `createTray(actions: TrayActions): Tray`。
- `installFocusedShortcut(window: BrowserWindow, binding: string, onInvoke: () => void): void`。

- [ ] **Step 1: Write failing startup tests**

  覆盖：手动启动与开机启动区分、`delayOnlyOnLogin`、0～3600 秒范围、立即显示取消倒计时、取消后不触发回调。

- [ ] **Step 2: Run startup tests to verify failure**

  Run: `npm test -- --run tests/unit/startup/startup-manager.test.ts`

  Expected: FAIL because startup manager is not implemented.

- [ ] **Step 3: Implement startup manager**

  使用 Electron 登录项 API 注册当前用户启动项；通过明确启动参数识别登录启动；延迟逻辑返回可取消 timer。

- [ ] **Step 4: Write failing tray and shortcut tests**

  覆盖固定四项托盘菜单、显示/隐藏/重载/退出动作、快捷键只在窗口焦点事件中触发、关闭快捷键后不再监听。

- [ ] **Step 5: Implement tray and focused shortcut**

  不使用系统全局快捷键；托盘模式下配置入口由托盘菜单提供；第二次启动和“立即显示”调用同一个 `showAndFocus()`。

- [ ] **Step 6: Write startup flow integration tests**

  覆盖合法配置 + 托盘 + 10 秒延迟、合法配置 + 最小化、延迟 0、第二次启动取消倒计时。

- [ ] **Step 7: Run tests**

  Run: `npm test -- --run tests/unit/startup tests/unit/tray tests/integration/startup-flow.test.ts`

  Expected: PASS。

- [ ] **Step 8: Commit**

  `git add src/main/startup src/main/tray src/main/app-controller.ts tests && git commit -m "feat: add startup tray and maintenance controls"`


