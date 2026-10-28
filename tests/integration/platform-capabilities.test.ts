import { describe, expect, it } from 'vitest';

import { validateConfig } from '../../src/main/config/config-schema';
import {
  createPlatformAdapter,
  deriveCapabilities,
  detectPlatformCapabilities,
  mapAlwaysOnTopLevel,
} from '../../src/main/platform/capability-detector';
import type {
  AlwaysOnTopLevel,
  PlatformCapabilities,
  PlatformEnvironment,
} from '../../src/main/platform/platform-adapter';

/**
 * 集成验证：把「配置里的置顶层级」与「平台能力」接到一起，
 * 确认规格 v2.1 §8 的逐平台降级策略在真实探测路径上自洽，且不崩溃。
 */

const ALL_LEVELS: AlwaysOnTopLevel[] = ['normal', 'floating', 'pop-up-menu', 'screen-saver'];

function linuxX11Environment(overrides: Partial<PlatformEnvironment> = {}): PlatformEnvironment {
  return {
    platform: 'linux',
    osRelease: '6.8.0-45-generic',
    arch: 'x64',
    env: { XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', DISPLAY: ':0' },
    displays: { count: 1 },
    trayProbed: true,
    trayProtocol: 'gtk-status-icon',
    ...overrides,
  };
}

function linuxWaylandEnvironment(overrides: Partial<PlatformEnvironment> = {}): PlatformEnvironment {
  return {
    platform: 'linux',
    osRelease: '6.8.0-45-generic',
    arch: 'x64',
    env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', WAYLAND_DISPLAY: 'wayland-0' },
    displays: { count: 1 },
    trayProbed: true,
    ...overrides,
  };
}

/** 从一份合法配置里取出置顶层级。 */
function levelFromConfig(level: AlwaysOnTopLevel): AlwaysOnTopLevel {
  const result = validateConfig({
    schemaVersion: 1,
    targetUrl: 'https://example.com',
    window: { alwaysOnTop: level !== 'normal', alwaysOnTopLevel: level },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('配置应当合法');
  return result.value.window.alwaysOnTopLevel;
}

describe('平台能力集成', () => {
  it('真实探测路径在当前宿主机上不崩溃且结果自洽', async () => {
    const capabilities = await detectPlatformCapabilities({ displays: { count: 1 } });

    expect(['win32', 'darwin', 'linux']).toContain(capabilities.platform);
    expect(capabilities.osVersion.length).toBeGreaterThan(0);
    expect(capabilities.arch.length).toBeGreaterThan(0);

    // 托盘不可用时必须给出原因，且不能因此认为其他能力也失效。
    if (!capabilities.tray.available) {
      expect(capabilities.tray.reason).toBeTruthy();
    }
    expect(capabilities.fullscreen.supported).toBe(true);
    expect(capabilities.loginItem.supported).toBe(true);

    // 四个层级都能映射，不抛异常。
    for (const level of ALL_LEVELS) {
      const mapped = mapAlwaysOnTopLevel(level, capabilities);
      expect(mapped.requested).toBe(level);
      expect(mapped.coversSystemSecureUi).toBe(false);
    }
  });

  it('Linux Wayland 下任何非 normal 层级都降级为不置顶', () => {
    const capabilities = deriveCapabilities(linuxWaylandEnvironment());

    expect(capabilities.alwaysOnTop.supported).toBe(false);

    for (const level of ALL_LEVELS.filter((value) => value !== 'normal')) {
      const mapped = mapAlwaysOnTopLevel(levelFromConfig(level), capabilities);
      expect(mapped.alwaysOnTop, `${level} 不应请求置顶`).toBe(false);
      expect(mapped.effective).toBe('none');
      expect(mapped.degraded).toBe(true);
      expect(mapped.reason).toContain('Wayland');
    }
  });

  it('Linux Wayland 下托盘缺失仍保留其余能力', () => {
    const capabilities = deriveCapabilities(linuxWaylandEnvironment());

    expect(capabilities.tray.available).toBe(false);
    expect(capabilities.tray.reason).toContain('窗口内配置入口');
    // 不得连带降级无关能力。
    expect(capabilities.fullscreen.supported).toBe(true);
    expect(capabilities.kiosk.supported).toBe(true);
    expect(capabilities.loginItem.supported).toBe(true);
  });

  it('Linux X11 下高层级降级为「在普通窗口之上」', () => {
    const capabilities = deriveCapabilities(linuxX11Environment());

    for (const level of ['floating', 'pop-up-menu', 'screen-saver'] as AlwaysOnTopLevel[]) {
      const mapped = mapAlwaysOnTopLevel(levelFromConfig(level), capabilities);
      expect(mapped.alwaysOnTop).toBe(true);
      expect(mapped.effective).toBe('normal');
      expect(mapped.degraded).toBe(true);
      expect(mapped.windowManagerControlled).toBe(true);
      expect(mapped.canCoverTaskbar).toBe(false);
    }
  });

  it('降级结果在四个平台形态下都不承诺覆盖系统安全界面', () => {
    const environments: PlatformEnvironment[] = [
      { platform: 'win32', osRelease: '10.0.19045', arch: 'x64', env: {}, displays: { count: 1 } },
      { platform: 'darwin', osRelease: '14.5.0', arch: 'arm64', env: {}, displays: { count: 1 } },
      linuxX11Environment(),
      linuxWaylandEnvironment(),
    ];

    for (const environment of environments) {
      const capabilities = deriveCapabilities(environment);
      for (const level of ALL_LEVELS) {
        const mapped = mapAlwaysOnTopLevel(level, capabilities);
        expect(mapped.coversSystemSecureUi).toBe(false);
        // 只有 Windows 在规格允许的层级下才声称可覆盖任务栏。
        if (mapped.canCoverTaskbar) {
          expect(environment.platform).toBe('win32');
          expect(['pop-up-menu', 'screen-saver']).toContain(level);
        }
      }
    }
  });

  it('能力对象可被适配器打包并重复使用', () => {
    const environment = linuxWaylandEnvironment();
    const capabilities: PlatformCapabilities = deriveCapabilities(environment);
    const adapter = createPlatformAdapter(capabilities, environment);

    expect(adapter.capabilities).toBe(capabilities);
    expect(adapter.mapAlwaysOnTopLevel('floating').effective).toBe('none');
    expect(adapter.mapAlwaysOnTopLevel('normal').degraded).toBe(false);
  });

  it('能力字段齐备，可供日志与诊断直接序列化', () => {
    const capabilities = deriveCapabilities(linuxWaylandEnvironment());

    // 规格 §12 要求记录操作系统、桌面环境、窗口能力等。
    expect(capabilities).toMatchObject({
      platform: 'linux',
      osVersion: '6.8.0-45-generic',
      arch: 'x64',
      desktopEnvironment: 'GNOME',
      sessionType: 'wayland',
      wayland: true,
    });
    expect(JSON.parse(JSON.stringify(capabilities))).toEqual(capabilities);
  });
});
