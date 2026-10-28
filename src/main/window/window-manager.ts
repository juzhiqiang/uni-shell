/**
 * 主窗口、配置窗口与窗口策略。
 *
 * 规则来源：规格 v2.1 §8（窗口、全屏与置顶）、§11（安全要求）
 * 与 `rules/platform.md`「平台适配」、「多显示器」。
 *
 * 关键约束：
 * - 远程业务窗口与本地配置窗口使用不同的窗口配置和权限边界
 *   （`rules/architecture.md`）：远程窗口不加载 preload，配置窗口只加载最小 preload；
 * - 平台差异通过 `PlatformCapabilities` 表达，不假设 Windows 行为：
 *   Linux Wayland 下置顶降级、Kiosk/全屏不支持时降级都要记录原因；
 * - Electron API 通过 `createWindow` 等注入端口传入（`rules/testing-release.md`），
 *   因此本模块可在纯 Node 环境下完整测试；真实 `BrowserWindow` 结构上满足
 *   `BrowserWindowLike`（文件末尾有编译期断言）。
 */

import { join } from 'node:path';

import type { BrowserWindow } from 'electron';

import type { AppConfig, SecurityConfig, WindowConfig, WindowMode } from '../config/config-types';
import { mapAlwaysOnTopLevel } from '../platform/capability-detector';
import type { MappedWindowLevel, PlatformCapabilities } from '../platform/platform-adapter';
import {
  createLocalConfigSecurityPolicy,
  installNavigationGuards,
  secureRemoteWebPreferences,
  type GuardEvent,
  type GuardWebContents,
  type NavigationGuardHandle,
  type NavigationGuardRecord,
} from './navigation-guard';

const MAIN_WINDOW_WIDTH = 1280;
const MAIN_WINDOW_HEIGHT = 800;
const MAIN_WINDOW_MIN_WIDTH = 640;
const MAIN_WINDOW_MIN_HEIGHT = 480;

const CONFIG_WINDOW_WIDTH = 960;
const CONFIG_WINDOW_HEIGHT = 720;
const CONFIG_WINDOW_MIN_WIDTH = 720;
const CONFIG_WINDOW_MIN_HEIGHT = 560;

const DEFAULT_RENDERER_ENTRY = 'dist/renderer/config/index.html';

/** 窗口矩形。 */
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `screen` 显示器的最小读取面。 */
export interface DisplayLike {
  id: number | string;
  label?: string;
  bounds: Rectangle;
  workArea?: Rectangle;
}

/** Electron `screen` 模块的最小读取面。 */
export interface ScreenLike {
  getAllDisplays(): DisplayLike[];
  getPrimaryDisplay(): DisplayLike;
}

/** 创建窗口时使用的选项子集；真实实现由主进程映射为 `BrowserWindowConstructorOptions`。 */
export interface BrowserWindowConstructorOptions {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  show?: boolean;
  center?: boolean;
  title?: string;
  autoHideMenuBar?: boolean;
  resizable?: boolean;
  fullscreenable?: boolean;
  webPreferences?: Record<string, unknown>;
}

