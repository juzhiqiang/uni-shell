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
 * - 两类窗口都以 `show: false` 加占位底色创建，等 `ready-to-show` 再按
 *   `startup.initialState` 显示（见 `InitialReveal`），避免首屏白闪；
 * - Electron API 通过 `createWindow` 等注入端口传入（`rules/testing-release.md`），
 *   因此本模块可在纯 Node 环境下完整测试；真实 `BrowserWindow` 结构上满足
 *   `BrowserWindowLike`（文件末尾有编译期断言）。
 */

import { posix, win32 } from 'node:path';

import type { BrowserWindow } from 'electron';

import type { AppConfig, InitialState, SecurityConfig, WindowConfig, WindowMode } from '../config/config-types';
import { mapAlwaysOnTopLevel } from '../platform/capability-detector';
import type { MappedWindowLevel, PlatformCapabilities } from '../platform/platform-adapter';
import {
  createLocalConfigSecurityPolicy,
  installNavigationGuards,
  resolveEffectiveSecurityPolicy,
  secureRemoteWebPreferences,
  type GuardEvent,
  type GuardWebContents,
  type NavigationGuardHandle,
  type NavigationGuardRecord,
} from './navigation-guard';
import {
  installSessionPolicy,
  LOCAL_CONFIG_PARTITION,
  REMOTE_PARTITION,
  type SessionPolicyHandle,
} from './session-policy';

const MAIN_WINDOW_WIDTH = 1280;
const MAIN_WINDOW_HEIGHT = 800;
const MAIN_WINDOW_MIN_WIDTH = 640;
const MAIN_WINDOW_MIN_HEIGHT = 480;

const CONFIG_WINDOW_WIDTH = 960;
const CONFIG_WINDOW_HEIGHT = 720;
const CONFIG_WINDOW_MIN_WIDTH = 720;
const CONFIG_WINDOW_MIN_HEIGHT = 560;

const DEFAULT_RENDERER_ENTRY = 'dist/renderer/config/index.html';

/**
 * 窗口就绪前的占位底色。
 *
 * 与配置界面 `--color-bg`（#f5f6f8）、离线页底色（#f4f6f5）一致：
 * 窗口以 `show: false` 创建，首帧绘制完成前由该底色填充，
 * 避免远程页或本地页加载期间先出现一帧操作系统默认的白色空窗。
 */
const WINDOW_BACKGROUND_COLOR = '#f5f6f8';

/**
 * `ready-to-show` 兜底超时。
 *
 * 远程页面挂起（DNS、连接、长任务）时 `ready-to-show` 可能永不触发，
 * 超过该时限仍按初始驻留状态显示，避免窗口始终不出现。
 */
const READY_TO_SHOW_TIMEOUT_MS = 3000;

/** 初始驻留状态对应的首屏显示方式（规格 §6 `startup.initialState`、§9）。 */
type InitialVisibility = 'show' | 'showInactive' | 'hidden';

/** `startup.initialState` → 首屏显示方式：托盘驻留保持隐藏，最小化显示但不抢占焦点。 */
function resolveInitialVisibility(state: InitialState): InitialVisibility {
  if (state === 'tray') return 'hidden';
  if (state === 'minimized') return 'showInactive';
  return 'show';
}

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
  /** 首帧绘制完成前的占位底色，格式为 `#rrggbb` 或 `#aarrggbb`。 */
  backgroundColor?: string;
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
  /** 首帧绘制完成事件；只关心一次，因此只要求 `once`。 */
  once(event: 'ready-to-show', listener: () => void): unknown;
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
  /** 显示但不抢占焦点，用于 `startup.initialState=minimized`。 */
  showInactive(): void;
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
      try {
        await window.loadURL(devUrl);
        return;
      } catch {
        // 开发服务器加载失败时回退到打包后的本地页面
      }
    }
    const pathApi = options.appPath.startsWith('/') ? posix : win32;
    await window.loadFile(pathApi.join(options.appPath, entry));
  };
}

