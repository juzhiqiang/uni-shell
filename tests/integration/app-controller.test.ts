import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultConfig } from '../../src/main/config/config-schema';
import type { ConfigLoadResult } from '../../src/main/config/config-store';
import { createConfigService, type ConfigService } from '../../src/main/config/config-service';
import type { ConfigFileSystem } from '../../src/main/config/config-store';
import {
  AppController,
  createDefaultDelayPort,
  type AppControllerDeps,
  type DelayPort,
  type WindowPort,
} from '../../src/main/app-controller';
import { type LaunchContext } from '../../src/main/instance/single-instance';
import { resolveConfigPaths, type ResolvedConfigPaths } from '../../src/main/platform/config-paths';
import type { PlatformCapabilities } from '../../src/main/platform/platform-adapter';
import { shouldApplyDelay } from '../../src/main/startup/startup-manager';
import type { TrayActions } from '../../src/main/tray/tray-manager';

/**
 * 覆盖规格 v2.1 §4 的启动状态机与唤醒行为：
 * 无效配置进配置界面、有效配置进入启动策略、启动来源解析、延迟状态、关闭时资源清理。
 */

const PATHS: ResolvedConfigPaths = resolveConfigPaths({
  platform: 'linux',
  homeDir: '/home/tester',
  env: {},
  argv: ['app', '--config-dir=/etc/uni'],
});

const CAPABILITIES: PlatformCapabilities = {
  platform: 'linux',
  osVersion: '6.8.0',
  arch: 'x64',
  sessionType: 'x11',
  wayland: false,
  tray: { available: true, protocol: 'gtk-status-icon' },
  alwaysOnTop: { supported: true, levels: ['normal', 'floating', 'pop-up-menu', 'screen-saver'], windowManagerControlled: true },
  fullscreen: { supported: true },
  kiosk: { supported: true },
  loginItem: { supported: true, mechanism: 'xdg-autostart' },
  displaySelection: { available: true, count: 1 },
};

afterEach(() => vi.useRealTimers());

/** 记录调用的假窗口端口。 */
function createFakeWindow() {
  const calls: string[] = [];
  let configWindowOpen = false;
  let mainVisible = false;
  let mainCreated = false;

  const window: WindowPort = {
    async openConfigWindow(reason) {
      calls.push(`openConfigWindow:${reason}`);
      configWindowOpen = true;
    },
    async createMainWindow() {
      calls.push('createMainWindow');
      mainCreated = true;
      mainVisible = true;
    },
    async reloadMain() {
      calls.push('reloadMain');
    },
    async showAndFocusMain() {
      calls.push('showAndFocusMain');
      mainVisible = true;
    },
    async hideMain() {
      calls.push('hideMain');
      mainVisible = false;
    },
    isMainWindowVisible: () => mainVisible,
    isConfigWindowOpen: () => configWindowOpen,
    focusConfigWindow() {
      calls.push('focusConfigWindow');
    },
  };

  return {
    window,
    calls,
    setConfigWindowOpen(value: boolean) {
      configWindowOpen = value;
    },
    setMainVisible(value: boolean) {
      mainVisible = value;
    },
    get mainCreated() {
      return mainCreated;
    },
  };
}

