import { describe, expect, it, vi } from 'vitest';

import type { Session } from 'electron';

import {
  AppController,
  type AppControllerDeps,
  type DelayPort,
  type PowerMonitorPort,
  type ProxyPort,
  type WindowPort,
} from '../../src/main/app-controller';
import { createDefaultConfig, type AppConfig } from '../../src/main/config/config-schema';
import { loadConfig, type ConfigFileSystem } from '../../src/main/config/config-store';
import type { NetworkConfig } from '../../src/main/config/config-types';
import { createLogger, type LogFileSystem } from '../../src/main/logging/logger';
import { applyProxy } from '../../src/main/network/proxy-manager';
import { resolveConfigPaths, type ResolvedConfigPaths } from '../../src/main/platform/config-paths';
import type { PlatformCapabilities } from '../../src/main/platform/platform-adapter';
import type { WindowManagerEvent } from '../../src/main/window/window-manager';

/**
 * 恢复流程集成：规格 §5.3（损坏配置恢复）、§7（代理与断网恢复）、
 * §12（诊断记录）、§14.1（断网恢复时限）。
 *
 * 组合真实模块（config-store、proxy-manager、retry-controller、logger、AppController），
 * 只对 Electron 边界（窗口、托盘、session、电源）注入假实现。
 */

/** 本地时间构造，避免测试结果依赖运行时所在时区。 */
const NOW = new Date(2026, 9, 28, 12, 0, 0, 0);
const HOME_DIR = '/home/tester';
const LOG_PATH = `${HOME_DIR}/.local/state/uni-shell/logs/uni-shell-2026-10-28.log`;

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

/** 内存文件系统：同时满足 config-store 与 logger 的注入面。 */
function createMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));

  const fs: ConfigFileSystem & LogFileSystem = {
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' } as NodeJS.ErrnoException);
      }
      return value;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async rename(from, to) {
      const value = files.get(from);
      if (value === undefined) {
        throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' } as NodeJS.ErrnoException);
      }
      files.set(to, value);
      files.delete(from);
    },
    async mkdir() {},
    async access(path) {
      if (!files.has(path)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' } as NodeJS.ErrnoException);
      }
    },
    async unlink(path) {
      if (!files.delete(path)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' } as NodeJS.ErrnoException);
      }
    },
    async appendFile(path, data) {
      files.set(path, `${files.get(path) ?? ''}${data}`);
    },
    async readdir(path) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const names: string[] = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.includes('/')) continue;
        names.push(rest);
      }
      return names;
    },
  };

  return { fs, files };
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
    async showOfflinePage() {
      calls.push('showOfflinePage');
    },
  };

  return { window, calls };
}

/** 手动推进的假延迟，用于倒计时中的唤醒等场景。 */
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
    async fire() {
      entries[entries.length - 1]?.onReady();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function createFakePowerMonitor() {
  const suspendHandlers: Array<() => void> = [];
  const resumeHandlers: Array<() => void> = [];
  let removed = false;

  const port: PowerMonitorPort = {
    onSuspend(handler) {
      suspendHandlers.push(handler);
    },
    onResume(handler) {
      resumeHandlers.push(handler);
    },
    removeAllListeners() {
      removed = true;
      suspendHandlers.length = 0;
      resumeHandlers.length = 0;
    },
  };

  return {
    port,
    get removed() {
      return removed;
    },
    emitSuspend() {
      for (const handler of [...suspendHandlers]) handler();
    },
    emitResume() {
      for (const handler of [...resumeHandlers]) handler();
    },
  };
}

/** 假 Electron session：只记录代理配置应用。 */
function createFakeSession() {
  const setProxy = vi.fn(async () => {});
  const closeAllConnections = vi.fn(async () => {});
  return {
    session: { setProxy, closeAllConnections } as unknown as Session,
    setProxy,
    closeAllConnections,
  };
}

interface LogLine {
  level: string;
  event: string;
  data?: Record<string, unknown>;
}

function readLog(memory: ReturnType<typeof createMemoryFs>): LogLine[] {
  const content = memory.files.get(LOG_PATH) ?? '';
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogLine);
}

/**
 * 日志写入经微任务队列顺序追加；等待队列排空后再断言文件内容。
 * 只用微任务轮询，避免依赖定时器，兼容假计时器场景。
 */
async function settleLog(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    await Promise.resolve();
  }
}

function logEvents(memory: ReturnType<typeof createMemoryFs>): string[] {
  return readLog(memory).map((line) => line.event);
}