/**
 * 首屏显示时序。
 *
 * 窗口一律以 `show: false` 创建，等 `ready-to-show`（首帧已绘制）再显示，
 * 避免页面加载期间先出现一帧占位底色的空窗；`ready-to-show` 不触发时由兜底
 * 超时补显示，避免远程页挂起导致窗口永不出现。
 *
 * 主动显示请求（托盘「立即显示窗口」、二次启动唤醒）在首帧未就绪时同样挂起，
 * 就绪后统一执行，因此不会为抢显示而牺牲首屏质量。
 *
 * 资源释放（`rules/architecture.md`「所有资源必须可释放」）：
 * - `close`：放弃挂起的自动显示——close-to-hide 之后不得再把窗口弹出来；
 * - `closed`：清除兜底定时器。
 */
class InitialReveal<T extends BrowserWindowLike> {
  private ready = false;
  private disposed = false;
  private pending: (() => void) | null;
  private timer: ReturnType<typeof setTimeout> | null;

  constructor(
    window: T,
    initialAction: (() => void) | null,
    timeoutMs: number = READY_TO_SHOW_TIMEOUT_MS,
  ) {
    this.pending = initialAction;
    window.once('ready-to-show', () => this.markReady());
    this.timer = setTimeout(() => this.markReady(), timeoutMs);
  }

  /** 主动显示；首帧未就绪时挂起，就绪后与初始显示一并执行。 */
  request(action: () => void): void {
    if (this.disposed) return;
    if (this.ready) {
      action();
      return;
    }
    this.pending = action;
  }

  /** 窗口被关闭（含 close-to-hide 的拦截关闭）时放弃挂起的自动显示。 */
  dropPending(): void {
    this.pending = null;
  }

