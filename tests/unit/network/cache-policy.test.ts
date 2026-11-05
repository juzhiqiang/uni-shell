import { describe, expect, it } from 'vitest';

import {
  CLEARABLE_STORAGES,
  REVALIDATION_URL_FILTER,
  buildRevalidationHeaders,
  clearRemoteCache,
  installCachePolicy,
  resolveCacheBehavior,
  type CachePolicySession,
  type RevalidationRequestDetails,
} from '../../../src/main/network/cache-policy';

/**
 * 网页缓存策略测试。
 *
 * 规则来源：规格 v2.1.5 §7（`network.cacheMode` 三态）、§12（清除诊断）、
 * `rules/testing-release.md`（Electron API 经注入端口测试，不依赖真实 Session）。
 *
 * 假 Session 只录制 `webRequest.onBeforeSendHeaders` 注册/移除与两个清除调用，
 * 不触碰真实 Chromium 网络栈。
 */

type BeforeSendHeadersListener = (
  details: RevalidationRequestDetails,
  callback: (response: { requestHeaders: Record<string, string> }) => void,
) => void;

class FakeWebRequest {
  readonly registrations: Array<{ filter: { urls: string[] }; listener: BeforeSendHeadersListener | null }> = [];

  onBeforeSendHeaders(filter: { urls: string[] }, listener: BeforeSendHeadersListener | null): void {
    this.registrations.push({ filter, listener });
  }

  /**
   * Electron 语义：同一 filter 以最后一次注册（含传 `null` 移除）为准，
   * 只有生效监听会收到请求。
   */
  private effectiveListeners(): BeforeSendHeadersListener[] {
    const latest = new Map<{ urls: string[] }, BeforeSendHeadersListener | null>();
    for (const registration of this.registrations) latest.set(registration.filter, registration.listener);
    return [...latest.values()].filter((listener): listener is BeforeSendHeadersListener => listener !== null);
  }

  /** 模拟 Electron：把请求依次交给生效监听，返回最终请求头。 */
  emit(details: RevalidationRequestDetails): Record<string, string> {
    let headers = { ...details.requestHeaders };
    for (const listener of this.effectiveListeners()) {
      listener(details, (response) => {
        headers = response.requestHeaders;
      });
    }
    return headers;
  }

  activeListenerCount(filter: { urls: string[] }): number {
    const latest = [...this.registrations].reverse().find((registration) => registration.filter === filter);
    return latest !== undefined && latest.listener !== null ? 1 : 0;
  }
}

class FakeSession implements CachePolicySession {
  readonly webRequest = new FakeWebRequest();
  readonly clearCalls: string[] = [];
  failClearStorageData = false;
  failClearCache = false;

  async clearCache(): Promise<void> {
    this.clearCalls.push('clearCache');
    if (this.failClearCache) throw new Error('磁盘占用');
  }

  async clearStorageData(options?: { storages?: string[] }): Promise<void> {
    this.clearCalls.push(`clearStorageData:${(options?.storages ?? []).join(',')}`);
    if (this.failClearStorageData) throw new Error('存储占用');
  }
}

function requestDetails(requestHeaders: Record<string, string> = {}): RevalidationRequestDetails {
  return { requestHeaders };
}

describe('resolveCacheBehavior（规格 §7 三态）', () => {
  it('keep：不干预缓存，也不清除', () => {
    expect(resolveCacheBehavior('keep')).toEqual({ forceRevalidate: false, clearOnStart: false });
  });

  it('revalidate：只注入请求头，不清除', () => {
    expect(resolveCacheBehavior('revalidate')).toEqual({ forceRevalidate: true, clearOnStart: false });
  });

  it('clear：注入请求头并在启动时清除', () => {
    expect(resolveCacheBehavior('clear')).toEqual({ forceRevalidate: true, clearOnStart: true });
  });
});

describe('buildRevalidationHeaders', () => {
  it('缺失时补齐 Cache-Control 与 Pragma', () => {
    expect(buildRevalidationHeaders({ Accept: 'text/html' })).toEqual({
      Accept: 'text/html',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    });
  });

  it('覆盖已存在的强缓存指令（大小写不敏感）', () => {
    const headers = buildRevalidationHeaders({
      'cache-control': 'max-age=31536000, immutable',
      pragma: 'no-cache-obsolete',
      Cookie: 'session=1',
    });
    expect(headers['Cache-Control']).toBe('no-cache');
    expect(headers.Pragma).toBe('no-cache');
    expect(headers.Cookie).toBe('session=1');
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === 'cache-control')).toHaveLength(1);
  });

  it('不修改入参对象', () => {
    const existing = { Accept: 'text/html' };
    buildRevalidationHeaders(existing);
    expect(existing).toEqual({ Accept: 'text/html' });
  });
});

