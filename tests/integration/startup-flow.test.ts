import { describe, expect, it, vi } from 'vitest';

import { createDefaultConfig } from '../../src/main/config/config-schema';
import type { ConfigLoadResult } from '../../src/main/config/config-store';
import {
  AppController,
  type AppControllerDeps,
  type TrayActions,
  type TrayPort,
  type WindowPort,
} from '../../src/main/app-controller';
import { resolveConfigPaths, type ResolvedConfigPaths } from '../../src/main/platform/config-paths';
import type { PlatformCapabilities } from '../../src/main/platform/platform-adapter';
import { LOGIN_LAUNCH_FLAG } from '../../src/main/instance/single-instance';
import type { LoginItemPort } from '../../src/main/startup/startup-manager';
import type { ShortcutTarget } from '../../src/main/tray/tray-manager';

/**
 * 覆盖规格 v2.1 §9/§10 的端到端启动流程：
 * 登录自启按配置应用、托盘四个固定动作、无托盘降级不影响启动、
 * 焦点快捷键仅在窗口聚焦时生效、关闭时释放全部资源。
 */

const PATHS: ResolvedConfigPaths = resolveConfigPaths({
  platform: 'linux',
  homeDir: '/home/tester',
  env: {},
  argv: ['app', '--config-dir=/etc/uni'],
});

function capabilities(overrides: Partial<PlatformCapabilities> = {}): PlatformCapabilities {
  return {
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
    ...overrides,
  };
}

function createFakeWindow() {
  const calls: string[] = [];
  let configWindowOpen = false;
  let mainVisible = false;

  const window: WindowPort = {
    async openConfigWindow(reason) {
      calls.push(`openConfigWindow:${reason}`);
      configWindowOpen = true;
    },
    async createMainWindow() {
      calls.push('createMainWindow');
      mainVisible = true;
    },
    async showAndFocusMain() {
      calls.push('showAndFocusMain');
      mainVisible = true;
    },
    async hideMain() {
      calls.push('hideMain');
      mainVisible = false;
    },
    async reloadMain() {
      calls.push('reloadMain');
    },
    isMainWindowVisible: () => mainVisible,
    isConfigWindowOpen: () => configWindowOpen,
    focusConfigWindow() {
      calls.push('focusConfigWindow');
    },
  };

  return { window, calls };
}

function createFakeTray() {
  const calls: string[] = [];
  const created: TrayActions[] = [];
  const port: TrayPort = {
    create(actions) {
      calls.push('create');
      created.push(actions);
      return { ok: true };
    },
    destroy() {
      calls.push('destroy');
    },
  };
  return { port, calls, created };
}

function createFakeLoginItem() {
  const applied: boolean[] = [];
  const port: LoginItemPort = {
    platform: 'linux',
    async apply(enabled) {
      applied.push(enabled);
      return { ok: true, location: '/home/tester/.config/autostart/uni-shell.desktop' };
    },
    async query() {
      return applied[applied.length - 1] ?? false;
    },
  };
  return { port, applied };
}

/** 假快捷键宿主，可控制焦点与派发按键。 */
function createFakeShortcutTarget() {
  let focused = true;
  const invocations: number[] = [];
  let handler: ((event: unknown) => void) | undefined;

  const target: ShortcutTarget = {
    isFocused: () => focused,
    onBeforeInput(next) {
      handler = next as (event: unknown) => void;
    },
  };

  return {
    target,
    invocations,
    setFocused(value: boolean) {
      focused = value;
    },
    press(keys: { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }) {
      handler?.({
        key: keys.key,
        control: keys.ctrl ?? false,
        alt: keys.alt ?? false,
        shift: keys.shift ?? false,
        meta: keys.meta ?? false,
        preventDefault: () => {},
      });
    },
    get registered() {
      return handler !== undefined;
    },
  };
}

