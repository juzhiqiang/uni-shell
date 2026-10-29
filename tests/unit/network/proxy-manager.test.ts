import { describe, expect, it, vi } from 'vitest';

import type { NetworkConfig } from '../../../src/main/config/config-types';
import {
  applyProxy,
  buildStaticInterfaceProxyPacScript,
  parseResolvedProxy,
  toPacProxyIdentifier,
  toPacScriptDataUrl,
  wrapUserPacScript,
  type PacHostRule,
} from '../../../src/main/network/proxy-manager';

/**
 * 接口代理（规格 v2.1.1 §7）：
 * 只有 network.apiProxyHosts 命中的请求经过代理，页面导航、静态资源和其余流量一律直连。
 * Chromium 的 proxyRules 只支持按协议映射（net/proxy_resolution/proxy_config.cc），
 * 按域名只能走 PAC；PAC 获取器允许 data: URL 内联脚本（pac_file_fetcher_impl.cc）。
 */

function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    proxyMode: 'direct',
    proxyServer: '',
    proxyBypass: '',
    apiProxyHosts: [],
    retryIntervalSec: 3,
    requestTimeoutSec: 20,
    offlinePageEnabled: true,
    ...overrides,
  };
}

function makeSession() {
  return {
    setProxy: vi.fn().mockResolvedValue(undefined),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
    resolveProxy: vi.fn().mockResolvedValue('DIRECT'),
  };
}

/** 取出最近一次 setProxy 调用里 PAC 脚本明文（data URL 是 base64 内联）。 */
function lastPacScript(session: ReturnType<typeof makeSession>): string {
  const calls = session.setProxy.mock.calls as Array<[{ mode?: string; pacScript?: string }?]>;
  const last = calls[calls.length - 1]?.[0];
  expect(last?.mode).toBe('pac_script');
  const pacScript = last?.pacScript ?? '';
  expect(pacScript.startsWith('data:application/x-ns-proxy-autoconfig;charset=utf-8;base64,')).toBe(true);
  return Buffer.from(pacScript.slice('data:application/x-ns-proxy-autoconfig;charset=utf-8;base64,'.length), 'base64').toString(
    'utf8',
  );
}

/**
 * 在 Node 中执行生成的 PAC 脚本：注入 PAC 标准helper 桩后取回 FindProxyForURL。
 * 这样无需 Electron 就能验证代理判定行为本身。
 */
function evaluatePac(script: string, url: string, host: string): string {
  const dnsDomainIs = (candidate: string, domain: string): boolean => {
    const normalized = String(candidate).toLowerCase();
    const suffix = domain.toLowerCase();
    return normalized.length > suffix.length && normalized.endsWith(suffix);
  };
  const shExpMatch = (candidate: string, pattern: string): boolean => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i').test(String(candidate));
  };
  const factory = new Function(
    'dnsDomainIs',
    'shExpMatch',
    'isPlainHostName',
    'localHostOrDomainIs',
    'myIpAddress',
    'dnsResolve',
    'isInNet',
    `${script}\nreturn typeof FindProxyForURL === 'function' ? FindProxyForURL : undefined;`,
  );
  const findProxyForURL = factory(
    dnsDomainIs,
    shExpMatch,
    () => false,
    () => false,
    () => '127.0.0.1',
    () => '127.0.0.1',
    () => false,
  ) as ((url: string, host: string) => string) | undefined;
  expect(findProxyForURL, 'PAC 脚本应定义 FindProxyForURL').toBeTypeOf('function');
  return findProxyForURL!(url, host);
}

describe('toPacProxyIdentifier', () => {
  it.each([
    ['proxy.example.com:8080', 'PROXY proxy.example.com:8080'],
    ['http://proxy.example.com:8080', 'PROXY proxy.example.com:8080'],
    ['http://proxy.example.com', 'PROXY proxy.example.com'],
    // URL 解析会归一化掉协议默认端口（https 的 443），语义不变。
    ['https://proxy.example.com:443', 'HTTPS proxy.example.com'],
    ['socks5://proxy.example.com:1080', 'SOCKS5 proxy.example.com:1080'],
    ['socks4://proxy.example.com:1080', 'SOCKS4 proxy.example.com:1080'],
  ])('把 %s 转换为 PAC 标识 %s', (input, expected) => {
    expect(toPacProxyIdentifier(input)).toBe(expected);
  });

  it('拒绝 PAC 不支持的代理协议', () => {
    expect(() => toPacProxyIdentifier('quic://proxy.example.com:443')).toThrow();
    expect(() => toPacProxyIdentifier('ftp://proxy.example.com:21')).toThrow();
  });
});