/** 手动推进的假延迟。控制器已通过 shouldApplyDelay 决定是否延迟，端口只需计时。 */
function createFakeDelay() {
  const entries: Array<{ onReady: () => void; cancel: () => void }> = [];

  const delay: DelayPort = {
    run(_config, _context, onReady) {
      let cancelled = false;
      let fired = false;
      const entry = {
        onReady: () => {
          if (cancelled || fired) return;
          fired = true;
          onReady();
        },
        cancel: () => {
          cancelled = true;
        },
      };
      entries.push(entry);
      return {
        cancel: entry.cancel,
        get pending() {
          return !cancelled && !fired;
        },
      };
    },
  };

  return {
    delay,
    get count() {
      return entries.length;
    },
    /** 触发最后一个未取消的延迟，并刷新微任务等待异步收尾完成。 */
    async fire() {
      entries[entries.length - 1]?.onReady();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    cancelAll() {
      for (const entry of entries) entry.cancel();
    },
  };
}

function createTrayFake() {
  const calls: string[] = [];
  let actions: TrayActions | undefined;
  return {
    tray: {
      create(next: TrayActions) {
        calls.push('create');
        actions = next;
        return { ok: true };
      },
      destroy() {
        calls.push('destroy');
      },
    },
    calls,
    get actions() {
      return actions;
    },
  };
}

function loadedResult(config = createDefaultConfig('https://example.com')): ConfigLoadResult {
  return { status: 'loaded', path: PATHS.configPath, source: 'cli', config };
}

function createFakeConfigService(result: ConfigLoadResult = loadedResult(), paths: ResolvedConfigPaths = PATHS): ConfigService {
  let currentResult = result;
  let currentConfig = result.status === 'loaded' ? result.config : undefined;
  return {
    paths,
    load: vi.fn(async () => currentResult),
    reload: vi.fn(async () => currentResult),
    current: () => currentConfig,
    save: vi.fn(async (next) => {
      currentConfig = next;
      currentResult = { status: 'loaded', path: paths.configPath, source: paths.source, config: next };
    }),
    onChange: () => () => {},
  };
}

interface CreateDepsOverrides extends Partial<AppControllerDeps> {
  loadConfig?: () => Promise<ConfigLoadResult>;
}

function createDeps(overrides: CreateDepsOverrides = {}) {
  const fakeWindow = createFakeWindow();
  const fakeDelay = createFakeDelay();
  const logs: Array<{ level: string; event: string; data?: unknown }> = [];

  let configService = overrides.configService;
  if (!configService) {
    if (overrides.loadConfig) {
      const loadFn = overrides.loadConfig;
      let loadedConfig: AppConfig | undefined;
      const fake = {
        paths: PATHS,
        load: vi.fn(async () => {
          const res = await loadFn();
          loadedConfig = res.status === 'loaded' ? res.config : undefined;
          return res;
        }),
        reload: vi.fn(async () => {
          const res = await loadFn();
          loadedConfig = res.status === 'loaded' ? res.config : undefined;
          return res;
        }),
        current: () => loadedConfig,
        save: vi.fn(async () => {}),
        onChange: () => () => {},
      };
      configService = fake;
    } else {
      configService = createFakeConfigService();
    }
  }

  const cleanOverrides = { ...overrides };
  delete cleanOverrides.loadConfig;

  const deps: AppControllerDeps = {
    configService,
    capabilities: CAPABILITIES,
    window: fakeWindow.window,
    delay: fakeDelay.delay,
    log: {
      info: (event, data) => logs.push({ level: 'info', event, data }),
      warn: (event, data) => logs.push({ level: 'warn', event, data }),
      error: (event, data) => logs.push({ level: 'error', event, data }),
      debug: (event, data) => logs.push({ level: 'debug', event, data }),
      close: async () => {},
    },
    ...cleanOverrides,
  };

  return { deps, fakeWindow, fakeDelay, logs };
}

describe('AppController 启动', () => {
  it('有效配置时创建主窗口并进入运行状态', async () => {
    const { deps, fakeWindow } = createDeps();
    const controller = new AppController(deps);

    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeWindow.calls).toContain('createMainWindow');
    expect(controller.state).toBe('running');
  });

  it('启动流程复用 ConfigService，启动只读一次 config.json', async () => {
    let readCount = 0;
    const config = createDefaultConfig('https://example.com');
    const memoryFs: ConfigFileSystem = {
      readFile: vi.fn(async () => {
        readCount += 1;
        return JSON.stringify(config);
      }),
      writeFile: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      access: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    const service = createConfigService({ paths: PATHS, fs: memoryFs });

    // 模拟 main.ts bootstrap 行为：bootstrap 预加载一次
    await service.load();
    expect(readCount).toBe(1);

    // 控制器 start 复用同一 service
    const { deps } = createDeps({ configService: service });
    const controller = new AppController(deps);
    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    // 仍保持 1 次读盘
    expect(readCount).toBe(1);
    expect(controller.state).toBe('running');
  });

  it('无效配置时打开配置界面而不创建主窗口', async () => {
    const { deps, fakeWindow } = createDeps({
      loadConfig: async () => ({
        status: 'invalid',
        path: PATHS.configPath,
        source: 'cli',
        issues: [{ path: 'targetUrl', message: '必须是 http/https', code: 'custom' }],
        reason: '配置校验失败',
      }),
    });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeWindow.calls.some((call) => call.startsWith('openConfigWindow:'))).toBe(true);
    expect(fakeWindow.calls).not.toContain('createMainWindow');
    expect(controller.state).toBe('configuring');
  });

  it('配置缺失时也打开配置界面', async () => {
    const { deps, fakeWindow } = createDeps({
      loadConfig: async () => ({ status: 'missing', path: PATHS.configPath, source: 'cli' }),
    });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeWindow.calls.some((call) => call.startsWith('openConfigWindow:'))).toBe(true);
    expect(controller.state).toBe('configuring');
  });

  it('记录启动来源、配置路径与平台能力', async () => {
    const { deps, logs } = createDeps();
    const controller = new AppController(deps);

    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });

    const events = logs.map((entry) => entry.event);
    expect(events).toContain('startup');
    expect(events).toContain('config-loaded');
    expect(logs.find((entry) => entry.event === 'startup')).toBeDefined();
  });

  it('重复 start 不会重复创建主窗口', async () => {
    const { deps, fakeWindow } = createDeps();
    const controller = new AppController(deps);

    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });
    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeWindow.calls.filter((call) => call === 'createMainWindow')).toHaveLength(1);
  });
});

