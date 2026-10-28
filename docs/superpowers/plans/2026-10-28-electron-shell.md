# Electron 通用桌面客户端 Implementation Plan

> **已废弃：** 本计划为 Windows 单平台基线，已被 `2026-10-28-electron-shell-cross-platform.md` 替代。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从当前仅包含产品规格书的仓库开始，构建一个可配置、可安装、可绿色交付的 Windows Electron Web 外壳客户端。

**Architecture:** 使用 Electron 主进程统一负责配置、单实例、启动策略、窗口、托盘、代理、重试和日志；使用受限 preload 为本地配置界面提供白名单 IPC；远程业务页面不暴露 Node.js 能力。配置、状态机和网络策略先以纯 TypeScript 模块实现并单元测试，再接入 Electron 窗口和 Windows 行为。

**Tech Stack:** Electron、TypeScript、React + Vite（本地配置界面）、Zod（运行时配置校验）、Vitest（单元测试）、electron-builder + NSIS（安装包和 ZIP 绿色版）、ESLint/Prettier。

**Spec:** `docs/electron-desktop-shell-product-spec-v2.0.md`

## Task Tracking

This plan is the baseline. Execution is tracked in dated task files under `docs/task/2026-10-28/`; executors update the matching task file and status without rewriting this baseline plan.

## Global Constraints

- 首期支持 Windows 10/11 64 位；如需 ARM64，必须单独构建和验收。
- Electron 版本在实施时锁定为当前稳定版本，并写入构建清单，不允许每次打包自动漂移。
- 安装包、主程序和绿色版程序均应进行代码签名。
- 安装版默认使用当前用户安装模式，默认路径为用户可写目录；允许用户选择其他目录。
- 禁止把标准安装版默认安装到 `C:\Program Files` 等系统保护目录。
- 配置文件主路径为主程序 `.exe` 同级目录；权限不足时必须显示明确错误，不得静默失败。
- 配置保存必须采用临时文件写入后原子替换，并保留最近一次有效配置备份。
- 远程网页不得启用 Node.js 集成；必须启用上下文隔离和沙箱。
- 配置快捷键只在当前客户端窗口获得焦点时生效，不得注册为系统全局快捷键。
- 本期不实现独立 API 反向代理服务器和自动更新服务。

## Review Focus

- 配置文件不存在、损坏、只读或目录无权限时，程序必须进入可恢复的配置流程而不是循环崩溃；由任务 2 的持久化测试覆盖。
- 第二次启动、托盘隐藏、延迟倒计时中的唤醒行为必须统一；由任务 3 的单实例和生命周期测试覆盖。
- 远程页面跳转到新域名、打开弹窗或请求权限时，必须遵守安全配置；由任务 4 的导航安全测试覆盖。
- 断网、DNS 失败、TLS 错误、HTTP 500 和恢复网络时，重试定时器不得泄漏且页面应恢复；由任务 5 的网络状态测试覆盖。
- 标准用户、非系统盘、中文路径和绿色 ZIP 目录下都必须能读取和保存配置；由任务 8 的 Windows 打包验收覆盖。

## Repository Baseline

当前仓库只有 `docs/electron-desktop-shell-product-spec-v2.0.md`，没有 `package.json`、源码、测试或构建配置。因此第一阶段需要创建完整工程骨架，不假设已有脚手架、命名或运行时依赖。

## Planned File Map

### Application