describe('parseResolvedProxy', () => {
  it('取系统代理解析结果中的第一个代理', () => {
    expect(parseResolvedProxy('PROXY proxy.corp:8080;DIRECT')).toBe('PROXY proxy.corp:8080;DIRECT');
    expect(parseResolvedProxy('SOCKS5 socks.corp:1080')).toBe('SOCKS5 socks.corp:1080');
  });

  it('DIRECT 或无法解析时返回 null', () => {
    expect(parseResolvedProxy('DIRECT')).toBeNull();
    expect(parseResolvedProxy('')).toBeNull();
    expect(parseResolvedProxy('DIRECT;PROXY a:1')).toBeNull();
  });

  it('拒绝包含意外字符的解析结果', () => {
    expect(parseResolvedProxy('PROXY a:1";evil')).toBeNull();
  });
});

describe('buildStaticInterfaceProxyPacScript', () => {
  const rules: PacHostRule[] = [
    { host: 'api.example.com', proxy: 'PROXY proxy.internal:8080' },
    { host: '*.internal.example.com', proxy: 'SOCKS5 socks.internal:1080' },
  ];

  it('接口域名返回配置代理，其余主机一律 DIRECT', () => {
    const script = buildStaticInterfaceProxyPacScript(rules);

    expect(evaluatePac(script, 'https://api.example.com/v1/orders', 'api.example.com')).toBe('PROXY proxy.internal:8080');
    expect(evaluatePac(script, 'https://gw.internal.example.com/v1', 'gw.internal.example.com')).toBe(
      'SOCKS5 socks.internal:1080',
    );
    expect(evaluatePac(script, 'https://erp.example.com/', 'erp.example.com')).toBe('DIRECT');
    expect(evaluatePac(script, 'https://cdn.example.com/app.js', 'cdn.example.com')).toBe('DIRECT');
    expect(evaluatePac(script, 'https://internal.example.com/', 'internal.example.com')).toBe('DIRECT');
  });

  it('主机名大小写不敏感，容忍尾点', () => {
    const script = buildStaticInterfaceProxyPacScript(rules);

    expect(evaluatePac(script, 'https://API.EXAMPLE.COM/v1', 'API.EXAMPLE.COM')).toBe('PROXY proxy.internal:8080');
    expect(evaluatePac(script, 'https://api.example.com./v1', 'api.example.com.')).toBe('PROXY proxy.internal:8080');
  });

  it('空规则表时所有请求直连', () => {
    const script = buildStaticInterfaceProxyPacScript([]);
    expect(evaluatePac(script, 'https://api.example.com/v1', 'api.example.com')).toBe('DIRECT');
  });

  it('脚本对异常输入不抛出（PAC 运行时报错会导致强制代理失败）', () => {
    const script = buildStaticInterfaceProxyPacScript(rules);
    expect(evaluatePac(script, '', '')).toBe('DIRECT');
  });
});

describe('wrapUserPacScript', () => {
  const hosts = ['api.example.com', '*.example.net'];

  it('仅接口域名调用用户 PAC，其余 DIRECT', () => {
    const userPac = [
      'function FindProxyForURL(url, host) {',
      "  if (shExpMatch(host, '*.internal')) return 'PROXY gw.internal:8080';",
      "  return 'PROXY fallback:3128';",
      '}',
    ].join('\n');

    const script = wrapUserPacScript(userPac, hosts);

    expect(evaluatePac(script, 'https://api.example.com/v1', 'api.example.com')).toBe('PROXY fallback:3128');
    expect(evaluatePac(script, 'https://x.example.net/v1', 'x.example.net')).toBe('PROXY fallback:3128');
    expect(evaluatePac(script, 'https://erp.example.com/', 'erp.example.com')).toBe('DIRECT');
  });

  it('重命名用户入口，避免与分发器冲突', () => {
    const script = wrapUserPacScript('function FindProxyForURL(url, host) { return "PROXY a:1"; }', hosts);
    expect(script).toContain('uniShellUserPac');
    expect(script.match(/function FindProxyForURL/g)).toHaveLength(1);
  });

  it('用户 PAC 未定义 FindProxyForURL 时拒绝', () => {
    expect(() => wrapUserPacScript('var x = 1;', hosts)).toThrow(/FindProxyForURL/);
  });
});

