# Electron 跨平台通用桌面客户端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建同时支持 Windows、Linux 和 macOS 的可配置 Electron Web 外壳客户端。

**Architecture:** 使用 Electron 主进程承载统一应用状态机，并通过平台适配层处理配置路径、开机自启、托盘、窗口层级、桌面环境和打包差异。远程业务页面与本地配置页面彻底隔离：远程页面禁用 Node 能力，配置页面仅通过白名单 preload IPC 访问主进程。配置、状态机、网络重试和平台能力探测优先实现为可测试的纯 TypeScript 模块，再接入 Electron API。

**Tech Stack:** Electron、TypeScript、React + Vite、Zod、Vitest、electron-builder、NSIS、DEB、AppImage、DMG。

**Spec:** `docs/electron-desktop-shell-product-spec-v2.1-cross-platform.md`

## Task Tracking

This plan is the active cross-platform baseline. Dated execution tasks are tracked under `docs/task/2026-10-28/cross-platform/`. Each task records its owner and dependencies. Up to four tasks may run concurrently only when dependencies are complete, file ownership is disjoint, and shared interfaces are agreed. Update the matching task file and status without rewriting this baseline plan.

## Global Constraints

- 支持矩阵：Windows 10 21H2+ x64、macOS 13+ x64/arm64/Universal、Ubuntu 22.04+ x64；Linux 额外兼容 Debian 12。
- Linux 必测 GNOME X11 和 GNOME Wayland；其他发行版和桌面环境为尽力支持。
- 三个平台使用同一 `AppConfig` JSON 结构和 `schemaVersion`。
- 配置解析顺序：`--config-dir`、`UNI_SHELL_CONFIG_DIR`、平台便携路径、平台用户配置目录。
- Windows 配置便携路径为可执行文件同级；Linux AppImage 为 `$APPIMAGE` 同级；macOS ZIP 为 `.app` 同级且目录可写。
- 标准安装场景必须使用用户可写配置路径，禁止向 `.app`、AppImage 挂载目录或系统保护目录写入配置。
- 配置写入必须校验、临时文件写入、原子替换并保留备份。
- 远程网页必须关闭 Node 集成，启用上下文隔离和沙箱。
- preload 只暴露显式白名单 IPC，不向远程页面暴露文件系统、Shell、Node 或任意 IPC。
- 配置快捷键只在当前客户端窗口获得焦点时生效，不得注册系统全局快捷键。
- Windows 交付 NSIS 当前用户安装包和 ZIP；macOS 交付签名公证 DMG 和 ZIP；Linux 交付 DEB 和 AppImage。
- 三平台升级均不得覆盖用户配置。
- 本期不实现独立反向代理服务器和自动更新服务。

## Review Focus

- 三平台配置主路径不可写或只读时，必须明确降级到用户路径或给出可恢复错误；由 Task 2 覆盖。
- Linux Wayland、macOS 系统窗口和 Windows 安全桌面下置顶能力不同，必须探测、映射、降级并记录日志；由 Task 6 覆盖。
- 托盘协议缺失、Linux 桌面环境变化和 macOS 菜单栏不可用时不能崩溃；由 Task 7 覆盖。
- 第二次启动、延迟倒计时、托盘隐藏和配置窗口聚焦必须共享同一唤醒状态机；由 Task 3 覆盖。
- 远程页面导航、弹窗、下载、外部链接和权限请求不得绕过安全配置；由 Task 4 覆盖。
- 断网、恢复、DNS、TLS、HTTP 错误和代理切换后不得泄漏重试定时器；由 Task 5 覆盖。
- 三平台构建产物、签名要求和配置保留规则不同，发布验证必须逐平台检查；由 Task 10 覆盖。

## Planned File Map

### Shared Core

- `src/main.ts`：Electron 主进程入口。
- `src/main/app-controller.ts`：统一启动状态机和模块编排。
- `src/main/config/config-types.ts`：跨平台配置类型。
- `src/main/config/config-schema.ts`：Zod schema、默认值和迁移。
- `src/main/config/config-store.ts`：配置读写、备份和原子替换。
- `src/main/instance/single-instance.ts`：单实例锁和唤醒消息。
- `src/main/window/window-manager.ts`：主窗口、配置窗口和窗口策略。
- `src/main/window/navigation-guard.ts`：导航、弹窗、权限和下载策略。
- `src/main/network/proxy-manager.ts`：代理模式应用。
- `src/main/network/retry-controller.ts`：离线页和重试状态。
- `src/main/logging/logger.ts`：日志、脱敏和保留策略。
- `src/preload/config-preload.ts`：配置界面白名单 IPC。

### Platform Adapter

- `src/main/platform/platform-adapter.ts`：平台适配接口。
- `src/main/platform/capability-detector.ts`：操作系统、桌面环境、显示器和窗口能力探测。
- `src/main/platform/config-paths.ts`：跨平台配置路径解析。
- `src/main/startup/startup-manager.ts`：登录自启和延迟状态。
- `src/main/tray/tray-manager.ts`：Windows 通知区域、macOS 菜单栏、Linux StatusNotifier 适配。

