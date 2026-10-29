import { describe, expect, it, vi } from 'vitest';

import {
  classifyConnectionError,
  registerConfigIpc,
  testTargetConnection,
  type ConfigIpcDeps,
  type ConfigIpcHost,
} from '../../../src/main/config/config-ipc';
import { loadConfig, saveConfig, type ConfigFileSystem } from '../../../src/main/config/config-store';
import type { AppConfig, NetworkConfig } from '../../../src/main/config/config-types';
import type { ResolvedConfigPaths } from '../../../src/main/platform/config-paths';
import { CONFIG_IPC_CHANNELS } from '../../../src/preload/config-bridge';

/**
 * 配置界面 IPC 主进程侧测试。
 *
 * 规则来源：规格 v2.1 §5.2（临时文件加原子替换并保留备份）、
 * §5.3（未保存关闭不得修改原配置）、§14.1（保存、重启）
 * 与 `rules/security.md`「preload 只暴露显式白名单 IPC」。
 *
 * 全部通过注入完成：ipcMain、文件系统、fetch 都不接触真实环境，
 * 因此可在纯 Node 下运行，不触发 Electron。
 */

const FIXED_NOW = new Date('2026-10-28T09:00:00.000Z');

const PATHS: ResolvedConfigPaths = {
  configPath: '/cfg/uni-shell/config.json',
  directory: '/cfg/uni-shell',
  source: 'user-config',
  candidates: [],
  writable: true,
  writeDirectory: '/cfg/uni-shell',
  writePath: '/cfg/uni-shell/config.json',
  writeSource: 'user-config',
  backupPath: '/cfg/uni-shell/config.json.bak',
  invalidFilePrefix: '/cfg/uni-shell/config.json.invalid.',
};

interface HandlerMap {
  host: ConfigIpcHost;
  handlers: Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>;
}

function createHost(): HandlerMap {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  return {
    host: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    handlers,
  };
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}

function createMemoryFs(initial: Record<string, string> = {}): {
  fs: ConfigFileSystem;
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    fs: {
      readFile: async (path) => {
        const value = files.get(path);
        if (value === undefined) throw enoent(path);
        return value;
      },
      writeFile: async (path, data) => {
        files.set(path, data);
      },
      rename: async (from, to) => {
        const value = files.get(from);
        if (value === undefined) throw enoent(from);
        files.delete(from);
        files.set(to, value);
      },
      mkdir: async () => {},
      access: async (path) => {
        if (!files.has(path)) throw enoent(path);
      },
      unlink: async (path) => {
        files.delete(path);
      },
    },
  };
}

