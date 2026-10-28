import { describe, expect, it, vi } from 'vitest';

import type { SecurityConfig } from '../../../src/main/config/config-types';
import {
  createLocalConfigSecurityPolicy,
  decideDownload,
  decideNavigation,
  decidePermission,
  decideWindowOpen,
  installNavigationGuards,
  isAllowedOrigin,
  isExternallyOpenableUrl,
  normalizeOrigin,
  readDownloadUrl,
  secureRemoteWebPreferences,
  type GuardDownloadItem,
  type GuardEvent,
  type GuardNavigationDetails,
  type GuardSession,
  type GuardWebContents,
  type GuardWindowOpenDetails,
  type GuardWindowOpenResponse,
  type NavigationGuardRecord,
} from '../../../src/main/window/navigation-guard';

/**
 * 导航守卫单元测试。
 *
 * 规则来源：规格 v2.1 §11（安全要求）与 `rules/security.md`「导航、弹窗和权限」。
 * 覆盖授权源放行、未授权重定向拦截、弹窗拒绝、外链策略、下载策略和权限拒绝。
 */

const ALLOWED_ORIGIN = 'https://app.example.com';

function security(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    allowedOrigins: [ALLOWED_ORIGIN],
    allowExternalLinks: false,
    allowPopups: false,
    allowDownloads: false,
    ...overrides,
  };
}

/** 可拦截事件的最小假实现。 */
class FakeGuardEvent implements GuardEvent {
  prevented = false;

  preventDefault(): void {
    this.prevented = true;
  }
}

/** `will-navigate` / `will-redirect` 的 details 假实现。 */
class FakeNavigationDetails implements GuardNavigationDetails {
  prevented = false;

  constructor(readonly url: string) {}

  preventDefault(): void {
    this.prevented = true;
  }
}

class FakeEventEmitter {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((registered) => registered !== listener),
    );
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }

  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }
}