### Renderer

- `src/renderer/config/`：本地配置界面。
- `src/renderer/offline/offline.html`：本地离线页。

### Build and Test

- `electron-builder/*.yml`：Windows、macOS、Linux 打包配置。
- `resources/config.example.json`：默认配置模板。
- `tests/unit/`：纯逻辑单元测试。
- `tests/integration/`：主进程模块集成测试。
- `tests/manual/`：三平台实机验收文档。

---

### Task 1: 初始化跨平台 Electron 工程

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `src/main.ts`
- Create: `src/renderer/config/index.html`
- Create: `src/renderer/config/main.tsx`
- Test: `tests/smoke/project.test.ts`

**Interfaces:**
- Produces scripts: `dev`, `typecheck`, `test`, `lint`, `build:dir`, `build:win`, `build:mac`, `build:linux`, `verify:release`.
- Produces an Electron entry that starts the local configuration window and never auto-loads a remote URL before validation.

- [ ] **Step 1: Write the failing project smoke test**

  Assert that all cross-platform scripts, source entry files, and renderer entry files exist, and that the Electron version is pinned.

- [ ] **Step 2: Verify the test fails**

  Run: `npm test -- --run tests/smoke/project.test.ts`

- [ ] **Step 3: Implement the minimal scaffold**

  Lock dependency versions. Keep remote content disabled in this task; only the local config page is allowed.

- [ ] **Step 4: Run checks**

  Run: `npm run typecheck` and `npm test -- --run tests/smoke/project.test.ts`

- [ ] **Step 5: Commit**

  `git add package.json tsconfig*.json vite.config.ts src tests && git commit -m "build: initialize cross-platform electron shell"`

### Task 2: 实现配置模型与跨平台持久化

**Files:**
- Create: `src/main/config/config-types.ts`
- Create: `src/main/config/config-schema.ts`
- Create: `src/main/config/config-store.ts`
- Create: `src/main/platform/config-paths.ts`
- Create: `resources/config.example.json`
- Test: `tests/unit/config/config-schema.test.ts`
- Test: `tests/unit/config/config-store.test.ts`

**Interfaces:**
- `type AppConfig = ...` exactly matching v2.1 JSON.
- `validateConfig(input: unknown): ValidationResult<AppConfig>`
- `migrateConfig(input: unknown): AppConfig`
- `resolveConfigPaths(options: ResolveConfigPathsOptions): ResolvedConfigPaths`
- `loadConfig(options: LoadConfigOptions): Promise<ConfigLoadResult>`
- `saveConfig(config: AppConfig, options: SaveConfigOptions): Promise<void>`

- [ ] **Step 1: Write failing schema tests**

  Cover URL protocol/host rules, enum values, delay range, unknown fields, defaults, and migration.

- [ ] **Step 2: Implement schema and defaults**

  Use Zod and preserve unknown fields only when the spec allows compatibility without conflicting with typed fields.

- [ ] **Step 3: Write failing path and persistence tests**

  Cover `--config-dir`, environment override, Windows exe directory, Linux `$APPIMAGE`, macOS `.app` sibling, XDG config, macOS Application Support, read-only paths, invalid JSON backup, atomic write, and `.bak`.

- [ ] **Step 4: Implement path resolution and store**

  Never write into `.app` bundles, AppImage mount directories, or protected system paths. Return actionable permission errors.

- [ ] **Step 5: Run config tests**

  Run: `npm test -- --run tests/unit/config`

- [ ] **Step 6: Commit**

  `git add src/main/config src/main/platform/config-paths.ts resources tests/unit/config && git commit -m "feat: add cross-platform config storage"`

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

### Task 4: 实现安全窗口与导航防护

**Files:**
- Create: `src/main/window/window-manager.ts`
- Create: `src/main/window/navigation-guard.ts`
- Create: `src/preload/config-preload.ts`
- Test: `tests/unit/window/navigation-guard.test.ts`
- Test: `tests/integration/window-manager.test.ts`

**Interfaces:**
- `WindowManager.createMainWindow(config: AppConfig): Promise<BrowserWindow>`
- `WindowManager.openConfigWindow(): BrowserWindow`
- `WindowManager.applyWindowPolicy(config: WindowConfig, capabilities: PlatformCapabilities): void`
- `installNavigationGuards(window: BrowserWindow, config: SecurityConfig): void`

- [ ] **Step 1: Write failing navigation tests**

  Cover allowed origin, unauthorized redirect, popup denial, external link policy, download policy, and permission denial.