function createDeps(overrides: Partial<AppControllerDeps> = {}) {
  const fakeWindow = createFakeWindow();
  const fakeTray = createFakeTray();
  const fakeLoginItem = createFakeLoginItem();
  const fakeShortcut = createFakeShortcutTarget();
  const logs: Array<{ level: string; event: string; data?: unknown }> = [];

  const deps: AppControllerDeps = {
    resolvePaths: () => PATHS,
    loadConfig: async (): Promise<ConfigLoadResult> => ({
      status: 'loaded',
      path: PATHS.configPath,
      source: 'cli',
      config: createDefaultConfig('https://example.com'),
    }),
    capabilities: capabilities(),
    window: fakeWindow.window,
    tray: fakeTray.port,
    loginItem: fakeLoginItem.port,
    shortcutTarget: fakeShortcut.target,
    log: {
      info: (event, data) => logs.push({ level: 'info', event, data }),
      warn: (event, data) => logs.push({ level: 'warn', event, data }),
      error: (event, data) => logs.push({ level: 'error', event, data }),
    },
    ...overrides,
  };

  return { deps, fakeWindow, fakeTray, fakeLoginItem, fakeShortcut, logs };
}

describe('登录自启接入', () => {
  it('配置 openAtLogin=true 时启动即写入登录项', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, openAtLogin: true } };
    const { deps, fakeLoginItem } = createDeps({
      loadConfig: async () => ({ status: 'loaded', path: PATHS.configPath, source: 'cli', config }),
    });

    await new AppController(deps).start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeLoginItem.applied).toEqual([true]);
  });

  it('配置 openAtLogin=false 时不写入登录项', async () => {
    const { deps, fakeLoginItem } = createDeps();

    await new AppController(deps).start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeLoginItem.applied).toEqual([]);
  });

  it('登录启动时按配置延迟，手动启动立即执行', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = {
      ...base,
      startup: { ...base.startup, delaySec: 30, delayOnlyOnLogin: true, openAtLogin: true },
    };
    const { deps } = createDeps({
      loadConfig: async () => ({ status: 'loaded', path: PATHS.configPath, source: 'cli', config }),
    });

    const loginController = new AppController(deps);
    await loginController.start({ argv: ['app', LOGIN_LAUNCH_FLAG], workingDirectory: '/work', env: {} });
    expect(loginController.currentState).toBe('awaiting-delay');

    const manualController = new AppController(deps);
    await manualController.start({ argv: ['app'], workingDirectory: '/work', env: {} });
    expect(manualController.currentState).toBe('running');
  });

  it('未提供登录项端口时不写入也不报错', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, openAtLogin: true } };
    const { deps } = createDeps({
      loginItem: undefined,
      loadConfig: async () => ({ status: 'loaded', path: PATHS.configPath, source: 'cli', config }),
    });

    await expect(
      new AppController(deps).start({ argv: ['app'], workingDirectory: '/work', env: {} }),
    ).resolves.toBeUndefined();
  });
});

describe('托盘接入', () => {
  it('托盘可用时创建并暴露四个固定动作', async () => {
    const { deps, fakeTray } = createDeps();

    await new AppController(deps).start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeTray.calls).toContain('create');
    expect(fakeTray.created).toHaveLength(1);
    expect(Object.keys(fakeTray.created[0]).sort()).toEqual(['openConfig', 'quit', 'reload', 'showWindow']);
  });

  it('四个动作分别触发对应窗口能力', async () => {
    const { deps, fakeTray, fakeWindow } = createDeps();
    await new AppController(deps).start({ argv: ['app'], workingDirectory: '/work', env: {} });

    fakeWindow.calls.length = 0;
    const actions = fakeTray.created[0];
    await actions.showWindow();
    await actions.openConfig();
    await actions.reload();

    expect(fakeWindow.calls).toEqual(['showAndFocusMain', 'openConfigWindow:用户从托盘打开配置界面', 'reloadMain']);
  });

  it('托盘「退出程序」触发关闭并释放资源', async () => {
    const release = vi.fn();
    const { deps, fakeTray } = createDeps({ singleInstance: { release } });
    const controller = new AppController(deps);
    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    await fakeTray.created[0].quit();

    expect(release).toHaveBeenCalledTimes(1);
    expect(controller.currentState).toBe('stopped');
    expect(fakeTray.calls).toContain('destroy');
  });

  it('Linux 无托盘协议时降级但不影响启动', async () => {
    const { deps, fakeTray, logs } = createDeps({
      capabilities: capabilities({ tray: { available: false, reason: 'Linux 桌面未提供托盘协议' } }),
    });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeTray.calls).not.toContain('create');
    expect(controller.currentState).toBe('running');
    expect(logs.some((entry) => entry.event === 'tray-degraded')).toBe(true);
  });

  it('托盘创建失败时降级且主窗口仍可创建', async () => {
    const { deps, fakeWindow } = createDeps({
      tray: {
        create: () => ({ ok: false, reason: '托盘协议不可用' }),
        destroy: () => {},
      },
    });

    await new AppController(deps).start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeWindow.calls).toContain('createMainWindow');
  });

  it('未注入托盘端口时降级且不崩溃', async () => {
    const { deps } = createDeps({ tray: undefined });
    const controller = new AppController(deps);

    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(controller.currentState).toBe('running');
  });

  it('配置界面状态下也创建托盘以保留维护入口', async () => {
    const { deps, fakeTray } = createDeps({
      loadConfig: async () => ({ status: 'missing', path: PATHS.configPath, source: 'cli' }),
    });

    await new AppController(deps).start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeTray.calls).toContain('create');
  });
});