describe('toPacScriptDataUrl', () => {
  it('生成 Chromium 接受的 base64 data URL（含 charset）', () => {
    const dataUrl = toPacScriptDataUrl("function FindProxyForURL(url, host) { return 'DIRECT'; }");
    expect(dataUrl.startsWith('data:application/x-ns-proxy-autoconfig;charset=utf-8;base64,')).toBe(true);
    const base64 = dataUrl.slice('data:application/x-ns-proxy-autoconfig;charset=utf-8;base64,'.length);
    expect(Buffer.from(base64, 'base64').toString('utf8')).toContain('FindProxyForURL');
  });
});

describe('applyProxy', () => {
  it('direct 模式只切换直连并关闭旧连接', async () => {
    const session = makeSession();

    await applyProxy(session as unknown as Electron.Session, makeConfig());

    expect(session.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    expect(session.closeAllConnections).toHaveBeenCalledOnce();
  });

  it('fixed 模式把单个代理固定到接口域名，其余直连', async () => {
    const session = makeSession();
    const config = makeConfig({
      proxyMode: 'fixed',
      proxyServer: 'http://proxy.internal:8080',
      proxyBypass: 'localhost',
      apiProxyHosts: ['api.example.com', '*.internal.example.com'],
    });

    const result = await applyProxy(session as unknown as Electron.Session, config);

    const last = session.setProxy.mock.calls.at(-1)?.[0] as { mode: string; proxyBypassRules?: string };
    expect(last.mode).toBe('pac_script');
    expect(last.proxyBypassRules).toBe('localhost');
    expect(session.closeAllConnections).toHaveBeenCalledOnce();

    const script = lastPacScript(session);
    expect(evaluatePac(script, 'https://api.example.com/v1', 'api.example.com')).toBe('PROXY proxy.internal:8080');
    expect(evaluatePac(script, 'https://erp.example.com/', 'erp.example.com')).toBe('DIRECT');
    expect(result).toMatchObject({ mode: 'fixed', effective: 'pac', hostCount: 2, proxiedHostCount: 2 });
  });

  it('fixed 模式未填接口域名时回落直连，不生成 PAC', async () => {
    const session = makeSession();

    const result = await applyProxy(
      session as unknown as Electron.Session,
      makeConfig({ proxyMode: 'fixed', proxyServer: 'http://proxy.internal:8080' }),
    );

    expect(session.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    expect(result).toMatchObject({ effective: 'direct', hostCount: 0 });
  });

  it('system 模式逐域名解析系统代理并固定进 PAC', async () => {
    const session = makeSession();
    session.resolveProxy.mockImplementation(async (url: string) =>
      url.includes('api.example.com') ? 'PROXY proxy.corp:8080;DIRECT' : 'DIRECT',
    );

    const result = await applyProxy(
      session as unknown as Electron.Session,
      makeConfig({ proxyMode: 'system', apiProxyHosts: ['api.example.com', 'other.example.com'] }),
    );

    // 先切回系统设置再解析，最后固定为 PAC。
    expect(session.setProxy.mock.calls[0]?.[0]).toEqual({ mode: 'system' });
    expect(session.resolveProxy).toHaveBeenCalledWith('http://api.example.com/');
    expect(session.resolveProxy).toHaveBeenCalledWith('http://other.example.com/');

    const script = lastPacScript(session);
    expect(evaluatePac(script, 'https://api.example.com/v1', 'api.example.com')).toBe('PROXY proxy.corp:8080;DIRECT');
    expect(evaluatePac(script, 'https://other.example.com/v1', 'other.example.com')).toBe('DIRECT');
    expect(result).toMatchObject({ mode: 'system', effective: 'pac', hostCount: 2, proxiedHostCount: 1 });
  });

  it('system 模式解析全部为 DIRECT 时回落直连', async () => {
    const session = makeSession();

    const result = await applyProxy(
      session as unknown as Electron.Session,
      makeConfig({ proxyMode: 'system', apiProxyHosts: ['api.example.com'] }),
    );

    expect(session.setProxy.mock.calls.at(-1)?.[0]).toEqual({ mode: 'direct' });
    expect(result).toMatchObject({ effective: 'direct', proxiedHostCount: 0 });
  });

  it('pac 模式包装用户 PAC：仅接口域名按用户判定走代理', async () => {
    const session = makeSession();
    const fetchPacScript = vi.fn(async () => 'function FindProxyForURL(url, host) { return "SOCKS5 gw.corp:1080"; }');

    const result = await applyProxy(
      session as unknown as Electron.Session,
      makeConfig({ proxyMode: 'pac', proxyServer: 'https://proxy.example.com/proxy.pac', apiProxyHosts: ['api.example.com'] }),
      { fetchPacScript },
    );

    expect(fetchPacScript).toHaveBeenCalledWith('https://proxy.example.com/proxy.pac', expect.any(Number));
    const script = lastPacScript(session);
    expect(evaluatePac(script, 'https://api.example.com/v1', 'api.example.com')).toBe('SOCKS5 gw.corp:1080');
    expect(evaluatePac(script, 'https://erp.example.com/', 'erp.example.com')).toBe('DIRECT');
    expect(result).toMatchObject({ mode: 'pac', effective: 'pac', hostCount: 1, proxiedHostCount: 1 });
  });

  it('pac 模式未填接口域名时不拉取 PAC，直接回落直连', async () => {
    const session = makeSession();
    const fetchPacScript = vi.fn(async () => 'function FindProxyForURL(url, host) { return "DIRECT"; }');

    await applyProxy(
      session as unknown as Electron.Session,
      makeConfig({ proxyMode: 'pac', proxyServer: 'https://proxy.example.com/proxy.pac' }),
      { fetchPacScript },
    );

    expect(fetchPacScript).not.toHaveBeenCalled();
    expect(session.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
  });

  it('先应用代理再关闭旧连接', async () => {
    const order: string[] = [];
    const session = {
      setProxy: vi.fn(async () => { order.push('set'); }),
      closeAllConnections: vi.fn(async () => { order.push('close'); }),
      resolveProxy: vi.fn(async () => 'DIRECT'),
    };

    await applyProxy(
      session as unknown as Electron.Session,
      makeConfig({ proxyMode: 'fixed', proxyServer: 'proxy.internal:8080', apiProxyHosts: ['api.example.com'] }),
    );

    expect(order).toEqual(['set', 'close']);
  });

  it.each([
    ['fixed 代理缺失', makeConfig({ proxyMode: 'fixed', apiProxyHosts: ['api.example.com'] })],
    [
      'fixed 代理带路由规则',
      makeConfig({ proxyMode: 'fixed', proxyServer: 'http=a:8080;https=b:8443', apiProxyHosts: ['api.example.com'] }),
    ],
    [
      'fixed 代理带回退链',
      makeConfig({ proxyMode: 'fixed', proxyServer: 'a:8080,direct://', apiProxyHosts: ['api.example.com'] }),
    ],
    [
      'fixed 代理带凭据',
      makeConfig({ proxyMode: 'fixed', proxyServer: 'http://user:secret@proxy.example.com:8080', apiProxyHosts: ['api.example.com'] }),
    ],
    [
      'fixed 代理带路径',
      makeConfig({ proxyMode: 'fixed', proxyServer: 'http://proxy.example.com:8080/path', apiProxyHosts: ['api.example.com'] }),
    ],
    [
      'fixed 代理协议不受支持',
      makeConfig({ proxyMode: 'fixed', proxyServer: 'quic://proxy.example.com:443', apiProxyHosts: ['api.example.com'] }),
    ],
    ['PAC 地址无效', makeConfig({ proxyMode: 'pac', proxyServer: 'file:///proxy.pac', apiProxyHosts: ['api.example.com'] })],
  ])('拒绝非法代理值：先回落直连再抛出，%s', async (_name, config) => {
    const session = makeSession();
    const fetchPacScript = vi.fn(async () => 'function FindProxyForURL(url, host) { return "DIRECT"; }');

    await expect(
      applyProxy(session as unknown as Electron.Session, config, { fetchPacScript }),
    ).rejects.toThrow();
    // 显式直连：避免会话停留在 Electron 默认的系统代理（等于全部流量走代理）。
    expect(session.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    expect(session.closeAllConnections).toHaveBeenCalledOnce();
  });

  it('PAC 拉取失败时先回落直连再抛出', async () => {
    const session = makeSession();
    const fetchPacScript = vi.fn(async () => {
      throw new Error('PAC 地址不可达');
    });

    await expect(
      applyProxy(
        session as unknown as Electron.Session,
        makeConfig({ proxyMode: 'pac', proxyServer: 'https://proxy.example.com/proxy.pac', apiProxyHosts: ['api.example.com'] }),
        { fetchPacScript },
      ),
    ).rejects.toThrow(/PAC/);
    expect(session.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
  });

  it('PAC 响应非 200 时先回落直连再抛出', async () => {
    const session = makeSession();
    const fetchPacScript = vi.fn(async () => {
      throw new Error('PAC 地址返回 HTTP 503');
    });

    await expect(
      applyProxy(
        session as unknown as Electron.Session,
        makeConfig({ proxyMode: 'pac', proxyServer: 'https://proxy.example.com/proxy.pac', apiProxyHosts: ['api.example.com'] }),
        { fetchPacScript },
      ),
    ).rejects.toThrow();
    expect(session.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
  });
});
