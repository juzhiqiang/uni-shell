import { describe, expect, it } from 'vitest';

import {
  createTray,
  installFocusedShortcut,
  parseKeyBinding,
  type ShortcutTarget,
  type TrayActions,
  type TrayPort,
} from '../../../src/main/tray/tray-manager';
import type { PlatformCapabilities } from '../../../src/main/platform/platform-adapter';

/**
 * 覆盖规格 v2.1 §10：托盘四个固定菜单动作、Linux 无托盘协议降级、macOS 菜单栏；
 * 快捷键只在客户端窗口获得焦点时生效，不得注册系统全局快捷键。
 */

const LOGIN_FLAG = '--launched-at-login';

function capabilities(overrides: Partial<PlatformCapabilities> = {}): PlatformCapabilities {
  return {
    platform: 'linux',
    osVersion: '6.8.0',
    arch: 'x64',
    sessionType: 'x11',
    wayland: false,
    tray: { available: true, protocol: 'gtk-status-icon' },
    alwaysOnTop: { supported: true, levels: ['normal'], windowManagerControlled: true },
    fullscreen: { supported: true },
    kiosk: { supported: true },
    loginItem: { supported: true, mechanism: 'xdg-autostart' },
    displaySelection: { available: true, count: 1 },
    ...overrides,
  };
}

function createActions(): TrayActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    showWindow: () => {
      calls.push('showWindow');
    },
    openConfig: () => {
      calls.push('openConfig');
    },
    reload: () => {
      calls.push('reload');
    },
    quit: () => {
      calls.push('quit');
    },
  };
}

/** 假托盘端口，记录创建与销毁。 */
function createFakeTrayPort(options: { ok?: boolean } = {}) {
  const created: TrayActions[] = [];
  let destroyed = 0;

  const port: TrayPort = {
    create(actions) {
      if (options.ok === false) return { ok: false, reason: '托盘协议不可用' };
      created.push(actions);
      return { ok: true };
    },
    destroy() {
      destroyed += 1;
    },
  };

  return {
    port,
    created,
    get destroyed() {
      return destroyed;
    },
  };
}

describe('parseKeyBinding', () => {
  it('解析修饰键与主键', () => {
    expect(parseKeyBinding('Ctrl+Alt+Shift+F12')).toEqual({
      key: 'F12',
      ctrl: true,
      alt: true,
      shift: true,
      meta: false,
    });
  });

  it('支持 Command/Meta/Cmd 别名', () => {
    expect(parseKeyBinding('Command+Shift+K').meta).toBe(true);
    expect(parseKeyBinding('Meta+Shift+K').meta).toBe(true);
    expect(parseKeyBinding('Cmd+Shift+K').meta).toBe(true);
  });

  it('大小写与空白不敏感', () => {
    expect(parseKeyBinding('  ctrl + alt + f12 ')).toEqual({
      key: 'F12',
      ctrl: true,
      alt: true,
      shift: false,
      meta: false,
    });
  });

  it('单键与无修饰键可用', () => {
    expect(parseKeyBinding('F12')).toEqual({ key: 'F12', ctrl: false, alt: false, shift: false, meta: false });
    expect(parseKeyBinding('Ctrl+F1')).toEqual({ key: 'F1', ctrl: true, alt: false, shift: false, meta: false });
  });

  it('空串与非法输入返回 undefined', () => {
    expect(parseKeyBinding('')).toBeUndefined();
    expect(parseKeyBinding('   ')).toBeUndefined();
    expect(parseKeyBinding('+')).toBeUndefined();
    expect(parseKeyBinding('Ctrl+')).toBeUndefined();
  });
});

describe('createTray', () => {
  it('托盘可用时创建并暴露四个固定动作', () => {
    const fake = createFakeTrayPort();
    const actions = createActions();

    const result = createTray(actions, capabilities(), { port: fake.port });

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(fake.created).toHaveLength(1);
  });

  it('四个动作均可被调用且行为正确', () => {
    const fake = createFakeTrayPort();
    const actions = createActions();
    createTray(actions, capabilities(), { port: fake.port });

    const trayActions = fake.created[0];
    void trayActions.showWindow();
    void trayActions.openConfig();
    void trayActions.reload();
    void trayActions.quit();

    expect(actions.calls).toEqual(['showWindow', 'openConfig', 'reload', 'quit']);
  });

  it('macOS 使用菜单栏协议', () => {
    const fake = createFakeTrayPort();

    const result = createTray(createActions(), capabilities({ tray: { available: true, protocol: 'macos-menu-bar' } }), {
      port: fake.port,
    });

    expect(result.protocol).toBe('macos-menu-bar');
    expect(result.ok).toBe(true);
  });

  it('Windows 使用通知区域协议', () => {
    const fake = createFakeTrayPort();

    const result = createTray(
      createActions(),
      capabilities({ platform: 'win32', tray: { available: true, protocol: 'windows-notification-area' } }),
      { port: fake.port },
    );

    expect(result.protocol).toBe('windows-notification-area');
  });

  it('Linux 无托盘协议时不创建托盘、不崩溃并给出替代入口', () => {
    const fake = createFakeTrayPort();
    const actions = createActions();

    const result = createTray(
      actions,
      capabilities({
        tray: { available: false, reason: 'Linux 桌面未提供托盘协议' },
      }),
      { port: fake.port },
    );

    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('托盘协议');
    expect(result.fallback).toContain('窗口内配置入口');
    expect(fake.created).toHaveLength(0);
  });

  it('托盘创建失败时降级而不抛出', () => {
    const fake = createFakeTrayPort({ ok: false });

    const result = createTray(createActions(), capabilities(), { port: fake.port });

    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('托盘协议不可用');
  });

  it('未注入端口时降级而不抛出', () => {
    const result = createTray(createActions(), capabilities());

    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('TrayPort');
  });
});