- `package.json`：脚本、依赖、版本和构建入口。
- `tsconfig.json`、`tsconfig.node.json`、`vite.config.ts`：TypeScript 和 renderer 构建配置。
- `src/main.ts`：Electron 主进程启动入口，只负责组装依赖和启动生命周期。
- `src/main/app-controller.ts`：应用状态机、配置加载、窗口/托盘/启动模块编排。
- `src/main/config/config-types.ts`：配置类型和枚举。
- `src/main/config/config-schema.ts`：Zod schema、默认值、迁移和校验。
- `src/main/config/config-store.ts`：配置路径解析、读写、备份和原子替换。
- `src/main/startup/startup-manager.ts`：开机自启注册、启动来源识别和延迟计时。
- `src/main/window/window-manager.ts`：主窗口、配置窗口、全屏/Kiosk/置顶和显示器策略。
- `src/main/window/navigation-guard.ts`：导航、新窗口、权限和外部链接策略。
- `src/main/network/proxy-manager.ts`：direct/system/fixed/pac 代理应用。
- `src/main/network/retry-controller.ts`：离线状态、重试计时和加载错误分类。
- `src/main/tray/tray-manager.ts`：托盘图标、菜单和窗口动作。
- `src/main/instance/single-instance.ts`：单实例锁和第二次启动消息。
- `src/main/logging/logger.ts`：本地日志、脱敏和保留策略。
- `src/preload/config-preload.ts`：仅供本地配置窗口使用的白名单 IPC。

### Renderer

- `src/renderer/config/index.html`、`src/renderer/config/main.tsx`：配置界面入口。
- `src/renderer/config/App.tsx`：配置表单、校验提示和保存流程。
- `src/renderer/config/styles.css`：配置界面样式。
- `src/renderer/offline/offline.html`：离线/重试提示页面。

### Build and Tests

- `electron-builder.yml`：NSIS 当前用户安装和 ZIP 绿色版配置。
- `build/installer.nsh`：安装目录和配置文件保留规则。
- `resources/config.example.json`：默认配置模板。
- `tests/unit/**/*.test.ts`：纯逻辑单元测试。
- `tests/integration/**/*.test.ts`：主进程模块集成测试。
- `tests/manual/windows-acceptance.md`：真实 Windows 验收步骤和记录表。
- `.github/workflows/build-windows.yml`：可选的 Windows 构建流水线。

---

### Task 1: 初始化 Electron + TypeScript 工程

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `src/main.ts`
- Create: `src/renderer/config/index.html`
- Create: `src/renderer/config/main.tsx`
- Create: `tests/smoke/project.test.ts`

**Interfaces:**
- Produces npm scripts: `dev`, `typecheck`, `test`, `lint`, `build:dir`, `build:win`。
- Produces an Electron entry that starts without a configured target URL and opens the local configuration window。

- [ ] **Step 1: Write the failing smoke test**

  在 `tests/smoke/project.test.ts` 验证 `package.json` 包含 `dev`、`typecheck`、`test`、`build:win` 脚本，且 `src/main.ts` 与配置页面入口存在。

- [ ] **Step 2: Run the smoke test to verify it fails**

  Run: `npm test -- --run tests/smoke/project.test.ts`

  Expected: FAIL because the project files and scripts do not yet exist.

- [ ] **Step 3: Implement the minimal project scaffold**

  锁定 Electron、TypeScript、Vite、React、Zod、Vitest 和 electron-builder 的版本；实现最小主进程入口和配置页面占位入口。主进程不得直接加载远程 URL。

- [ ] **Step 4: Run checks**

  Run: `npm run typecheck` and `npm test -- --run tests/smoke/project.test.ts`

  Expected: typecheck passes and the smoke test passes。

- [ ] **Step 5: Commit**

  `git add package.json tsconfig.json tsconfig.node.json vite.config.ts src tests && git commit -m "build: initialize electron typescript shell"`

### Task 2: 实现配置模型、校验和持久化

**Files:**
- Create: `src/main/config/config-types.ts`
- Create: `src/main/config/config-schema.ts`
- Create: `src/main/config/config-store.ts`
- Create: `resources/config.example.json`
- Test: `tests/unit/config/config-schema.test.ts`
- Test: `tests/unit/config/config-store.test.ts`

**Interfaces:**
- `AppConfig`：与规格书推荐 JSON 结构一致。
- `validateConfig(input: unknown): { success: true; data: AppConfig } | { success: false; issues: string[] }`。
- `loadConfig(options: LoadConfigOptions): Promise<ConfigLoadResult>`。
- `saveConfig(config: AppConfig, options: SaveConfigOptions): Promise<void>`。
- `resolveConfigPaths(options: ConfigPathOptions): ConfigPaths`。
- `migrateConfig(input: unknown): AppConfig`。

