import { describe, expect, it, vi } from 'vitest';

import { createDefaultConfig } from '../../src/main/config/config-schema';
import type { AppConfig, WindowConfig } from '../../src/main/config/config-types';
import { deriveCapabilities } from '../../src/main/platform/capability-detector';
import type { PlatformCapabilities, PlatformEnvironment } from '../../src/main/platform/platform-adapter';
import {
  WindowManager,
  centerWindowBounds,
  createConfigWindowLoader,
  findDisplay,
  isLocalDevelopmentUrl,
  type BrowserWindowConstructorOptions,
  type BrowserWindowLike,
  type DisplayLike,
  type Rectangle,
  type ScreenLike,
  type WindowManagerEvent,
} from '../../src/main/window/window-manager';
import type { GuardSession, GuardWebContents } from '../../src/main/window/navigation-guard';

/**
 * 窗口管理器集成测试。
 *
 * 覆盖窗口模式（normal/fullscreen/kiosk）、close-to-hide、显示器选择、
 * 配置窗口复用，以及所有窗口创建路径上的安全设置。
 * Electron API 全部由假实现注入（`rules/testing-release.md`）。
 */

const PRIMARY_DISPLAY: DisplayLike = {
  id: 1,
  label: 'Primary',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

const SECONDARY_DISPLAY: DisplayLike = {
  id: 2,
  label: 'HDMI-1',
  bounds: { x: 1920, y: 0, width: 1600, height: 900 },
  workArea: { x: 1920, y: 0, width: 1600, height: 860 },
};

function windowsCapabilities(): PlatformCapabilities {
  return deriveCapabilities({
    platform: 'win32',
    osRelease: '10.0.19045',
    arch: 'x64',
    env: {},
    displays: { count: 2 },
    trayProbed: true,
    trayProtocol: 'windows-notification-area',
  } satisfies PlatformEnvironment);
}

function linuxX11Capabilities(): PlatformCapabilities {
  return deriveCapabilities({
    platform: 'linux',
    osRelease: '6.8.0-45-generic',
    arch: 'x64',
    env: { XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', DISPLAY: ':0' },
    displays: { count: 1 },
    trayProbed: true,
    trayProtocol: 'gtk-status-icon',
  } satisfies PlatformEnvironment);
}

function linuxWaylandCapabilities(): PlatformCapabilities {
  return deriveCapabilities({
    platform: 'linux',
    osRelease: '6.8.0-45-generic',
    arch: 'x64',
    env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', WAYLAND_DISPLAY: 'wayland-0' },
    displays: { count: 1 },
    trayProbed: true,
  } satisfies PlatformEnvironment);
}

function withKioskUnsupported(capabilities: PlatformCapabilities): PlatformCapabilities {
  return { ...capabilities, kiosk: { supported: false, reason: '测试：平台不支持 Kiosk' } };
}

function withFullscreenUnsupported(capabilities: PlatformCapabilities): PlatformCapabilities {
  return { ...capabilities, fullscreen: { supported: false, reason: '测试：平台不支持全屏' } };
}

function withDisplaySelectionUnavailable(capabilities: PlatformCapabilities): PlatformCapabilities {
  return { ...capabilities, displaySelection: { available: false, count: 0, reason: '测试：显示器选择不可用' } };
}

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...createDefaultConfig('https://app.example.com'), ...overrides };
}

function windowConfig(overrides: Partial<WindowConfig> = {}): WindowConfig {
  return {
    mode: 'window',
    alwaysOnTop: false,
    alwaysOnTopLevel: 'normal',
    display: 'primary',
    closeAction: 'hide',
    ...overrides,
  };
}

/** 可拦截事件的最小假实现。 */
class FakeEvent {
  prevented = false;

  preventDefault(): void {
    this.prevented = true;
  }
}

class FakeSession implements GuardSession {
  readonly events = new Map<string, Array<(...args: unknown[]) => void>>();
  permissionHandler: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null =
    null;

  on(event: 'will-download', listener: (...args: unknown[]) => void): unknown {
    const list = this.events.get(event) ?? [];
    list.push(listener);
    this.events.set(event, list);
    return this;
  }

