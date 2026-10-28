import { describe, expect, it } from 'vitest';

import {
  collectPlatformEnvironment,
  createPlatformAdapter,
  deriveCapabilities,
  detectPlatformCapabilities,
  mapAlwaysOnTopLevel,
} from '../../../src/main/platform/capability-detector';
import type {
  AlwaysOnTopLevel,
  PlatformCapabilities,
  PlatformEnvironment,
} from '../../../src/main/platform/platform-adapter';

/**
 * 覆盖规格 v2.1 §2/§8/§10 与 `rules/platform.md`「平台适配」。
 * 通过注入 PlatformEnvironment，在单一宿主机上验证四种目标平台形态。
 */

function windowsEnvironment(overrides: Partial<PlatformEnvironment> = {}): PlatformEnvironment {
  return {
    platform: 'win32',
    osRelease: '10.0.19045',
    arch: 'x64',
    env: {},
    displays: { count: 2 },
    ...overrides,
  };
}

function macEnvironment(overrides: Partial<PlatformEnvironment> = {}): PlatformEnvironment {
  return {
    platform: 'darwin',
    osRelease: '14.5.0',
    arch: 'arm64',
    env: {},
    displays: { count: 1 },
    ...overrides,
  };
}

function linuxX11Environment(overrides: Partial<PlatformEnvironment> = {}): PlatformEnvironment {
  return {
    platform: 'linux',
    osRelease: '6.8.0-45-generic',
    arch: 'x64',
    env: {
      XDG_SESSION_TYPE: 'x11',
      XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
      DISPLAY: ':0',
    },
    displays: { count: 1 },
    ...overrides,
  };
}

function linuxWaylandEnvironment(overrides: Partial<PlatformEnvironment> = {}): PlatformEnvironment {
  return {
    platform: 'linux',
    osRelease: '6.8.0-45-generic',
    arch: 'x64',
    env: {
      XDG_SESSION_TYPE: 'wayland',
      XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
      WAYLAND_DISPLAY: 'wayland-0',
    },
    displays: { count: 1 },
    ...overrides,
  };
}

describe('Windows 能力', () => {
  const capabilities = deriveCapabilities(windowsEnvironment());

  it('识别平台、版本与架构', () => {
    expect(capabilities.platform).toBe('win32');
    expect(capabilities.osVersion).toBe('10.0.19045');
    expect(capabilities.arch).toBe('x64');
    expect(capabilities.wayland).toBe(false);
  });

  it('托盘使用通知区域且可用', () => {
    expect(capabilities.tray).toEqual({ available: true, protocol: 'windows-notification-area' });
  });

  it('置顶支持全部四个层级且不由窗口管理器控制', () => {
    expect(capabilities.alwaysOnTop.supported).toBe(true);
    expect(capabilities.alwaysOnTop.levels).toEqual(['normal', 'floating', 'pop-up-menu', 'screen-saver']);
    expect(capabilities.alwaysOnTop.windowManagerControlled).toBe(false);
  });

  it('全屏与 Kiosk 可用', () => {
    expect(capabilities.fullscreen.supported).toBe(true);
    expect(capabilities.kiosk.supported).toBe(true);
  });

  it('登录项使用当前用户启动项', () => {
    expect(capabilities.loginItem).toEqual({ supported: true, mechanism: 'windows-run-key' });
  });

  it('显示器选择可用并报告数量', () => {
    expect(capabilities.displaySelection).toEqual({ available: true, count: 2 });
  });
});

describe('macOS 能力', () => {
  const capabilities = deriveCapabilities(macEnvironment());

  it('识别平台、版本与架构', () => {
    expect(capabilities.platform).toBe('darwin');
    expect(capabilities.osVersion).toBe('14.5.0');
    expect(capabilities.arch).toBe('arm64');
    expect(capabilities.wayland).toBe(false);
  });

  it('托盘使用菜单栏且可用', () => {
    expect(capabilities.tray).toEqual({ available: true, protocol: 'macos-menu-bar' });
  });

  it('置顶支持全部四个层级', () => {
    expect(capabilities.alwaysOnTop.supported).toBe(true);
    expect(capabilities.alwaysOnTop.levels).toHaveLength(4);
  });

  it('登录项使用登录项 API', () => {
    expect(capabilities.loginItem).toEqual({ supported: true, mechanism: 'macos-login-item' });
  });
});