- [ ] **Step 1: Write failing schema tests**

  覆盖：合法 HTTPS URL、非法协议、缺少主机名、延迟范围 0～3600、未知字段兼容、代理模式枚举和默认值填充。

- [ ] **Step 2: Run schema tests to verify failure**

  Run: `npm test -- --run tests/unit/config/config-schema.test.ts`

  Expected: FAIL because `AppConfig` and `validateConfig` are not defined.

- [ ] **Step 3: Implement schema and migration**

  使用 Zod 进行运行时校验；所有默认值集中在 `DEFAULT_CONFIG`；`schemaVersion` 低于当前版本时执行显式迁移。

- [ ] **Step 4: Write failing persistence tests**

  覆盖：主路径优先、备用路径选择、缺失文件、JSON 损坏备份、临时文件原子替换、只读文件返回明确错误、未知字段保留/忽略策略。

- [ ] **Step 5: Run persistence tests to verify failure**

  Run: `npm test -- --run tests/unit/config/config-store.test.ts`

  Expected: FAIL because path resolution and atomic persistence are not implemented.

- [ ] **Step 6: Implement `config-store.ts`**

  主路径使用程序目录同级 `config.json`；Portable 场景使用显式的可执行目录；所有写操作先写 `.tmp`，成功后替换原文件，并保留 `.bak`。

- [ ] **Step 7: Run all config tests**

  Run: `npm test -- --run tests/unit/config`

  Expected: PASS。

- [ ] **Step 8: Commit**

  `git add src/main/config resources tests/unit/config && git commit -m "feat: add validated config storage"`

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

### Task 4: 实现窗口、远程页面安全和配置窗口

**Files:**
- Create: `src/main/window/window-manager.ts`
- Create: `src/main/window/navigation-guard.ts`
- Create: `src/preload/config-preload.ts`
- Modify: `src/renderer/config/index.html`
- Test: `tests/unit/window/navigation-guard.test.ts`
- Test: `tests/integration/window-manager.test.ts`

**Interfaces:**
- `WindowManager.createMainWindow(config: AppConfig): BrowserWindow`。
- `WindowManager.openConfigWindow(): BrowserWindow`。
- `WindowManager.showAndFocus(): void`。
- `WindowManager.hide(): void`。
- `WindowManager.reload(): void`。
- `WindowManager.applyWindowPolicy(config: WindowConfig): void`。
- `installNavigationGuards(window: BrowserWindow, security: SecurityConfig): void`。

- [ ] **Step 1: Write failing navigation security tests**

  覆盖：允许目标源、阻止未授权重定向、默认阻止新窗口、外部链接按配置交给系统浏览器、权限请求默认拒绝。

- [ ] **Step 2: Run security tests to verify failure**

  Run: `npm test -- --run tests/unit/window/navigation-guard.test.ts`

  Expected: FAIL because navigation guard functions are absent.

- [ ] **Step 3: Implement secure window creation**

  远程业务窗口关闭 Node 集成并启用上下文隔离、沙箱；配置窗口使用最小权限 preload；所有 IPC channel 显式白名单。

- [ ] **Step 4: Write failing window policy tests**

  覆盖 `window`、`fullscreen`、`kiosk`、置顶层级、`primary` 显示器、关闭按钮 `hide` 行为和配置窗口复用。

- [ ] **Step 5: Implement `WindowManager`**

  主窗口只负责远程页面，配置窗口只负责本地界面；窗口策略应用集中在 `applyWindowPolicy`，便于保存配置后受控重启和真实 Windows 验收。

- [ ] **Step 6: Run tests**

  Run: `npm test -- --run tests/unit/window tests/integration/window-manager.test.ts`

  Expected: PASS。