describe('焦点快捷键接入', () => {
  it('默认开启时安装快捷键并在聚焦时触发', async () => {
    const { deps, fakeShortcut, fakeWindow } = createDeps();

    await new AppController(deps).start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeShortcut.registered).toBe(true);
    fakeWindow.calls.length = 0;
    fakeShortcut.press({ key: 'F12', ctrl: true, alt: true, shift: true });

    expect(fakeWindow.calls).toEqual(['showAndFocusMain']);
  });

  it('窗口失焦时不触发', async () => {
    const { deps, fakeShortcut, fakeWindow } = createDeps();

    await new AppController(deps).start({ argv: ['app'], workingDirectory: '/work', env: {} });

    fakeShortcut.setFocused(false);
    fakeWindow.calls.length = 0;
    fakeShortcut.press({ key: 'F12', ctrl: true, alt: true, shift: true });

    expect(fakeWindow.calls).not.toContain('showAndFocusMain');
  });

  it('hotkeyEnabled=false 时不安装快捷键', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, maintenance: { ...base.maintenance, hotkeyEnabled: false } };
    const { deps, fakeShortcut, logs } = createDeps({
      loadConfig: async () => ({ status: 'loaded', path: PATHS.configPath, source: 'cli', config }),
    });

    await new AppController(deps).start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeShortcut.registered).toBe(false);
    expect(logs.some((entry) => entry.event === 'shortcut-disabled')).toBe(true);
  });

  it('快捷键绑定非法时记录告警且不崩溃', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, maintenance: { ...base.maintenance, hotkey: 'Ctrl+' } };
    const { deps, fakeShortcut, logs } = createDeps({
      loadConfig: async () => ({ status: 'loaded', path: PATHS.configPath, source: 'cli', config }),
    });

    await new AppController(deps).start({ argv: ['app'], workingDirectory: '/work', env: {} });

    expect(fakeShortcut.registered).toBe(false);
    expect(logs.some((entry) => entry.event === 'shortcut-invalid-binding')).toBe(true);
  });

  it('关闭时解除快捷键监听', async () => {
    const { deps, fakeShortcut, fakeWindow } = createDeps();
    const controller = new AppController(deps);
    await controller.start({ argv: ['app'], workingDirectory: '/work', env: {} });

    await controller.shutdown();
    fakeWindow.calls.length = 0;
    fakeShortcut.press({ key: 'F12', ctrl: true, alt: true, shift: true });

    expect(fakeWindow.calls).not.toContain('showAndFocusMain');
  });
});

describe('关闭时资源释放', () => {
  it('同时释放延迟、托盘、快捷键与单实例锁', async () => {
    const base = createDefaultConfig('https://example.com');
    const config = { ...base, startup: { ...base.startup, delaySec: 30 } };
    const release = vi.fn();
    const { deps, fakeTray, fakeShortcut, fakeWindow } = createDeps({
      loadConfig: async () => ({ status: 'loaded', path: PATHS.configPath, source: 'cli', config }),
      singleInstance: { release },
    });
    const controller = new AppController(deps);
    await controller.start({ argv: ['app', LOGIN_LAUNCH_FLAG], workingDirectory: '/work', env: {} });
    expect(controller.currentState).toBe('awaiting-delay');

    await controller.shutdown();

    expect(fakeTray.calls).toContain('destroy');
    expect(release).toHaveBeenCalledTimes(1);
    expect(controller.currentState).toBe('stopped');

    // 关闭后快捷键不应再触发窗口显示。
    fakeWindow.calls.length = 0;
    fakeShortcut.press({ key: 'F12', ctrl: true, alt: true, shift: true });
    expect(fakeWindow.calls).not.toContain('showAndFocusMain');
  });
});