  off(event: 'will-download', listener: (...args: unknown[]) => void): unknown {
    const list = this.events.get(event) ?? [];
    this.events.set(
      event,
      list.filter((registered) => registered !== listener),
    );
    return this;
  }

  setPermissionRequestHandler(
    handler: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null,
  ): void {
    this.permissionHandler = handler;
  }

  requestPermission(permission: string): boolean | undefined {
    let granted: boolean | undefined;
    this.permissionHandler?.(undefined, permission, (value: boolean) => {
      granted = value;
    });
    return granted;
  }
}

class FakeWebContents implements GuardWebContents {
  readonly events = new Map<string, Array<(...args: unknown[]) => void>>();
  private windowOpenHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | null = null;

  constructor(readonly session = new FakeSession()) {}

  on(event: 'will-navigate' | 'will-redirect', listener: (details: { url: string; preventDefault(): void }) => void): unknown {
    const list = this.events.get(event) ?? [];
    list.push(listener);
    this.events.set(event, list);
    return this;
  }

  off(event: 'will-navigate' | 'will-redirect', listener: (details: { url: string; preventDefault(): void }) => void): unknown {
    const list = this.events.get(event) ?? [];
    this.events.set(
      event,
      list.filter((registered) => registered !== listener),
    );
    return this;
  }

  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void {
    this.windowOpenHandler = handler;
  }

  emitNavigate(url: string, event = 'will-navigate'): FakeEvent {
    const details = Object.assign(new FakeEvent(), { url });
    for (const listener of [...(this.events.get(event) ?? [])]) {
      listener(details);
    }
    return details;
  }

  listenerCount(event: string): number {
    return (this.events.get(event) ?? []).length;
  }
}

class FakeWindow implements BrowserWindowLike {
  readonly calls: string[] = [];
  readonly webContents = new FakeWebContents();
  readonly closeListeners: Array<(event?: { preventDefault(): void }) => void> = [];
  readonly closedListeners: Array<() => void> = [];
  readonly loadURLCalls: string[] = [];
  readonly loadFileCalls: string[] = [];
  bounds: Rectangle = { x: 0, y: 0, width: 1280, height: 800 };
  destroyed = false;
  visible = false;
  focused = false;
  minimized = false;
  fullscreen = false;
  kiosk = false;
  alwaysOnTop: { flag: boolean; level?: string } = { flag: false };
  loadFailure: Error | null = null;

  async loadURL(url: string): Promise<void> {
    this.calls.push(`loadURL:${url}`);
    this.loadURLCalls.push(url);
    if (this.loadFailure) throw this.loadFailure;
  }

  async loadFile(filePath: string): Promise<void> {
    this.calls.push(`loadFile:${filePath}`);
    this.loadFileCalls.push(filePath);
  }

  on(event: 'close' | 'closed', listener: (event?: { preventDefault(): void }) => void): unknown {
    if (event === 'close') this.closeListeners.push(listener);
    else this.closedListeners.push(listener);
    return this;
  }

  getBounds(): Rectangle {
    return this.bounds;
  }

  setBounds(bounds: Partial<Rectangle>): void {
    this.calls.push('setBounds');
    this.bounds = { ...this.bounds, ...bounds };
  }

  setFullScreen(flag: boolean): void {
    this.calls.push(`setFullScreen:${String(flag)}`);
    this.fullscreen = flag;
  }

  isFullScreen(): boolean {
    return this.fullscreen;
  }

  setKiosk(flag: boolean): void {
    this.calls.push(`setKiosk:${String(flag)}`);
    this.kiosk = flag;
  }

  isKiosk(): boolean {
    return this.kiosk;
  }

  setAlwaysOnTop(flag: boolean, level?: string): void {
    this.calls.push(`setAlwaysOnTop:${String(flag)}:${level ?? ''}`);
    this.alwaysOnTop = { flag, level };
  }

