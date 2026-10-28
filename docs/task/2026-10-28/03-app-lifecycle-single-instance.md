---
task_id: "3"
date: 2026-10-28
status: deprecated
plan: ../../../superpowers/plans/2026-10-28-electron-shell.md
spec: ../../../electron-desktop-shell-product-spec-v2.0.md
---

### Task 3: 实现主进程生命周期和单实例

**Files:**
- Create: `src/main/app-controller.ts`
- Create: `src/main/instance/single-instance.ts`
- Modify: `src/main.ts`
- Test: `tests/unit/instance/single-instance.test.ts`
- Test: `tests/integration/app-controller.test.ts`

**Interfaces:**
- `acquireSingleInstance(onSecondLaunch): boolean`。
- `AppController.start(): Promise<void>`。
- `AppController.handleSecondLaunch(payload: SecondLaunchPayload): Promise<void>`。
- `AppController.shutdown(): Promise<void>`。

- [ ] **Step 1: Write failing single-instance tests**

  覆盖：首次启动获得锁、第二次启动不创建第二个实例、第二次启动向已有实例发送唤醒消息。

- [ ] **Step 2: Run tests to verify failure**

  Run: `npm test -- --run tests/unit/instance/single-instance.test.ts`

  Expected: FAIL because the single-instance adapter is missing.

- [ ] **Step 3: Implement single-instance adapter**

  在 Electron ready 前获取单实例锁；第二次启动携带 `--startup` 或唤醒参数时转发给主实例，并由主实例统一处理。

- [ ] **Step 4: Write failing lifecycle integration tests**

  覆盖：配置读取失败打开配置窗口、合法配置进入启动策略、关闭应用时清理定时器和托盘资源。

- [ ] **Step 5: Implement `AppController`**

  只编排模块，不把配置读写、窗口细节和网络重试逻辑塞入单一入口文件。

- [ ] **Step 6: Run lifecycle tests**

  Run: `npm test -- --run tests/integration/app-controller.test.ts`

  Expected: PASS。

- [ ] **Step 7: Commit**

  `git add src/main.ts src/main/app-controller.ts src/main/instance tests && git commit -m "feat: add app lifecycle and single instance"`


