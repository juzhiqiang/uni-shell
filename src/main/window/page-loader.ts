import { join } from 'node:path';
import { app } from 'electron';

export const OFFLINE_PAGE_ENTRY = 'dist/renderer/config/offline.html';
export const CONFIG_PAGE_ENTRY = 'dist/renderer/config/index.html';

export interface WebPageTarget {
  loadURL: (url: string) => Promise<void>;
  loadFile: (filePath: string, options?: { query?: Record<string, string> }) => Promise<void>;
}

export function isLocalDevelopmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 本地离线页判定：离线页加载成功不算「目标页恢复」。
 *
 * 生产环境离线页是 `loadFile`（file://）；开发模式走 Vite dev server
 * （http://localhost:PORT/offline.html）。两者都会触发 `did-navigate`，
 * 若不排除，降级后的离线页会被当成目标页加载成功，从而清空崩溃窗口、
 * 取消重试，规格 §7 的「停止自动重载」在 `npm run dev` 下被静默破坏。
 */
export function isLocalOfflinePage(url: string, developmentUrl?: string): boolean {
  if (url.startsWith('file:')) return true;
  const devUrl = developmentUrl ?? process.env.ELECTRON_RENDERER_URL;
  if (!devUrl || !isLocalDevelopmentUrl(devUrl)) return false;
  try {
    return new URL(url).pathname.endsWith('/offline.html');
  } catch {
    return false;
  }
}

export interface LoadConfigWindowOptions {
  configPath?: string;
  appPath?: string;
  developmentUrl?: string;
}

/** 加载本地配置界面；开发模式下走 Vite dev server，两种模式都附带实际配置路径。 */
export async function loadConfigWindow(
  window: WebPageTarget,
  options: LoadConfigWindowOptions = {},
): Promise<void> {
  const configPath = options.configPath ?? '';
  const developmentUrl = options.developmentUrl ?? process.env.ELECTRON_RENDERER_URL;

  if (developmentUrl && isLocalDevelopmentUrl(developmentUrl)) {
    try {
      const url = new URL(developmentUrl);
      url.searchParams.set('configPath', configPath);
      await window.loadURL(url.toString());
      return;
    } catch {
      // 开发服务器不可达（如保存重启后 Vite 服务断开、或脱机调试）时回退到打包页面，避免白屏
    }
  }

  const appPath = options.appPath ?? (typeof app?.getAppPath === 'function' ? app.getAppPath() : '');
  await window.loadFile(join(appPath, CONFIG_PAGE_ENTRY), {
    query: { configPath },
  });
}

export interface LoadOfflinePageOptions {
  appPath?: string;
  developmentUrl?: string;
}

/** 规格 §7：断网时展示本地离线页；开发模式走开发服务器，生产加载打包产物。 */
export async function loadOfflinePage(
  window: WebPageTarget,
  options: LoadOfflinePageOptions = {},
): Promise<void> {
  const developmentUrl = options.developmentUrl ?? process.env.ELECTRON_RENDERER_URL;

  if (developmentUrl && isLocalDevelopmentUrl(developmentUrl)) {
    try {
      await window.loadURL(new URL('offline.html', developmentUrl).toString());
      return;
    } catch {
      // 回退到本地离线页
    }
  }

  const appPath = options.appPath ?? (typeof app?.getAppPath === 'function' ? app.getAppPath() : '');
  await window.loadFile(join(appPath, OFFLINE_PAGE_ENTRY));
}

export interface MainWindowDiagnosticCallbacks {
  reportLoadFailure(details: { errorCode: number; errorDescription: string; isMainFrame: boolean }): void;
  reportLoadSuccess(): void;
  reportRendererGone(details: { reason: string; exitCode: number }): void;
  reportUnresponsive(): void;
  reportResponsive(): void;
}

export interface DiagnosticWindow {
  webContents: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    once(event: any, listener: any): unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: any, listener: any): unknown;
  };
}

/**
 * 主窗口加载诊断（规格 §12 的页面加载结果、§14.1 的断网恢复、§7 的进程级恢复）：
 * - `did-fail-load` 进入控制器的失败分类与重试控制；
 * - `did-navigate` 在主框架导航成功时触发且带 URL，本地离线页不算恢复；
 * - `render-process-gone` / `unresponsive` / `responsive` 交给控制器的崩溃窗口：
 *   崩溃不产生 `did-fail-load`，重试控制器不会被触发，必须由进程级事件驱动恢复。
 */
export function attachMainWindowDiagnostics(
  window: DiagnosticWindow,
  callbacks: MainWindowDiagnosticCallbacks,
  onFirstLoad: () => void,
  developmentUrl?: string,
): void {
  window.webContents.once('did-finish-load', onFirstLoad);
  window.webContents.on(
    'did-fail-load',
    (_event: unknown, errorCode: number, errorDescription: string, _validatedURL: string, isMainFrame: boolean) => {
      callbacks.reportLoadFailure({ errorCode, errorDescription, isMainFrame });
    },
  );
  window.webContents.on('did-navigate', (_event: unknown, url: string) => {
    if (isLocalOfflinePage(url, developmentUrl)) return;
    callbacks.reportLoadSuccess();
  });
  window.webContents.on('render-process-gone', (_event: unknown, details: { reason: string; exitCode: number }) => {
    callbacks.reportRendererGone({ reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on('unresponsive', () => {
    callbacks.reportUnresponsive();
  });
  window.webContents.on('responsive', () => {
    callbacks.reportResponsive();
  });
}

