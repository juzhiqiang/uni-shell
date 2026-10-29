import { existsSync } from 'node:fs';
import { access, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
  session,
  shell,
  Tray,
} from 'electron';

import {
  AppController,
  type Logger,
  type PowerMonitorPort,
  type ProxyPort,
  type WindowPort,
} from './main/app-controller';
import {
  installPickedIcon,
  loadAppIcon,
  readConfiguredIconFileName,
  removeUnreferencedIconFiles,
  type IconFileSystem,
  type IconImageFactory,
  type ResolvedAppIcon,
} from './main/appearance/icon-manager';
import { registerConfigIpc, testTargetConnection } from './main/config/config-ipc';
import { loadConfig, saveConfig } from './main/config/config-store';
import type { AppConfig } from './main/config/config-schema';
import type { LogLevel, NetworkConfig } from './main/config/config-types';
import { createLogger } from './main/logging/logger';
import {
  CONFIG_FILE_NAME,
  resolveConfigPaths,
  type NodePlatform,
  type ResolveConfigPathsOptions,
  type ResolvedConfigPaths,
} from './main/platform/config-paths';
import { detectPlatformCapabilities } from './main/platform/capability-detector';
import { applyProxy } from './main/network/proxy-manager';
import { acquireSingleInstance, LOGIN_LAUNCH_FLAG, type SingleInstancePort } from './main/instance/single-instance';
import type { LoginItemPort } from './main/startup/startup-manager';
import type { ShortcutTarget, TrayPort } from './main/tray/tray-manager';
import type { IconPickResult } from './preload/config-bridge';
import {
  WindowManager,
  type BrowserWindowConstructorOptions,
} from './main/window/window-manager';

/**
 * Electron 主进程入口。
 *
 * 规格 §4：启动 → 取单实例锁 → 识别来源 → 解析配置路径 → 读取校验 → 启动策略。
 * 单实例锁必须在 app ready 之前取得，因此这里的装配是同步的，启动流程交给 AppController。
 *
 * 装配说明（Task 9 诊断接线 + 任务 4/5 模块接入）：
 * - 窗口经 `WindowManager`（Task 4）创建，其事件出口接到控制器的 `reportWindowEvent`；
 * - 主窗口的 `did-fail-load` / `did-navigate` 接到 `reportLoadFailure` / `reportLoadSuccess`，
 *   由控制器持有的重试控制（Task 5）完成断网恢复；
 * - 代理经默认 session 应用（Task 5 的 `applyProxy`，接口代理语义见规格 §7）；电源事件经 `powerMonitor` 端口注入；
 * - 应用图标（规格 §5.4）在启动前解析：用户图标（配置目录 app-icon.*）或内置默认图标，
 *   注入窗口工厂与托盘，macOS 另设 Dock 图标；
 * - 日志使用 Task 9 的正式文件日志器；退出前由控制器刷新落盘。
 */

/** 打包产物中本地离线页的位置（renderer 的 publicDir 会复制到 outDir 根）。 */
const OFFLINE_PAGE_ENTRY = 'dist/renderer/config/offline.html';

function isLocalDevelopmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function createElectronSingleInstancePort(): SingleInstancePort {
  return {
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    releaseSingleInstanceLock: () => app.releaseSingleInstanceLock(),
    onSecondInstance: (handler) => {
      app.on('second-instance', (_event, argv, workingDirectory) => handler(argv, workingDirectory));
    },
  };
}

/**
 * macOS 便携交付判定：仅当 `.app` 旁置目录确实带有 `config.json` 时才按 ZIP 便携包处理；
 * 标准安装（DMG）按规格 §5.2 使用 Application Support。
 */
function macPortableExecutablePath(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const executablePath = app.getPath('exe');
  return existsSync(join(resolve(executablePath, '..'), CONFIG_FILE_NAME)) ? executablePath : undefined;
}

/**
 * 配置窗口 preload 产物路径。
 *
 * 与 `vite.config.ts` 的 preload 构建条目（`dist/preload/index.cjs`，CJS）一致；
 * 开发模式由 electron-vite 预构建到同一位置。延迟求值：`app.getAppPath()`
 * 在 app ready 之前调用不稳定。
 */
function preloadPath(): string {
  return join(app.getAppPath(), 'dist/preload/index.cjs');
}