/** 本模块使用到的 `BrowserWindow` 能力子集。 */
export interface BrowserWindowLike {
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string): Promise<void>;
  webContents: GuardWebContents;
  on(event: 'close' | 'closed', listener: (event?: GuardEvent) => void): unknown;
  getBounds(): Rectangle;
  setBounds(bounds: Partial<Rectangle>): void;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  isKiosk(): boolean;
  setKiosk(flag: boolean): void;
  setAlwaysOnTop(flag: boolean, level?: string, relativeLevel?: number): void;
  isFocused(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  isDestroyed(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  hide(): void;
  close(): void;
  destroy(): void;
}

/**
 * 窗口事件，供日志与诊断消费（Task 9）。
 *
 * 注意：`url` 字段可能带有查询参数（业务系统有时把令牌放在查询串里），
 * Task 9 的日志脱敏必须处理 URL，遵守 `rules/security.md`
 * 「代理密码、Token、Cookie 和业务敏感值不得写入明文配置或日志」。
 */
export type WindowManagerEvent =
  | { type: 'main-window-created' }
  | { type: 'main-window-reused' }
  | { type: 'main-load-failed'; url: string; message: string }
  | { type: 'config-window-created' }
  | { type: 'config-window-reused' }
  | { type: 'config-load-failed'; message: string }
  | {
      type: 'navigation-guard';
      window: 'main' | 'config';
      kind: NavigationGuardRecord['kind'];
      url: string;
      action: string;
      reason: string;
    }
  | {
      type: 'window-policy-applied';
      window: 'main';
      mode: WindowMode;
      fullscreen: boolean;
      kiosk: boolean;
      alwaysOnTop: MappedWindowLevel;
      display: string;
    }
  | {
      type: 'window-policy-degraded';
      window: 'main';
      field: 'mode' | 'alwaysOnTop' | 'display';
      reason: string;
    }
  | { type: 'close-action'; window: 'main'; action: 'hide' | 'quit' };

export interface WindowManagerDeps<T extends BrowserWindowLike = BrowserWindowLike> {
  /** 创建窗口的工厂；生产环境注入 `(options) => new BrowserWindow(options)`。 */
  createWindow: (options: BrowserWindowConstructorOptions) => T;
  /** 当前平台能力，由 `src/main/platform/` 探测后注入。 */
  capabilities: PlatformCapabilities;
  /** 显示器枚举；未注入时保持系统默认位置。 */
  screen?: ScreenLike;
  /** 配置窗口 preload 的绝对路径。 */
  preloadPath: string;
  /** 配置窗口内容加载方式（开发服务器或打包产物）。 */
  loadConfigWindow: (window: T) => Promise<void>;
  /** 外链出口，通常是 `shell.openExternal`。 */
  openExternal?: (url: string) => void | Promise<void>;
  /** `closeAction=quit` 时退出应用。 */
  quitApp?: () => void;
  /** 事件出口，供日志与诊断消费（Task 9）。 */
  onEvent?: (event: WindowManagerEvent) => void;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 在显示器列表中查找目标显示器；支持标识与标签，找不到时返回 null。 */
export function findDisplay(displays: readonly DisplayLike[], displayId: string): DisplayLike | null {
  for (const display of displays) {
    if (String(display.id) === displayId) return display;
  }
  for (const display of displays) {
    if (display.label !== undefined && display.label === displayId) return display;
  }
  return null;
}

/** 把窗口居中放到目标显示器的工作区，并保证不超出该显示器范围。 */
export function centerWindowBounds(current: Rectangle, display: DisplayLike): Rectangle {
  const area = display.workArea ?? display.bounds;
  const width = Math.max(0, Math.min(current.width, area.width));
  const height = Math.max(0, Math.min(current.height, area.height));
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

/** 本地开发渲染进程地址只接受本机 http 地址，避免把远程地址当开发服务器加载。 */
export function isLocalDevelopmentUrl(value: string | undefined): boolean {
  if (value === undefined || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 构造配置窗口的内容加载器：开发环境用本机开发服务器，生产环境加载打包产物。
 * `appPath` 传 `app.getAppPath()`，`devUrl` 传 `process.env.ELECTRON_RENDERER_URL`。
 */
export function createConfigWindowLoader(options: {
  appPath: string;
  devUrl?: string;
  rendererEntry?: string;
}): (window: BrowserWindowLike) => Promise<void> {
  const entry = options.rendererEntry ?? DEFAULT_RENDERER_ENTRY;
  return async (window) => {
    const devUrl = options.devUrl;
    if (devUrl !== undefined && isLocalDevelopmentUrl(devUrl)) {
      await window.loadURL(devUrl);
      return;
    }
    await window.loadFile(join(options.appPath, entry));
  };
}

/**
 * 窗口管理器。
 *
 * 生命周期：`createMainWindow` / `openConfigWindow` 创建窗口并立即应用安全与平台策略；
 * `applyWindowPolicy` 可对已有主窗口重新应用窗口策略；`beginShutdown` / `closeAll`
 * 供关闭流程使用，避免 close-to-hide 阻止退出。
 */
export class WindowManager<T extends BrowserWindowLike = BrowserWindowLike> {
  private mainWindow: T | null = null;
  private configWindow: T | null = null;
  private readonly guards = new Map<T, NavigationGuardHandle>();
  private security: SecurityConfig = createLocalConfigSecurityPolicy();
  private windowPolicy: { window: WindowConfig; capabilities: PlatformCapabilities } | null = null;
  private quitting = false;
  private pendingQuit = false;

  constructor(private readonly deps: WindowManagerDeps<T>) {}

  getMainWindow(): T | null {
    const window = this.mainWindow;
    return window !== null && !window.isDestroyed() ? window : null;
  }

  getConfigWindow(): T | null {
    const window = this.configWindow;
    return window !== null && !window.isDestroyed() ? window : null;
  }

  /**
   * 创建（或复用）主窗口并加载目标页面。
   *
   * 目标页加载失败不会让本方法拒绝：窗口与守卫已经就绪，失败通过
   * `main-load-failed` 事件上报，由网络重试与离线页（Task 5）接管。
   */
  async createMainWindow(config: AppConfig): Promise<T> {
    this.security = config.security;

    const existing = this.getMainWindow();
    if (existing !== null) {
      this.applyWindowPolicy(config.window, this.deps.capabilities);
      existing.show();
      existing.focus();
      this.emit({ type: 'main-window-reused' });
      return existing;
    }

    const window = this.deps.createWindow({
      width: MAIN_WINDOW_WIDTH,
      height: MAIN_WINDOW_HEIGHT,
      minWidth: MAIN_WINDOW_MIN_WIDTH,
      minHeight: MAIN_WINDOW_MIN_HEIGHT,
      show: true,
      autoHideMenuBar: true,
      title: 'UniShell',
      webPreferences: secureRemoteWebPreferences(),
    });
    this.mainWindow = window;

    this.installGuards(window, config.security, 'main', config.window.mode === 'kiosk');
    this.applyWindowPolicy(config.window, this.deps.capabilities);
    this.registerMainWindowLifecycle(window);
    this.emit({ type: 'main-window-created' });

    try {
      await window.loadURL(config.targetUrl);
    } catch (error) {
      this.emit({ type: 'main-load-failed', url: config.targetUrl, message: describeError(error) });
    }

    return window;
  }

  /** 打开本地配置窗口；已打开时复用并聚焦。 */
  openConfigWindow(): T {
    const existing = this.getConfigWindow();
    if (existing !== null) {
      existing.show();
      existing.focus();
      this.emit({ type: 'config-window-reused' });
      return existing;
    }

    const window = this.deps.createWindow({
      width: CONFIG_WINDOW_WIDTH,
      height: CONFIG_WINDOW_HEIGHT,
      minWidth: CONFIG_WINDOW_MIN_WIDTH,
      minHeight: CONFIG_WINDOW_MIN_HEIGHT,
      show: true,
      autoHideMenuBar: true,
      title: 'UniShell 配置',
      webPreferences: {
        ...secureRemoteWebPreferences(),
        preload: this.deps.preloadPath,
      },
    });
    this.configWindow = window;

    this.installGuards(window, createLocalConfigSecurityPolicy(), 'config', false);
    window.on('closed', () => {
      this.releaseWindow(window);
    });

    void this.deps.loadConfigWindow(window).catch((error: unknown) => {
      this.emit({ type: 'config-load-failed', message: describeError(error) });
    });
    this.emit({ type: 'config-window-created' });

    return window;
  }

  /**
   * 对当前主窗口应用窗口策略：模式、置顶层级和显示器选择。
   * 主窗口不存在时记录策略但不应用，等窗口创建后再生效。
   */
  applyWindowPolicy(config: WindowConfig, capabilities: PlatformCapabilities): void {
    this.windowPolicy = { window: config, capabilities };

    const window = this.getMainWindow();
    if (window === null) {
      this.emit({
        type: 'window-policy-degraded',
        window: 'main',
        field: 'mode',
        reason: '主窗口尚未创建，窗口策略已记录但未应用',
      });
      return;
    }

    const mode = this.applyMode(window, config, capabilities);
    const alwaysOnTop = this.applyAlwaysOnTop(window, config, capabilities);
    this.applyDisplay(window, config, capabilities);

    this.emit({
      type: 'window-policy-applied',
      window: 'main',
      mode,
      fullscreen: window.isFullScreen(),
      kiosk: window.isKiosk(),
      alwaysOnTop,
      display: config.display,
    });
  }

  /** 显示并聚焦主窗口；窗口不存在时返回 false。 */
  showMainWindow(): boolean {
    const window = this.getMainWindow();
    if (window === null) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  }

  /** 配置保存后热替换主窗口的授权源等安全策略。 */
  updateSecurity(security: SecurityConfig): void {
    this.security = security;
    const main = this.getMainWindow();
    const guards = main === null ? undefined : this.guards.get(main);
    guards?.update(security);
  }

  /** 退出流程开始：之后的窗口关闭不再被 close-to-hide 拦截。 */
  beginShutdown(): void {
    this.quitting = true;
  }

  /** 关闭所有窗口；配合 `beginShutdown` 使用可确保退出不被拦截。 */
  closeAll(): void {
    this.beginShutdown();
    const config = this.configWindow;
    if (config !== null && !config.isDestroyed()) config.close();
    const main = this.mainWindow;
    if (main !== null && !main.isDestroyed()) main.close();
  }

  private applyMode(window: T, config: WindowConfig, capabilities: PlatformCapabilities): WindowMode {
    window.setKiosk(false);
    window.setFullScreen(false);

    if (config.mode === 'kiosk' && capabilities.kiosk.supported) {
      window.setKiosk(true);
      return 'kiosk';
    }

    if (config.mode === 'kiosk') {
      this.emit({
        type: 'window-policy-degraded',
        window: 'main',
        field: 'mode',
        reason: `Kiosk 模式不可用，按全屏降级：${capabilities.kiosk.reason ?? '平台不支持 Kiosk'}`,
      });
    }

    if (config.mode !== 'window') {
      if (capabilities.fullscreen.supported) {
        window.setFullScreen(true);
        return 'fullscreen';
      }
      const requested = config.mode === 'kiosk' ? 'Kiosk' : '全屏';
      this.emit({
        type: 'window-policy-degraded',
        window: 'main',
        field: 'mode',
        reason: `${requested}模式不可用，已降级为普通窗口：${capabilities.fullscreen.reason ?? '平台不支持全屏'}`,
      });
      return 'window';
    }

    return 'window';
  }

  private applyAlwaysOnTop(
    window: T,
    config: WindowConfig,
    capabilities: PlatformCapabilities,
  ): MappedWindowLevel {
    if (!config.alwaysOnTop) {
      window.setAlwaysOnTop(false);
      return mapAlwaysOnTopLevel('normal', capabilities);
    }

    const mapped = mapAlwaysOnTopLevel(config.alwaysOnTopLevel, capabilities);
    window.setAlwaysOnTop(mapped.alwaysOnTop, mapped.alwaysOnTop ? mapped.electronLevel : undefined);

    if (mapped.degraded) {
      this.emit({
        type: 'window-policy-degraded',
        window: 'main',
        field: 'alwaysOnTop',
        reason: mapped.reason ?? `置顶层级 ${config.alwaysOnTopLevel} 已降级`,
      });
    }

    return mapped;
  }

  private applyDisplay(window: T, config: WindowConfig, capabilities: PlatformCapabilities): void {
    const screen = this.deps.screen;
    if (screen === undefined) return;

    if (!capabilities.displaySelection.available) {
      this.emit({
        type: 'window-policy-degraded',
        window: 'main',
        field: 'display',
        reason: `显示器选择能力不可用，保持默认位置：${capabilities.displaySelection.reason ?? '未说明原因'}`,
      });
      return;
    }

    const displays = screen.getAllDisplays();
    if (displays.length === 0) {
      this.emit({
        type: 'window-policy-degraded',
        window: 'main',
        field: 'display',
        reason: '未探测到可用显示器，保持默认位置',
      });
      return;
    }

    const requested = findDisplay(displays, config.display);
    const target = requested ?? this.primaryDisplay(screen) ?? displays[0];
    if (requested === null && config.display !== 'primary') {
      this.emit({
        type: 'window-policy-degraded',
        window: 'main',
        field: 'display',
        reason: `未找到显示器 ${config.display}，已回退到 ${target.label ?? String(target.id)}`,
      });
    }

    window.setBounds(centerWindowBounds(window.getBounds(), target));
  }

  private primaryDisplay(screen: ScreenLike): DisplayLike | null {
    try {
      return screen.getPrimaryDisplay() ?? null;
    } catch {
      return null;
    }
  }

  private registerMainWindowLifecycle(window: T): void {
    window.on('close', (event) => {
      if (this.quitting) return;

      const policy = this.windowPolicy;
      const mode = policy?.window.mode ?? 'window';
      const closeAction = policy?.window.closeAction ?? 'hide';
      // 规格 §8：Kiosk 模式限制退出，一律转为隐藏，由托盘或维护入口退出。
      const action = mode === 'kiosk' ? 'hide' : closeAction;

      if (action === 'hide') {
        event?.preventDefault();
        window.hide();
        this.emit({ type: 'close-action', window: 'main', action: 'hide' });
        return;
      }

      this.pendingQuit = true;
      this.emit({ type: 'close-action', window: 'main', action: 'quit' });
    });

    window.on('closed', () => {
      const shouldQuit = this.pendingQuit;
      this.pendingQuit = false;
      this.releaseWindow(window);
      if (shouldQuit) this.deps.quitApp?.();
    });
  }

  private installGuards(
    window: T,
    security: SecurityConfig,
    owner: 'main' | 'config',
    kiosk: boolean,
  ): void {
    const guards = installNavigationGuards(window, security, {
      kiosk,
      openExternal: this.deps.openExternal,
      onDecision: (record) => {
        this.emit({
          type: 'navigation-guard',
          window: owner,
          kind: record.kind,
          url: record.url,
          action: record.action,
          reason: record.reason,
        });
      },
    });
    this.guards.set(window, guards);
  }

  private releaseWindow(window: T): void {
    this.guards.get(window)?.dispose();
    this.guards.delete(window);
    if (this.mainWindow === window) this.mainWindow = null;
    if (this.configWindow === window) this.configWindow = null;
  }

  private emit(event: WindowManagerEvent): void {
    this.deps.onEvent?.(event);
  }
}

/**
 * 编译期断言：真实 Electron `BrowserWindow` 结构上满足 `BrowserWindowLike`，
 * 主进程可以把 `new BrowserWindow(options)` 直接作为 `createWindow` 注入，
 * 不需要为生产代码保留 any 转换。Electron 升级导致接口变化时这里会先失败。
 */
type ElectronBrowserWindowIsWindowLike = BrowserWindow extends BrowserWindowLike ? true : never;
const electronBrowserWindowTypeCheck: ElectronBrowserWindowIsWindowLike = true;
void electronBrowserWindowTypeCheck;
