/**
 * 跨平台配置类型契约。
 *
 * 唯一事实来源：`docs/electron-desktop-shell-product-spec-v2.1-cross-platform.md` §6。
 * Windows、macOS、Linux 三个平台共用同一结构；平台差异不进入该结构，
 * 由 `src/main/platform/` 适配层通过能力对象表达。
 *
 * 纯类型契约模块：不得导入 Electron 或 Node 内置模块。
 */

/** 配置结构版本，用于迁移判断。 */
export const CONFIG_SCHEMA_VERSION = 1;

export type WindowMode = 'window' | 'fullscreen' | 'kiosk';

/**
 * 置顶层级。取值同时是平台能力词汇，`mapAlwaysOnTopLevel` 以此为入参；
 * 具体映射与降级规则见规格 §8。
 */
export type AlwaysOnTopLevel = 'normal' | 'floating' | 'pop-up-menu' | 'screen-saver';

export type WindowCloseAction = 'hide' | 'quit';

export type ProxyMode = 'direct' | 'system' | 'fixed' | 'pac';

/**
 * 网页缓存模式（规格 v2.1.5 §7）：
 * - `keep`：不干预网页缓存（默认）；
 * - `revalidate`：远程会话每个 http/https 请求附加 `Cache-Control: no-cache`，每次导航向服务器验证；
 * - `clear`：在 `revalidate` 之上，启动首次加载目标页前清除 CacheStorage、Service Worker 与 HTTP 缓存；
 *
 * 任何模式都不清除 Cookie、localStorage、IndexedDB 等登录态存储。
 */
export type CacheMode = 'keep' | 'revalidate' | 'clear';

export type InitialState = 'tray' | 'minimized';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface WindowConfig {
  mode: WindowMode;
  alwaysOnTop: boolean;
  alwaysOnTopLevel: AlwaysOnTopLevel;
  /** `primary` 或平台显示器标识；跨平台可迁移，故保持字符串。 */
  display: string;
  closeAction: WindowCloseAction;
}

export interface NetworkConfig {
  proxyMode: ProxyMode;
  proxyServer: string;
  proxyBypass: string;
  /**
   * 接口域名列表：只有命中这些主机的请求经过代理，其余流量直连（规格 §7 接口代理语义）。
   * 每项为主机名或 `*.example.com` 子域通配，不带协议、端口和路径。
   */
  apiProxyHosts: string[];
  retryIntervalSec: number;
  requestTimeoutSec: number;
  offlinePageEnabled: boolean;
  /** 网页缓存模式，默认 `keep`；含义见规格 §7。 */
  cacheMode: CacheMode;
  /**
   * 是否放行远程业务会话中不受信任的 HTTPS 证书（规格 v2.1.7 §7）。
   * 默认 `false`：证书校验失败时页面加载失败，与普通浏览器一致。
   * `true`：远程会话（`persist:remote`）的全部证书错误（自签名、不受信任的
   * CA、主机名不匹配、过期、弱签名、已吊销等）一律放行，主框架、子资源与
   * 主进程连通性探测同样生效；仅建议用于内网自建证书的可信场景。
   */
  allowUntrustedCertificates: boolean;
}

export interface StartupConfig {
  openAtLogin: boolean;
  initialState: InitialState;
  /** 0～3600 的整数秒。 */
  delaySec: number;
  delayOnlyOnLogin: boolean;
  showAfterDelay: boolean;
}

export interface MaintenanceConfig {
  hotkeyEnabled: boolean;
  /** 仅在客户端窗口获得焦点时生效，不注册系统全局快捷键。 */
  hotkey: string;
  trayConfigEnabled: boolean;
}

export interface SecurityConfig {
  /** 授权源列表，仅允许 http/https 且带主机名的裸源。 */
  allowedOrigins: string[];
  allowExternalLinks: boolean;
  allowPopups: boolean;
  allowDownloads: boolean;
}

export interface LoggingConfig {
  level: LogLevel;
  retentionDays: number;
}

/**
 * 外观配置。平台无关：只记录配置目录中的图标文件名，
 * 平台差异（托盘尺寸、Dock）由 `src/main/appearance/` 适配层表达（规格 §5.4）。
 */
export interface AppearanceConfig {
  /** 配置目录中的图标文件名（如 `app-icon.png`）；空串表示使用内置默认图标。 */
  icon: string;
}

export interface AppConfig {
  schemaVersion: number;
  /** 必填，仅允许 http/https 且包含主机名。 */
  targetUrl: string;
  window: WindowConfig;
  network: NetworkConfig;
  startup: StartupConfig;
  maintenance: MaintenanceConfig;
  security: SecurityConfig;
  appearance: AppearanceConfig;
  logging: LoggingConfig;
}

export interface ValidationIssue {
  /** 点号路径，根级字段为空字符串。 */
  path: string;
  message: string;
  code: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