  /** 窗口已销毁：清除兜底定时器并丢弃挂起动作。 */
  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.clearTimer();
  }

  private markReady(): void {
    this.clearTimer();
    if (this.disposed) return;
    this.ready = true;
    const action = this.pending;
    this.pending = null;
    action?.();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
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
  private readonly reveals = new Map<T, InitialReveal<T>>();
  private remoteSessionPolicy: SessionPolicyHandle | null = null;
  private configSessionPolicy: SessionPolicyHandle | null = null;
  private security: SecurityConfig = createLocalConfigSecurityPolicy();
  private windowPolicy: { window: WindowConfig; capabilities: PlatformCapabilities } | null = null;
  private targetUrl: string | undefined;
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
    this.targetUrl = config.targetUrl;
    const effectiveSecurity = resolveEffectiveSecurityPolicy(config.security, config.targetUrl);
    this.security = effectiveSecurity;

    const existing = this.getMainWindow();
    if (existing !== null) {
      this.applyWindowPolicy(config.window, this.deps.capabilities);
      this.updateSecurity(config.security, config.targetUrl);
      this.revealWindow(existing, () => {
        existing.show();
        existing.focus();
      });
      this.emit({ type: 'main-window-reused' });
      return existing;
    }

    const window = this.deps.createWindow({
      width: MAIN_WINDOW_WIDTH,
      height: MAIN_WINDOW_HEIGHT,
      minWidth: MAIN_WINDOW_MIN_WIDTH,
      minHeight: MAIN_WINDOW_MIN_HEIGHT,
      show: false,
      backgroundColor: WINDOW_BACKGROUND_COLOR,
      autoHideMenuBar: true,
      title: 'UniShell',
      webPreferences: {
        ...secureRemoteWebPreferences(),
        partition: REMOTE_PARTITION,
      },
    });
    this.mainWindow = window;

    this.installGuards(window, effectiveSecurity, 'main', config.window.mode === 'kiosk');
    this.attachSessionPolicy(window, effectiveSecurity, 'main', config.window.mode === 'kiosk');
    this.attachInitialReveal(window, resolveInitialVisibility(config.startup.initialState));
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
      this.revealWindow(existing, () => {
        existing.show();
        existing.focus();
      });
      this.emit({ type: 'config-window-reused' });
      return existing;
    }

    const window = this.deps.createWindow({
      width: CONFIG_WINDOW_WIDTH,
      height: CONFIG_WINDOW_HEIGHT,
      minWidth: CONFIG_WINDOW_MIN_WIDTH,
      minHeight: CONFIG_WINDOW_MIN_HEIGHT,
      show: false,
      backgroundColor: WINDOW_BACKGROUND_COLOR,
      autoHideMenuBar: true,
      title: 'UniShell 配置',
      webPreferences: {
        ...secureRemoteWebPreferences(),
        preload: this.deps.preloadPath,
        partition: LOCAL_CONFIG_PARTITION,
      },
    });
    this.configWindow = window;

    this.installGuards(window, createLocalConfigSecurityPolicy(), 'config', false);
    this.attachSessionPolicy(window, createLocalConfigSecurityPolicy(), 'config', false);
    // 配置窗口是用户显式打开的入口（含配置不可用时的首次启动），就绪即显示。
    this.attachInitialReveal(window, 'show');
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
    this.revealWindow(window, () => {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    return true;
  }

  /** 显示并聚焦配置窗口；窗口不存在时返回 false。 */
  focusConfigWindow(): boolean {
    const window = this.getConfigWindow();
    if (window === null) return false;
    this.revealWindow(window, () => {
      window.show();
      window.focus();
    });
    return true;
  }

  /** 配置保存后热替换主窗口的授权源等安全策略。 */
  updateSecurity(security: SecurityConfig, targetUrl?: string): void {
    if (targetUrl !== undefined) this.targetUrl = targetUrl;
    const effectiveSecurity = resolveEffectiveSecurityPolicy(security, this.targetUrl);
    this.security = effectiveSecurity;
    const main = this.getMainWindow();
    const guards = main === null ? undefined : this.guards.get(main);
    guards?.update(effectiveSecurity);
    this.remoteSessionPolicy?.update(effectiveSecurity);
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
    this.remoteSessionPolicy?.dispose();
    this.remoteSessionPolicy = null;
    this.configSessionPolicy?.dispose();
    this.configSessionPolicy = null;
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

  private attachSessionPolicy(
    window: T,
    security: SecurityConfig,
    owner: 'main' | 'config',
    kiosk: boolean,
  ): void {
    const session = window.webContents.session;
    if (!session) return;

    if (owner === 'main') {
      if (this.remoteSessionPolicy) {
        this.remoteSessionPolicy.update(security);
      } else {
        this.remoteSessionPolicy = installSessionPolicy(session, security, {
          kiosk,
          onDecision: (record) => {
            this.emit({
              type: 'navigation-guard',
              window: 'main',
              kind: record.kind,
              url: record.url,
              action: record.action,
              reason: record.reason,
            });
          },
        });
      }
    } else {
      if (this.configSessionPolicy) {
        this.configSessionPolicy.update(security);
      } else {
        this.configSessionPolicy = installSessionPolicy(session, security, {
          kiosk,
          onDecision: (record) => {
            this.emit({
              type: 'navigation-guard',
              window: 'config',
              kind: record.kind,
              url: record.url,
              action: record.action,
              reason: record.reason,
            });
          },
        });
      }
    }
  }

  private releaseWindow(window: T): void {
    try {
      this.guards.get(window)?.dispose();
    } catch {
      // 避免窗口在 closed 事件中触发销毁异常
    }
    this.guards.delete(window);
    this.reveals.delete(window);
    if (this.mainWindow === window) this.mainWindow = null;
    if (this.configWindow === window) {
      this.configWindow = null;
      this.configSessionPolicy?.dispose();
      this.configSessionPolicy = null;
    }
  }

  /**
   * 挂载首屏显示时序，并接管该窗口的生命周期释放。
   * 初始驻留为托盘时不做自动显示，等调用方明确要求（托盘、唤醒）再显示。
   */
  private attachInitialReveal(window: T, visibility: InitialVisibility): void {
    const reveal = new InitialReveal<T>(
      window,
      visibility === 'hidden' ? null : () => this.applyInitialVisibility(window, visibility),
    );
    this.reveals.set(window, reveal);
    // close-to-hide 之后不得再把窗口弹出来；closed 时释放兜底定时器。
    window.on('close', () => reveal.dropPending());
    window.on('closed', () => reveal.dispose());
  }

  /** 首屏显示动作：最小化显示不抢焦点，其余显示并聚焦。 */
  private applyInitialVisibility(window: T, visibility: InitialVisibility): void {
    if (window.isDestroyed()) return;
    if (visibility === 'showInactive') {
      window.showInactive();
      return;
    }
    window.show();
    window.focus();
  }

  /** 主动显示：首帧未就绪时由首屏时序挂起，避免出现占位底色空窗。 */
  private revealWindow(window: T, action: () => void): void {
    const reveal = this.reveals.get(window);
    if (reveal === undefined) {
      action();
      return;
    }
    reveal.request(action);
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