describe('URL 过滤器与清除范围', () => {
  it('只干预 http(s) 请求', () => {
    expect(REVALIDATION_URL_FILTER.urls).toEqual(['http://*/*', 'https://*/*']);
  });

  it('清除范围只含 CacheStorage 与 Service Worker，不含登录态存储', () => {
    expect([...CLEARABLE_STORAGES]).toEqual(['cachestorage', 'serviceworkers']);
    for (const forbidden of ['cookies', 'localstorage', 'indexdb', 'filesystem', 'shadercache']) {
      expect(CLEARABLE_STORAGES).not.toContain(forbidden);
    }
  });
});

describe('installCachePolicy', () => {
  it('keep 不注册任何监听', () => {
    const session = new FakeSession();
    installCachePolicy(session, 'keep');
    expect(session.webRequest.registrations).toHaveLength(0);
  });

  it('revalidate 注册监听并改写请求头，保留其余头', () => {
    const session = new FakeSession();
    installCachePolicy(session, 'revalidate');
    expect(session.webRequest.activeListenerCount(REVALIDATION_URL_FILTER)).toBe(1);

    const headers = session.webRequest.emit(
      requestDetails({ Cookie: 'session=1', 'Cache-Control': 'max-age=600', Accept: 'text/html' }),
    );
    expect(headers['Cache-Control']).toBe('no-cache');
    expect(headers.Pragma).toBe('no-cache');
    expect(headers.Cookie).toBe('session=1');
    expect(headers.Accept).toBe('text/html');
  });

  it('clear 同样注册监听（clear 蕴含 revalidate 行为）', () => {
    const session = new FakeSession();
    installCachePolicy(session, 'clear');
    expect(session.webRequest.activeListenerCount(REVALIDATION_URL_FILTER)).toBe(1);
  });

  it('update 切换到 keep 后请求头不再被改写，切回 revalidate 后恢复', () => {
    const session = new FakeSession();
    const handle = installCachePolicy(session, 'revalidate');

    handle.update('keep');
    expect(session.webRequest.activeListenerCount(REVALIDATION_URL_FILTER)).toBe(0);
    expect(session.webRequest.emit(requestDetails({ Accept: 'text/html' }))).toEqual({ Accept: 'text/html' });

    handle.update('revalidate');
    expect(session.webRequest.activeListenerCount(REVALIDATION_URL_FILTER)).toBe(1);
    expect(session.webRequest.emit(requestDetails({})).Pragma).toBe('no-cache');
  });

  it('同一模式重复 update 不重复注册', () => {
    const session = new FakeSession();
    const handle = installCachePolicy(session, 'revalidate');
    handle.update('revalidate');
    handle.update('clear');
    expect(session.webRequest.activeListenerCount(REVALIDATION_URL_FILTER)).toBe(1);
  });

  it('dispose 移除监听；未安装时调用 dispose 无副作用', () => {
    const session = new FakeSession();
    const installed = installCachePolicy(session, 'revalidate');
    installed.dispose();
    expect(session.webRequest.activeListenerCount(REVALIDATION_URL_FILTER)).toBe(0);

    const never = installCachePolicy(session, 'keep');
    never.dispose();
    expect(session.webRequest.registrations).toHaveLength(2); // revalidate 注册 + null 移除
  });

  it('安装策略本身不清除任何存储', () => {
    const session = new FakeSession();
    installCachePolicy(session, 'clear');
    expect(session.clearCalls).toEqual([]);
  });
});

describe('clearRemoteCache', () => {
  it('先清 CacheStorage 与 Service Worker，再清 HTTP 缓存', async () => {
    const session = new FakeSession();
    await clearRemoteCache(session);
    expect(session.clearCalls).toEqual(['clearStorageData:cachestorage,serviceworkers', 'clearCache']);
  });

  it('清除失败向上抛，由调用方决定降级', async () => {
    const failing = new FakeSession();
    failing.failClearStorageData = true;
    await expect(clearRemoteCache(failing)).rejects.toThrow('存储占用');
    expect(failing.clearCalls).not.toContain('clearCache');

    const cacheFailing = new FakeSession();
    cacheFailing.failClearCache = true;
    await expect(clearRemoteCache(cacheFailing)).rejects.toThrow('磁盘占用');
  });
});