describe('Linux X11 能力', () => {
  const capabilities = deriveCapabilities(linuxX11Environment());

  it('识别桌面环境与会话类型', () => {
    expect(capabilities.platform).toBe('linux');
    expect(capabilities.wayland).toBe(false);
    expect(capabilities.sessionType).toBe('x11');
    expect(capabilities.desktopEnvironment).toBe('GNOME');
  });

  it('托盘可用', () => {
    // 托盘协议需实际探测；这里注入已探测到的 GTK 状态图标。
    const capabilities = deriveCapabilities(
      linuxX11Environment({ trayProbed: true, trayProtocol: 'gtk-status-icon' }),
    );

    expect(capabilities.tray).toEqual({ available: true, protocol: 'gtk-status-icon' });
  });

  it('置顶可用但由窗口管理器决定层级', () => {
    expect(capabilities.alwaysOnTop.supported).toBe(true);
    expect(capabilities.alwaysOnTop.windowManagerControlled).toBe(true);
    expect(capabilities.alwaysOnTop.reason).toContain('窗口管理器');
  });

  it('登录项使用 XDG Autostart', () => {
    expect(capabilities.loginItem).toEqual({ supported: true, mechanism: 'xdg-autostart' });
  });
});

describe('Linux Wayland 能力', () => {
  const capabilities = deriveCapabilities(linuxWaylandEnvironment());

  it('识别 Wayland 会话', () => {
    expect(capabilities.wayland).toBe(true);
    expect(capabilities.sessionType).toBe('wayland');
  });

  it('置顶明确降级为不支持并记录原因', () => {
    expect(capabilities.alwaysOnTop.supported).toBe(false);
    expect(capabilities.alwaysOnTop.levels).toEqual([]);
    expect(capabilities.alwaysOnTop.reason).toContain('Wayland');
    expect(capabilities.alwaysOnTop.reason).toContain('always-on-top');
  });

  it('全屏与 Kiosk 仍然可用', () => {
    expect(capabilities.fullscreen.supported).toBe(true);
    expect(capabilities.kiosk.supported).toBe(true);
  });
});

describe('托盘协议缺失时的降级', () => {
  it('Linux 未探测到托盘协议时不崩溃且标记不可用', () => {
    const capabilities = deriveCapabilities(
      linuxWaylandEnvironment({ trayProbed: true, trayProtocol: undefined }),
    );

    expect(capabilities.tray.available).toBe(false);
    expect(capabilities.tray.reason).toContain('窗口内配置入口');
  });

  it('Linux 未执行探测时按不可用处理并说明', () => {
    const capabilities = deriveCapabilities(linuxWaylandEnvironment());

    expect(capabilities.tray.available).toBe(false);
    expect(capabilities.tray.reason).toContain('尚未探测');
  });

  it('注入 StatusNotifierItem 协议后可用', () => {
    const capabilities = deriveCapabilities(
      linuxWaylandEnvironment({ trayProbed: true, trayProtocol: 'statusnotifier' }),
    );

    expect(capabilities.tray).toEqual({ available: true, protocol: 'statusnotifier' });
  });

  it('Linux X11 注入 GTK 状态图标后可用', () => {
    const capabilities = deriveCapabilities(
      linuxX11Environment({ trayProbed: true, trayProtocol: 'gtk-status-icon' }),
    );

    expect(capabilities.tray).toEqual({ available: true, protocol: 'gtk-status-icon' });
  });
});

describe('显示器不可用时的降级', () => {
  it('未注入显示器探测结果时标记不可用并说明', () => {
    const capabilities = deriveCapabilities(windowsEnvironment({ displays: undefined }));

    expect(capabilities.displaySelection.available).toBe(false);
    expect(capabilities.displaySelection.count).toBe(0);
    expect(capabilities.displaySelection.reason).toContain('显示器');
  });

  it('显示器数量为 0 时标记不可用', () => {
    const capabilities = deriveCapabilities(macEnvironment({ displays: { count: 0 } }));

    expect(capabilities.displaySelection.available).toBe(false);
    expect(capabilities.displaySelection.reason).toContain('未探测到可用显示器');
  });

  it('多显示器时报告正确数量', () => {
    expect(deriveCapabilities(macEnvironment({ displays: { count: 3 } })).displaySelection).toEqual({
      available: true,
      count: 3,
    });
  });
});