  isFocused(): boolean {
    return this.focused;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isVisible(): boolean {
    return this.visible;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  restore(): void {
    this.calls.push('restore');
    this.minimized = false;
  }

  show(): void {
    this.calls.push('show');
    this.visible = true;
  }

  focus(): void {
    this.calls.push('focus');
    this.focused = true;
  }

  hide(): void {
    this.calls.push('hide');
    this.visible = false;
  }

  /** 模拟 Electron：close 事件未被拦截时窗口真正关闭。 */
  close(): void {
    this.calls.push('close');
    const event = new FakeEvent();
    for (const listener of [...this.closeListeners]) listener(event);
    if (event.prevented) return;
    this.destroyed = true;
    for (const listener of [...this.closedListeners]) listener();
  }

  destroy(): void {
    this.calls.push('destroy');
    this.destroyed = true;
    for (const listener of [...this.closedListeners]) listener();
  }
}

class FakeScreen implements ScreenLike {
  constructor(private readonly displays: DisplayLike[]) {}

  getAllDisplays(): DisplayLike[] {
    return this.displays;
  }

  getPrimaryDisplay(): DisplayLike {
    return this.displays[0];
  }
}

interface ManagerHarness {
  manager: WindowManager<FakeWindow>;
  created: FakeWindow[];
  optionsLog: BrowserWindowConstructorOptions[];
  events: WindowManagerEvent[];
  quitApp: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  /** 最近一次创建的主窗口。 */
  mainWindow(): FakeWindow;
  configWindow(): FakeWindow;
  degradedReasons(): string[];
}

function createManager(
  options: {
    capabilities?: PlatformCapabilities;
    displays?: DisplayLike[];
    screen?: ScreenLike;
  } = {},
): ManagerHarness {
  const created: FakeWindow[] = [];
  const optionsLog: BrowserWindowConstructorOptions[] = [];
  const events: WindowManagerEvent[] = [];
  const quitApp = vi.fn();
  const openExternal = vi.fn();

  const manager = new WindowManager<FakeWindow>({
    createWindow: (windowOptions) => {
      optionsLog.push(windowOptions);
      const window = new FakeWindow();
      created.push(window);
      return window;
    },
    capabilities: options.capabilities ?? windowsCapabilities(),
    screen: 'screen' in options ? options.screen : new FakeScreen(options.displays ?? [PRIMARY_DISPLAY, SECONDARY_DISPLAY]),
    preloadPath: '/app/dist/preload/index.cjs',
    loadConfigWindow: async (window) => {
      await window.loadFile('/app/dist/renderer/config/index.html');
    },
    quitApp,
    openExternal,
    onEvent: (event) => events.push(event),
  });

  return {
    manager,
    created,
    optionsLog,
    events,
    quitApp,
    openExternal,
    mainWindow: () => {
      const window = created[created.length - 1];
      if (!window) throw new Error('尚未创建窗口');
      return window;
    },
    configWindow: () => {
      const window = created[created.length - 1];
      if (!window) throw new Error('尚未创建窗口');
      return window;
    },
    degradedReasons: () =>
      events
        .filter((event): event is Extract<WindowManagerEvent, { type: 'window-policy-degraded' }> => event.type === 'window-policy-degraded')
        .map((event) => event.reason),
  };
}

describe('安全窗口创建', () => {
  it('主窗口关闭 Node 集成并启用上下文隔离与沙箱，且不带 preload', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig());

    const options = harness.optionsLog[0];
    expect(options.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    });
    expect(options.webPreferences).not.toHaveProperty('preload');
    expect(harness.mainWindow().loadURLCalls).toEqual(['https://app.example.com']);
  });

