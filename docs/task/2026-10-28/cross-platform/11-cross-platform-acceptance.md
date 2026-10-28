---
task_id: "11"
date: 2026-10-28
status: pending
owner: unassigned
depends_on: [10]
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 11: 三平台实机验收与发布基线

**Files:**
- Create: `tests/manual/cross-platform-acceptance.md`
- Create: `docs/release/2026-10-28-v1.0-acceptance-report.md`
- Create: `docs/release/release-manifest.json`

**Interfaces:**
- The release report records product version, Electron version, OS build, architecture, desktop environment, artifact SHA-256, test result, and remaining P0/P1 issues.

- [ ] **Step 1: Prepare systems**

  Use Windows 10/11, macOS 13+ on supported architectures, Ubuntu 22.04/24.04 GNOME X11, and Ubuntu GNOME Wayland.

- [ ] **Step 2: Execute common acceptance**

  Validate preconfigured startup, invalid config flow, save/restart, offline recovery, proxy switch, single instance, delay, tray, and security boundaries.

- [ ] **Step 3: Execute platform acceptance**

  Validate Windows NSIS/ZIP and taskbar behavior; macOS signing/notarization/menu bar/login item; Linux DEB/AppImage/XDG autostart/tray degradation.

- [ ] **Step 4: Execute upgrade acceptance**

  Upgrade each installer while retaining existing user configuration and verify path migration/backup behavior.

- [ ] **Step 5: Record release baseline**

  Publish the report only when all P0 issues are closed and all required platform artifacts pass verification.

- [ ] **Step 6: Commit**

  `git add tests/manual docs/release && git commit -m "release: record cross-platform acceptance baseline"`

