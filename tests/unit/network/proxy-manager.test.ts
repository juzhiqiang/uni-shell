import { describe, expect, it, vi } from 'vitest';

import type { NetworkConfig } from '../../../src/main/config/config-types';
import { applyProxy } from '../../../src/main/network/proxy-manager';

function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    proxyMode: 'direct',
    proxyServer: '',
    proxyBypass: '',
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
  };
}

describe('applyProxy', () => {
  it.each([
    ['direct', makeConfig(), { mode: 'direct' }],
    ['system', makeConfig({ proxyMode: 'system' }), { mode: 'system' }],
    [
      'fixed',
      makeConfig({ proxyMode: 'fixed', proxyServer: 'proxy.example.com:8080', proxyBypass: 'localhost,*.internal' }),
      {
        mode: 'fixed_servers',
        proxyRules: 'proxy.example.com:8080',
        proxyBypassRules: 'localhost,*.internal',
      },
    ],
    [
      'pac',
      makeConfig({ proxyMode: 'pac', proxyServer: 'https://proxy.example.com/proxy.pac', proxyBypass: 'localhost' }),
      {
        mode: 'pac_script',
        pacScript: 'https://proxy.example.com/proxy.pac',
        proxyBypassRules: 'localhost',
      },
    ],
  ])('maps %s mode and closes existing connections', async (_name, config, expected) => {
    const session = makeSession();

    await applyProxy(session as unknown as Electron.Session, config);

    expect(session.setProxy).toHaveBeenCalledWith(expected);
    expect(session.closeAllConnections).toHaveBeenCalledOnce();
  });

  it('preserves protocol routing and fallback proxy rules', async () => {
    const session = makeSession();
    const rules = 'http=proxy.example.com:8080;socks=socks5://backup.example.com,direct://';

    await applyProxy(session as unknown as Electron.Session, makeConfig({ proxyMode: 'fixed', proxyServer: rules }));

    expect(session.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: rules });
  });

  it('applies the proxy before closing old connections', async () => {
    const order: string[] = [];
    const session = {
      setProxy: vi.fn(async () => { order.push('set'); }),
      closeAllConnections: vi.fn(async () => { order.push('close'); }),
    };

    await applyProxy(session as unknown as Electron.Session, makeConfig({ proxyMode: 'system' }));

    expect(order).toEqual(['set', 'close']);
  });

  it.each([
    ['fixed proxy is missing', makeConfig({ proxyMode: 'fixed' })],
    ['fixed proxy has an unsupported protocol', makeConfig({ proxyMode: 'fixed', proxyServer: 'ftp://proxy.example.com:21' })],
    ['fixed proxy embeds credentials', makeConfig({ proxyMode: 'fixed', proxyServer: 'http://user:secret@proxy.example.com:8080' })],
    ['PAC URL is invalid', makeConfig({ proxyMode: 'pac', proxyServer: 'file:///proxy.pac' })],
  ])('rejects invalid proxy values before changing the session: %s', async (_name, config) => {
    const session = makeSession();

    await expect(applyProxy(session as unknown as Electron.Session, config)).rejects.toThrow();
    expect(session.setProxy).not.toHaveBeenCalled();
    expect(session.closeAllConnections).not.toHaveBeenCalled();
  });
});
