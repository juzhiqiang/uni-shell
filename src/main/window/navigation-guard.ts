/**
 * 远程页面导航、弹窗、下载、外链与权限策略。
 *
 * 规则来源：规格 v2.1 §11（安全要求）与 `rules/security.md`「导航、弹窗和权限」：
 * - 使用授权源列表限制主框架导航和重定向；
 * - 默认阻止新窗口、弹窗、下载和权限请求；
 * - 外部链接仅在配置允许时交给系统默认浏览器；
 * - 对 will-navigate、setWindowOpenHandler、权限请求和下载分别实施策略，
 *   不依赖单一事件拦截。
 *
 * 设计约束（`rules/architecture.md`、`rules/testing-release.md`）：
 * - 本模块不导入 Electron 运行时，Electron 能力通过最小结构化端口注入，
 *   因此决策函数与安装函数都能在纯 Node 环境下完整测试；
 * - 决策一律失败关闭（fail-closed）：无法解析、无法读取来源或能力未注入时按拒绝处理。
 *
 * 接口按 Electron 45 的真实事件形状声明：
 * - `will-navigate` / `will-redirect` 的监听器第一个参数是 details 对象
 *   （`details.url` + `details.preventDefault()`），位置参数形式已废弃；
 * - `setWindowOpenHandler` 是 webContents 的方法而不是事件；
 * - `will-download` 没有回调，取消下载使用 `event.preventDefault()`。
 */

import type { SecurityConfig } from '../config/config-types';

/** 守卫决策结果。 */
export interface GuardDecision {
  /**
   * - `allow`：允许在应用内发生（导航、授权源弹窗、授权源下载）；
   * - `deny`：直接拒绝（弹窗、下载、权限请求）；
   * - `block`：阻止应用内导航，且不外带；
   * - `open-external`：阻止应用内加载，并交给系统默认浏览器。
   */
  action: 'allow' | 'deny' | 'block' | 'open-external';
  reason: string;
}

/** 守卫决策记录，供日志与诊断消费（Task 9）。 */
export interface NavigationGuardRecord {
  kind: 'navigation' | 'redirect' | 'window-open' | 'download' | 'permission';
  url: string;
  action: GuardDecision['action'];
  reason: string;
}

/** 可被拦截的事件。 */
export interface GuardEvent {
  preventDefault(): void;
}

/** `will-navigate` / `will-redirect` 的 details 子集。 */
export interface GuardNavigationDetails {
  url: string;
  preventDefault(): void;
}

/** `setWindowOpenHandler` 的 details 子集。 */
export interface GuardWindowOpenDetails {
  url: string;
}

/** `setWindowOpenHandler` 的返回值。 */
export interface GuardWindowOpenResponse {
  action: 'allow' | 'deny';
  /** 放行弹窗时强制覆盖的安全选项，避免新窗口继承上游窗口的配置。 */
  overrideBrowserWindowOptions?: unknown;
}

/** `DownloadItem` 的最小读取面。 */
export interface GuardDownloadItem {
  getURL?: () => string;
  url?: string;
}

/** `session` 的最小读取面。 */
export interface GuardSession {
  on(
    event: 'will-download',
    listener: (event: GuardEvent, item: GuardDownloadItem, webContents?: unknown, frame?: unknown) => void,
  ): unknown;
  off(
    event: 'will-download',
    listener: (event: GuardEvent, item: GuardDownloadItem, webContents?: unknown, frame?: unknown) => void,
  ): unknown;
  setPermissionRequestHandler(
    handler:
      | ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void)
      | null,
  ): void;
}

/** `webContents` 的最小读取面。 */
export interface GuardWebContents {
  isDestroyed?: () => boolean;
  on(
    event: 'will-navigate' | 'will-redirect',
    listener: (details: GuardNavigationDetails) => void,
  ): unknown;
  off(
    event: 'will-navigate' | 'will-redirect',
    listener: (details: GuardNavigationDetails) => void,
  ): unknown;
  setWindowOpenHandler(handler: (details: GuardWindowOpenDetails) => GuardWindowOpenResponse): void;
  session: GuardSession;
}

/** 被保护窗口的最小读取面；真实 `BrowserWindow` 结构上满足该接口。 */
export interface GuardWindow {
  webContents: GuardWebContents;
}

export interface NavigationGuardOptions {
  /** 外链出口；未注入时外链决策只记录不放行（失败关闭）。 */
  openExternal?: (url: string) => void | Promise<void>;
  /** 决策回调，供日志与诊断消费（Task 9）。 */
  onDecision?: (record: NavigationGuardRecord) => void;
  /** Kiosk 模式：规格 §8 要求限制新窗口。 */
  kiosk?: boolean;
}