/** 取指定事件最后一条记录的 data。 */
function logData(memory: ReturnType<typeof createMemoryFs>, event: string): Record<string, unknown> {
  const matches = readLog(memory).filter((line) => line.event === event);
  expect(matches.length, `日志中应存在事件 ${event}`).toBeGreaterThan(0);
  return matches[matches.length - 1].data ?? {};
}

function baseConfig(): AppConfig {
  return createDefaultConfig('https://erp.example.com');
}

/** 组装带真实日志与真实配置读写的控制器依赖。 */
function createDeps(overrides: Partial<AppControllerDeps> = {}) {
  const memory = createMemoryFs();
  const paths = resolveConfigPaths({ platform: 'linux', homeDir: HOME_DIR, env: {}, argv: ['app'] });
  const fakeWindow = createFakeWindow();
  const session = createFakeSession();

  const logger = createLogger({
    platform: 'linux',
    homeDir: HOME_DIR,
    env: {},
    context: {
      appVersion: '0.1.0',
      electronVersion: '45.0.0',
      arch: 'x64',
      desktopEnvironment: 'GNOME',
      sessionType: 'x11',
    },
    fs: memory.fs,
    now: () => NOW,
  });

  const proxy: ProxyPort = {
    apply: (config: NetworkConfig) => applyProxy(session.session, config),
  };

  const deps: AppControllerDeps = {
    resolvePaths: () => paths,
    loadConfig: (resolved: ResolvedConfigPaths) => loadConfig({ paths: resolved, fs: memory.fs, now: () => NOW }),
    capabilities: CAPABILITIES,
    window: fakeWindow.window,
    log: logger,
    proxy,
    ...overrides,
  };

  return { deps, memory, fakeWindow, paths, session, logger };
}

/** 把配置写入内存盘，模拟用户经配置界面保存后的磁盘状态。 */
function writeConfig(memory: ReturnType<typeof createMemoryFs>, paths: ResolvedConfigPaths, config: AppConfig): void {
  memory.files.set(paths.configPath, JSON.stringify(config));
}

const START_OPTIONS = { argv: ['app'], workingDirectory: '/work', env: {} };

describe('损坏配置恢复（规格 §5.3、§12）', () => {
  it('配置损坏时进入配置界面、隔离原文件并记录诊断', async () => {
    const { deps, memory, fakeWindow, paths } = createDeps();
    memory.files.set(paths.configPath, '{ 这不是合法 JSON');

    const controller = new AppController(deps);
    await controller.start(START_OPTIONS);

    expect(controller.currentState).toBe('configuring');
    expect(fakeWindow.calls.some((call) => call.startsWith('openConfigWindow:'))).toBe(true);
    // 损坏文件被隔离而不是覆盖。
    expect([...memory.files.keys()].some((key) => key.includes('config.json.invalid.'))).toBe(true);
    await settleLog();
    expect(logEvents(memory)).toContain('config-unavailable');
    expect(logData(memory, 'config-unavailable')).toMatchObject({ status: 'invalid' });
  });

  it('修复配置并重启后恢复正常启动流程', async () => {
    const { deps, memory, fakeWindow, paths, logger } = createDeps();
    memory.files.set(paths.configPath, '{ 这不是合法 JSON');

    const first = new AppController(deps);
    await first.start(START_OPTIONS);
    expect(first.currentState).toBe('configuring');

    // 用户在配置界面修正并保存；受控重启后进入新的启动流程。
    writeConfig(memory, paths, baseConfig());
    const restarted = new AppController(deps);
    await restarted.start(START_OPTIONS);

    expect(restarted.currentState).toBe('running');
    expect(fakeWindow.calls).toContain('createMainWindow');
    await settleLog();
    expect(logEvents(memory)).toContain('config-loaded');
    expect(logData(memory, 'config-loaded')).toMatchObject({ proxyMode: 'direct' });
    expect(logEvents(memory)).toContain('proxy-applied');

    await restarted.shutdown();
    await logger.close();
  });
});