  it('配置窗口使用最小 preload，并保持同样的安全设置', () => {
    const harness = createManager();
    harness.manager.openConfigWindow();

    const options = harness.optionsLog[0];
    expect(options.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    });
    expect(options.webPreferences?.preload).toBe('/app/dist/preload/index.cjs');
    expect(harness.configWindow().loadFileCalls).toEqual(['/app/dist/renderer/config/index.html']);
  });

  it('所有窗口创建路径都使用安全 webPreferences', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig());
    harness.manager.openConfigWindow();

    expect(harness.optionsLog.length).toBe(2);
    for (const options of harness.optionsLog) {
      expect(options.webPreferences).toMatchObject({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      });
    }
  });

  it('每个窗口创建后都安装导航守卫', async () => {
    const harness = createManager();
    const main = await harness.manager.createMainWindow(
      appConfig({
        security: {
          allowedOrigins: ['https://app.example.com'],
          allowExternalLinks: false,
          allowPopups: false,
          allowDownloads: false,
        },
      }),
    );
    harness.manager.openConfigWindow();
    const config = harness.created[1];

    expect(main.webContents.emitNavigate('https://evil.example.com/').prevented).toBe(true);
    expect(main.webContents.emitNavigate('https://app.example.com/dashboard').prevented).toBe(false);
    // 配置窗口使用本地拒绝策略：任何页面内导航都被阻止。
    expect(config.webContents.emitNavigate('https://app.example.com/').prevented).toBe(true);
    expect(main.webContents.session.requestPermission('media')).toBe(false);
  });

  it('重复创建主窗口时复用已有窗口并刷新策略', async () => {
    const harness = createManager();
    const first = await harness.manager.createMainWindow(appConfig());
    const second = await harness.manager.createMainWindow(appConfig({ window: windowConfig({ mode: 'fullscreen' }) }));

    expect(second).toBe(first);
    expect(harness.optionsLog.length).toBe(1);
    expect(first.calls).toContain('setFullScreen:true');
    expect(first.calls).toContain('focus');
  });

  it('目标页加载失败时仍然返回窗口，并记录加载失败事件', async () => {
    const failing = new FakeWindow();
    failing.loadFailure = new Error('ERR_NAME_NOT_RESOLVED');
    const events: WindowManagerEvent[] = [];
    const manager = new WindowManager<FakeWindow>({
      createWindow: () => failing,
      capabilities: windowsCapabilities(),
      screen: new FakeScreen([PRIMARY_DISPLAY]),
      preloadPath: '/app/dist/preload/index.cjs',
      loadConfigWindow: async (window) => {
        await window.loadFile('/app/dist/renderer/config/index.html');
      },
      onEvent: (event) => events.push(event),
    });

    const window = await manager.createMainWindow(appConfig());

    expect(window).toBe(failing);
    expect(manager.getMainWindow()).toBe(failing);
    expect(events.filter((event) => event.type === 'main-load-failed')).toHaveLength(1);
  });
});

describe('窗口模式', () => {
  it('普通模式关闭全屏与 Kiosk', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig());

    expect(harness.mainWindow().calls).toContain('setFullScreen:false');
    expect(harness.mainWindow().calls).toContain('setKiosk:false');
  });

  it('全屏模式请求全屏', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig({ window: windowConfig({ mode: 'fullscreen' }) }));

    expect(harness.mainWindow().calls).toContain('setFullScreen:true');
    expect(harness.mainWindow().calls).not.toContain('setKiosk:true');
  });

  it('Kiosk 模式请求 Kiosk', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig({ window: windowConfig({ mode: 'kiosk' }) }));

    expect(harness.mainWindow().calls).toContain('setKiosk:true');
  });

  it('平台不支持 Kiosk 时降级为全屏', async () => {
    const harness = createManager({ capabilities: withKioskUnsupported(windowsCapabilities()) });
    await harness.manager.createMainWindow(appConfig({ window: windowConfig({ mode: 'kiosk' }) }));

    expect(harness.mainWindow().calls).not.toContain('setKiosk:true');
    expect(harness.mainWindow().calls).toContain('setFullScreen:true');
    expect(harness.degradedReasons().join(' ')).toContain('Kiosk');
  });

  it('平台不支持全屏时降级为普通窗口', async () => {
    const harness = createManager({ capabilities: withFullscreenUnsupported(windowsCapabilities()) });
    await harness.manager.createMainWindow(appConfig({ window: windowConfig({ mode: 'fullscreen' }) }));

    expect(harness.mainWindow().calls).not.toContain('setFullScreen:true');
    expect(harness.degradedReasons().join(' ')).toContain('全屏');
  });

  it('Kiosk 与全屏都不可用时降级为普通窗口', async () => {
    const capabilities = withKioskUnsupported(withFullscreenUnsupported(windowsCapabilities()));
    const harness = createManager({ capabilities });
    await harness.manager.createMainWindow(appConfig({ window: windowConfig({ mode: 'kiosk' }) }));

    expect(harness.mainWindow().calls).not.toContain('setKiosk:true');
    expect(harness.mainWindow().calls).not.toContain('setFullScreen:true');
  });
});

