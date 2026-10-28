import { describe, expect, it, vi } from 'vitest';

import {
  LOGIN_LAUNCH_FLAG,
  MAX_DELAY_SEC,
  MIN_DELAY_SEC,
  clampDelaySec,
  detectLaunchContext,
  runStartupDelay,
  setOpenAtLogin,
  shouldApplyDelay,
  type LaunchContext,
  type LoginItemPort,
} from '../../../src/main/startup/startup-manager';
import { createDefaultConfig } from '../../../src/main/config/config-schema';

/**
 * 覆盖规格 v2.1 §9：登录启动注册、延迟只对登录启动生效、托盘「立即显示窗口」取消倒计时；
 * 以及 `rules/platform.md`「平台适配」的三平台登录启动机制。
 */

const LOGIN: LaunchContext = { source: 'login', argv: ['app', LOGIN_LAUNCH_FLAG], workingDirectory: '/work' };
const MANUAL: LaunchContext = { source: 'manual', argv: ['app'], workingDirectory: '/work' };

function startupConfig(overrides: Partial<ReturnType<typeof createDefaultConfig>['startup']> = {}) {
  return { ...createDefaultConfig('https://example.com').startup, ...overrides };
}

/** 可操控的假登录项端口。 */
function createFakeLoginItemPort(options: { platform?: 'win32' | 'darwin' | 'linux'; ok?: boolean } = {}) {
  const applied: boolean[] = [];
  let enabled = false;

  const port: LoginItemPort = {
    platform: options.platform ?? 'linux',
    async apply(next) {
      applied.push(next);
      if (options.ok === false) {
        return { ok: false, reason: 'EACCES: permission denied' };
      }
      enabled = next;
      return { ok: true, location: '/home/tester/.config/autostart/uni-shell.desktop' };
    },
    async query() {
      return enabled;
    },
  };

  return { port, applied, get enabled() { return enabled; } };
}

describe('detectLaunchContext', () => {
  it('识别登录启动与手动启动', () => {
    expect(detectLaunchContext(['app', LOGIN_LAUNCH_FLAG])).toBe('login');
    expect(detectLaunchContext(['app'])).toBe('manual');
    expect(detectLaunchContext([])).toBe('manual');
  });

  it('识别 macOS 登录启动的 -psn_ 参数', () => {
    expect(detectLaunchContext(['app', '-psn_0_999'])).toBe('login');
  });
});

describe('shouldApplyDelay', () => {
  it('delaySec 为 0 时不延迟', () => {
    expect(shouldApplyDelay(startupConfig({ delaySec: 0 }), LOGIN)).toBe(false);
    expect(shouldApplyDelay(startupConfig({ delaySec: 0 }), MANUAL)).toBe(false);
  });

  it('delayOnlyOnLogin 为 true 时只对登录启动生效', () => {
    const config = startupConfig({ delaySec: 30, delayOnlyOnLogin: true });
    expect(shouldApplyDelay(config, LOGIN)).toBe(true);
    expect(shouldApplyDelay(config, MANUAL)).toBe(false);
  });

  it('delayOnlyOnLogin 为 false 时两种来源都延迟', () => {
    const config = startupConfig({ delaySec: 30, delayOnlyOnLogin: false });
    expect(shouldApplyDelay(config, LOGIN)).toBe(true);
    expect(shouldApplyDelay(config, MANUAL)).toBe(true);
  });
});

