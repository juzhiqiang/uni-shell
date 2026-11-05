/**
 * 网页缓存策略。
 *
 * 规则来源：规格 v2.1.5 §7（`network.cacheMode` 三态行为）、§12（`cache-cleared`
 * 诊断）、§5.2（热应用分级）与 `rules/security.md`「会话分区与策略隔离」。
 *
 * 背景：远程业务窗口使用持久化分区 `persist:remote`，HTTP 磁盘缓存、CacheStorage
 * 与 Service Worker 重启不丢。网页强缓存时，更新后容器内仍展示旧页面；旧 Service
 * Worker 引用缺失的带哈希资源时直接白屏（不触发 `did-fail-load`，离线页机制不介入）。
 *
 * 三态语义（默认 `keep`，由使用者按场景选择）：
 * - `keep`：客户端不干预网页缓存；
 * - `revalidate`：远程会话每个 http/https 请求附加 `Cache-Control: no-cache`，
 *   每次导航向服务器验证，304 时仍用本地副本；不改动任何本地存储；
 * - `clear`：在 `revalidate` 之上，启动首次加载目标页前清除 CacheStorage 与
 *   Service Worker 注册及 HTTP 缓存。
 *
 * 硬约束：任何清除都**不得**触碰 Cookie、localStorage、IndexedDB、文件系统等
 * 登录态存储；Electron API 经注入端口传入，测试不依赖真实 Session。
 */

import type { CacheMode } from '../../shared/config-types';

export interface CacheBehavior {
  /** 是否给远程会话请求注入强制重新验证头。 */
  forceRevalidate: boolean;
  /** 是否在启动首次加载目标页前清除缓存。 */
  clearOnStart: boolean;
}

/** 配置三态 → 行为开关。 */
export function resolveCacheBehavior(mode: CacheMode): CacheBehavior {
  if (mode === 'keep') return { forceRevalidate: false, clearOnStart: false };
  if (mode === 'revalidate') return { forceRevalidate: true, clearOnStart: false };
  return { forceRevalidate: true, clearOnStart: true };
}

/**
 * 请求头策略的 URL 过滤器：只干预 http(s)。
 *
 * `file:`（离线页、配置页）、`data:`（PAC）等scheme 不经过缓存协商，无需也不应触碰。
 */
export const REVALIDATION_URL_FILTER: { urls: string[] } = { urls: ['http://*/*', 'https://*/*'] };

/** 强制重新验证请求头：让浏览器每次导航都向服务器验证，304 时仍使用本地副本。 */
const REVALIDATION_HEADERS: Record<string, string> = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' };

/**
 * 在既有请求头基础上注入强制验证头。
 *
 * 同名头（大小写不敏感）先移除再写入规范名，避免出现两个 `Cache-Control`；
 * 其余头（Cookie、Accept 等）原样保留。纯函数，不修改入参。
 */
export function buildRevalidationHeaders(existing: Record<string, string>): Record<string, string> {
  const overridden = new Set(Object.keys(REVALIDATION_HEADERS).map((name) => name.toLowerCase()));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(existing)) {
    if (overridden.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return { ...headers, ...REVALIDATION_HEADERS };
}

/**
 * `clear` 模式的存储清除范围。
 *
 * Electron `ClearStorageDataOptions.storages` 合法取值为 `cookies`、`filesystem`、
 * `indexdb`、`localstorage`、`shadercache`、`serviceworkers`、`cachestorage`
 * （无 `appcache`）。这里只取 `cachestorage` 与 `serviceworkers`：Cookie、
 * localStorage、IndexedDB、文件系统是登录态载体，永不清除（规格 §7 硬约束）；
 * HTTP 磁盘缓存由 `clearCache()` 负责（其清除范围比 `clearStorageData` 更彻底）。
 */
export const CLEARABLE_STORAGES: readonly string[] = ['cachestorage', 'serviceworkers'];

/** `onBeforeSendHeaders` 监听收到的最小请求面。 */
export interface RevalidationRequestDetails {
  requestHeaders: Record<string, string>;
}

/** `session.webRequest` 的最小使用面；真实 `WebRequest` 结构上满足该接口。 */
export interface RevalidationWebRequest {
  onBeforeSendHeaders(
    filter: { urls: string[] },
    listener:
      | ((details: RevalidationRequestDetails, callback: (response: { requestHeaders: Record<string, string> }) => void) => void)
      | null,
  ): void;
}

/** 远程会话的最小使用面；真实 Electron `Session` 结构上满足该接口。 */
export interface CachePolicySession {
  webRequest: RevalidationWebRequest;
  clearCache(): Promise<void>;
  clearStorageData(options?: { storages?: string[] }): Promise<void>;
}

export interface CachePolicyHandle {
  /** 热应用新模式（规格 §5.2：请求头策略即时生效）。 */
  update(mode: CacheMode): void;
  /** 移除监听；幂等。 */
  dispose(): void;
}

/**
 * 在会话上安装（或按模式跳过）请求头策略。
 *
 * 安装是幂等的：同一 filter 下重复注册会叠加监听，因此用 `installed` 守卫；
 * 移除沿用 Electron 语义——对该 filter 传 `null` 即移除其下全部监听
 * （与 `setPermissionRequestHandler(null)` 同一模式）。
 */
export function installCachePolicy(session: CachePolicySession, mode: CacheMode): CachePolicyHandle {
  let behavior = resolveCacheBehavior(mode);
  let installed = false;

  const listener = (details: RevalidationRequestDetails, callback: (response: { requestHeaders: Record<string, string> }) => void): void => {
    callback({ requestHeaders: buildRevalidationHeaders(details.requestHeaders) });
  };

  const install = (): void => {
    if (installed) return;
    session.webRequest.onBeforeSendHeaders(REVALIDATION_URL_FILTER, listener);
    installed = true;
  };

  const uninstall = (): void => {
    if (!installed) return;
    session.webRequest.onBeforeSendHeaders(REVALIDATION_URL_FILTER, null);
    installed = false;
  };

  if (behavior.forceRevalidate) install();

  return {
    update(next: CacheMode): void {
      behavior = resolveCacheBehavior(next);
      if (behavior.forceRevalidate) install();
      else uninstall();
    },
    dispose(): void {
      uninstall();
    },
  };
}

/**
 * 清除网页缓存（`clear` 模式，启动首次加载目标页前调用）。
 *
 * 先清 CacheStorage 与 Service Worker 注册，再清 HTTP 磁盘缓存；任一步失败即
 * 拒绝，由调用方记录 `cache-clear-failed` 并继续加载页面，不阻断启动。
 */
export async function clearRemoteCache(session: CachePolicySession): Promise<void> {
  await session.clearStorageData({ storages: [...CLEARABLE_STORAGES] });
  await session.clearCache();
}
