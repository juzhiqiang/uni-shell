---
task_id: "8"
date: 2026-10-28
status: deprecated
plan: ../../../superpowers/plans/2026-10-28-electron-shell.md
spec: ../../../electron-desktop-shell-product-spec-v2.0.md
---

### Task 8: 日志、诊断和错误恢复

**Files:**
- Create: `src/main/logging/logger.ts`
- Modify: `src/main/app-controller.ts`
- Modify: `src/main/config/config-store.ts`
- Test: `tests/unit/logging/logger.test.ts`
- Test: `tests/integration/recovery-flow.test.ts`

**Interfaces:**
- `createLogger(options: LoggerOptions): Logger`。
- `Logger.info(event: string, data?: unknown): void`。
- `Logger.warn(event: string, data?: unknown): void`。
- `Logger.error(event: string, error: unknown, data?: unknown): void`。
- `Logger.close(): Promise<void>`。

- [ ] **Step 1: Write failing logger tests**

  覆盖日志级别、14 天保留策略、Token/Cookie/密码脱敏、配置路径和加载错误记录。

- [ ] **Step 2: Run logger tests to verify failure**

  Run: `npm test -- --run tests/unit/logging/logger.test.ts`

  Expected: FAIL because logger is not implemented.

- [ ] **Step 3: Implement logger**

  日志写入 `%LOCALAPPDATA%\\Vendor\\App\\logs`；日志格式包含时间、版本、启动来源、事件名和脱敏数据。

- [ ] **Step 4: Write recovery integration tests**

  覆盖配置损坏后进入编辑、页面加载失败后重试、退出时清理定时器和日志资源。

- [ ] **Step 5: Wire diagnostics into app lifecycle**

  在配置读取、代理应用、窗口策略、启动项、单实例和页面加载关键路径记录结构化事件。

- [ ] **Step 6: Run tests**

  Run: `npm test -- --run tests/unit/logging tests/integration/recovery-flow.test.ts`

  Expected: PASS。

- [ ] **Step 7: Commit**

  `git add src/main/logging src/main/app-controller.ts src/main/config tests && git commit -m "feat: add diagnostic logging and recovery"`


