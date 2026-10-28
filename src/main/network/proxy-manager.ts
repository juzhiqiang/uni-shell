import type { ProxyConfig, Session } from 'electron';

import type { NetworkConfig } from '../config/config-types';

const proxyProtocols = new Set(['http:', 'https:', 'socks4:', 'socks5:', 'quic:']);
const routingSchemes = new Set(['http', 'https', 'ftp', 'socks']);

function parseUrl(value: string, field: string, allowedProtocols: Set<string>): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} 必须是有效的 URL`);
  }

  if (!allowedProtocols.has(url.protocol)) {
    throw new Error(`${field} 使用了不支持的协议`);
  }

  if (!url.hostname || url.username || url.password) {
    throw new Error(`${field} 必须包含主机名且不能包含代理凭据`);
  }

  return url;
}

function validateProxyEndpoint(endpoint: string): void {
  if (endpoint === 'direct://') return;

  const candidate = endpoint.includes('://') ? endpoint : `http://${endpoint}`;
  const proxyUrl = parseUrl(candidate, 'proxyServer', proxyProtocols);
  if ((proxyUrl.pathname !== '' && proxyUrl.pathname !== '/') || proxyUrl.search || proxyUrl.hash) {
    throw new Error('proxyServer 代理地址不能包含路径、查询参数或片段');
  }
}

function validateProxyRules(value: string): string {
  const rules = value.trim();
  if (!rules) throw new Error('proxyServer 不能为空');

  for (const group of rules.split(';')) {
    if (!group) throw new Error('proxyServer 包含空代理规则');

    const separator = group.indexOf('=');
    const route = separator === -1 ? undefined : group.slice(0, separator);
    const endpoints = separator === -1 ? group : group.slice(separator + 1);
    if (route !== undefined && !routingSchemes.has(route)) {
      throw new Error('proxyServer 包含不支持的路由协议');
    }

    const endpointList = endpoints.split(',');
    if (endpointList.some((endpoint) => !endpoint)) throw new Error('proxyServer 包含空代理地址');
    endpointList.forEach(validateProxyEndpoint);
  }

  return rules;
}

function buildProxyConfig(config: NetworkConfig): ProxyConfig {
  const bypassRules = config.proxyBypass.trim();

  switch (config.proxyMode) {
    case 'direct':
      return { mode: 'direct' };
    case 'system':
      return { mode: 'system' };
    case 'fixed': {
      const proxyRules = validateProxyRules(config.proxyServer);
      return {
        mode: 'fixed_servers',
        proxyRules,
        ...(bypassRules ? { proxyBypassRules: bypassRules } : {}),
      };
    }
    case 'pac': {
      const pacUrl = parseUrl(config.proxyServer.trim(), 'proxyServer', new Set(['http:', 'https:']));
      return {
        mode: 'pac_script',
        pacScript: pacUrl.href,
        ...(bypassRules ? { proxyBypassRules: bypassRules } : {}),
      };
    }
    default: {
      const unsupportedMode: never = config.proxyMode;
      throw new Error(`不支持的代理模式：${String(unsupportedMode)}`);
    }
  }
}

/** Applies the selected proxy and drops connections opened with the previous settings. */
export async function applyProxy(session: Session, config: NetworkConfig): Promise<void> {
  const proxyConfig = buildProxyConfig(config);
  await session.setProxy(proxyConfig);
  await session.closeAllConnections();
}
