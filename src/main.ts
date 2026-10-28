import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { app, BrowserWindow, Menu, nativeImage, screen, Tray } from 'electron';

import { AppController, type WindowPort } from './main/app-controller';
import { loadConfig } from './main/config/config-store';
import { CONFIG_FILE_NAME } from './main/platform/config-paths';
import { resolveConfigPaths, type ResolveConfigPathsOptions } from './main/platform/config-paths';
import { detectPlatformCapabilities } from './main/platform/capability-detector';
import { acquireSingleInstance, LOGIN_LAUNCH_FLAG, type SingleInstancePort } from './main/instance/single-instance';
import type { LoginItemPort } from './main/startup/startup-manager';
import type { ShortcutTarget, TrayPort } from './main/tray/tray-manager';

/**
 * Electron 主进程入口。
 *
 * 规格 §4：启动 → 取单实例锁 → 识别来源 → 解析配置路径 → 读取校验 → 启动策略。
 * 单实例锁必须在 app ready 之前取得，因此这里的装配是同步的，启动流程交给 AppController。
 *
 * 窗口端口目前是 Task 3 的最小实现；Task 4 将以 `src/main/window/window-manager.ts`
 * 取代，并在此处改为注入 WindowManager。远程页面的加载、代理与重试由 Task 4/5 接入。
 */

const MAIN_WINDOW_WIDTH = 1280;
const MAIN_WINDOW_HEIGHT = 800;
const CONFIG_WINDOW_WIDTH = 960;
const CONFIG_WINDOW_HEIGHT = 720;

/** 远程页面与本地配置页面的共同安全边界（规格 §11）。 */
const SECURE_WEB_PREFERENCES = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
} as const;

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

/** 加载本地配置界面；开发模式下走 Vite dev server。 */
async function loadConfigWindow(window: BrowserWindow): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl && isLocalDevelopmentUrl(developmentUrl)) {
    await window.loadURL(developmentUrl);
    return;
  }
  await window.loadFile(join(app.getAppPath(), 'dist/renderer/config/index.html'));
}

/** 主窗口就绪通道：快捷键宿主窗口在延迟结束后才创建，需要延后绑定。 */
function createMainWindowChannel() {
  const handlers: Array<(window: BrowserWindow) => void> = [];
  let current: BrowserWindow | null = null;

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
      if (current && !current.isDestroyed()) handler(current);
    },
    emitReady(window: BrowserWindow) {
      current = window;
      for (const handler of handlers) handler(window);
    },
  };
}

const mainWindowChannel = createMainWindowChannel();

/** 托盘图标：Task 10 接入正式图标资源前，用程序生成的占位图标。 */
function createTrayIcon() {
  const placeholder = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNgYGD4z0AEYBxVSF4jDJgYGX4TQsmg/0mTArRYgIlQAAPnZBcDdeqrAAAAAASUVORK5CYII=',
  );
  return placeholder.isEmpty() ? nativeImage.createEmpty() : placeholder.resize({ width: 16, height: 16 });
}

/** 规格 §10：Windows 通知区域 / macOS 菜单栏 / Linux StatusNotifierItem 共用的托盘端口。 */
function createElectronTrayPort(): TrayPort {
  let tray: Tray | null = null;

  return {
    create(actions) {
      try {
        tray?.destroy();
        tray = new Tray(createTrayIcon());
        tray.setToolTip('UniShell');

        const menu = Menu.buildFromTemplate([
          { label: '打开配置界面', click: () => void actions.openConfig() },
          { label: '重新加载网页', click: () => void actions.reload() },
          { label: '立即显示窗口', click: () => void actions.showWindow() },
          { type: 'separator' },
          { label: '退出程序', click: () => void actions.quit() },
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

function createWindowPort(): WindowPort {
  let mainWindow: BrowserWindow | null = null;
  let configWindow: BrowserWindow | null = null;

  const isAlive = (window: BrowserWindow | null): window is BrowserWindow =>
    window !== null && !window.isDestroyed();

  const createMainWindow = async (): Promise<void> => {
    if (isAlive(mainWindow)) {
      mainWindow.show();
      mainWindow.focus();
      return;
    }

    mainWindow = new BrowserWindow({
      width: MAIN_WINDOW_WIDTH,
      height: MAIN_WINDOW_HEIGHT,
      show: true,
      webPreferences: SECURE_WEB_PREFERENCES,
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
      mainWindowChannel.set(null);
    });

    mainWindowChannel.emitReady(mainWindow);

    // 目标网址由 Task 4/5 的窗口与网络层注入；此处先展示本地配置界面占位。
    await loadConfigWindow(mainWindow);
  };

  return {
    async openConfigWindow() {
      if (isAlive(configWindow)) {
        configWindow.focus();
        return;
      }

      configWindow = new BrowserWindow({
        width: CONFIG_WINDOW_WIDTH,
        height: CONFIG_WINDOW_HEIGHT,
        show: true,
        webPreferences: SECURE_WEB_PREFERENCES,
      });
      configWindow.on('closed', () => {
        configWindow = null;
      });

      await loadConfigWindow(configWindow);
    },

    createMainWindow,

    async reloadMain() {
      if (!isAlive(mainWindow)) {
        await createMainWindow();
        return;
      }
      mainWindow.webContents.reload();
    },

    async showAndFocusMain() {
      if (!isAlive(mainWindow)) {
        await createMainWindow();
        return;
      }
      mainWindow.show();
      mainWindow.focus();
    },

    async hideMain() {
      if (isAlive(mainWindow)) mainWindow.hide();
    },

    isMainWindowVisible: () => isAlive(mainWindow) && mainWindow.isVisible(),
    isConfigWindowOpen: () => isAlive(configWindow),
    focusConfigWindow() {
      if (isAlive(configWindow)) {
        configWindow.show();
        configWindow.focus();
      }
    },
  };
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const capabilities = await detectPlatformCapabilities({
    displays: { count: screen.getAllDisplays().length },
  });

  const windowPort = createWindowPort();

  const controller = new AppController({
    resolvePaths: (options: ResolveConfigPathsOptions) =>
      resolveConfigPaths({
        ...options,
        macAppBundlePath: macPortableExecutablePath(),
      }),
    loadConfig: (paths) => loadConfig({ paths }),
    capabilities,
    window: windowPort,
    tray: createElectronTrayPort(),
    loginItem: createElectronLoginItemPort(),
    shortcutTarget: createShortcutTarget(),
  });

  activeController = controller;

  await controller.start({
    argv: process.argv,
    workingDirectory: process.cwd(),
    env: process.env as Record<string, string | undefined>,
  });

  app.on('before-quit', () => {
    void controller.shutdown();
  });
}

let activeController: AppController | undefined;

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