export interface NavigationGuardHandle {
  /** 配置保存后替换策略，无需重建窗口。 */
  update(security: SecurityConfig): void;
  /** 移除本守卫注册的监听器；弹窗策略替换为拒绝，保持失败关闭。 */
  dispose(): void;
}

/** 允许交给系统默认浏览器的协议。javascript:/data:/file: 等一律不外带。 */
const EXTERNAL_LINK_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * 归一化裸源：`scheme://host[:port]`。
 * 非 http/https、空值或无法解析时返回 null。
 */
export function normalizeOrigin(value: string): string | null {
  const url = parseUrl(value);
  if (url === null) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname.length === 0) return null;
  return `${url.protocol}//${url.host}`;
}

/** 判断地址是否属于授权源列表（按源比较，忽略路径、查询、片段和大小写）。 */
export function isAllowedOrigin(value: string, allowedOrigins: readonly string[]): boolean {
  const origin = normalizeOrigin(value);
  if (origin === null) return false;
  return allowedOrigins.some((allowed) => normalizeOrigin(allowed) === origin);
}

/** 判断地址是否可以交给系统默认浏览器。 */
export function isExternallyOpenableUrl(value: string): boolean {
  const url = parseUrl(value);
  if (url === null) return false;
  return EXTERNAL_LINK_SCHEMES.includes(url.protocol);
}

/**
 * 主框架导航与重定向策略：授权源内放行；未授权源在允许外链时外带，否则阻止。
 */
export function decideNavigation(value: string, security: SecurityConfig): GuardDecision {
  if (isAllowedOrigin(value, security.allowedOrigins)) {
    return { action: 'allow', reason: '目标源在授权源列表中' };
  }
  if (security.allowExternalLinks && isExternallyOpenableUrl(value)) {
    return { action: 'open-external', reason: '目标源未授权，按配置作为外链交给系统默认浏览器' };
  }
  return { action: 'block', reason: '目标源不在授权源列表中，且未允许外链，已阻止应用内导航' };
}

/**
 * 弹窗策略：默认拒绝；Kiosk 模式一律拒绝；允许时仅放行授权源。
 */
export function decideWindowOpen(
  value: string,
  security: SecurityConfig,
  options: { kiosk?: boolean } = {},
): GuardDecision {
  if (options.kiosk === true) {
    return { action: 'deny', reason: 'Kiosk 模式限制新窗口' };
  }
  if (!security.allowPopups) {
    return { action: 'deny', reason: '默认禁止新窗口与弹窗（security.allowPopups=false）' };
  }
  if (isAllowedOrigin(value, security.allowedOrigins)) {
    return { action: 'allow', reason: '弹窗目标源在授权源列表中' };
  }
  if (security.allowExternalLinks && isExternallyOpenableUrl(value)) {
    return { action: 'open-external', reason: '弹窗目标源未授权，按配置作为外链交给系统默认浏览器' };
  }
  return { action: 'deny', reason: '弹窗目标源不在授权源列表中' };
}

/**
 * 下载策略：默认拒绝；Kiosk 模式一律拒绝；允许时仅放行授权源。
 */
export function decideDownload(
  value: string,
  security: SecurityConfig,
  options: { kiosk?: boolean } = {},
): GuardDecision {
  if (options.kiosk === true) {
    return { action: 'deny', reason: 'Kiosk 模式禁止下载' };
  }
  if (!security.allowDownloads) {
    return { action: 'deny', reason: '默认禁止下载（security.allowDownloads=false）' };
  }
  if (isAllowedOrigin(value, security.allowedOrigins)) {
    return { action: 'allow', reason: '下载来源在授权源列表中' };
  }
  return { action: 'deny', reason: '下载来源不在授权源列表中' };
}

/**
 * 权限策略：规格 v2.1 §11 默认禁止通知、摄像头、麦克风和 USB 等权限请求，
 * 配置中没有放开权限的字段，因此一律拒绝。
 *
 * 只安装 `setPermissionRequestHandler`，不安装 `setPermissionCheckHandler`：
 * 后者会连 `clipboard-sanitized-write` 这类 Electron 内部自动放行的写入型
 * 权限一起拒绝，破坏远程页面的基本复制粘贴；规格清单内的权限都是请求型，
 * 由请求处理器覆盖即可。
 */
export function decidePermission(permission: string): GuardDecision {
  return { action: 'deny', reason: `默认拒绝权限请求：${permission}（规格 v2.1 §11）` };
}

