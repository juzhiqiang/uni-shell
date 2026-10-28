---
task_id: "8"
date: 2026-10-28
status: pending
owner: unassigned
depends_on: [4, 7]
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 8: 完成本地配置界面与受控保存

**Files:**
- Create: `src/renderer/config/App.tsx`
- Create: `src/renderer/config/styles.css`
- Modify: `src/renderer/config/main.tsx`
- Modify: `src/preload/config-preload.ts`
- Test: `tests/unit/config/config-form.test.tsx`

**Interfaces:**
- `window.uniShell.getConfig(): Promise<AppConfig>`
- `window.uniShell.validateConfig(input: unknown): Promise<ValidationResult<AppConfig>>`
- `window.uniShell.saveConfig(input: unknown): Promise<SaveResult>`
- `window.uniShell.resetConfig(): Promise<AppConfig>`
- `window.uniShell.testConnection(url: string, network: NetworkConfig): Promise<ConnectionResult>`

- [ ] **Step 1: Write failing form tests**

  Cover loading, URL validation, proxy conditional fields, delay range, defaults, unsaved-close protection, save errors, and actual config path display.

- [ ] **Step 2: Implement minimal preload bridge**

  Expose only the five methods above.

- [ ] **Step 3: Implement React form**

  Group fields by target URL, window, network, startup, maintenance, security, and logging.

- [ ] **Step 4: Implement controlled save/restart**

  Validate, atomically save, log, close stale windows, and restart only after a successful write.

- [ ] **Step 5: Run form tests**

  Run: `npm test -- --run tests/unit/config/config-form.test.tsx`

- [ ] **Step 6: Commit**

  `git add src/renderer/config src/preload tests/unit/config && git commit -m "feat: add local configuration UI"`