class FakeSession implements GuardSession {
  readonly events = new FakeEventEmitter();
  permissionHandler:
    | ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void)
    | null = null;

  on(
    event: 'will-download',
    listener: (event: GuardEvent, item: GuardDownloadItem, webContents?: unknown, frame?: unknown) => void,
  ): unknown {
    this.events.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off(
    event: 'will-download',
    listener: (event: GuardEvent, item: GuardDownloadItem, webContents?: unknown, frame?: unknown) => void,
  ): unknown {
    this.events.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  setPermissionRequestHandler(
    handler: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null,
  ): void {
    this.permissionHandler = handler;
  }

  emitDownload(item: GuardDownloadItem): boolean {
    const event = new FakeGuardEvent();
    this.events.emit('will-download', event, item);
    return event.prevented;
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
  readonly events = new FakeEventEmitter();
  readonly session = new FakeSession();
  private windowOpenHandler: ((details: GuardWindowOpenDetails) => GuardWindowOpenResponse) | null = null;
  on(event: 'will-navigate' | 'will-redirect', listener: (details: GuardNavigationDetails) => void): unknown {
    this.events.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off(event: 'will-navigate' | 'will-redirect', listener: (details: GuardNavigationDetails) => void): unknown {
    this.events.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  setWindowOpenHandler(handler: (details: GuardWindowOpenDetails) => GuardWindowOpenResponse): void {
    this.windowOpenHandler = handler;
  }
  emitNavigate(url: string, kind: 'will-navigate' | 'will-redirect' = 'will-navigate'): FakeNavigationDetails {
    const details = new FakeNavigationDetails(url);
    this.events.emit(kind, details);
    return details;
  }

  emitWindowOpen(details: GuardWindowOpenDetails): { action: string; overrideBrowserWindowOptions?: unknown } {
    if (!this.windowOpenHandler) throw new Error('未安装 setWindowOpenHandler');
    return this.windowOpenHandler(details);
  }
}

interface FakeWindow {
  webContents: FakeWebContents;
}

function createWindow(): FakeWindow {
  return { webContents: new FakeWebContents() };
}

describe('源比较辅助函数', () => {
  it('归一化 http/https 源的协议、主机和端口', () => {
    expect(normalizeOrigin('https://APP.example.com/path?q=1')).toBe('https://app.example.com');
    expect(normalizeOrigin('https://app.example.com:443/x')).toBe('https://app.example.com');
    expect(normalizeOrigin('https://app.example.com:8443/x')).toBe('https://app.example.com:8443');
    expect(normalizeOrigin('http://app.example.com:80/x')).toBe('http://app.example.com');
  });

  it('非 http/https、空值和无法解析的地址没有源', () => {
    for (const value of ['', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'data:text/html,x']) {
      expect(normalizeOrigin(value)).toBeNull();
    }
  });

  it('按源比较，路径、查询、片段和大小写不影响结果', () => {
    const origins = [ALLOWED_ORIGIN, 'https://other.example.com:8443/'];
    expect(isAllowedOrigin('https://app.example.com/any/path?q=1#frag', origins)).toBe(true);
    expect(isAllowedOrigin('https://APP.example.com/other', origins)).toBe(true);
    expect(isAllowedOrigin('https://other.example.com:8443/deep/path', origins)).toBe(true);
    expect(isAllowedOrigin('https://other.example.com:8444/', origins)).toBe(false);
    expect(isAllowedOrigin('https://evil.example.com/', origins)).toBe(false);
    expect(isAllowedOrigin('http://app.example.com/', origins)).toBe(false);
  });

  it('授权源条目本身带尾斜杠或不同大小写时也能匹配', () => {
    expect(isAllowedOrigin('https://app.example.com/x', ['https://APP.example.com/'])).toBe(true);
  });

  it('只有 http/https/mailto/tel 可交给系统默认浏览器', () => {
    expect(isExternallyOpenableUrl('https://example.com/')).toBe(true);
    expect(isExternallyOpenableUrl('http://example.com/')).toBe(true);
    expect(isExternallyOpenableUrl('mailto:ops@example.com')).toBe(true);
    expect(isExternallyOpenableUrl('tel:+861000000000')).toBe(true);
    expect(isExternallyOpenableUrl('javascript:alert(1)')).toBe(false);
    expect(isExternallyOpenableUrl('file:///etc/passwd')).toBe(false);
    expect(isExternallyOpenableUrl('data:text/html,<b>x</b>')).toBe(false);
    expect(isExternallyOpenableUrl('')).toBe(false);
  });
});

describe('导航与重定向策略', () => {
  it('授权源内的导航放行', () => {
    const decision = decideNavigation('https://app.example.com/dashboard', security());
    expect(decision.action).toBe('allow');
    expect(decision.reason).toBeTruthy();
  });

  it('未授权源的导航被拦截', () => {
    const decision = decideNavigation('https://evil.example.com/', security());
    expect(decision.action).toBe('block');
  });

  it('未授权源在允许外链时交给系统默认浏览器', () => {
    const decision = decideNavigation('https://docs.example.com/help', security({ allowExternalLinks: true }));
    expect(decision.action).toBe('open-external');
  });

  it('javascript: 与 data: 等地址既不放行也不外带', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd']) {
      expect(decideNavigation(value, security({ allowExternalLinks: true })).action).toBe('block');
    }
  });

  it('mailto/tel 在允许外链时交给系统默认浏览器，否则拦截', () => {
    expect(decideNavigation('mailto:ops@example.com', security()).action).toBe('block');
    expect(decideNavigation('mailto:ops@example.com', security({ allowExternalLinks: true })).action).toBe(
      'open-external',
    );
  });

  it('授权源列表为空时一切页面内导航都被拦截', () => {
    expect(decideNavigation('https://app.example.com/', security({ allowedOrigins: [] })).action).toBe('block');
  });
});

describe('弹窗策略', () => {
  it('默认拒绝新窗口', () => {
    expect(decideWindowOpen('https://app.example.com/popup', security()).action).toBe('deny');
  });

  it('允许弹窗时授权源放行，未授权源拒绝', () => {
    expect(decideWindowOpen('https://app.example.com/popup', security({ allowPopups: true })).action).toBe('allow');
    expect(decideWindowOpen('https://evil.example.com/', security({ allowPopups: true })).action).toBe('deny');
  });

  it('允许弹窗且允许外链时，未授权源作为外链打开而不是应用内窗口', () => {
    const decision = decideWindowOpen(
      'https://docs.example.com/',
      security({ allowPopups: true, allowExternalLinks: true }),
    );
    expect(decision.action).toBe('open-external');
  });

  it('Kiosk 模式一律拒绝新窗口', () => {
    expect(decideWindowOpen('https://app.example.com/popup', security({ allowPopups: true }), { kiosk: true }).action).toBe(
      'deny',
    );
  });
});

describe('下载策略', () => {
  it('默认拒绝下载', () => {
    expect(decideDownload('https://app.example.com/file.pdf', security()).action).toBe('deny');
  });

  it('允许下载时只放行授权源', () => {
    expect(decideDownload('https://app.example.com/file.pdf', security({ allowDownloads: true })).action).toBe('allow');
    expect(decideDownload('https://evil.example.com/file.pdf', security({ allowDownloads: true })).action).toBe('deny');
  });

  it('Kiosk 模式一律拒绝下载', () => {
    expect(
      decideDownload('https://app.example.com/file.pdf', security({ allowDownloads: true }), { kiosk: true }).action,
    ).toBe('deny');
  });

  it('无法读取下载地址时拒绝', () => {
    expect(decideDownload('', security({ allowDownloads: true })).action).toBe('deny');
  });
});

describe('权限策略', () => {
  it('所有权限请求一律拒绝', () => {
    for (const permission of ['media', 'geolocation', 'notifications', 'midiSysex', 'pointerLock', 'clipboard-read']) {
      expect(decidePermission(permission).action).toBe('deny');
    }
  });

  it('拒绝原因说明该权限来自默认禁止清单', () => {
    expect(decidePermission('media').reason).toContain('media');
  });
});

describe('下载地址读取', () => {
  it('优先使用 getURL()，其次回退 url 属性', () => {
    expect(readDownloadUrl({ getURL: () => 'https://app.example.com/a' })).toBe('https://app.example.com/a');
    expect(readDownloadUrl({ url: 'https://app.example.com/b' })).toBe('https://app.example.com/b');
  });

  it('getURL() 抛错或字段缺失时返回空字符串（按拒绝处理）', () => {
    expect(
      readDownloadUrl({
        getURL: () => {
          throw new Error('destroyed');
        },
      }),
    ).toBe('');
    expect(readDownloadUrl({})).toBe('');
  });
});

describe('installNavigationGuards', () => {
  it('授权源导航放行，未授权源导航被拦截', () => {
    const window = createWindow();
    const records: NavigationGuardRecord[] = [];
    installNavigationGuards(window as never, security(), {
      onDecision: (record) => records.push(record),
    });

    const allowed = window.webContents.emitNavigate('https://app.example.com/dashboard');
    expect(allowed.prevented).toBe(false);

    const blocked = window.webContents.emitNavigate('https://evil.example.com/');
    expect(blocked.prevented).toBe(true);

    expect(records.map((record) => [record.kind, record.action])).toEqual([
      ['navigation', 'allow'],
      ['navigation', 'block'],
    ]);
  });

  it('重定向与导航使用同一策略', () => {
    const window = createWindow();
    installNavigationGuards(window as never, security());

    const redirect = window.webContents.emitNavigate('https://evil.example.com/', 'will-redirect');
    expect(redirect.prevented).toBe(true);
  });

  it('允许外链时未授权导航交给系统默认浏览器并阻止应用内加载', () => {
    const window = createWindow();
    const openExternal = vi.fn();
    installNavigationGuards(window as never, security({ allowExternalLinks: true }), { openExternal });

    const event = window.webContents.emitNavigate('https://docs.example.com/help');
    expect(event.prevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://docs.example.com/help');
  });

  it('未允许外链时不调用系统浏览器', () => {
    const window = createWindow();
    const openExternal = vi.fn();
    installNavigationGuards(window as never, security(), { openExternal });

    window.webContents.emitNavigate('https://evil.example.com/');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('默认拒绝弹窗；允许时放行的窗口也必须带安全 webPreferences', () => {
    const window = createWindow();
    installNavigationGuards(window as never, security());

    expect(window.webContents.emitWindowOpen({ url: 'https://app.example.com/popup' }).action).toBe('deny');
  });

  it('允许弹窗时授权源放行并覆盖为安全的 webPreferences', () => {
    const window = createWindow();
    installNavigationGuards(window as never, security({ allowPopups: true }));

    const response = window.webContents.emitWindowOpen({ url: 'https://app.example.com/popup' });
    expect(response.action).toBe('allow');
    const options = response.overrideBrowserWindowOptions as { webPreferences?: Record<string, unknown> };
    expect(options.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    });
  });

  it('允许弹窗且允许外链时，未授权源弹窗转交系统浏览器', () => {
    const window = createWindow();
    const openExternal = vi.fn();
    installNavigationGuards(window as never, security({ allowPopups: true, allowExternalLinks: true }), {
      openExternal,
    });

    expect(window.webContents.emitWindowOpen({ url: 'https://docs.example.com/' }).action).toBe('deny');
    expect(openExternal).toHaveBeenCalledWith('https://docs.example.com/');
  });

  it('Kiosk 模式拒绝弹窗', () => {
    const window = createWindow();
    installNavigationGuards(window as never, security({ allowPopups: true }), { kiosk: true });

    expect(window.webContents.emitWindowOpen({ url: 'https://app.example.com/popup' }).action).toBe('deny');
  });

  it('默认拒绝下载，允许时按授权源放行', () => {
    const denied = createWindow();
    installNavigationGuards(denied as never, security());

    // emitDownload 返回下载是否被取消（preventDefault 被调用）。
    expect(denied.webContents.session.emitDownload({ getURL: () => 'https://app.example.com/a.pdf' })).toBe(true);

    const allowed = createWindow();
    installNavigationGuards(allowed as never, security({ allowDownloads: true }));
    expect(allowed.webContents.session.emitDownload({ getURL: () => 'https://app.example.com/a.pdf' })).toBe(false);
    expect(allowed.webContents.session.emitDownload({ getURL: () => 'https://evil.example.com/a.pdf' })).toBe(true);
  });

  it('权限请求一律被拒绝', () => {
    const window = createWindow();
    installNavigationGuards(window as never, security());

    expect(window.webContents.session.requestPermission('media')).toBe(false);
    expect(window.webContents.session.requestPermission('notifications')).toBe(false);
  });

  it('update 用新安全配置替换策略', () => {
    const window = createWindow();
    const guards = installNavigationGuards(window as never, security());

    expect(window.webContents.emitNavigate('https://app.example.com/x').prevented).toBe(false);

    guards.update(security({ allowedOrigins: ['https://other.example.com'] }));

    expect(window.webContents.emitNavigate('https://app.example.com/x').prevented).toBe(true);
    expect(window.webContents.emitNavigate('https://other.example.com/x').prevented).toBe(false);
  });

  it('dispose 移除已注册的监听器，弹窗策略退化为拒绝', () => {
    const window = createWindow();
    const guards = installNavigationGuards(window as never, security({ allowPopups: true }));

    expect(window.webContents.events.listenerCount('will-navigate')).toBe(1);
    expect(window.webContents.events.listenerCount('will-redirect')).toBe(1);
    expect(window.webContents.session.events.listenerCount('will-download')).toBe(1);

    guards.dispose();

    expect(window.webContents.events.listenerCount('will-navigate')).toBe(0);
    expect(window.webContents.events.listenerCount('will-redirect')).toBe(0);
    expect(window.webContents.session.events.listenerCount('will-download')).toBe(0);
    // 失败关闭：卸载后仍然拒绝新窗口。
    expect(window.webContents.emitWindowOpen({ url: 'https://app.example.com/popup' })).toEqual({ action: 'deny' });
  });

  it('未注入 openExternal 时外链决策不会抛出', () => {
    const window = createWindow();
    installNavigationGuards(window as never, security({ allowExternalLinks: true }));

    expect(() => window.webContents.emitNavigate('https://docs.example.com/')).not.toThrow();
  });
});

describe('安全 webPreferences', () => {
  it('远程页面固定关闭 Node 集成并启用上下文隔离与沙箱', () => {
    const preferences = secureRemoteWebPreferences();
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.sandbox).toBe(true);
    expect(preferences.webSecurity).toBe(true);
    expect(preferences.allowRunningInsecureContent).toBe(false);
    expect(preferences.webviewTag).toBe(false);
    expect(preferences.preload).toBeUndefined();
  });

  it('每次调用返回独立对象，避免窗口之间共享可变配置', () => {
    expect(secureRemoteWebPreferences()).not.toBe(secureRemoteWebPreferences());
  });
});

describe('本地配置窗口策略', () => {
  it('配置窗口不导航、不弹窗、不下载、不放行外链', () => {
    const policy = createLocalConfigSecurityPolicy();
    expect(policy).toEqual({
      allowedOrigins: [],
      allowExternalLinks: false,
      allowPopups: false,
      allowDownloads: false,
    });
  });
});