/** 读取下载地址；失败时返回空字符串，由下载策略按拒绝处理。 */
export function readDownloadUrl(item: GuardDownloadItem): string {
  if (typeof item.getURL === 'function') {
    try {
      return item.getURL();
    } catch {
      return '';
    }
  }
  return typeof item.url === 'string' ? item.url : '';
}

/**
 * 渲染远程内容的窗口必须使用的 webPreferences。
 * 主窗口、被放行的弹窗都使用同一份策略，避免遗漏。
 */
export function secureRemoteWebPreferences(): Record<string, unknown> {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
  };
}

/**
 * 本地配置窗口的策略：本地页面没有导航、弹窗、下载或外链的合法需求，
 * 一律按拒绝处理；需要系统能力的操作由后续任务通过白名单 IPC 提供。
 */
export function createLocalConfigSecurityPolicy(): SecurityConfig {
  return {
    allowedOrigins: [],
    allowExternalLinks: false,
    allowPopups: false,
    allowDownloads: false,
  };
}

type NavigationKind = NavigationGuardRecord['kind'];

/**
 * 为窗口安装导航、弹窗、下载和权限守卫。
 *
 * 策略集中在 `holder.security`，`update` 可在配置保存后热替换；
 * `dispose` 移除本守卫注册的监听器，并把弹窗策略替换为拒绝（失败关闭）。
 * 会话级权限策略是进程内共享的拒绝默认，是否清除应由会话所有者决定，
 * 这里不擅自移除。
 */
export function installNavigationGuards(
  window: GuardWindow,
  security: SecurityConfig,
  options: NavigationGuardOptions = {},
): NavigationGuardHandle {
  const holder: { security: SecurityConfig } = { security };
  const kiosk = options.kiosk === true;
  const { webContents } = window;

  const record = (kind: NavigationKind, url: string, decision: GuardDecision): void => {
    options.onDecision?.({ kind, url, action: decision.action, reason: decision.reason });
  };

  const openExternally = (url: string): void => {
    if (typeof options.openExternal === 'function') {
      void options.openExternal(url);
    }
  };

  const onNavigate = (details: GuardNavigationDetails): void => {
    const decision = decideNavigation(details.url, holder.security);
    record('navigation', details.url, decision);
    if (decision.action === 'allow') return;
    details.preventDefault();
    if (decision.action === 'open-external') openExternally(details.url);
  };

  const onRedirect = (details: GuardNavigationDetails): void => {
    const decision = decideNavigation(details.url, holder.security);
    record('redirect', details.url, decision);
    if (decision.action === 'allow') return;
    details.preventDefault();
    if (decision.action === 'open-external') openExternally(details.url);
  };

  const onWindowOpen = (details: GuardWindowOpenDetails): GuardWindowOpenResponse => {
    const decision = decideWindowOpen(details.url, holder.security, { kiosk });
    record('window-open', details.url, decision);
    if (decision.action === 'allow') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: secureRemoteWebPreferences() },
      };
    }
    if (decision.action === 'open-external') openExternally(details.url);
    return { action: 'deny' };
  };

  const onWillDownload = (event: GuardEvent, item: GuardDownloadItem): void => {
    const url = readDownloadUrl(item);
    const decision = decideDownload(url, holder.security, { kiosk });
    record('download', url, decision);
    if (decision.action !== 'allow') event.preventDefault();
  };

  const onPermissionRequest = (
    _contents: unknown,
    permission: string,
    callback: (granted: boolean) => void,
  ): void => {
    const decision = decidePermission(permission);
    record('permission', permission, decision);
    callback(false);
  };

  /** 卸载后的失败关闭策略：一律拒绝新窗口。 */
  const denyAllWindowOpen = (): GuardWindowOpenResponse => ({ action: 'deny' });

  webContents.on('will-navigate', onNavigate);
  webContents.on('will-redirect', onRedirect);
  webContents.setWindowOpenHandler(onWindowOpen);
  webContents.session.on('will-download', onWillDownload);
  webContents.session.setPermissionRequestHandler(onPermissionRequest);

  return {
    update(next: SecurityConfig): void {
      holder.security = next;
    },
    dispose(): void {
      if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
        return;
      }
      try {
        webContents.off('will-navigate', onNavigate);
        webContents.off('will-redirect', onRedirect);
        webContents.session.off('will-download', onWillDownload);
        webContents.setWindowOpenHandler(denyAllWindowOpen);
      } catch {
        // 窗口已销毁时静默安全退出，避免 Object has been destroyed
      }
    },
  };
}