describe('AppController 页面加载失败', () => {
  it('忽略主框架 ERR_ABORTED，不展示离线页、不重试、不增加失败计数并记录 debug', async () => {
    vi.useFakeTimers();
    const { deps, fakeWindow, logs } = createDeps();
    fakeWindow.window.showOfflinePage = vi.fn(() => fakeWindow.calls.push('showOfflinePage'));
    const controller = new AppController(deps);
    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });
    fakeWindow.calls.length = 0;
    logs.length = 0;

    controller.reportLoadFailure({ errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true });
    await vi.advanceTimersByTimeAsync(3000);
    controller.reportLoadSuccess();

    expect(fakeWindow.calls).not.toContain('showOfflinePage');
    expect(fakeWindow.calls).not.toContain('reloadMain');
    expect(logs).toContainEqual(expect.objectContaining({ level: 'debug', event: 'page-load-aborted' }));
    expect(logs).not.toContainEqual(expect.objectContaining({ level: 'warn', event: 'page-load-failed' }));
    expect(logs).toContainEqual({ level: 'info', event: 'page-load-succeeded', data: { recovered: false } });
    await controller.shutdown();
    vi.useRealTimers();
  });

  it('仍按离线恢复流程处理其他主框架错误', async () => {
    const { deps, fakeWindow, logs } = createDeps();
    fakeWindow.window.showOfflinePage = vi.fn(() => fakeWindow.calls.push('showOfflinePage'));
    const controller = new AppController(deps);
    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });
    fakeWindow.calls.length = 0;
    logs.length = 0;

    controller.reportLoadFailure({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', isMainFrame: true });

    expect(fakeWindow.calls).toContain('showOfflinePage');
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', event: 'page-load-failed' }));
    await controller.shutdown();
  });
});

