import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { app, BrowserWindow, screen } from 'electron';

import { AppController, type WindowPort } from './main/app-controller';
import { loadConfig } from './main/config/config-store';
import { CONFIG_FILE_NAME } from './main/platform/config-paths';
import { resolveConfigPaths, type ResolveConfigPathsOptions } from './main/platform/config-paths';
import { detectPlatformCapabilities } from './main/platform/capability-detector';
import { acquireSingleInstance, type SingleInstancePort } from './main/instance/single-instance';

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
    });

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

  const controller = new AppController({
    resolvePaths: (options: ResolveConfigPathsOptions) =>
      resolveConfigPaths({
        ...options,
        macAppBundlePath: macPortableExecutablePath(),
      }),
    loadConfig: (paths) => loadConfig({ paths }),
    capabilities,
    window: createWindowPort(),
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