describe('断网恢复（规格 §7、§14.1）', () => {
  it('主框架加载失败后展示离线页、按间隔重试，成功后停止重试', async () => {
    vi.useFakeTimers();
    try {
      const { deps, memory, fakeWindow, paths } = createDeps();
      writeConfig(memory, paths, {
        ...baseConfig(),
        network: { ...baseConfig().network, retryIntervalSec: 10, offlinePageEnabled: true },
      });

      const controller = new AppController(deps);
      await controller.start(START_OPTIONS);
      expect(controller.currentState).toBe('running');

      controller.reportLoadFailure({
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        isMainFrame: true,
      });

      // 失败分类来自真实的 classifyLoadFailure。
      await settleLog();
      expect(logData(memory, 'page-load-failed')).toMatchObject({ failureKind: 'dns' });
      expect(fakeWindow.calls).toContain('showOfflinePage');
      expect(logEvents(memory)).toContain('offline-page-shown');

      vi.advanceTimersByTime(10_000);
      expect(fakeWindow.calls.filter((call) => call === 'reloadMain')).toHaveLength(1);
      await settleLog();
      expect(logEvents(memory)).toContain('retry-attempt');

      // 重试成功：恢复标志与定时器清理。
      controller.reportLoadSuccess();
      await settleLog();
      expect(logData(memory, 'page-load-succeeded')).toMatchObject({ recovered: true });

      vi.advanceTimersByTime(120_000);
      expect(fakeWindow.calls.filter((call) => call === 'reloadMain')).toHaveLength(1);

      await controller.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('子框架失败不触发重试', async () => {
    const { deps, memory, fakeWindow, paths } = createDeps();
    writeConfig(memory, paths, baseConfig());

    const controller = new AppController(deps);
    await controller.start(START_OPTIONS);

    controller.reportLoadFailure({
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      isMainFrame: false,
    });

    expect(logEvents(memory)).not.toContain('page-load-failed');
    expect(fakeWindow.calls).not.toContain('showOfflinePage');
  });

  it('关闭后重试定时器被清理，不再重载页面', async () => {
    vi.useFakeTimers();
    try {
      const { deps, memory, fakeWindow, paths } = createDeps();
      writeConfig(memory, paths, {
        ...baseConfig(),
        network: { ...baseConfig().network, retryIntervalSec: 10 },
      });

      const controller = new AppController(deps);
      await controller.start(START_OPTIONS);

      controller.reportLoadFailure({
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        isMainFrame: true,
      });

      await controller.shutdown();
      vi.advanceTimersByTime(120_000);

      expect(fakeWindow.calls).not.toContain('reloadMain');
      expect(logEvents(memory)).toContain('shutdown');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('代理切换（规格 §7）', () => {
  it('启动时应用固定代理，运行中可切换模式', async () => {
    const { deps, memory, paths, session } = createDeps();
    const network: NetworkConfig = {
      ...baseConfig().network,
      proxyMode: 'fixed',
      proxyServer: 'http://proxy.internal:8080',
      proxyBypass: 'localhost',
    };
    writeConfig(memory, paths, { ...baseConfig(), network });

    const controller = new AppController(deps);
    await controller.start(START_OPTIONS);

    // 真实的 applyProxy 经假 session 落成 Electron 代理配置。
    await settleLog();
    expect(session.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.internal:8080',
      proxyBypassRules: 'localhost',
    });
    expect(session.closeAllConnections).toHaveBeenCalled();
    expect(logData(memory, 'proxy-applied')).toMatchObject({ mode: 'fixed' });

    await controller.applyProxyConfig({ ...network, proxyMode: 'system' });

    expect(session.setProxy).toHaveBeenLastCalledWith({ mode: 'system' });
    await settleLog();
    expect(
      readLog(memory)
        .filter((line) => line.event === 'proxy-applied')
        .map((line) => line.data?.mode),
    ).toEqual(['fixed', 'system']);
  });

  it('代理应用失败不阻塞启动，仅记录错误', async () => {
    const { deps, memory, paths, session, fakeWindow } = createDeps();
    session.setProxy.mockRejectedValueOnce(new Error('代理服务器不可达'));
    writeConfig(memory, paths, {
      ...baseConfig(),
      network: { ...baseConfig().network, proxyMode: 'pac', proxyServer: 'https://pac.example.com/proxy.pac' },
    });

    const controller = new AppController(deps);
    await controller.start(START_OPTIONS);

    expect(controller.currentState).toBe('running');
    expect(fakeWindow.calls).toContain('createMainWindow');
    await settleLog();
    expect(logData(memory, 'proxy-apply-failed')).toMatchObject({ mode: 'pac' });
  });
});

describe('休眠唤醒诊断（规格 §12、§14.1）', () => {
  it('记录休眠与唤醒，唤醒后重载目标页面', async () => {
    const { deps, memory, fakeWindow, paths } = createDeps();
    const power = createFakePowerMonitor();
    writeConfig(memory, paths, baseConfig());

    const controller = new AppController({ ...deps, powerMonitor: power.port });
    await controller.start(START_OPTIONS);

    power.emitSuspend();
    power.emitResume();

    await settleLog();
    expect(logEvents(memory)).toEqual(expect.arrayContaining(['power-suspend', 'power-resume']));
    expect(fakeWindow.calls).toContain('reloadMain');
  });

  it('倒计时中的唤醒不抢先创建窗口', async () => {
    const { deps, memory, fakeWindow, paths } = createDeps();
    const power = createFakePowerMonitor();
    const fakeDelay = createFakeDelay();
    writeConfig(memory, paths, {
      ...baseConfig(),
      startup: { ...baseConfig().startup, delaySec: 30 },
    });

    const controller = new AppController({ ...deps, powerMonitor: power.port, delay: fakeDelay.delay });
    await controller.start({ ...START_OPTIONS, argv: ['app', '--launched-at-login'] });
    expect(controller.currentState).toBe('awaiting-delay');

    power.emitResume();

    expect(fakeWindow.calls).not.toContain('reloadMain');
    expect(fakeWindow.calls).not.toContain('createMainWindow');

    await fakeDelay.fire();
    expect(fakeWindow.calls).toContain('createMainWindow');
  });

  it('关闭后移除电源监听并不再响应唤醒', async () => {
    const { deps, memory, fakeWindow, paths } = createDeps();
    const power = createFakePowerMonitor();
    writeConfig(memory, paths, baseConfig());

    const controller = new AppController({ ...deps, powerMonitor: power.port });
    await controller.start(START_OPTIONS);

    await controller.shutdown();

    expect(power.removed).toBe(true);
    fakeWindow.calls.length = 0;
    power.emitResume();
    expect(fakeWindow.calls).not.toContain('reloadMain');
  });
});

describe('窗口与导航诊断（规格 §8、§11、§12）', () => {
  it('窗口策略、导航拦截与加载失败都转成结构化日志，URL 经脱敏', async () => {
    const { deps, memory, paths } = createDeps();
    writeConfig(memory, paths, baseConfig());

    const controller = new AppController(deps);
    await controller.start(START_OPTIONS);

    const events: WindowManagerEvent[] = [
      { type: 'window-policy-applied', window: 'main', mode: 'fullscreen', fullscreen: true, kiosk: false, alwaysOnTop: { requested: 'floating', electronLevel: 'floating', alwaysOnTop: true, effective: 'floating', degraded: false, windowManagerControlled: true, canCoverTaskbar: false, coversSystemSecureUi: false, requiresDeviceVerification: false }, display: 'primary' },
      { type: 'window-policy-degraded', window: 'main', field: 'alwaysOnTop', reason: 'Wayland 不支持置顶' },
      { type: 'navigation-guard', window: 'main', kind: 'navigation', url: 'https://evil.example.com/', action: 'blocked', reason: '不在授权源列表' },
      { type: 'main-load-failed', url: 'https://erp.example.com/app?token=abc123', message: 'ERR_CONNECTION_REFUSED' },
    ];
    for (const event of events) controller.reportWindowEvent(event);

    await settleLog();
    expect(logEvents(memory)).toEqual(
      expect.arrayContaining(['window-policy-applied', 'window-policy-degraded', 'navigation-blocked', 'page-load-failed']),
    );
    expect(logData(memory, 'navigation-blocked')).toMatchObject({ url: 'https://evil.example.com/', action: 'blocked' });
    // 规格 §11：URL 查询串中的令牌不得明文落盘。
    expect(logData(memory, 'page-load-failed').url).toBe('https://erp.example.com/app?token=[REDACTED]');
  });
});

describe('关闭时刷新日志（规格 §12）', () => {
  it('shutdown 记录事件并刷新全部挂起写入', async () => {
    const { deps, memory, paths, logger } = createDeps();
    writeConfig(memory, paths, baseConfig());

    const controller = new AppController(deps);
    await controller.start(START_OPTIONS);

    // 关闭前连续记录多条，不等待任何微任务。
    controller.reportWindowEvent({ type: 'close-action', window: 'main', action: 'hide' });
    await controller.shutdown();

    const events = logEvents(memory);
    expect(events).toContain('window-close-action');
    expect(events).toContain('shutdown');
    // shutdown 必须是最后一条：close 之后不再接受新事件。
    expect(events[events.length - 1]).toBe('shutdown');

    await logger.close();
  });
});