describe('不支持的置顶层级', () => {
  it('Wayland 上请求 floating 降级为不置顶', () => {
    const capabilities = deriveCapabilities(linuxWaylandEnvironment());
    const mapped = mapAlwaysOnTopLevel('floating', capabilities);

    expect(mapped.alwaysOnTop).toBe(false);
    expect(mapped.effective).toBe('none');
    expect(mapped.degraded).toBe(true);
    expect(mapped.electronLevel).toBe('normal');
    expect(mapped.reason).toContain('Wayland');
  });

  it('Wayland 上请求 screen-saver 同样降级', () => {
    const capabilities = deriveCapabilities(linuxWaylandEnvironment());
    const mapped = mapAlwaysOnTopLevel('screen-saver', capabilities);

    expect(mapped.alwaysOnTop).toBe(false);
    expect(mapped.effective).toBe('none');
    expect(mapped.degraded).toBe(true);
  });

  it('能力对象声称不支持某层级时降级', () => {
    const capabilities = deriveCapabilities(windowsEnvironment());
    const restricted: PlatformCapabilities = {
      ...capabilities,
      alwaysOnTop: { supported: true, levels: ['normal', 'floating'], windowManagerControlled: false },
    };

    const mapped = mapAlwaysOnTopLevel('screen-saver', restricted);

    expect(mapped.degraded).toBe(true);
    expect(mapped.effective).toBe('none');
    expect(mapped.reason).toContain('screen-saver');
  });
});

describe('置顶层级映射', () => {
  it('Windows 四个层级都直接映射', () => {
    const capabilities = deriveCapabilities(windowsEnvironment());

    for (const level of ['floating', 'pop-up-menu', 'screen-saver'] as AlwaysOnTopLevel[]) {
      const mapped = mapAlwaysOnTopLevel(level, capabilities);
      expect(mapped.electronLevel).toBe(level);
      expect(mapped.effective).toBe(level);
      expect(mapped.degraded).toBe(false);
      expect(mapped.alwaysOnTop).toBe(true);
    }
  });

  it('Windows 上 pop-up-menu 与 screen-saver 可覆盖任务栏', () => {
    const capabilities = deriveCapabilities(windowsEnvironment());

    expect(mapAlwaysOnTopLevel('pop-up-menu', capabilities).canCoverTaskbar).toBe(true);
    expect(mapAlwaysOnTopLevel('screen-saver', capabilities).canCoverTaskbar).toBe(true);
    expect(mapAlwaysOnTopLevel('floating', capabilities).canCoverTaskbar).toBe(false);
    expect(mapAlwaysOnTopLevel('normal', capabilities).canCoverTaskbar).toBe(false);
  });

  it('任何平台都不承诺覆盖系统安全界面', () => {
    for (const environment of [
      windowsEnvironment(),
      macEnvironment(),
      linuxX11Environment(),
      linuxWaylandEnvironment(),
    ]) {
      const capabilities = deriveCapabilities(environment);
      for (const level of ['normal', 'floating', 'pop-up-menu', 'screen-saver'] as AlwaysOnTopLevel[]) {
        expect(mapAlwaysOnTopLevel(level, capabilities).coversSystemSecureUi).toBe(false);
      }
    }
  });

  it('macOS 非 normal 层级标记为需实测确认', () => {
    const capabilities = deriveCapabilities(macEnvironment());

    expect(mapAlwaysOnTopLevel('normal', capabilities).requiresDeviceVerification).toBe(false);
    expect(mapAlwaysOnTopLevel('floating', capabilities).requiresDeviceVerification).toBe(true);
    expect(mapAlwaysOnTopLevel('floating', capabilities).degraded).toBe(false);
    // 不承诺覆盖 Dock。
    expect(mapAlwaysOnTopLevel('screen-saver', capabilities).canCoverTaskbar).toBe(false);
  });

  it('Linux X11 请求高层级时只保证在普通窗口之上', () => {
    const capabilities = deriveCapabilities(linuxX11Environment());
    const mapped = mapAlwaysOnTopLevel('screen-saver', capabilities);

    expect(mapped.alwaysOnTop).toBe(true);
    expect(mapped.electronLevel).toBe('screen-saver');
    expect(mapped.effective).toBe('normal');
    expect(mapped.degraded).toBe(true);
    expect(mapped.windowManagerControlled).toBe(true);
    expect(mapped.canCoverTaskbar).toBe(false);
    expect(mapped.reason).toContain('窗口管理器');
  });

  it('normal 在任何平台都不请求置顶且不降级', () => {
    for (const environment of [
      windowsEnvironment(),
      macEnvironment(),
      linuxX11Environment(),
      linuxWaylandEnvironment(),
    ]) {
      const capabilities = deriveCapabilities(environment);
      const mapped = mapAlwaysOnTopLevel('normal', capabilities);

      expect(mapped.alwaysOnTop).toBe(false);
      expect(mapped.effective).toBe('normal');
      expect(mapped.degraded).toBe(false);
    }
  });
});