describe('关闭行为', () => {
  it('closeAction=hide 时关闭转为隐藏，窗口不被销毁', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig());
    const main = harness.mainWindow();
    main.show();

    main.close();

    expect(main.calls).toContain('hide');
    expect(main.isDestroyed()).toBe(false);
    expect(main.isVisible()).toBe(false);
    expect(harness.quitApp).not.toHaveBeenCalled();
  });

  it('closeAction=quit 时关闭放行并退出应用', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig({ window: windowConfig({ closeAction: 'quit' }) }));
    const main = harness.mainWindow();

    main.close();

    expect(main.isDestroyed()).toBe(true);
    expect(harness.quitApp).toHaveBeenCalledTimes(1);
  });

  it('Kiosk 模式限制退出，即使配置为 quit 也转为隐藏', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(
      appConfig({ window: windowConfig({ mode: 'kiosk', closeAction: 'quit' }) }),
    );
    const main = harness.mainWindow();

    main.close();

    expect(main.isDestroyed()).toBe(false);
    expect(main.calls).toContain('hide');
    expect(harness.quitApp).not.toHaveBeenCalled();
  });

  it('beginShutdown 后关闭不再被拦截', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig());
    const main = harness.mainWindow();

    harness.manager.beginShutdown();
    main.close();

    expect(main.isDestroyed()).toBe(true);
    expect(main.calls).not.toContain('hide');
  });

  it('closeAll 关闭配置窗口与主窗口', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig());
    harness.manager.openConfigWindow();
    const config = harness.created[1];

    harness.manager.closeAll();

    expect(config.isDestroyed()).toBe(true);
    expect(harness.mainWindow().isDestroyed()).toBe(true);
    expect(harness.manager.getConfigWindow()).toBeNull();
    expect(harness.manager.getMainWindow()).toBeNull();
  });
});

describe('显示器选择', () => {
  it('按显示器标识把窗口放到目标显示器中心', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig({ window: windowConfig({ display: '2' }) }));

    expect(harness.mainWindow().bounds).toEqual({ x: 2080, y: 30, width: 1280, height: 800 });
  });

  it('primary 使用主显示器', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig());

    expect(harness.mainWindow().bounds).toEqual({ x: 320, y: 120, width: 1280, height: 800 });
  });

  it('找不到目标显示器时回退主显示器并记录降级', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig({ window: windowConfig({ display: 'VGA-9' }) }));

    expect(harness.mainWindow().bounds).toEqual({ x: 320, y: 120, width: 1280, height: 800 });
    expect(harness.degradedReasons().join(' ')).toContain('VGA-9');
  });

  it('显示器选择能力不可用时保持默认位置并记录降级', async () => {
    const harness = createManager({ capabilities: withDisplaySelectionUnavailable(windowsCapabilities()) });
    await harness.manager.createMainWindow(appConfig({ window: windowConfig({ display: '2' }) }));

    expect(harness.mainWindow().calls).not.toContain('setBounds');
    expect(harness.degradedReasons().join(' ')).toContain('显示器');
  });

  it('未注入 screen 时不移动窗口', async () => {
    const harness = createManager({ screen: undefined });
    await harness.manager.createMainWindow(appConfig({ window: windowConfig({ display: '2' }) }));

    expect(harness.mainWindow().calls).not.toContain('setBounds');
  });
});