- [ ] **Step 7: Commit**

  `git add src/main/window src/preload src/renderer/config tests && git commit -m "feat: add secure windows and navigation policy"`

### Task 5: 实现网络代理、离线页和重试控制

**Files:**
- Create: `src/main/network/proxy-manager.ts`
- Create: `src/main/network/retry-controller.ts`
- Create: `src/renderer/offline/offline.html`
- Test: `tests/unit/network/proxy-manager.test.ts`
- Test: `tests/unit/network/retry-controller.test.ts`

**Interfaces:**
- `applyProxy(session: Session, config: NetworkConfig): Promise<void>`。
- `class RetryController { start(); stop(); reset(); onLoadFailed(error): void; onLoadSucceeded(): void; }`。
- `classifyLoadFailure(details: LoadFailureDetails): LoadFailureKind`。

- [ ] **Step 1: Write failing proxy tests**

  覆盖 `direct`、`system`、`fixed`、`pac` 四种模式、代理参数校验和切换时清理旧连接。

- [ ] **Step 2: Run proxy tests to verify failure**

  Run: `npm test -- --run tests/unit/network/proxy-manager.test.ts`

  Expected: FAIL because proxy manager is not implemented.

- [ ] **Step 3: Implement proxy manager**

  将配置映射为 Electron session 代理设置；代理账号密码不进入配置文件；代理切换后显式刷新/关闭旧连接。

- [ ] **Step 4: Write failing retry tests**

  覆盖主框架失败启动重试、成功加载停止重试、HTTP/TLS/DNS 错误分类、重复失败不创建多个 timer、停止后不再重试。

- [ ] **Step 5: Implement retry controller and offline page**

  默认间隔 3 秒；离线页只作为主框架失败时的本地 fallback；重试状态通过受限 IPC 或页面初始化参数展示。

- [ ] **Step 6: Run network tests**

  Run: `npm test -- --run tests/unit/network`

  Expected: PASS。

- [ ] **Step 7: Commit**

  `git add src/main/network src/renderer/offline tests/unit/network && git commit -m "feat: add proxy and offline retry handling"`

### Task 6: 实现启动策略、托盘和焦点快捷键

**Files:**
- Create: `src/main/startup/startup-manager.ts`
- Create: `src/main/tray/tray-manager.ts`
- Modify: `src/main/app-controller.ts`
- Test: `tests/unit/startup/startup-manager.test.ts`
- Test: `tests/unit/tray/tray-manager.test.ts`
- Test: `tests/integration/startup-flow.test.ts`

**Interfaces:**
- `detectLaunchContext(argv: string[]): 'manual' | 'login'`。
- `setOpenAtLogin(enabled: boolean): void`。
- `runDelay(config: StartupConfig, context: LaunchContext, onReady: () => void): CancelableTimer`。
- `createTray(actions: TrayActions): Tray`。
- `installFocusedShortcut(window: BrowserWindow, binding: string, onInvoke: () => void): void`。

- [ ] **Step 1: Write failing startup tests**

  覆盖：手动启动与开机启动区分、`delayOnlyOnLogin`、0～3600 秒范围、立即显示取消倒计时、取消后不触发回调。

- [ ] **Step 2: Run startup tests to verify failure**

  Run: `npm test -- --run tests/unit/startup/startup-manager.test.ts`

  Expected: FAIL because startup manager is not implemented.

- [ ] **Step 3: Implement startup manager**

  使用 Electron 登录项 API 注册当前用户启动项；通过明确启动参数识别登录启动；延迟逻辑返回可取消 timer。

- [ ] **Step 4: Write failing tray and shortcut tests**

  覆盖固定四项托盘菜单、显示/隐藏/重载/退出动作、快捷键只在窗口焦点事件中触发、关闭快捷键后不再监听。

- [ ] **Step 5: Implement tray and focused shortcut**

  不使用系统全局快捷键；托盘模式下配置入口由托盘菜单提供；第二次启动和“立即显示”调用同一个 `showAndFocus()`。

