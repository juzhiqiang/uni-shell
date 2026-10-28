---
task_id: "9"
date: 2026-10-28
status: pending
owner: unassigned
depends_on: [8]
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 9: 实现日志、诊断与恢复

**Files:**
- Create: `src/main/logging/logger.ts`
- Modify: `src/main/app-controller.ts`
- Test: `tests/unit/logging/logger.test.ts`
- Test: `tests/integration/recovery-flow.test.ts`

**Interfaces:**
- `createLogger(options: LoggerOptions): Logger`
- `Logger.info/warn/error(event: string, data?: unknown): void`
- `Logger.close(): Promise<void>`

- [ ] **Step 1: Write failing logger tests**

  Cover platform log directories, 14-day retention, structured events, sensitive-field redaction, and shutdown flushing.

- [ ] **Step 2: Implement logger**

  Use app-specific directories on Windows, XDG state on Linux, and `~/Library/Logs` on macOS.

- [ ] **Step 3: Write failing recovery tests**

  Cover invalid config recovery, network recovery, proxy change, sleep/wake diagnostics, and timer cleanup.

- [ ] **Step 4: Wire diagnostics**

  Log startup source, platform capabilities, config path, proxy mode, page load, retry, window policy, tray degradation, and save result.

- [ ] **Step 5: Run logging tests**

  Run: `npm test -- --run tests/unit/logging tests/integration/recovery-flow.test.ts`

- [ ] **Step 6: Commit**

  `git add src/main/logging src/main/app-controller.ts tests && git commit -m "feat: add cross-platform diagnostics"`