/** 展示给配置界面的实际写入路径（规格 §5.1）。 */
function currentConfigPath(): string {
  const paths = activeController?.configPaths;
  return paths?.writePath ?? paths?.configPath ?? '';
}

/** 加载本地配置界面；开发模式下走 Vite dev server，两种模式都附带实际配置路径。 */
async function loadConfigWindow(window: BrowserWindow): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl && isLocalDevelopmentUrl(developmentUrl)) {
    try {
      const url = new URL(developmentUrl);
      url.searchParams.set('configPath', currentConfigPath());
      await window.loadURL(url.toString());
      return;
    } catch {
      // 开发服务器不可达（如保存重启后 Vite 服务断开、或脱机调试）时回退到打包页面，避免白屏
    }
  }
  await window.loadFile(join(app.getAppPath(), 'dist/renderer/config/index.html'), {
    query: { configPath: currentConfigPath() },
  });
}

/** 规格 §7：断网时展示本地离线页；开发模式走开发服务器，生产加载打包产物。 */
async function loadOfflinePage(window: BrowserWindow): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl && isLocalDevelopmentUrl(developmentUrl)) {
    try {
      await window.loadURL(new URL('offline.html', developmentUrl).toString());
      return;
    } catch {
      // 回退到本地离线页
    }
  }
  await window.loadFile(join(app.getAppPath(), OFFLINE_PAGE_ENTRY));
}

/**
 * 预读配置的 `logging` 段，供 logger 在控制器构造前确定级别与保留天数。
 *
 * 只做只读解析：文件缺失、损坏或字段异常时返回空，由 logger 的规格默认值
 * （info / 14 天）兜底；损坏文件的隔离由控制器的正式加载负责，不在这里重复处理。
 */