function storedConfig(overrides: Partial<AppConfig> = {}): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      targetUrl: 'https://erp.example.com',
      window: { mode: 'window', alwaysOnTop: false, alwaysOnTopLevel: 'normal', display: 'primary', closeAction: 'hide' },
      network: { proxyMode: 'direct', proxyServer: '', proxyBypass: '', retryIntervalSec: 3, requestTimeoutSec: 20, offlinePageEnabled: true },
      startup: { openAtLogin: false, initialState: 'tray', delaySec: 0, delayOnlyOnLogin: false, showAfterDelay: true },
      maintenance: { hotkeyEnabled: true, hotkey: 'Ctrl+Alt+Shift+F12', trayConfigEnabled: true },
      security: { allowedOrigins: [], allowExternalLinks: false, allowPopups: false, allowDownloads: false },
      logging: { level: 'info', retentionDays: 14 },
      ...overrides,
    },
    null,
    2,
  )}\n`;
}

interface Harness {
  deps: ConfigIpcDeps;
  handlers: Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>;
  files: Map<string, string>;
  calls: string[];
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function createHarness(options: { initial?: Record<string, string>; overrides?: Partial<ConfigIpcDeps> } = {}): Harness {
  const { host, handlers } = createHost();
  const memory = createMemoryFs(options.initial);
  const calls: string[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), close: vi.fn(async () => {}) };

  const deps: ConfigIpcDeps = {
    host,
    paths: () => PATHS,
    loadConfig: (paths) => loadConfig({ paths, fs: memory.fs, now: () => FIXED_NOW }),
    saveConfig: (config, saveOptions) => saveConfig(config, saveOptions),
    fs: memory.fs,
    now: () => FIXED_NOW,
    logger,
    onSaved: () => {
      calls.push('onSaved');
    },
    closeStaleWindows: () => {
      calls.push('closeStaleWindows');
    },
    restart: () => {
      calls.push('restart');
    },
    ...options.overrides,
  };

  return { deps, handlers, files: memory.files, calls, logger };
}

function call(harness: Harness, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (handler === undefined) throw new Error(`通道未注册：${channel}`);
  return handler(undefined, ...args);
}

const validInput = (): Record<string, unknown> =>
  JSON.parse(storedConfig({ targetUrl: 'https://erp2.example.com' })) as Record<string, unknown>;

describe('registerConfigIpc 白名单注册', () => {
  it('恰好注册五个白名单通道', () => {
    const harness = createHarness();

    registerConfigIpc(harness.deps);

    expect([...harness.handlers.keys()].sort()).toEqual(Object.values(CONFIG_IPC_CHANNELS).sort());
  });
});

describe('getConfig 通道', () => {
  it('配置缺失时返回空白默认配置供界面编辑', async () => {
    const harness = createHarness();
    const registration = registerConfigIpc(harness.deps);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.getConfig)) as AppConfig;

    expect(result.targetUrl).toBe('');
    expect(result.network.proxyMode).toBe('direct');
    expect(result.network.retryIntervalSec).toBe(3);
    expect(result.startup.delaySec).toBe(0);
    expect(result.logging.retentionDays).toBe(14);
    expect(registration.getLastConfig()).toEqual(result);
  });

  it('配置存在时返回迁移并补齐默认值后的配置', async () => {
    const harness = createHarness({ initial: { [PATHS.writePath]: storedConfig() } });
    registerConfigIpc(harness.deps);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.getConfig)) as AppConfig;

    expect(result.targetUrl).toBe('https://erp.example.com');
    expect(result.schemaVersion).toBe(1);
  });
});

describe('validateConfig 通道', () => {
  it('原样返回校验结果，不写盘', async () => {
    const harness = createHarness();
    registerConfigIpc(harness.deps);

    const ok = await call(harness, CONFIG_IPC_CHANNELS.validateConfig, validInput());
    expect(ok).toMatchObject({ ok: true });

    const failed = (await call(harness, CONFIG_IPC_CHANNELS.validateConfig, { schemaVersion: 1 })) as {
      ok: boolean;
      issues: Array<{ path: string }>;
    };
    expect(failed.ok).toBe(false);
    expect(failed.issues.map((issue) => issue.path)).toContain('targetUrl');
    expect(harness.files.size).toBe(0);
  });
});

describe('saveConfig 通道受控保存', () => {
  it('校验通过后原子写盘、记录日志并按顺序收尾与重启', async () => {
    const harness = createHarness({ initial: { [PATHS.writePath]: storedConfig() } });
    registerConfigIpc(harness.deps);

    const result = await call(harness, CONFIG_IPC_CHANNELS.saveConfig, validInput());

    expect(result).toEqual({ ok: true, configPath: PATHS.writePath, requiresRestart: true });
    const written = JSON.parse(harness.files.get(PATHS.writePath) ?? '{}') as { targetUrl: string };
    expect(written.targetUrl).toBe('https://erp2.example.com');
    // 旧配置被保留为备份，临时文件被清理。
    expect(harness.files.get(PATHS.backupPath)).toContain('https://erp.example.com');
    expect([...harness.files.keys()].some((path) => path.includes('.tmp-'))).toBe(false);
    expect(harness.calls).toEqual(['onSaved', 'closeStaleWindows', 'restart']);
    expect(harness.logger.info).toHaveBeenCalledWith('config-saved', expect.objectContaining({ path: PATHS.writePath }));
  });

  it('校验失败时不写盘、不重启', async () => {
    const harness = createHarness({ initial: { [PATHS.writePath]: storedConfig() } });
    registerConfigIpc(harness.deps);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.saveConfig, { schemaVersion: 1, targetUrl: 'ftp://x' })) as {
      ok: boolean;
      message: string;
    };

    expect(result.ok).toBe(false);
    expect(result.message).toContain('配置校验失败');
    expect(harness.files.get(PATHS.writePath)).toBe(storedConfig());
    expect(harness.calls).toEqual([]);
  });

  it('写入失败时返回可操作错误且不重启', async () => {
    const memory = createMemoryFs({ [PATHS.writePath]: storedConfig() });
    memory.fs.writeFile = async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };
    const harness = createHarness({ initial: { [PATHS.writePath]: storedConfig() }, overrides: { fs: memory.fs } });
    registerConfigIpc(harness.deps);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.saveConfig, validInput())) as {
      ok: boolean;
      message: string;
      configPath?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.message).toContain('没有权限写入配置文件');
    expect(result.configPath).toBe(PATHS.writePath);
    expect(harness.calls).toEqual([]);
    expect(harness.logger.error).toHaveBeenCalledWith('config-save-failed', expect.objectContaining({ path: PATHS.writePath }));
  });

  it('登录项等副作用失败不阻塞重启', async () => {
    const harness = createHarness({
      initial: { [PATHS.writePath]: storedConfig() },
      overrides: {
        onSaved: () => {
          throw new Error('登录项写入失败');
        },
      },
    });
    registerConfigIpc(harness.deps);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.saveConfig, validInput())) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(harness.calls).toEqual(['closeStaleWindows', 'restart']);
    expect(harness.logger.warn).toHaveBeenCalledWith('config-save-side-effects-failed', expect.objectContaining({ message: '登录项写入失败' }));
  });

  it('保存后 getLastConfig 反映最新配置', async () => {
    const harness = createHarness({ initial: { [PATHS.writePath]: storedConfig() } });
    const registration = registerConfigIpc(harness.deps);

    await call(harness, CONFIG_IPC_CHANNELS.saveConfig, validInput());

    expect(registration.getLastConfig()?.targetUrl).toBe('https://erp2.example.com');
  });
});

describe('resetConfig 通道', () => {
  it('保留已保存的 targetUrl，其余恢复默认值，且不写盘', async () => {
    const harness = createHarness({
      initial: { [PATHS.writePath]: storedConfig({ logging: { level: 'debug', retentionDays: 30 } }) },
    });
    const registration = registerConfigIpc(harness.deps);
    await call(harness, CONFIG_IPC_CHANNELS.getConfig);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.resetConfig)) as AppConfig;

    expect(result.targetUrl).toBe('https://erp.example.com');
    expect(result.logging).toEqual({ level: 'info', retentionDays: 14 });
    expect(result.network.retryIntervalSec).toBe(3);
    expect(harness.files.get(PATHS.writePath)).toBe(storedConfig({ logging: { level: 'debug', retentionDays: 30 } }));
    // 重置不是保存：最近一次有效配置不变。
    expect(registration.getLastConfig()?.logging.level).toBe('debug');
  });

  it('首次启动（无已保存配置）时 targetUrl 为空', async () => {
    const harness = createHarness();
    registerConfigIpc(harness.deps);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.resetConfig)) as AppConfig;

    expect(result.targetUrl).toBe('');
    expect(result.maintenance.hotkey).toBe('Ctrl+Alt+Shift+F12');
  });
});

describe('testConnection 通道', () => {
  it('用注入的连接测试出口执行，不访问网络', async () => {
    const testConnection = vi.fn(async () => ({ ok: true, statusCode: 200, durationMs: 12 }));
    const harness = createHarness({ overrides: { testConnection } });
    registerConfigIpc(harness.deps);

    const network: NetworkConfig = {
      proxyMode: 'fixed',
      proxyServer: 'http://proxy.internal:8080',
      proxyBypass: '',
      retryIntervalSec: 3,
      requestTimeoutSec: 20,
      offlinePageEnabled: true,
    };
    const result = await call(harness, CONFIG_IPC_CHANNELS.testConnection, 'https://erp.example.com', network);

    expect(testConnection).toHaveBeenCalledWith('https://erp.example.com', network);
    expect(result).toEqual({ ok: true, statusCode: 200, durationMs: 12 });
  });

  it('网址或网络配置非法时拒绝测试', async () => {
    const testConnection = vi.fn(async () => ({ ok: true }));
    const harness = createHarness({ overrides: { testConnection } });
    registerConfigIpc(harness.deps);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.testConnection, 'ftp://erp.example.com', {})) as {
      ok: boolean;
      message: string;
    };

    expect(result.ok).toBe(false);
    expect(result.message).toContain('配置校验失败');
    expect(testConnection).not.toHaveBeenCalled();
  });
});

describe('图标选择通道（规格 §5.4）', () => {
  it('成功时回传文件名与预览并记录日志', async () => {
    const pickIcon = vi.fn(async () => ({ ok: true, fileName: 'app-icon.png', previewDataUrl: 'data:image/png;base64,AA' }));
    const harness = createHarness({ overrides: { pickIcon } });
    registerConfigIpc(harness.deps);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.iconPick)) as {
      ok: boolean;
      fileName: string;
      previewDataUrl: string;
    };

    expect(pickIcon).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, fileName: 'app-icon.png', previewDataUrl: 'data:image/png;base64,AA' });
    expect(harness.logger.info).toHaveBeenCalledWith('icon-picked', { fileName: 'app-icon.png' });
  });

  it('用户取消或选择被拒时回传失败原因且不写配置', async () => {
    const pickIcon = vi.fn(async () => ({ ok: false, message: '请选择 PNG、ICO 或 ICNS 格式的图标文件' }));
    const harness = createHarness({ overrides: { pickIcon } });
    registerConfigIpc(harness.deps);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.iconPick)) as { ok: boolean; message: string };

    expect(result.ok).toBe(false);
    expect(result.message).toContain('PNG');
    expect(harness.logger.warn).toHaveBeenCalledWith('icon-pick-rejected', { message: result.message });
    expect(harness.files.size).toBe(0);
  });

  it('选择过程抛出时按失败处理', async () => {
    const pickIcon = vi.fn(async () => {
      throw new Error('对话框打开失败');
    });
    const harness = createHarness({ overrides: { pickIcon } });
    registerConfigIpc(harness.deps);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.iconPick)) as { ok: boolean; message: string };

    expect(result.ok).toBe(false);
    expect(result.message).toBe('对话框打开失败');
    expect(harness.logger.warn).toHaveBeenCalledWith('icon-pick-failed', { message: '对话框打开失败' });
  });

  it('未注入选择出口时返回可操作的失败信息', async () => {
    const harness = createHarness();
    registerConfigIpc(harness.deps);

    const result = (await call(harness, CONFIG_IPC_CHANNELS.iconPick)) as { ok: boolean; message: string };

    expect(result.ok).toBe(false);
    expect(result.message).toContain('不支持选择图标文件');
  });
});

describe('testTargetConnection', () => {
  const network: NetworkConfig = {
    proxyMode: 'direct',
    proxyServer: '',
    proxyBypass: '',
    retryIntervalSec: 3,
    requestTimeoutSec: 20,
    offlinePageEnabled: true,
  };

  it('HTTP 响应正常时报告成功与状态码', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, body: { cancel: async () => {} } })) as unknown as typeof fetch;

    const result = await testTargetConnection('https://erp.example.com', network, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.message).toContain('HTTP 200');
  });

  it('HTTP 4xx/5xx 视为不可用', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 503, body: undefined })) as unknown as typeof fetch;

    const result = await testTargetConnection('https://erp.example.com', network, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.message).toContain('HTTP 503');
  });

  it('超时被归类为连接超时', async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;

    const result = await testTargetConnection('https://erp.example.com', network, { fetchImpl, timeoutMs: 5 });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('连接超时');
  });

  it('fixed/pac 模式下提示测试未经过代理', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, body: undefined })) as unknown as typeof fetch;

    const result = await testTargetConnection('https://erp.example.com', { ...network, proxyMode: 'fixed' }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('测试未经过代理');
  });
});

describe('classifyConnectionError', () => {
  it('按 cause 错误码归类常见网络故障', () => {
    expect(classifyConnectionError({ cause: { code: 'ENOTFOUND' } })).toBe('DNS 解析失败');
    expect(classifyConnectionError({ cause: { code: 'ECONNREFUSED' } })).toBe('连接被拒绝');
    expect(classifyConnectionError({ cause: { code: 'ECONNRESET' } })).toBe('连接被重置');
    expect(classifyConnectionError({ name: 'TimeoutError' })).toBe('连接超时');
    expect(classifyConnectionError(new Error('boom'))).toContain('boom');
  });
});