describe('环境事实推断', () => {
  it('仅有 WAYLAND_DISPLAY 时也识别为 Wayland', () => {
    const capabilities = deriveCapabilities(
      linuxX11Environment({
        env: { WAYLAND_DISPLAY: 'wayland-0' },
      }),
    );

    expect(capabilities.wayland).toBe(true);
    expect(capabilities.sessionType).toBe('wayland');
  });

  it('仅有 DISPLAY 时识别为 X11', () => {
    const capabilities = deriveCapabilities(
      linuxWaylandEnvironment({ env: { DISPLAY: ':0' } }),
    );

    expect(capabilities.wayland).toBe(false);
    expect(capabilities.sessionType).toBe('x11');
  });

  it('缺少桌面环境变量时不崩溃', () => {
    const capabilities = deriveCapabilities(linuxX11Environment({ env: {} }));

    expect(capabilities.desktopEnvironment).toBeUndefined();
    expect(capabilities.sessionType).toBeUndefined();
    expect(capabilities.wayland).toBe(false);
  });

  it('XDG_CURRENT_DESKTOP 取冒号分隔的最后一段', () => {
    expect(deriveCapabilities(linuxX11Environment({ env: { XDG_CURRENT_DESKTOP: 'KDE' } })).desktopEnvironment).toBe(
      'KDE',
    );
    expect(
      deriveCapabilities(linuxX11Environment({ env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' } })).desktopEnvironment,
    ).toBe('GNOME');
    expect(
      deriveCapabilities(linuxX11Environment({ env: { XDG_CURRENT_DESKTOP: '   ' } })).desktopEnvironment,
    ).toBeUndefined();
  });

  it('非 Linux 平台不推导桌面环境、会话类型与 Wayland', () => {
    const capabilities = deriveCapabilities(
      windowsEnvironment({ env: { XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' } }),
    );

    expect(capabilities.desktopEnvironment).toBeUndefined();
    expect(capabilities.sessionType).toBeUndefined();
    expect(capabilities.wayland).toBe(false);
    // 不能因为误判 Wayland 而把置顶能力降级掉。
    expect(capabilities.alwaysOnTop.supported).toBe(true);
  });

  it('macOS 上的 XDG 变量不影响能力推导', () => {
    const capabilities = deriveCapabilities(
      macEnvironment({ env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' } }),
    );

    expect(capabilities.wayland).toBe(false);
    expect(capabilities.sessionType).toBeUndefined();
    expect(capabilities.alwaysOnTop.supported).toBe(true);
  });
});

describe('探测入口', () => {
  it('detectPlatformCapabilities 采集当前进程事实', async () => {
    const capabilities = await detectPlatformCapabilities({ displays: { count: 1 } });

    expect(['win32', 'darwin', 'linux']).toContain(capabilities.platform);
    expect(capabilities.osVersion.length).toBeGreaterThan(0);
    expect(capabilities.arch.length).toBeGreaterThan(0);
  });

  it('collectPlatformEnvironment 返回可用的环境事实', async () => {
    const environment = await collectPlatformEnvironment();

    expect(environment.platform).toBe(process.platform);
    expect(environment.arch).toBe(process.arch);
    expect(typeof environment.env).toBe('object');
  });

  it('覆盖项优先于进程事实', async () => {
    const capabilities = await detectPlatformCapabilities({
      platform: 'linux',
      osRelease: 'test-release',
      env: { XDG_SESSION_TYPE: 'wayland' },
      displays: { count: 1 },
    });

    expect(capabilities.platform).toBe('linux');
    expect(capabilities.osVersion).toBe('test-release');
    expect(capabilities.wayland).toBe(true);
    expect(capabilities.alwaysOnTop.supported).toBe(false);
  });

  it('createPlatformAdapter 暴露能力与映射', async () => {
    const environment = linuxWaylandEnvironment();
    const adapter = createPlatformAdapter(deriveCapabilities(environment), environment);

    expect(adapter.capabilities.wayland).toBe(true);
    expect(adapter.mapAlwaysOnTopLevel('floating').effective).toBe('none');
    expect(await adapter.detectCapabilities()).toEqual(adapter.capabilities);
    expect(adapter.describeEnvironment()).toEqual(environment);
  });
});
