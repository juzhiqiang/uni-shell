---
task_id: "6"
date: 2026-10-28
status: pending
owner: unassigned
depends_on: [1]
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 6: 实现平台能力探测与降级策略

**Files:**
- Create: `src/main/platform/platform-adapter.ts`
- Create: `src/main/platform/capability-detector.ts`
- Test: `tests/unit/platform/capability-detector.test.ts`
- Test: `tests/integration/platform-capabilities.test.ts`

**Interfaces:**
- `type PlatformCapabilities = { tray: TraySupport; alwaysOnTop: AlwaysOnTopSupport; fullscreen: FullscreenSupport; kiosk: KioskSupport; loginItem: LoginItemSupport; displaySelection: DisplaySupport; wayland: boolean }`
- `detectPlatformCapabilities(): Promise<PlatformCapabilities>`
- `mapAlwaysOnTopLevel(level: AlwaysOnTopLevel, capabilities: PlatformCapabilities): MappedWindowLevel`

- [ ] **Step 1: Write failing capability tests**

  Cover Windows, macOS, Linux X11, Linux Wayland, no tray protocol, unavailable display, and unsupported top levels.

- [ ] **Step 2: Implement capability detection**

  Detect OS version, architecture, desktop session, tray protocol, display count, and window-manager limitations without crashing.

- [ ] **Step 3: Write failing level mapping tests**

  Cover Electron level mapping and documented graceful degradation on macOS and Linux.

- [ ] **Step 4: Implement platform adapter and mappings**

  Never promise taskbar/Dock coverage outside the platform-specific v2.1 rules.

- [ ] **Step 5: Run platform tests**

  Run: `npm test -- --run tests/unit/platform tests/integration/platform-capabilities.test.ts`

- [ ] **Step 6: Commit**

  `git add src/main/platform tests && git commit -m "feat: add platform capability adapter"`