- [ ] **Step 6: Write startup flow integration tests**

  覆盖合法配置 + 托盘 + 10 秒延迟、合法配置 + 最小化、延迟 0、第二次启动取消倒计时。

- [ ] **Step 7: Run tests**

  Run: `npm test -- --run tests/unit/startup tests/unit/tray tests/integration/startup-flow.test.ts`

  Expected: PASS。

- [ ] **Step 8: Commit**

  `git add src/main/startup src/main/tray src/main/app-controller.ts tests && git commit -m "feat: add startup tray and maintenance controls"`

### Task 7: 完成本地配置界面和受控保存流程

**Files:**
- Modify: `src/renderer/config/main.tsx`
- Create: `src/renderer/config/App.tsx`
- Create: `src/renderer/config/styles.css`
- Modify: `src/preload/config-preload.ts`
- Modify: `src/main/app-controller.ts`
- Test: `tests/unit/config/config-form.test.tsx`

**Interfaces:**
- `window.shellApi.getConfig(): Promise<AppConfig>`。
- `window.shellApi.validateConfig(input: unknown): Promise<ValidationResult>`。
- `window.shellApi.saveConfig(input: unknown): Promise<SaveResult>`。
- `window.shellApi.resetConfig(): Promise<AppConfig>`。
- `window.shellApi.testConnection(url: string, network: NetworkConfig): Promise<ConnectionResult>`。

- [ ] **Step 1: Write failing form tests**

  覆盖：初始值加载、URL 校验、延迟范围、代理字段按模式显示、保存失败提示、恢复默认值、未保存关闭不改文件。

- [ ] **Step 2: Run form tests to verify failure**

  Run: `npm test -- --run tests/unit/config/config-form.test.tsx`

  Expected: FAIL because the form and IPC bridge are not implemented.

- [ ] **Step 3: Implement preload API**

  只暴露上面定义的配置操作，不暴露 `ipcRenderer`、Node API 或任意文件系统访问。

- [ ] **Step 4: Implement React configuration form**

  表单按配置结构分区；字段错误就地显示；保存按钮只有在校验通过后可用；展示当前配置实际路径和保存错误。

- [ ] **Step 5: Implement controlled save/restart**

  主进程收到保存请求后执行 schema 校验、原子写入、日志记录，然后关闭旧窗口并按新配置受控重启；写入失败不重启。

- [ ] **Step 6: Run tests**

  Run: `npm test -- --run tests/unit/config/config-form.test.tsx`

  Expected: PASS。

- [ ] **Step 7: Commit**

  `git add src/renderer/config src/preload src/main/app-controller.ts tests/unit/config && git commit -m "feat: add local configuration UI"`

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

### Task 9: 打包、安装版和绿色版交付

**Files:**
- Create: `electron-builder.yml`
- Create: `build/installer.nsh`
- Modify: `package.json`
- Modify: `resources/config.example.json`
- Create: `tests/manual/windows-acceptance.md`
- Create: `tests/manual/release-checklist.md`

**Interfaces:**
- `npm run build:dir`：生成未安装目录包。
- `npm run build:win`：生成 NSIS 安装包和 ZIP 绿色包。
- `npm run verify:release`：检查产物、配置文件位置、版本和校验摘要。

- [ ] **Step 1: Write release verification script/test**

  验证构建输出同时包含 NSIS `.exe` 和 ZIP；解压 ZIP 后存在主程序、`config.json` 和资源目录；安装构建配置为当前用户默认而非强制 per-machine。

- [ ] **Step 2: Run verification to verify failure**

  Run: `npm run verify:release`

  Expected: FAIL because electron-builder configuration and artifacts do not exist.

- [ ] **Step 3: Implement electron-builder configuration**

  配置 NSIS assisted installer、当前用户安装、可修改安装目录、根目录 `config.json` 和 ZIP 绿色版；配置升级时保留配置文件。

- [ ] **Step 4: Add installer script and signing hooks**

  安装脚本只负责安装、快捷方式、卸载和配置文件保护；签名证书通过 CI secret 注入，不把证书或密码提交到仓库。

