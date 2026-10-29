---
task_id: "10"
date: 2026-10-28
status: in_progress
owner: Codex
depends_on: [1, 2, 3, 4, 5, 6, 7, 8, 9]
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 10: 实现三平台打包、签名与发布验证

用户于 2026-10-28 明确授权任务 10 在任务 9 完成前提前启动。任务 9 已于提交 `477c4e8` 完成；任务 10 当前依赖已满足，本任务按既有接口实现打包。

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

- [x] **Step 1: Write failing release verification**

  Assert expected platform artifacts, config template placement, architecture metadata, checksums, and no config overwrite behavior declarations.

- [x] **Step 2: Implement Windows packaging**

  Use current-user assisted NSIS with custom directory and ZIP output; never default to `C:\Program Files`.

- [ ] **Step 3: Implement macOS packaging**

  Build Universal DMG and ZIP; require Developer ID signing and notarization inputs from CI secrets.

- [ ] **Step 4: Implement Linux packaging**

  Build DEB and AppImage; ensure AppImage can read a sibling `config.json`.

- [x] **Step 5: Implement release verification**

  Generate `release-manifest.json` with artifact names, platforms, architectures, SHA-256, and signing status.

- [ ] **Step 6: Run package verification**

  Run each available platform build followed by `npm run verify:release`; unavailable platform builds must be recorded as CI blockers, not marked passed.

- [x] **Step 7: Commit task 10 implementation and current validation record**

  Commit message: `build: 增加跨平台发布产物与验证`

### 执行记录

- 提前启动授权：用户于 2026-10-28 明确允许任务 10 在任务 9 完成前启动；任务 9 后于提交 `477c4e8` 完成。
- `npm test -- --run tests/unit/release/verify-release.test.ts`：实现前按预期因验证器缺失失败；实现后 6 项通过，覆盖必需产物、架构、SHA-256、模板 JSON、嵌入模板、签名公证门槛、配置保留声明和不修改活跃配置。
- `npx tsc --noEmit -p tsconfig.node.json`：通过。
- `npx eslint scripts tests/unit/release`：通过。
- `npx electron-builder --config electron-builder/windows.yml --win --config.directories.output=release/windows-validation2`：通过；实际生成 `UniShell-0.1.0-x64.exe` 与 `UniShell-0.1.0-x64.zip`，NSIS 当前用户安装模式和目录选择宏成功编译。无 `CSC_LINK`/`CSC_NAME`，该构建未签名。
- `node scripts/verify-release.ts --platform=windows --release-dir=release/final-output`：通过；验证 2 项真实产物及嵌入配置模板，清单 SHA-256：EXE `f619764f0b708ae3fe217d01b1f0b1b5756ddf486c8fbd273195e5fa82017a95`，ZIP `29656624a5abf42f51fa51e3801d258c1e7976dac3703d3882f4ee6bf45d810c`。该部分清单位于被忽略的 `release/final-output/release-manifest.json`。
- `npm run build:win`：首次使用默认输出目录失败，Windows 返回 `EPERM/EBUSY`，无法替换既有 `win-unpacked` 暂存目录；在新的隔离输出目录重跑通过。
- `npm run build:mac`：构建入口在签名阶段前按预期阻止；当前宿主不是 macOS，且未提供 Developer ID 与 notarization 凭据。
- `npm run build:linux`：显式 Linux 构建遇到 Windows 不支持 AppImage 符号链接的 `EPERM`。单独 DEB 构建因 Windows 主机缺少 `fpm` 报 `ENOENT`；正式构建需 Linux runner。Linux DEB 维护者信息由 CI 环境变量 `UNI_SHELL_LINUX_MAINTAINER` 注入。
- `npm run verify:release`：typecheck 与 lint 通过；全量测试为 432 通过、2 失败（`tests/integration/window-manager.test.ts` 两项 POSIX `/app/...` 路径断言在 Windows 上得到反斜杠路径）。
- 复核（2026-10-29，Windows）：`npm test -- --run tests/unit/release/verify-release.test.ts` 6 项通过；`npm run typecheck`、`npm run lint` 通过；`npm test` 仍为 432 项通过、2 项因上述 Windows 路径断言失败。
- 任务状态保持 `in_progress`：macOS 和 Linux 产物、macOS 签名/公证及三平台汇总清单尚未在对应 runner 验证；上述阻塞不标记为通过。