describe('启动来源与延迟', () => {
  const loginContext = (): LaunchContext => ({
    source: 'login',
    argv: ['app', '--launched-at-login'],
    workingDirectory: '/work',
  });

  it('手动启动且 delayOnlyOnLogin 时不延迟，立即创建主窗口', async () => {
    const config = {
      ...createDefaultConfig('https://example.com'),
      startup: { ...createDefaultConfig('https://example.com').startup, delaySec: 30, delayOnlyOnLogin: true },
    };
    const { deps, fakeDelay } = createDeps({ loadConfig: async () => loadedResult(config) });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeDelay.count).toBe(0);
    expect(controller.state).toBe('running');
  });

  it('登录启动且 delayOnlyOnLogin 时进入等待延迟状态', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, delaySec: 30, delayOnlyOnLogin: true } };
    const { deps, fakeDelay } = createDeps({ loadConfig: async () => loadedResult(config) });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });

    expect(fakeDelay.count).toBe(1);
    expect(controller.state).toBe('awaiting-delay');
  });

  it('delaySec 为 0 时不进入延迟状态', async () => {
    const { deps, fakeDelay } = createDeps();
    const controller = new AppController(deps);

    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });

    expect(fakeDelay.count).toBe(0);
    expect(controller.state).toBe('running');
  });

  it('延迟到期后创建并显示主窗口', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, delaySec: 30 } };
    const { deps, fakeDelay, fakeWindow } = createDeps({ loadConfig: async () => loadedResult(config) });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });
    expect(controller.state).toBe('awaiting-delay');

    await fakeDelay.fire();

    expect(fakeWindow.calls).toContain('createMainWindow');
    expect(controller.state).toBe('running');
  });

  it('showAfterDelay 为 false 时延迟到期仍保持驻留不显示窗口', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = {
      ...base,
      startup: { ...base.startup, delaySec: 30, showAfterDelay: false },
    };
    const { deps, fakeDelay, fakeWindow } = createDeps({ loadConfig: async () => loadedResult(config) });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });
    await fakeDelay.fire();

    expect(fakeWindow.calls).not.toContain('createMainWindow');
    expect(controller.state).toBe('running');
  });

  it('initialState 为 tray 时延迟前保持隐藏', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, initialState: 'tray' as const, delaySec: 30 } };
    const { deps, fakeWindow } = createDeps({ loadConfig: async () => loadedResult(config) });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });

    expect(fakeWindow.calls).toContain('hideMain');
    expect(controller.state).toBe('awaiting-delay');
  });

  it('initialState=tray 时延迟到期创建窗口后显式显示并聚焦', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, initialState: 'tray' as const, delaySec: 30 } };
    const { deps, fakeDelay, fakeWindow } = createDeps({ loadConfig: async () => loadedResult(config) });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });
    await fakeDelay.fire();

    // 窗口按初始驻留状态隐藏创建，控制器必须显式显示，否则托盘驻留时窗口不出现。
    expect(fakeWindow.calls).toEqual(['hideMain', 'createMainWindow', 'showAndFocusMain']);
    expect(fakeWindow.window.isMainWindowVisible()).toBe(true);
  });

  it('initialState=minimized 时延迟到期只创建窗口，不显式抢焦点', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, initialState: 'minimized' as const, delaySec: 30 } };
    const { deps, fakeDelay, fakeWindow } = createDeps({ loadConfig: async () => loadedResult(config) });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });
    await fakeDelay.fire();

    // 最小化由窗口层在 ready-to-show 时以 showInactive 呈现。
    expect(fakeWindow.calls).toEqual(['createMainWindow']);
  });

  it('显式请求显示时即使 initialState=minimized 也创建并聚焦', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, initialState: 'minimized' as const, delaySec: 30 } };
    const { deps, fakeWindow } = createDeps({ loadConfig: async () => loadedResult(config) });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });
    fakeWindow.calls.length = 0;
    await controller.showAndFocusMain();

    expect(fakeWindow.calls).toEqual(['createMainWindow', 'showAndFocusMain']);
    expect(fakeWindow.window.isMainWindowVisible()).toBe(true);
  });

  it('登录上下文由控制器从 argv 推导', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, delaySec: 30, delayOnlyOnLogin: true } };
    const { deps, fakeDelay } = createDeps({ loadConfig: async () => loadedResult(config) });

    const controller = new AppController(deps);
    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });
    expect(fakeDelay.count).toBe(1);

    const second = new AppController(deps);
    await second.start({ argv: ['app'], workingDirectory: '/work', env: {} });
    expect(fakeDelay.count).toBe(1);
  });

  it('shouldApplyDelay 实现规格 §9 的 delayOnlyOnLogin 规则', () => {
    const base = createDefaultConfig('https://a.b').startup;
    const login: LaunchContext = { source: 'login', argv: ['app'], workingDirectory: '/work' };
    const manual: LaunchContext = { source: 'manual', argv: ['app'], workingDirectory: '/work' };

    expect(shouldApplyDelay({ ...base, delaySec: 0 }, login)).toBe(false);
    expect(shouldApplyDelay({ ...base, delaySec: 30 }, login)).toBe(true);
    expect(shouldApplyDelay({ ...base, delaySec: 30 }, manual)).toBe(true);
    expect(shouldApplyDelay({ ...base, delaySec: 30, delayOnlyOnLogin: true }, login)).toBe(true);
    expect(shouldApplyDelay({ ...base, delaySec: 30, delayOnlyOnLogin: true }, manual)).toBe(false);
  });

  it('默认延迟端口按 delaySec 计时', () => {
    vi.useFakeTimers();
    try {
      const port = createDefaultDelayPort();
      const onReady = vi.fn();
      const handle = port.run(
        { ...createDefaultConfig('https://a.b').startup, delaySec: 1 },
        loginContext(),
        onReady,
      );

      expect(handle.pending).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(handle.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('默认延迟端口可取消且取消后不再触发', () => {
    vi.useFakeTimers();
    try {
      const port = createDefaultDelayPort();
      const onReady = vi.fn();
      const handle = port.run(
        { ...createDefaultConfig('https://a.b').startup, delaySec: 30 },
        loginContext(),
        onReady,
      );

      handle.cancel();
      vi.advanceTimersByTime(60000);

      expect(onReady).not.toHaveBeenCalled();
      expect(handle.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AppController 二次启动唤醒', () => {
  it('主窗口隐藏时显示并聚焦', async () => {
    const { deps, fakeWindow } = createDeps();
    const controller = new AppController(deps);
    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    fakeWindow.setMainVisible(false);
    fakeWindow.calls.length = 0;

    await controller.handleSecondLaunch({
      argv: ['app'],
      workingDirectory: '/work',
      source: 'manual',
    });

    expect(fakeWindow.calls).toContain('showAndFocusMain');
  });

  it('倒计时中的二次启动取消倒计时并立即显示', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, delaySec: 30 } };
    const { deps, fakeDelay, fakeWindow } = createDeps({ loadConfig: async () => loadedResult(config) });
    const controller = new AppController(deps);
    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });

    expect(controller.state).toBe('awaiting-delay');
    fakeWindow.calls.length = 0;

    await controller.handleSecondLaunch({ argv: ['app'], workingDirectory: '/work', source: 'manual' });

    expect(fakeWindow.calls).toContain('createMainWindow');
    expect(controller.state).toBe('running');

    // 倒计时已被取消，晚点触发也不应再建窗口。
    fakeWindow.calls.length = 0;
    await fakeDelay.fire();
    expect(fakeWindow.calls).not.toContain('createMainWindow');
  });

  it('配置窗口已打开时聚焦配置窗口而不动主窗口', async () => {
    const { deps, fakeWindow } = createDeps({
      loadConfig: async () => ({ status: 'missing', path: PATHS.configPath, source: 'cli' }),
    });
    const controller = new AppController(deps);
    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    fakeWindow.setConfigWindowOpen(true);
    fakeWindow.calls.length = 0;

    await controller.handleSecondLaunch({ argv: ['app'], workingDirectory: '/work', source: 'manual' });

    expect(fakeWindow.calls).toContain('focusConfigWindow');
    expect(fakeWindow.calls).not.toContain('showAndFocusMain');
    expect(fakeWindow.calls).not.toContain('createMainWindow');
  });

  it('正常运行中的二次启动只聚焦不重建窗口', async () => {
    const { deps, fakeWindow } = createDeps();
    const controller = new AppController(deps);
    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    fakeWindow.calls.length = 0;
    await controller.handleSecondLaunch({ argv: ['app'], workingDirectory: '/work', source: 'manual' });

    expect(fakeWindow.calls).toContain('showAndFocusMain');
    expect(fakeWindow.calls).not.toContain('createMainWindow');
  });

  it('关闭后收到的二次启动被忽略', async () => {
    const { deps, fakeWindow } = createDeps();
    const controller = new AppController(deps);
    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });
    await controller.shutdown();

    fakeWindow.calls.length = 0;
    await controller.handleSecondLaunch({ argv: ['app'], workingDirectory: '/work', source: 'manual' });

    expect(fakeWindow.calls).toHaveLength(0);
  });
});

