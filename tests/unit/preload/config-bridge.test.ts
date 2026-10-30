import { describe, expect, it, vi } from 'vitest';

import {
  CONFIG_IPC_CHANNELS,
  UNI_SHELL_BRIDGE_KEY,
  createConfigBridge,
  installConfigBridge,
  isConfigIpcChannel,
  type ConfigBridge,
} from '../../../src/preload/config-bridge';

/**
 * preload 暴露面测试。
 *
 * 规则来源：`rules/testing-release.md`「安全测试覆盖 ... preload 暴露面」
 * 与 `rules/security.md`「preload 只暴露显式白名单 IPC 通道」。
 */

function createInvokeSpy(): { invoke: ReturnType<typeof vi.fn>; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const invoke = vi.fn((...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve({});
  });
  return { invoke, calls };
}

describe('白名单通道表', () => {
  it('恰好定义八个具名通道', () => {
    expect(Object.keys(CONFIG_IPC_CHANNELS).sort()).toEqual([
      'getConfig',
      'getLogs',
      'iconPick',
      'openLogDirectory',
      'resetConfig',
      'saveConfig',
      'testConnection',
      'validateConfig',
    ]);
  });

  it('通道值使用统一的 uni-shell 前缀', () => {
    for (const channel of Object.values(CONFIG_IPC_CHANNELS)) {
      expect(channel.startsWith('uni-shell:')).toBe(true);
    }
  });

  it('通道值互不重复', () => {
    expect(new Set(Object.values(CONFIG_IPC_CHANNELS)).size).toBe(Object.keys(CONFIG_IPC_CHANNELS).length);
  });

  it('白名单外的通道一律拒绝', () => {
    for (const channel of ['uni-shell:config:get', 'uni-shell:shell:open', 'uni-shell:fs:read', 'send', '', 'uni-shell:']) {
      expect(isConfigIpcChannel(channel)).toBe(channel === 'uni-shell:config:get');
    }
  });
});

describe('createConfigBridge', () => {
  it('只暴露八个具名方法，没有通用发送能力', () => {
    const { invoke } = createInvokeSpy();
    const bridge = createConfigBridge(invoke as never);

    expect(Object.keys(bridge).sort()).toEqual([
      'getConfig',
      'getLogs',
      'openLogDirectory',
      'pickIcon',
      'resetConfig',
      'saveConfig',
      'testConnection',
      'validateConfig',
    ]);
    for (const forbidden of ['send', 'invoke', 'on', 'receive', 'readFile', 'openExternal']) {
      expect(Object.keys(bridge)).not.toContain(forbidden);
    }
  });

  it('每个方法只调用自己的白名单通道并透传参数', async () => {
    const { invoke, calls } = createInvokeSpy();
    const bridge = createConfigBridge(invoke as never);

    await bridge.getConfig();
    await bridge.validateConfig({ targetUrl: 'https://app.example.com' });
    await bridge.saveConfig({ schemaVersion: 1 });
    await bridge.resetConfig();
    await bridge.testConnection('https://app.example.com', {
      proxyMode: 'direct',
      proxyServer: '',
      proxyBypass: '',
      apiProxyHosts: [],
      retryIntervalSec: 3,
      requestTimeoutSec: 20,
      offlinePageEnabled: true,
    });
    await bridge.pickIcon();
    await bridge.getLogs({ limit: 100 });
    await bridge.openLogDirectory();

    expect(calls).toEqual([
      ['uni-shell:config:get'],
      ['uni-shell:config:validate', { targetUrl: 'https://app.example.com' }],
      ['uni-shell:config:save', { schemaVersion: 1 }],
      ['uni-shell:config:reset'],
      [
        'uni-shell:network:test',
        'https://app.example.com',
        {
          proxyMode: 'direct',
          proxyServer: '',
          proxyBypass: '',
          apiProxyHosts: [],
          retryIntervalSec: 3,
          requestTimeoutSec: 20,
          offlinePageEnabled: true,
        },
      ],
      ['uni-shell:icon:pick'],
      ['uni-shell:logs:get', { limit: 100 }],
      ['uni-shell:logs:open-directory'],
    ]);
  });

  it('无法调用白名单外的通道', () => {
    const { invoke } = createInvokeSpy();
    const bridge = createConfigBridge(invoke as never) as unknown as Record<string, (...args: unknown[]) => unknown>;

    // 桥的方法签名只接受白名单通道字面量，运行期也不会产生表外调用。
    for (const method of Object.values(bridge)) {
      void method();
    }
    expect(invoke.mock.calls.every((call) => isConfigIpcChannel(String(call[0])))).toBe(true);
  });
});

describe('installConfigBridge', () => {
  it('非 Electron 环境下不安装也不抛错', () => {
    expect(installConfigBridge(undefined)).toBe(false);
    expect(installConfigBridge({})).toBe(false);
    expect(installConfigBridge({ contextBridge: { exposeInMainWorld: () => {} } })).toBe(false);
    expect(installConfigBridge({ ipcRenderer: { invoke: () => Promise.resolve({}) } })).toBe(false);
  });

  it('Electron 环境下把桥挂到 window.uniShell 并走 ipcRenderer.invoke', async () => {
    const exposed: Record<string, unknown> = {};
    const invoke = vi.fn(() => Promise.resolve({ schemaVersion: 1 }));

    const installed = installConfigBridge({
      contextBridge: { exposeInMainWorld: (name, api) => Object.assign(exposed, { [name]: api }) },
      ipcRenderer: { invoke },
    });

    expect(installed).toBe(true);
    expect(Object.keys(exposed)).toEqual([UNI_SHELL_BRIDGE_KEY]);

    const bridge = exposed[UNI_SHELL_BRIDGE_KEY] as ConfigBridge;
    await bridge.getConfig();
    expect(invoke).toHaveBeenCalledWith('uni-shell:config:get');
  });
});