describe('clampDelaySec', () => {
  it('把越界值收敛到 0～3600', () => {
    expect(MIN_DELAY_SEC).toBe(0);
    expect(MAX_DELAY_SEC).toBe(3600);
    expect(clampDelaySec(-5)).toBe(0);
    expect(clampDelaySec(0)).toBe(0);
    expect(clampDelaySec(1800)).toBe(1800);
    expect(clampDelaySec(3600)).toBe(3600);
    expect(clampDelaySec(99999)).toBe(3600);
  });

  it('非有限数按不延迟处理', () => {
    // Infinity 会落到「无限等待」，比不延迟更危险，因此一律按 0 处理。
    expect(clampDelaySec(Number.NaN)).toBe(0);
    expect(clampDelaySec(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampDelaySec(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('runStartupDelay', () => {
  it('无需延迟时同步就绪且不再触发', () => {
    vi.useFakeTimers();
    try {
      const onReady = vi.fn();
      const handle = runStartupDelay(startupConfig({ delaySec: 0 }), LOGIN, onReady);

      expect(onReady).toHaveBeenCalledTimes(1);
      expect(handle.pending).toBe(false);

      vi.advanceTimersByTime(10000);
      expect(onReady).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('按 delaySec 到期触发', () => {
    vi.useFakeTimers();
    try {
      const onReady = vi.fn();
      const handle = runStartupDelay(startupConfig({ delaySec: 30 }), LOGIN, onReady);

      expect(handle.pending).toBe(true);
      vi.advanceTimersByTime(29999);
      expect(onReady).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(handle.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('手动启动且 delayOnlyOnLogin 时立即就绪', () => {
    vi.useFakeTimers();
    try {
      const onReady = vi.fn();
      runStartupDelay(startupConfig({ delaySec: 30, delayOnlyOnLogin: true }), MANUAL, onReady);

      expect(onReady).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('取消后不再触发（托盘「立即显示窗口」取消倒计时）', () => {
    vi.useFakeTimers();
    try {
      const onReady = vi.fn();
      const handle = runStartupDelay(startupConfig({ delaySec: 30 }), LOGIN, onReady);

      handle.cancel();
      vi.advanceTimersByTime(60000);

      expect(onReady).not.toHaveBeenCalled();
      expect(handle.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('重复取消不报错', () => {
    vi.useFakeTimers();
    try {
      const handle = runStartupDelay(startupConfig({ delaySec: 5 }), LOGIN, () => {});
      handle.cancel();
      expect(() => handle.cancel()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('到期后取消是空操作', () => {
    vi.useFakeTimers();
    try {
      const onReady = vi.fn();
      const handle = runStartupDelay(startupConfig({ delaySec: 1 }), LOGIN, onReady);
      vi.advanceTimersByTime(1000);
      handle.cancel();
      expect(onReady).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('越界 delaySec 被收敛后仍能工作', () => {
    vi.useFakeTimers();
    try {
      const onReady = vi.fn();
      const handle = runStartupDelay(startupConfig({ delaySec: 99999 }), LOGIN, onReady);
      vi.advanceTimersByTime(3600 * 1000);
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(handle.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('setOpenAtLogin', () => {
  it('启用时写入登录项并带上登录启动标记', async () => {
    const fake = createFakeLoginItemPort({ platform: 'linux' });

    const result = await setOpenAtLogin(true, { port: fake.port });

    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.mechanism).toBe('xdg-autostart');
    expect(fake.applied).toEqual([true]);
  });

  it('禁用时清除登录项', async () => {
    const fake = createFakeLoginItemPort({ platform: 'linux' });
    await setOpenAtLogin(true, { port: fake.port });

    const result = await setOpenAtLogin(false, { port: fake.port });

    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(false);
    expect(fake.applied).toEqual([true, false]);
  });

  it('Windows 使用当前用户启动项机制', async () => {
    const fake = createFakeLoginItemPort({ platform: 'win32' });
    const result = await setOpenAtLogin(true, { port: fake.port });

    expect(result.mechanism).toBe('windows-run-key');
  });

  it('macOS 使用登录项机制', async () => {
    const fake = createFakeLoginItemPort({ platform: 'darwin' });
    const result = await setOpenAtLogin(true, { port: fake.port });

    expect(result.mechanism).toBe('macos-login-item');
  });

  it('写入失败时返回可操作错误且不谎报成功', async () => {
    const fake = createFakeLoginItemPort({ platform: 'linux', ok: false });

    const result = await setOpenAtLogin(true, { port: fake.port });

    expect(result.ok).toBe(false);
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('permission denied');
  });

  it('端口抛异常时也被捕获为失败结果', async () => {
    const port: LoginItemPort = {
      platform: 'linux',
      async apply() {
        throw new Error('disk full');
      },
      async query() {
        return false;
      },
    };

    const result = await setOpenAtLogin(true, { port });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('disk full');
  });

  it('未注入端口时抛错而不是静默成功', async () => {
    await expect(setOpenAtLogin(true, {})).rejects.toThrow(/LoginItemPort/);
  });
});