describe('AppController 托盘与关闭', () => {
  it('创建托盘并暴露四个固定动作', async () => {
    const trayFake = createTrayFake();
    const { deps } = createDeps({ tray: trayFake.tray });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(trayFake.calls).toContain('create');
    expect(typeof trayFake.actions?.showWindow).toBe('function');
    expect(typeof trayFake.actions?.openConfig).toBe('function');
    expect(typeof trayFake.actions?.reload).toBe('function');
    expect(typeof trayFake.actions?.quit).toBe('function');
  });

  it('托盘「立即显示窗口」在倒计时中取消倒计时', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, delaySec: 30 } };
    const trayFake = createTrayFake();
    const { deps, fakeWindow } = createDeps({ loadConfig: async () => loadedResult(config), tray: trayFake.tray });
    const controller = new AppController(deps);
    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });

    fakeWindow.calls.length = 0;
    await trayFake.actions?.showWindow();

    expect(fakeWindow.calls).toContain('createMainWindow');
    expect(controller.state).toBe('running');
  });

  it('关闭时取消延迟、销毁托盘并释放单实例锁', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, delaySec: 30 } };
    const trayFake = createTrayFake();
    const release = vi.fn();
    const { deps } = createDeps({
      loadConfig: async () => loadedResult(config),
      tray: trayFake.tray,
      singleInstance: { release },
    });
    const controller = new AppController(deps);
    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });

    await controller.shutdown();

    expect(trayFake.calls).toContain('destroy');
    expect(release).toHaveBeenCalledTimes(1);
    expect(controller.state).toBe('stopped');
  });

  it('关闭是幂等的，不会重复释放资源', async () => {
    const trayFake = createTrayFake();
    const release = vi.fn();
    const { deps } = createDeps({ tray: trayFake.tray, singleInstance: { release } });
    const controller = new AppController(deps);
    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    await controller.shutdown();
    await controller.shutdown();

    expect(release).toHaveBeenCalledTimes(1);
    expect(trayFake.calls.filter((call) => call === 'destroy')).toHaveLength(1);
  });

  it('关闭时取消仍未触发的延迟', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, delaySec: 30 } };
    const { deps, fakeDelay, fakeWindow } = createDeps({ loadConfig: async () => loadedResult(config) });
    const controller = new AppController(deps);
    await controller.start({ argv: ['app', '--launched-at-login'], workingDirectory: '/work', env: {} });

    await controller.shutdown();
    fakeWindow.calls.length = 0;
    await fakeDelay.fire();

    expect(fakeWindow.calls).not.toContain('createMainWindow');
  });
});