- [ ] **Step 2: Implement secure window creation**

  Remote windows use `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Config windows use only the minimal preload.

- [ ] **Step 3: Write failing window policy tests**

  Cover normal/fullscreen/kiosk, close-to-hide, display selection, config-window reuse, and security settings on all window creations.

- [ ] **Step 4: Implement `WindowManager`**

  Apply platform capability results rather than assuming Windows behavior.

- [ ] **Step 5: Run window tests**

  Run: `npm test -- --run tests/unit/window tests/integration/window-manager.test.ts`

- [ ] **Step 6: Commit**

  `git add src/main/window src/preload tests && git commit -m "feat: add secure windows and navigation policy"`

### Task 5: 实现代理、离线页与自动重试

**Files:**
- Create: `src/main/network/proxy-manager.ts`
- Create: `src/main/network/retry-controller.ts`
- Create: `src/renderer/offline/offline.html`
- Test: `tests/unit/network/proxy-manager.test.ts`
- Test: `tests/unit/network/retry-controller.test.ts`

**Interfaces:**
- `applyProxy(session: Electron.Session, config: NetworkConfig): Promise<void>`
- `classifyLoadFailure(details: Electron.DidFailLoadEvent): LoadFailureKind`
- `class RetryController { start(); stop(); onLoadFailed(details: LoadFailureDetails): void; onLoadSucceeded(): void; }`

- [ ] **Step 1: Write failing proxy tests**

  Cover direct/system/fixed/pac modes, bypass rules, invalid proxy values, and old-connection cleanup.

- [ ] **Step 2: Implement proxy manager**

  Proxy credentials must not be persisted in `config.json`; use the OS secure credential mechanism only if a later task explicitly adds authenticated proxy support.

- [ ] **Step 3: Write failing retry tests**

  Cover main-frame-only failures, retry interval, cancel-on-success, no duplicate timers, cleanup on shutdown, DNS/TLS/HTTP classification, and recovery timing.

- [ ] **Step 4: Implement retry controller and offline page**

  The offline page is local and must not require network access.

- [ ] **Step 5: Run network tests**

  Run: `npm test -- --run tests/unit/network`

- [ ] **Step 6: Commit**

  `git add src/main/network src/renderer/offline tests/unit/network && git commit -m "feat: add proxy and offline retry"`

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

### Task 7: 实现登录自启、托盘和焦点快捷键

**Files:**
- Create: `src/main/startup/startup-manager.ts`
- Create: `src/main/tray/tray-manager.ts`
- Modify: `src/main/app-controller.ts`
- Test: `tests/unit/startup/startup-manager.test.ts`
- Test: `tests/unit/tray/tray-manager.test.ts`
- Test: `tests/integration/startup-flow.test.ts`

**Interfaces:**
- `detectLaunchContext(argv: string[]): 'manual' | 'login'`
- `setOpenAtLogin(enabled: boolean): Promise<LoginItemResult>`
- `runStartupDelay(config: StartupConfig, context: LaunchContext, onReady: () => void): CancelableDelay`
- `createTray(actions: TrayActions, capabilities: PlatformCapabilities): TrayResult`
- `installFocusedShortcut(window: BrowserWindow, binding: string, onInvoke: () => void): void`

- [ ] **Step 1: Write failing startup tests**

  Cover launch context, `delayOnlyOnLogin`, 0～3600 range, manual wake cancellation, and timer cleanup.

- [ ] **Step 2: Implement platform login items**

  Windows uses current-user startup registration, macOS uses LaunchAgent/login-item APIs, and Linux writes XDG autostart.

- [ ] **Step 3: Write failing tray and shortcut tests**

  Cover the four fixed menu actions, Linux no-tray degradation, macOS menu bar, disabled config shortcut, and focus-only key handling.

- [ ] **Step 4: Implement tray and focused shortcut**

  Do not use a system-wide global shortcut.

- [ ] **Step 5: Run startup flow tests**

  Run: `npm test -- --run tests/unit/startup tests/unit/tray tests/integration/startup-flow.test.ts`

- [ ] **Step 6: Commit**

  `git add src/main/startup src/main/tray src/main/app-controller.ts tests && git commit -m "feat: add cross-platform startup tray and maintenance controls"`

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

## Delivery Order

1. Task 1：工程骨架。
2. Task 2：跨平台配置。
3. Task 3：生命周期和单实例。
4. Task 4：安全窗口。
5. Task 5：网络与恢复。
6. Task 6：平台能力适配。
7. Task 7：自启、托盘和快捷键。
8. Task 8：配置界面。
9. Task 9：日志诊断。
10. Task 10：三平台打包。
11. Task 11：实机验收和发布。

## Definition of Done

- `npm run typecheck`、`npm run lint`、`npm test` 通过；
- Windows、macOS、Linux 的任务级测试和集成测试通过；
- 三平台要求的构建产物存在并通过 `npm run verify:release`；
- Windows、macOS、Linux 实机验收报告无未关闭 P0/P1 问题；
- 配置升级保留、断网恢复、单实例、安全边界和平台降级策略均验证通过；
- 发布清单记录版本、架构、产物和 SHA-256。