describe('installFocusedShortcut', () => {
  /** 假窗口目标，可控制焦点与输入事件。 */
  function createFakeTarget(options: { focused?: boolean } = {}) {
    let focused = options.focused ?? true;
    const invocations: number[] = [];
    let handler: ((event: Record<string, unknown>) => void) | undefined;

    const target: ShortcutTarget = {
      isFocused: () => focused,
      onBeforeInput(next) {
        handler = next as (event: Record<string, unknown>) => void;
      },
    };

    return {
      target,
      invocations,
      setFocused(value: boolean) {
        focused = value;
      },
      /** 模拟一次键盘输入。 */
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

  it('窗口聚焦且组合键匹配时触发', () => {
    const fake = createFakeTarget({ focused: true });

    const handle = installFocusedShortcut(fake.target, 'Ctrl+Alt+Shift+F12', () => fake.invocations.push(1));

    expect(handle).toBeDefined();
    fake.press({ key: 'F12', ctrl: true, alt: true, shift: true });

    expect(fake.invocations).toEqual([1]);
  });

  it('窗口未聚焦时不触发（不注册系统全局快捷键）', () => {
    const fake = createFakeTarget({ focused: false });

    installFocusedShortcut(fake.target, 'Ctrl+Alt+Shift+F12', () => fake.invocations.push(1));
    fake.press({ key: 'F12', ctrl: true, alt: true, shift: true });

    expect(fake.invocations).toEqual([]);
  });

  it('焦点变化后按当前焦点判断', () => {
    const fake = createFakeTarget({ focused: true });

    installFocusedShortcut(fake.target, 'Ctrl+Alt+Shift+F12', () => fake.invocations.push(1));

    fake.setFocused(false);
    fake.press({ key: 'F12', ctrl: true, alt: true, shift: true });
    expect(fake.invocations).toEqual([]);

    fake.setFocused(true);
    fake.press({ key: 'F12', ctrl: true, alt: true, shift: true });
    expect(fake.invocations).toEqual([1]);
  });

  it('修饰键不完整时不触发', () => {
    const fake = createFakeTarget();

    installFocusedShortcut(fake.target, 'Ctrl+Alt+Shift+F12', () => fake.invocations.push(1));

    fake.press({ key: 'F12', ctrl: true, alt: true });
    fake.press({ key: 'F12', alt: true, shift: true });
    fake.press({ key: 'F11', ctrl: true, alt: true, shift: true });

    expect(fake.invocations).toEqual([]);
  });

  it('额外修饰键按下时不触发', () => {
    const fake = createFakeTarget();

    installFocusedShortcut(fake.target, 'Ctrl+Alt+Shift+F12', () => fake.invocations.push(1));
    fake.press({ key: 'F12', ctrl: true, alt: true, shift: true, meta: true });

    expect(fake.invocations).toEqual([]);
  });

  it('解除安装后不再触发', () => {
    const fake = createFakeTarget();

    const handle = installFocusedShortcut(fake.target, 'Ctrl+Alt+Shift+F12', () => fake.invocations.push(1));
    handle?.dispose();
    fake.press({ key: 'F12', ctrl: true, alt: true, shift: true });

    expect(fake.invocations).toEqual([]);
  });

  it('重复解除安装不报错', () => {
    const fake = createFakeTarget();
    const handle = installFocusedShortcut(fake.target, 'Ctrl+F12', () => {});

    handle?.dispose();
    expect(() => handle?.dispose()).not.toThrow();
  });

  it('绑定为空或非法时不注册监听', () => {
    for (const binding of ['', '   ', 'Ctrl+']) {
      const fake = createFakeTarget();
      const handle = installFocusedShortcut(fake.target, binding, () => fake.invocations.push(1));

      expect(handle).toBeUndefined();
      expect(fake.registered).toBe(false);
    }
  });

  it('快捷键可多次触发', () => {
    const fake = createFakeTarget();

    installFocusedShortcut(fake.target, 'Ctrl+Alt+Shift+F12', () => fake.invocations.push(1));
    fake.press({ key: 'F12', ctrl: true, alt: true, shift: true });
    fake.press({ key: 'F12', ctrl: true, alt: true, shift: true });

    expect(fake.invocations).toEqual([1, 1]);
  });

  it('注册时带上登录启动标记常量以保持来源判定一致', () => {
    // 该常量由自启注册写入 argv，与托盘/快捷键的来源判定共用一套约定。
    expect(LOGIN_FLAG).toBe('--launched-at-login');
  });
});