describe('置顶层级', () => {
  it('Windows 上按配置层级请求置顶', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(
      appConfig({ window: windowConfig({ alwaysOnTop: true, alwaysOnTopLevel: 'floating' }) }),
    );

    expect(harness.mainWindow().calls).toContain('setAlwaysOnTop:true:floating');
    expect(harness.degradedReasons()).toEqual([]);
  });

  it('未启用置顶时显式取消置顶', async () => {
    const harness = createManager();
    await harness.manager.createMainWindow(appConfig());

    expect(harness.mainWindow().calls).toContain('setAlwaysOnTop:false:');
  });

  it('Linux Wayland 上置顶降级为不置顶并记录原因', async () => {
    const harness = createManager({ capabilities: linuxWaylandCapabilities() });
    await harness.manager.createMainWindow(
      appConfig({ window: windowConfig({ alwaysOnTop: true, alwaysOnTopLevel: 'floating' }) }),
    );

    expect(harness.mainWindow().calls).toContain('setAlwaysOnTop:false:');
    expect(harness.degradedReasons().join(' ')).toContain('Wayland');
  });

  it('Linux X11 上置顶由窗口管理器决定，记录降级', async () => {
    const harness = createManager({ capabilities: linuxX11Capabilities() });
    await harness.manager.createMainWindow(
      appConfig({ window: windowConfig({ alwaysOnTop: true, alwaysOnTopLevel: 'pop-up-menu' }) }),
    );

    expect(harness.mainWindow().calls).toContain('setAlwaysOnTop:true:pop-up-menu');
    expect(harness.degradedReasons().join(' ')).toContain('窗口管理器');
  });

  it('applyWindowPolicy 可对已有窗口重新应用策略', async () => {
    const harness = createManager();
    const main = await harness.manager.createMainWindow(appConfig());
    main.calls.length = 0;

    harness.manager.applyWindowPolicy(windowConfig({ mode: 'fullscreen' }), windowsCapabilities());

    expect(main.calls).toContain('setFullScreen:true');
  });
});

describe('配置窗口复用', () => {
  it('已打开时复用同一窗口并聚焦', () => {
    const harness = createManager();
    const first = harness.manager.openConfigWindow();
    const second = harness.manager.openConfigWindow();

    expect(second).toBe(first);
    expect(harness.optionsLog.length).toBe(1);
    expect(second.calls).toContain('show');
    expect(second.calls).toContain('focus');
    expect(harness.events.filter((event) => event.type === 'config-window-reused').length).toBe(1);
  });

  it('窗口关闭后可以重新打开', () => {
    const harness = createManager();
    const first = harness.manager.openConfigWindow();
    first.close();

    const second = harness.manager.openConfigWindow();

    expect(second).not.toBe(first);
    expect(harness.optionsLog.length).toBe(2);
  });
});

describe('主窗口显示与安全策略更新', () => {
  it('showMainWindow 恢复最小化并聚焦', async () => {
    const harness = createManager();
    const main = await harness.manager.createMainWindow(appConfig());
    main.minimized = true;
    main.visible = false;

    expect(harness.manager.showMainWindow()).toBe(true);
    expect(main.calls).toContain('restore');
    expect(main.calls).toContain('show');
    expect(main.calls).toContain('focus');
  });

  it('没有主窗口时 showMainWindow 返回 false', () => {
    const harness = createManager();
    expect(harness.manager.showMainWindow()).toBe(false);
  });

  it('updateSecurity 热替换主窗口的授权源', async () => {
    const harness = createManager();
    const main = await harness.manager.createMainWindow(appConfig());

    harness.manager.updateSecurity({
      allowedOrigins: [],
      allowExternalLinks: false,
      allowPopups: false,
      allowDownloads: false,
    });

    expect(main.webContents.emitNavigate('https://app.example.com/').prevented).toBe(true);
  });

  it('导航守卫决策通过事件上报', async () => {
    const harness = createManager();
    const main = await harness.manager.createMainWindow(appConfig());

    main.webContents.emitNavigate('https://evil.example.com/');

    const guardEvents = harness.events.filter((event) => event.type === 'navigation-guard');
    expect(guardEvents.length).toBeGreaterThan(0);
    expect(guardEvents[0]).toMatchObject({ kind: 'navigation', url: 'https://evil.example.com/', action: 'block' });
  });

  it('外链决策调用注入的 openExternal', async () => {
    const harness = createManager();
    const main = await harness.manager.createMainWindow(
      appConfig({
        security: {
          allowedOrigins: ['https://app.example.com'],
          allowExternalLinks: true,
          allowPopups: false,
          allowDownloads: false,
        },
      }),
    );

    main.webContents.emitNavigate('https://docs.example.com/help');
    expect(harness.openExternal).toHaveBeenCalledWith('https://docs.example.com/help');
  });
});

