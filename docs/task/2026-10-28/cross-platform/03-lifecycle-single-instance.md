---
task_id: "3"
date: 2026-10-28
status: pending
owner: unassigned
depends_on: [2]
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 3: 实现应用生命周期与单实例

**Files:**
- Create: `src/main/app-controller.ts`
- Create: `src/main/instance/single-instance.ts`
- Modify: `src/main.ts`
- Test: `tests/unit/instance/single-instance.test.ts`
- Test: `tests/integration/app-controller.test.ts`

**Interfaces:**
- `acquireSingleInstance(onSecondLaunch: (payload: SecondLaunchPayload) => void): boolean`
- `AppController.start(options: StartOptions): Promise<void>`
- `AppController.handleSecondLaunch(payload: SecondLaunchPayload): Promise<void>`
- `AppController.showAndFocusMain(): Promise<void>`
- `AppController.shutdown(): Promise<void>`

- [ ] **Step 1: Write failing single-instance tests**

  Cover first launch, second launch forwarding, tray-hidden wake, countdown cancel, and config-window focus reuse.

- [ ] **Step 2: Implement single-instance adapter**

  Acquire the lock before app readiness and forward launch arguments to the existing instance.

- [ ] **Step 3: Write failing lifecycle tests**

  Cover invalid config, valid config, startup source parsing, delayed state, and resource cleanup on shutdown.

- [ ] **Step 4: Implement `AppController`**

  Keep orchestration separate from config, network, window, tray, and platform implementation details.

- [ ] **Step 5: Run lifecycle tests**

  Run: `npm test -- --run tests/unit/instance tests/integration/app-controller.test.ts`

- [ ] **Step 6: Commit**

  `git add src/main.ts src/main/app-controller.ts src/main/instance tests && git commit -m "feat: add lifecycle and single instance"`