async function readLoggingPreferences(
  paths: ResolvedConfigPaths,
): Promise<{ level?: LogLevel; retentionDays?: number }> {
  try {
    const raw = await readFile(paths.configPath, 'utf8');
    const parsed = JSON.parse(raw) as { logging?: { level?: unknown; retentionDays?: unknown } };
    return {
      level: typeof parsed.logging?.level === 'string' ? (parsed.logging.level as LogLevel) : undefined,
      retentionDays: typeof parsed.logging?.retentionDays === 'number' ? parsed.logging.retentionDays : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * 主窗口就绪通道：快捷键宿主窗口在延迟结束后才创建，需要延后绑定。
 * 同一窗口只绑定一次，重建窗口（关闭后再次创建）时重新绑定。
 */
function createMainWindowChannel() {
  const handlers: Array<(window: BrowserWindow) => void> = [];
  let current: BrowserWindow | null = null;
  let bound: BrowserWindow | null = null;

  return {
    get window() {
      return current;
    },
    set(window: BrowserWindow | null) {
      current = window;
    },
    onReady(handler: (window: BrowserWindow) => void) {
      handlers.push(handler);
      // 窗口已存在时立即绑定，避免安装快捷键时窗口尚未创建。
      if (current && !current.isDestroyed() && bound !== current) {
        bound = current;
        handler(current);
      }
    },
    emitReady(window: BrowserWindow) {
      current = window;
      if (bound === window) return;
      bound = window;
      for (const handler of handlers) handler(window);
    },
  };
}

const mainWindowChannel = createMainWindowChannel();

/** 图标操作使用的文件系统能力（规格 §5.4）；由 `icon-manager` 定义最小面。 */
const iconFileSystem: IconFileSystem = {
  readFile: (path) => readFile(path) as Promise<Uint8Array>,
  writeFile: (path, data) => writeFile(path, data),
  readdir: (path) => readdir(path),
  unlink: (path) => unlink(path),
  access: (path) => access(path),
};

/** 镜像工厂：把 icon-manager 的最小接口桥接到 Electron `nativeImage`。 */
const electronIconImages: IconImageFactory = {
  fromBuffer: (data) => nativeImage.createFromBuffer(Buffer.from(data)),
  fromDataURL: (dataUrl) => nativeImage.createFromDataURL(dataUrl),
};

/**
 * 启动前预读配置里的图标文件名（与 `readLoggingPreferences` 同一模式）。
 * 只做只读解析：文件缺失、损坏或字段异常时返回 null，由内置默认图标兜底。
 */
async function readAppearanceIconFileName(paths: ResolvedConfigPaths): Promise<string | null> {
  try {
    const raw = await readFile(paths.configPath, 'utf8');
    return readConfiguredIconFileName(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * 解析应用图标（规格 §5.4）：用户图标缺失、损坏或超限时回退内置默认图标。
 * 结果在启动前一次解析，供窗口工厂、托盘与 Dock 共用；图标变化需重启生效。
 */
async function resolveAppIcon(paths: ResolvedConfigPaths, logger: Logger): Promise<ResolvedAppIcon> {
  const icon = await loadAppIcon({
    icon: await readAppearanceIconFileName(paths),
    configDirectory: paths.writeDirectory,
    fs: iconFileSystem,
    images: electronIconImages,
  });

  if (icon.source === 'configured') {
    logger.info('icon-resolved', { source: 'configured', fileName: icon.fileName });
  } else if (icon.fallbackReason !== undefined) {
    logger.warn('icon-fallback', { reason: icon.fallbackReason });
  }

  // 清理未被引用的残留图标文件（用户更换格式或恢复默认后）。
  const removed = await removeUnreferencedIconFiles({
    configDirectory: paths.writeDirectory,
    configuredIcon: icon.fileName ?? '',
    fs: iconFileSystem,
  });
  if (removed.length > 0) {
    logger.info('icon-files-cleaned', { removed });
  }

  return icon;
}

/** 规格 §10：Windows 通知区域 / macOS 菜单栏 / Linux StatusNotifierItem 共用的托盘端口。 */
function createElectronTrayPort(getTrayIcon: () => Electron.NativeImage): TrayPort {
  let tray: Tray | null = null;

  return {
    create(actions) {
      try {
        tray?.destroy();
        tray = new Tray(getTrayIcon());
        tray.setToolTip('UniShell');

        const menu = Menu.buildFromTemplate([
          { label: '打开配置界面', click: () => void actions.openConfig() },
          { label: '重新加载网页', click: () => void actions.reload() },
          { label: '立即显示窗口', click: () => void actions.showWindow() },
          { type: 'separator' },
          // 「退出程序」= 控制器的关闭流程（刷新日志、停定时器）+ 进程退出；
          // 控制器的 quit 动作由 quitApplication 内部触发。
          { label: '退出程序', click: () => void quitApplication() },
        ]);
        tray.setContextMenu(menu);

        // Windows 单击与 macOS 左键都表现为「立即显示窗口」。
        tray.on('click', () => {
          void actions.showWindow();
        });

        return { ok: true };
      } catch (error) {
        tray?.destroy();
        tray = null;
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: `托盘创建失败：${detail}` };
      }
    },
    destroy() {
      tray?.destroy();
      tray = null;
    },
  };
}

/**
 * 规格 §5.4：图标选择出口（配置界面「选择图标」按钮）。
 * 打开文件对话框 → 校验并复制到配置目录 → 回传文件名与预览；
 * 只回传结果，不向渲染进程暴露任意文件路径读写能力。
 */
function createIconPickPort(getConfigWindow: () => BrowserWindow | null) {
  return async (): Promise<IconPickResult> => {
    const paths = activeController?.configPaths;
    if (paths === undefined) {
      return { ok: false, message: '配置路径尚未解析，无法选择图标' };
    }

    const options: Electron.OpenDialogOptions = {
      title: '选择应用图标',
      properties: ['openFile'],
      filters: [{ name: '图标文件', extensions: ['png', 'ico', 'icns'] }],
    };
    const parent = getConfigWindow();
    const selection = parent !== null ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (selection.canceled || selection.filePaths.length === 0) {
      return { ok: false, canceled: true, message: '已取消选择' };
    }

    return installPickedIcon({
      pickedPath: selection.filePaths[0],
      configDirectory: paths.writeDirectory,
      fs: iconFileSystem,
      images: electronIconImages,
    });
  };
}

/** Linux XDG autostart 条目内容。 */
function buildLinuxAutostartEntry(): string {
  const executable = process.env.APPIMAGE?.trim() || process.execPath;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=UniShell',
    `Exec="${executable}" ${LOGIN_LAUNCH_FLAG}`,
    'X-GNOME-Autostart-enabled=true',
    'Terminal=false',
    '',
  ].join('\n');
}

/** Linux：写入或删除 `~/.config/autostart/uni-shell.desktop`。 */
async function applyLinuxAutostart(enabled: boolean): Promise<{ ok: boolean; location?: string; reason?: string }> {
  const { mkdir, rm, writeFile } = await import('node:fs/promises');
  const directory = join(homedir(), '.config', 'autostart');
  const file = join(directory, 'uni-shell.desktop');

  try {
    if (!enabled) {
      await rm(file, { force: true });
      return { ok: true, location: file };
    }
    await mkdir(directory, { recursive: true });
    await writeFile(file, buildLinuxAutostartEntry(), 'utf8');
    return { ok: true, location: file };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `写入 XDG autostart 失败：${detail}` };
  }
}

/**
 * 登录项端口。
 * 规格 §9：Windows 当前用户启动项、macOS 登录项/LaunchAgent、Linux XDG autostart。
 * Electron 的 `setLoginItemSettings` 覆盖 Windows 与 macOS；Linux 需自行写 .desktop。
 */
function createElectronLoginItemPort(): LoginItemPort {
  return {
    platform: process.platform as LoginItemPort['platform'],
    async apply(enabled) {
      if (process.platform === 'linux') {
        return applyLinuxAutostart(enabled);
      }

      app.setLoginItemSettings({
        openAtLogin: enabled,
        // 登录启动必须带上标记，供 detectLaunchContext 识别来源。
        args: enabled ? [LOGIN_LAUNCH_FLAG] : [],
      });

      return { ok: true, location: 'app.setLoginItemSettings' };
    },
    async query() {
      if (process.platform === 'linux') {
        const file = join(homedir(), '.config', 'autostart', 'uni-shell.desktop');
        return existsSync(file);
      }
      return app.getLoginItemSettings().openAtLogin;
    },
  };
}

/** 焦点快捷键宿主：绑定主窗口自身的 before-input-event，绝不注册全局快捷键。 */
function createShortcutTarget(): ShortcutTarget {
  return {
    isFocused() {
      const window = mainWindowChannel.window;
      return window !== null && !window.isDestroyed() && window.isFocused();
    },
    onBeforeInput(handler) {
      mainWindowChannel.onReady((window) => {
        window.webContents.on('before-input-event', (event, input) => {
          handler({
            key: input.key,
            control: input.control,
            alt: input.alt,
            shift: input.shift,
            meta: input.meta,
            preventDefault: () => event.preventDefault(),
          });
        });
      });
    },
  };
}

/**
 * 窗口工厂：把窗口层的中立选项映射为 Electron 的构造选项，并注入应用图标（规格 §5.4）。
 * `icon` 在启动前解析（用户图标或内置默认图标）；Windows 任务栏图标随窗口图标生效。
 */
function createBrowserWindowFactory(getWindowIcon: () => Electron.NativeImage | undefined) {
  return (options: BrowserWindowConstructorOptions): BrowserWindow => {
    const icon = getWindowIcon();
    return new BrowserWindow({
      ...options,
      ...(icon !== undefined ? { icon } : {}),
    } as unknown as Electron.BrowserWindowConstructorOptions);
  };
}

/**
 * 主窗口加载诊断（规格 §12 的页面加载结果、§14.1 的断网恢复）：
 * - `did-fail-load` 进入控制器的失败分类与重试控制；
 * - `did-navigate` 在主框架导航成功时触发且带 URL，本地离线页（file://）不算恢复。
 */
function attachMainWindowDiagnostics(window: BrowserWindow): void {
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      activeController?.reportLoadFailure({ errorCode, errorDescription, isMainFrame });
    },
  );
  window.webContents.on('did-navigate', (_event, url) => {
    if (url.startsWith('file:')) return;
    activeController?.reportLoadSuccess();
  });
}

/**
 * 把 WindowManager 适配到控制器的 WindowPort。
 * 记住最近一次配置：托盘「重新加载网页」与唤醒恢复都要重新加载目标网址，
 * 离线页展示后更不能重载离线页本身。
 */
function createWindowPortAdapter(windowManager: WindowManager<BrowserWindow>): WindowPort & {
  closeStaleWindows(): void;
} {
  let lastConfig: AppConfig | undefined;

  const createMain = async (config: AppConfig): Promise<void> => {
    lastConfig = config;
    await windowManager.createMainWindow(config);
  };

  return {
    async openConfigWindow() {
      windowManager.openConfigWindow();
    },

    createMainWindow: createMain,

    async showAndFocusMain() {
      // 窗口已被销毁（如关闭后再次唤醒）时按最近配置重建；重建窗口可能按
      // `startup.initialState` 隐藏创建，调用方已明确要展示，因此显式显示。
      if (!windowManager.showMainWindow() && lastConfig !== undefined) {
        await createMain(lastConfig);
        windowManager.showMainWindow();
      }
    },

    async hideMain() {
      windowManager.getMainWindow()?.hide();
    },

    async reloadMain() {
      const main = windowManager.getMainWindow();
      // 主窗口只可能由 createMainWindow 创建，因此窗口存在即有最近配置；
      // 离线页展示后必须重新加载目标网址，而不是重载离线页本身。
      if (main !== null && lastConfig !== undefined) {
        await main.loadURL(lastConfig.targetUrl);
        return;
      }
      if (lastConfig !== undefined) {
        await createMain(lastConfig);
        windowManager.showMainWindow();
      }
    },

    async showOfflinePage() {
      const main = windowManager.getMainWindow();
      if (main !== null) await loadOfflinePage(main);
    },

    isMainWindowVisible: () => windowManager.getMainWindow()?.isVisible() ?? false,
    isConfigWindowOpen: () => windowManager.getConfigWindow() !== null,
    focusConfigWindow() {
      // 走窗口管理器：配置窗口首帧未就绪时挂起显示，避免占位底色空窗。
      windowManager.focusConfigWindow();
    },
    /** 受控重启前关闭陈旧窗口；与 app.relaunch()/app.exit() 配合使用。 */
    closeStaleWindows() {
      windowManager.closeAll();
    },
  };
}

/** 代理端口：目标页面加载前经默认 session 应用代理（规格 §7）。 */
function createElectronProxyPort(): ProxyPort {
  return {
    apply: (config: NetworkConfig) => applyProxy(session.defaultSession, config),
  };
}

/** 电源端口：记录休眠/唤醒诊断，并在唤醒后由控制器重载目标页面（规格 §14.1）。 */
function createElectronPowerMonitorPort(): PowerMonitorPort {
  return {
    onSuspend: (handler) => {
      powerMonitor.on('suspend', handler);
    },
    onResume: (handler) => {
      powerMonitor.on('resume', handler);
    },
    removeAllListeners: () => {
      powerMonitor.removeAllListeners();
    },
  };
}

/** 统一退出：先刷新日志并释放资源，再退出进程。 */
async function quitApplication(): Promise<void> {
  try {
    await activeController?.shutdown();
  } finally {
    app.exit();
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const capabilities = await detectPlatformCapabilities({
    displays: { count: screen.getAllDisplays().length },
  });

  const resolvePaths = (options: ResolveConfigPathsOptions): ResolvedConfigPaths =>
    resolveConfigPaths({
      ...options,
      macAppBundlePath: macPortableExecutablePath(),
    });

  const paths = resolvePaths({
    platform: process.platform as NodePlatform,
    argv: process.argv,
    env: process.env as Record<string, string | undefined>,
    executablePath: process.execPath,
  });

  // 正式文件日志器（Task 9）：级别与保留天数取配置 logging 段，读不到用规格默认值。
  const loggingPreferences = await readLoggingPreferences(paths);
  const logger = createLogger({
    platform: process.platform as NodePlatform,
    env: process.env as Record<string, string | undefined>,
    level: loggingPreferences.level,
    retentionDays: loggingPreferences.retentionDays,
    context: {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      arch: process.arch,
      desktopEnvironment: capabilities.desktopEnvironment,
      sessionType: capabilities.sessionType,
    },
    onError: (error, event) => {
      // 日志不可用时在控制台留下最后线索，不影响主流程。
      console.error(`[uni-shell] 日志写入失败（${event}）`, error);
    },
  });

  // 应用图标（规格 §5.4）：启动前解析用户图标或内置默认图标；缺失/损坏回退并记日志。
  const appIcon = await resolveAppIcon(paths, logger);
  const windowIcon = appIcon.image as unknown as Electron.NativeImage;
  const trayIcon = appIcon.trayImage as unknown as Electron.NativeImage;

  // macOS：Dock 与应用切换器图标只能由进程自身设置；窗口 icon 选项在 macOS 不生效。
  if (process.platform === 'darwin' && !appIcon.image.isEmpty()) {
    app.dock?.setIcon(windowIcon);
  }

  const windowManager = new WindowManager({
    createWindow: createBrowserWindowFactory(() => windowIcon),
    capabilities,
    screen,
    preloadPath: preloadPath(),
    loadConfigWindow: (window) => loadConfigWindow(window),
    openExternal: (url) => shell.openExternal(url),
    quitApp: () => {
      void quitApplication();
    },
    onEvent: (event) => {
      activeController?.reportWindowEvent(event);
      if (event.type === 'main-window-created') {
        const main = windowManager.getMainWindow();
        if (main !== null) {
          mainWindowChannel.emitReady(main);
          main.on('closed', () => mainWindowChannel.set(null));
          attachMainWindowDiagnostics(main);
        }
      }
    },
  });

  const windowPort = createWindowPortAdapter(windowManager);

  const controller = new AppController({
    resolvePaths,
    loadConfig: (resolved) => loadConfig({ paths: resolved }),
    capabilities,
    window: windowPort,
    tray: createElectronTrayPort(() => trayIcon),
    loginItem: createElectronLoginItemPort(),
    shortcutTarget: createShortcutTarget(),
    proxy: createElectronProxyPort(),
    powerMonitor: createElectronPowerMonitorPort(),
    log: logger,
  });

  activeController = controller;

  // 配置界面 IPC：启动流程解析出配置路径后，才注册六个白名单通道（Task 8 + 规格 §5.4 图标选择）。
  registerConfigIpc({
    host: ipcMain,
    paths: () => activeController?.configPaths,
    loadConfig: (resolved) => loadConfig({ paths: resolved }),
    saveConfig: (config, options) => saveConfig(config, options),
    logger,
    onSaved: async (config, previous) => {
      // 规格 §9：开机自启变化立即同步登录项；只有用户显式改过才写。
      if (previous !== undefined && config.startup.openAtLogin !== previous.startup.openAtLogin) {
        await activeController?.applyOpenAtLogin(config.startup.openAtLogin);
      }
    },
    closeStaleWindows: () => {
      windowPort.closeStaleWindows();
    },
    // 规格 §14.1：仅在写入成功后由 config-ipc 调用；先关窗再 relaunch，避免半截状态。
    // 重启前先走一遍关闭流程：配置保存结果是规格 §12 的必记项，不能随进程退出丢失。
    restart: () => {
      void (async () => {
        try {
          await controller.shutdown();
        } finally {
          app.relaunch();
          app.exit();
        }
      })();
    },
    testConnection: (url, network) => testTargetConnection(url, network),
    pickIcon: createIconPickPort(() => windowManager.getConfigWindow()),
  });

  await controller.start({
    argv: process.argv,
    workingDirectory: process.cwd(),
    env: process.env as Record<string, string | undefined>,
  });

  app.on('before-quit', () => {
    // 规格 §8：close-to-hide 会阻止退出；关闭流程开始后放行。
    windowManager.beginShutdown();
    void controller.shutdown();
  });
}

let activeController: AppController | undefined;

/**
 * Windows 任务栏归属标识（AppUserModelID）。
 *
 * 必须与 electron-builder 三个平台配置的 `appId` 保持一致。Electron 默认不设置
 * AUMID，Windows 会退回进程默认值，导致运行窗口与任务栏固定项关联不上、
 * 任务栏按钮图标刷新不可靠（托盘与标题栏图标不受影响，因为它们来自窗口图标本身）。
 * 需在 app ready 之前调用，因此放在模块顶层。
 */
const APP_USER_MODEL_ID = 'com.unishell.desktop';

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

const singleInstancePort = createElectronSingleInstancePort();

const isFirstInstance = acquireSingleInstance(
  (payload) => {
    void activeController?.handleSecondLaunch(payload);
  },
  { port: singleInstancePort },
);

if (!isFirstInstance) {
  // 已有实例在运行：Electron 已把本次启动参数送过去，本进程尽快退出。
  app.quit();
} else {
  void bootstrap();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