- [ ] **Step 5: Implement release verification**

  检查产物名称、文件大小、SHA-256、配置文件位置和版本号，并生成 `release-manifest.json`。

- [ ] **Step 6: Write Windows manual acceptance checklist**

  按规格书覆盖 Windows 10/11、标准用户、中文路径、非系统盘、双显示器、任务栏、断网恢复、代理、开机自启、快捷键和单实例。

- [ ] **Step 7: Build artifacts and run verification**

  Run: `npm run build:win` and `npm run verify:release`

  Expected: both artifacts are generated and verification passes。

- [ ] **Step 8: Commit**

  `git add electron-builder.yml build package.json resources tests/manual && git commit -m "build: add windows installer and portable zip"`

### Task 10: Windows 真实环境验收与发布基线

**Files:**
- Modify: `tests/manual/windows-acceptance.md`
- Create: `docs/release/2026-10-28-v1.0-acceptance-report.md`
- Create: `docs/release/release-manifest.json`
- Optional Modify: `.github/workflows/build-windows.yml`

**Interfaces:**
- 发布验收报告必须列出客户端版本、Electron 版本、构建时间、SHA-256、测试系统版本和通过/失败结果。

- [ ] **Step 1: Prepare clean Windows test machines**

  至少准备 Windows 10 和 Windows 11；分别使用标准用户和管理员用户；测试安装目录包含空格、中文和非系统盘。

- [ ] **Step 2: Execute functional acceptance**

  使用有效预置配置验证不弹配置窗、托盘驻留、延迟展示、全屏/置顶、目标页面加载和第二次启动唤醒。

- [ ] **Step 3: Execute failure acceptance**

  验证配置损坏、只读、断网、恢复网络、DNS/TLS/HTTP 错误、代理切换、睡眠唤醒和退出清理。

- [ ] **Step 4: Execute security acceptance**

  验证远程页面不能访问 Node、本地文件、任意 IPC；新窗口、外部链接、下载和权限请求符合配置。

- [ ] **Step 5: Record release report**

  只有所有 P0 验收项通过后，才生成发布基线、产物清单和交付包。

- [ ] **Step 6: Commit**

  `git add tests/manual docs/release .github/workflows && git commit -m "release: record windows acceptance baseline"`

## Suggested Delivery Order

1. Task 1：工程骨架和可运行入口。
2. Task 2：配置模型和安全持久化。
3. Task 3：生命周期和单实例。
4. Task 4：窗口和安全边界。
5. Task 5：网络代理、离线和重试。
6. Task 6：启动、托盘和快捷键。
7. Task 7：本地配置界面。
8. Task 8：日志和恢复。
9. Task 9：安装版与绿色版。
10. Task 10：Windows 实机验收与发布基线。

## Milestones

- **M1 工程可运行：** Task 1 完成，主进程和配置页面可启动，CI/本地测试命令可运行。
- **M2 核心壳可用：** Task 2～6 完成，可读取配置、打开业务页面、断网重试、托盘驻留、延迟启动和单实例运行。
- **M3 可配置交付：** Task 7～8 完成，配置界面、日志和故障恢复可用。
- **M4 可安装交付：** Task 9 完成，NSIS 和 ZIP 产物可生成，配置文件位于预期位置。
- **M5 发布候选：** Task 10 完成，Windows 10/11 实机验收通过并生成发布清单。

## Definition of Done

- 所有 Task 的单元/集成测试通过；
- `npm run typecheck`、`npm run lint`、`npm test`、`npm run build:win` 和 `npm run verify:release` 通过；
- Windows 10/11 实机验收报告无未关闭的 P0/P1 问题；
- 安装版默认不写入受保护系统目录；
- ZIP 绿色版解压后可直接运行；
- 有效预置配置可开箱启动，配置损坏和断网场景可恢复；
- 发布包、SHA-256、版本号和配置模板已归档。