describe('纯辅助函数', () => {
  it('centerWindowBounds 在目标显示器工作区内居中', () => {
    expect(centerWindowBounds({ x: 0, y: 0, width: 1280, height: 800 }, PRIMARY_DISPLAY)).toEqual({
      x: 320,
      y: 120,
      width: 1280,
      height: 800,
    });
    expect(centerWindowBounds({ x: 0, y: 0, width: 1280, height: 800 }, SECONDARY_DISPLAY)).toEqual({
      x: 2080,
      y: 30,
      width: 1280,
      height: 800,
    });
  });

  it('centerWindowBounds 在窗口大于工作区时收敛到工作区尺寸', () => {
    const result = centerWindowBounds({ x: 0, y: 0, width: 4000, height: 3000 }, SECONDARY_DISPLAY);
    expect(result).toEqual({ x: 1920, y: 0, width: 1600, height: 860 });
  });

  it('findDisplay 支持标识与标签，找不到时返回 null', () => {
    expect(findDisplay([PRIMARY_DISPLAY, SECONDARY_DISPLAY], '2')).toBe(SECONDARY_DISPLAY);
    expect(findDisplay([PRIMARY_DISPLAY, SECONDARY_DISPLAY], 'HDMI-1')).toBe(SECONDARY_DISPLAY);
    expect(findDisplay([PRIMARY_DISPLAY, SECONDARY_DISPLAY], 'nope')).toBeNull();
    expect(findDisplay([], '2')).toBeNull();
  });

  it('isLocalDevelopmentUrl 只接受本机 http 地址', () => {
    expect(isLocalDevelopmentUrl('http://localhost:5173')).toBe(true);
    expect(isLocalDevelopmentUrl('http://127.0.0.1:5173')).toBe(true);
    expect(isLocalDevelopmentUrl('http://[::1]:5173')).toBe(true);
    expect(isLocalDevelopmentUrl('http://evil.example.com')).toBe(false);
    expect(isLocalDevelopmentUrl('https://localhost:5173')).toBe(false);
    expect(isLocalDevelopmentUrl('file:///tmp/index.html')).toBe(false);
    expect(isLocalDevelopmentUrl(undefined)).toBe(false);
  });

  it('createConfigWindowLoader 在开发地址可用时加载开发服务器', async () => {
    const window = new FakeWindow();
    const loader = createConfigWindowLoader({
      appPath: '/app',
      devUrl: 'http://localhost:5173',
      rendererEntry: 'dist/renderer/config/index.html',
    });

    await loader(window);

    expect(window.loadURLCalls).toEqual(['http://localhost:5173']);
    expect(window.loadFileCalls).toEqual([]);
  });

  it('createConfigWindowLoader 在生产环境加载打包后的本地页面', async () => {
    const window = new FakeWindow();
    const loader = createConfigWindowLoader({
      appPath: '/app',
      devUrl: process.env.ELECTRON_RENDERER_URL,
      rendererEntry: 'dist/renderer/config/index.html',
    });

    await loader(window);

    expect(window.loadFileCalls).toEqual(['/app/dist/renderer/config/index.html']);
    expect(window.loadURLCalls).toEqual([]);
  });

  it('createConfigWindowLoader 拒绝非本机开发地址', async () => {
    const window = new FakeWindow();
    const loader = createConfigWindowLoader({ appPath: '/app', devUrl: 'http://evil.example.com' });

    await loader(window);

    expect(window.loadURLCalls).toEqual([]);
    expect(window.loadFileCalls).toEqual(['/app/dist/renderer/config/index.html']);
  });
});
