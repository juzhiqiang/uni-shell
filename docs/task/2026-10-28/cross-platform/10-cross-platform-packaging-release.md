---
task_id: "10"
date: 2026-10-28
status: pending
owner: unassigned
depends_on: [1, 2, 3, 4, 5, 6, 7, 8, 9]
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 10: 实现三平台打包、签名与发布验证

**Files:**
- Create: `electron-builder/windows.yml`
- Create: `electron-builder/mac.yml`
- Create: `electron-builder/linux.yml`
- Create: `build/installer.nsh`
- Create: `scripts/verify-release.ts`
- Create: `tests/manual/release-checklist.md`
- Modify: `package.json`

**Interfaces:**
- `npm run build:win` produces NSIS `.exe` and ZIP.
- `npm run build:mac` produces Universal DMG and ZIP.
- `npm run build:linux` produces DEB and AppImage.
- `npm run verify:release` validates artifacts, config placement, metadata, and SHA-256.

- [ ] **Step 1: Write failing release verification**

  Assert expected platform artifacts, config template placement, architecture metadata, checksums, and no config overwrite behavior declarations.

- [ ] **Step 2: Implement Windows packaging**

  Use current-user assisted NSIS with custom directory and ZIP output; never default to `C:\Program Files`.

- [ ] **Step 3: Implement macOS packaging**

  Build Universal DMG and ZIP; require Developer ID signing and notarization inputs from CI secrets.

- [ ] **Step 4: Implement Linux packaging**

  Build DEB and AppImage; ensure AppImage can read a sibling `config.json`.

- [ ] **Step 5: Implement release verification**

  Generate `release-manifest.json` with artifact names, platforms, architectures, SHA-256, and signing status.

- [ ] **Step 6: Run package verification**

  Run each available platform build followed by `npm run verify:release`; unavailable platform builds must be recorded as CI blockers, not marked passed.

- [ ] **Step 7: Commit**

  `git add electron-builder build scripts tests/manual package.json && git commit -m "build: add cross-platform release artifacts"`

