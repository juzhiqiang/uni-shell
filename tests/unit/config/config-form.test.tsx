// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigurationApp } from '../../../src/renderer/config/App';
import type { ConfigBridge } from '../../../src/shared/ipc-contract';
import type { AppConfig } from '../../../src/shared/config-types';

/**
 * 本地配置界面测试。
 *
 * 规则来源：规格 v2.1 §5.1（界面展示实际路径）、§5.3（未保存关闭不得修改原配置）、
 * §14.1（保存与重启）与 `rules/testing-release.md`「UI 测试覆盖校验、保存失败、
 * 恢复默认值和未保存关闭」。
 *
 * 运行环境为 happy-dom（纯 JS，无平台二进制）；Electron API 一律经由
 * `window.uniShell` 白名单桥注入，测试不触碰真实 preload 与主进程。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULT_CONFIG_PATH = '/home/tester/.config/uni-shell/config.json';

const DEFAULT_NETWORK: AppConfig['network'] = {
  proxyMode: 'direct',
  proxyServer: '',
  proxyBypass: '',
  apiProxyHosts: [],
  retryIntervalSec: 3,
  requestTimeoutSec: 20,
  offlinePageEnabled: true,
};

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    schemaVersion: 1,
    targetUrl: 'https://erp.example.com',
    window: {
      mode: 'window',
      alwaysOnTop: false,
      alwaysOnTopLevel: 'normal',
      display: 'primary',
      closeAction: 'hide',
    },
    network: DEFAULT_NETWORK,
    startup: {
      openAtLogin: false,
      initialState: 'tray',
      delaySec: 0,
      delayOnlyOnLogin: false,
      showAfterDelay: true,
    },
    maintenance: {
      hotkeyEnabled: true,
      hotkey: 'Ctrl+Alt+Shift+F12',
      trayConfigEnabled: true,
    },
    security: {
      allowedOrigins: [],
      allowExternalLinks: false,
      allowPopups: false,
      allowDownloads: false,
    },
    appearance: { icon: '' },
    logging: { level: 'info', retentionDays: 14 },
  };

  return {
    ...base,
    ...overrides,
    // network/appearance 允许只覆盖部分字段，未提供的字段保持默认值。
    network: { ...base.network, ...overrides.network },
    appearance: { ...base.appearance, ...overrides.appearance },
  };
}

interface BridgeMock extends ConfigBridge {
  getConfig: ReturnType<typeof vi.fn>;
  validateConfig: ReturnType<typeof vi.fn>;
  saveConfig: ReturnType<typeof vi.fn>;
  resetConfig: ReturnType<typeof vi.fn>;
  testConnection: ReturnType<typeof vi.fn>;
  pickIcon: ReturnType<typeof vi.fn>;
}

function installBridge(overrides: Partial<ConfigBridge> = {}): BridgeMock {
  const bridge: BridgeMock = {
    getConfig: vi.fn(async () => createConfig()),
    validateConfig: vi.fn(async (input: unknown) => ({ ok: true as const, value: input as AppConfig })),
    saveConfig: vi.fn(async () => ({
      ok: true,
      applied: 'restart',
      configPath: DEFAULT_CONFIG_PATH,
      requiresRestart: true,
    })),
    resetConfig: vi.fn(async () => createConfig({ targetUrl: '' })),
    testConnection: vi.fn(async () => ({ ok: true, statusCode: 200, durationMs: 42 })),
    pickIcon: vi.fn(async () => ({ ok: true, fileName: 'app-icon.png', previewDataUrl: 'data:image/png;base64,AA' })),
    ...overrides,
  } as BridgeMock;
  (window as unknown as { uniShell: ConfigBridge }).uniShell = bridge;
  return bridge;
}

function removeBridge(): void {
  delete (window as unknown as { uniShell?: ConfigBridge }).uniShell;
}

function setWindowUrl(configPath?: string): void {
  const url =
    configPath === undefined
      ? 'http://localhost/'
      : `http://localhost/?configPath=${encodeURIComponent(configPath)}`;
  (window as unknown as { happyDOM?: { setURL(next: string): void } }).happyDOM?.setURL(url);
}

function field(id: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const element = document.querySelector(`#field-${id}`);
  if (element === null) throw new Error(`字段不存在：field-${id}`);
  return element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
}

function setNativeValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
}

async function setTextField(id: string, value: string): Promise<void> {
  await act(async () => {
    const element = field(id);
    setNativeValue(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function selectField(id: string, value: string): Promise<void> {
  await act(async () => {
    const element = field(id);
    setNativeValue(element, value);
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

async function clickButton(label: string): Promise<HTMLButtonElement> {
  const buttons = Array.from(document.querySelectorAll('button'));
  const button = buttons.find((candidate) => candidate.textContent?.includes(label));
  if (button === undefined) throw new Error(`按钮不存在：${label}`);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  return button as HTMLButtonElement;
}

async function submitForm(): Promise<void> {
  const form = document.querySelector('form');
  if (form === null) throw new Error('表单不存在');
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

function dispatchBeforeUnload(): Event {
  const event = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

/** 跨测试复用同一个 window：必须卸载 root，否则 beforeunload 等监听器会泄漏到后续用例。 */
const activeRoots: Root[] = [];

async function renderApp(): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push(root);
  await act(async () => {
    root.render(<ConfigurationApp />);
  });
  return { root, container };
}

beforeEach(() => {
  document.body.innerHTML = '';
  setWindowUrl(DEFAULT_CONFIG_PATH);
});

afterEach(async () => {
  removeBridge();
  await act(async () => {
    for (const root of activeRoots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = '';
});

describe('配置界面加载', () => {
  it('挂载时通过白名单桥读取配置并填充表单', async () => {
    const bridge = installBridge();

    await renderApp();

    expect(bridge.getConfig).toHaveBeenCalledTimes(1);
    expect((field('targetUrl') as HTMLInputElement).value).toBe('https://erp.example.com');
    expect((field('delaySec') as HTMLInputElement).value).toBe('0');
    expect((field('retryIntervalSec') as HTMLInputElement).value).toBe('3');
    expect((field('retentionDays') as HTMLInputElement).value).toBe('14');
    expect((field('hotkey') as HTMLInputElement).value).toBe('Ctrl+Alt+Shift+F12');
    expect(document.querySelector('form')).not.toBeNull();
  });

  it('展示当前实际读取和写入的配置路径', async () => {
    installBridge();

    await renderApp();

    expect(document.body.textContent).toContain(DEFAULT_CONFIG_PATH);
  });

  it('getConfig 失败时展示可操作错误且不渲染表单', async () => {
    installBridge({
      getConfig: vi.fn(async () => {
        throw new Error('配置目录不可写');
      }),
    });

    await renderApp();

    expect(document.body.textContent).toContain('配置加载失败');
    expect(document.body.textContent).toContain('配置目录不可写');
    expect(document.querySelector('form')).toBeNull();
  });

  it('preload 未加载时明确提示配置桥不可用', async () => {
    removeBridge();

    await renderApp();

    expect(document.body.textContent).toContain('配置桥不可用');
    expect(document.querySelector('form')).toBeNull();
  });
});

describe('保存前校验', () => {
  it('目标网址非法时展示校验问题且不调用保存', async () => {
    const bridge = installBridge({
      validateConfig: vi.fn(async () => ({
        ok: false as const,
        issues: [
          {
            path: 'targetUrl',
            message: '必须是包含主机名的 http:// 或 https:// 地址',
            code: 'custom',
          },
        ],
      })),
    });

    await renderApp();
    await setTextField('targetUrl', 'not-a-url');
    await submitForm();

    expect(bridge.validateConfig).toHaveBeenCalledTimes(1);
    expect(bridge.saveConfig).not.toHaveBeenCalled();
    const issues = Array.from(document.querySelectorAll('[data-path="targetUrl"]'));
    expect(issues).toHaveLength(1);
    expect(issues[0].textContent).toContain('必须是包含主机名的 http:// 或 https:// 地址');
  });

  it('启动延迟超出 0～3600 范围时在本地拦截，不调用 validateConfig 与 saveConfig', async () => {
    const bridge = installBridge();

    await renderApp();
    await setTextField('delaySec', '5000');
    await submitForm();

    expect(bridge.validateConfig).not.toHaveBeenCalled();
    expect(bridge.saveConfig).not.toHaveBeenCalled();
    const issues = Array.from(document.querySelectorAll('[data-path="startup.delaySec"]'));
    expect(issues).toHaveLength(1);
    expect(issues[0].textContent).toContain('0～3600');

    await setTextField('delaySec', '60');
    await submitForm();
    expect(bridge.validateConfig).toHaveBeenCalledTimes(1);
  });

  it('重试间隔、请求超时和日志保留天数必须是正整数', async () => {
    const bridge = installBridge();

    await renderApp();
    await setTextField('retryIntervalSec', 'abc');
    await submitForm();

    expect(bridge.validateConfig).not.toHaveBeenCalled();
    const issues = Array.from(document.querySelectorAll('[data-path="network.retryIntervalSec"]'));
    expect(issues).toHaveLength(1);
  });
});

describe('代理条件字段', () => {
  it('按代理模式显隐代理服务器与绕过规则', async () => {
    installBridge();

    await renderApp();

    expect(document.querySelector('#field-proxyServer')).toBeNull();
    expect(document.querySelector('#field-proxyBypass')).toBeNull();
    expect(document.querySelector('#field-apiProxyHosts')).toBeNull();

    await selectField('proxyMode', 'fixed');
    expect(document.querySelector('#field-proxyServer')).not.toBeNull();
    expect(document.querySelector('#field-proxyBypass')).not.toBeNull();
    expect(document.querySelector('#field-apiProxyHosts')).not.toBeNull();

    await selectField('proxyMode', 'pac');
    expect(document.querySelector('#field-proxyServer')).not.toBeNull();
    expect(document.querySelector('#field-proxyBypass')).toBeNull();
    expect(document.querySelector('#field-apiProxyHosts')).not.toBeNull();

    await selectField('proxyMode', 'system');
    expect(document.querySelector('#field-proxyServer')).toBeNull();
    expect(document.querySelector('#field-apiProxyHosts')).not.toBeNull();
  });

  it('接口域名按行（或逗号）解析后随配置保存', async () => {
    const bridge = installBridge();

    await renderApp();
    await selectField('proxyMode', 'fixed');
    await setTextField('proxyServer', 'http://proxy.internal:8080');
    await setTextField('apiProxyHosts', 'api.example.com\n*.internal.example.com, other.example.com');
    await submitForm();

    expect(bridge.saveConfig).toHaveBeenCalledTimes(1);
    const saved = bridge.saveConfig.mock.calls[0][0] as { network: { apiProxyHosts: string[] } };
    expect(saved.network.apiProxyHosts).toEqual(['api.example.com', '*.internal.example.com', 'other.example.com']);
  });

  it('读取配置时回填接口域名', async () => {
    installBridge({
      getConfig: vi.fn(async () =>
        createConfig({
          network: {
            proxyMode: 'fixed',
            proxyServer: 'http://proxy.internal:8080',
            proxyBypass: '',
            apiProxyHosts: ['api.example.com', '*.internal.example.com'],
            retryIntervalSec: 3,
            requestTimeoutSec: 20,
            offlinePageEnabled: true,
          },
        }),
      ),
    });

    await renderApp();

    expect((field('apiProxyHosts') as HTMLTextAreaElement).value).toBe('api.example.com\n*.internal.example.com');
  });

  it('代理模式非直连但未填接口域名时给出非阻塞提示，且不阻止保存', async () => {
    const bridge = installBridge();

    await renderApp();
    await selectField('proxyMode', 'fixed');
    await setTextField('proxyServer', 'http://proxy.internal:8080');

    expect(document.body.textContent).toContain('未填写接口域名');
    expect(document.body.textContent).toContain('代理不生效');

    await submitForm();
    expect(bridge.saveConfig).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('配置校验未通过');
  });
});

describe('保存流程', () => {
  it('保存成功后展示重启提示并刷新展示的配置路径', async () => {
    const bridge = installBridge({
      saveConfig: vi.fn(async () => ({
        ok: true,
        applied: 'restart',
        configPath: '/data/uni-shell/config.json',
        requiresRestart: true,
      })),
    });

    await renderApp();
    await setTextField('targetUrl', 'https://erp2.example.com');
    await submitForm();

    expect(bridge.saveConfig).toHaveBeenCalledTimes(1);
    const saved = bridge.saveConfig.mock.calls[0][0] as { targetUrl: string; network: { retryIntervalSec: number } };
    expect(saved.targetUrl).toBe('https://erp2.example.com');
    expect(saved.network.retryIntervalSec).toBe(3);
    expect(document.body.textContent).toContain('客户端即将重启');
    expect(document.body.textContent).toContain('/data/uni-shell/config.json');
  });

  it('保存失败时展示错误信息且不提示重启', async () => {
    installBridge({
      saveConfig: vi.fn(async () => ({
        ok: false,
        message: '没有权限写入配置文件 /etc/uni-shell/config.json',
      })),
    });

    await renderApp();
    await setTextField('targetUrl', 'https://erp2.example.com');
    await submitForm();

    expect(document.body.textContent).toContain('保存失败');
    expect(document.body.textContent).toContain('没有权限写入配置文件');
    expect(document.body.textContent).not.toContain('客户端正在重启');
    expect(document.querySelector('form')).not.toBeNull();
  });

  it('validateConfig 调用异常时按保存失败处理', async () => {
    installBridge({
      validateConfig: vi.fn(async () => {
        throw new Error('IPC 通道断开');
      }),
    });

    await renderApp();
    await setTextField('targetUrl', 'https://erp2.example.com');
    await submitForm();

    expect(document.body.textContent).toContain('IPC 通道断开');
    expect(document.body.textContent).not.toContain('客户端正在重启');
  });
});

describe('恢复默认值', () => {
  it('resetConfig 返回默认配置并重置全部字段', async () => {
    const bridge = installBridge({
      getConfig: vi.fn(async () =>
        createConfig({
          targetUrl: 'https://erp.example.com',
          network: {
            proxyMode: 'fixed',
            proxyServer: 'http://proxy.internal:8080',
            proxyBypass: 'localhost',
            retryIntervalSec: 30,
            requestTimeoutSec: 60,
            offlinePageEnabled: false,
          },
          startup: { openAtLogin: true, initialState: 'minimized', delaySec: 120, delayOnlyOnLogin: true, showAfterDelay: false },
          logging: { level: 'debug', retentionDays: 30 },
        }),
      ),
    });

    await renderApp();
    await clickButton('恢复默认值');

    expect(bridge.resetConfig).toHaveBeenCalledTimes(1);
    expect((field('targetUrl') as HTMLInputElement).value).toBe('');
    expect((field('proxyMode') as HTMLSelectElement).value).toBe('direct');
    expect((field('retryIntervalSec') as HTMLInputElement).value).toBe('3');
    expect((field('requestTimeoutSec') as HTMLInputElement).value).toBe('20');
    expect((field('delaySec') as HTMLInputElement).value).toBe('0');
    expect((field('retentionDays') as HTMLInputElement).value).toBe('14');
    expect((field('level') as HTMLSelectElement).value).toBe('info');
    expect((field('mode') as HTMLSelectElement).value).toBe('window');
    expect((field('closeAction') as HTMLSelectElement).value).toBe('hide');
    expect((field('hotkey') as HTMLInputElement).value).toBe('Ctrl+Alt+Shift+F12');
    expect((field('allowedOrigins') as HTMLTextAreaElement).value).toBe('');
  });
});

describe('未保存关闭保护', () => {
  it('仅在存在未保存修改时阻止窗口关闭', async () => {
    installBridge();

    await renderApp();

    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);

    await setTextField('targetUrl', 'https://erp2.example.com');
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

    await submitForm();
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it('恢复默认值产生的未保存修改同样受到保护', async () => {
    installBridge();

    await renderApp();
    await clickButton('恢复默认值');

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
  });
});

describe('连通性测试', () => {
  it('以当前网址和网络配置调用 testConnection 并展示结果', async () => {
    const bridge = installBridge();

    await renderApp();
    await setTextField('targetUrl', 'https://erp.example.com');
    await clickButton('测试连接');

    expect(bridge.testConnection).toHaveBeenCalledTimes(1);
    const [url, network] = bridge.testConnection.mock.calls[0] as [string, { proxyMode: string }];
    expect(url).toBe('https://erp.example.com');
    expect(network.proxyMode).toBe('direct');
    expect(document.body.textContent).toContain('连接成功');
    expect(document.body.textContent).toContain('HTTP 200');
  });

  it('连接失败时展示失败原因', async () => {
    installBridge({
      testConnection: vi.fn(async () => ({ ok: false, message: 'DNS 解析失败' })),
    });

    await renderApp();
    await clickButton('测试连接');

    expect(document.body.textContent).toContain('连接失败');
    expect(document.body.textContent).toContain('DNS 解析失败');
  });
});

describe('字段分组', () => {
  it('按目标网址、窗口、网络、启动、维护、安全、外观和日志分组展示', async () => {
    installBridge();

    await renderApp();

    const legends = Array.from(document.querySelectorAll('legend')).map((element) => element.textContent);
    expect(legends).toEqual(['目标网址', '窗口', '网络', '启动', '维护', '安全', '外观', '日志']);
  });
});

describe('自定义应用图标（规格 §5.4）', () => {
  it('未配置图标时展示内置默认图标', async () => {
    installBridge();

    await renderApp();

    expect(document.querySelector('[data-testid="current-icon"]')?.textContent).toBe('内置默认图标');
    expect(document.querySelector('img.icon-preview')).toBeNull();
  });

  it('读取配置时展示已配置的图标文件名', async () => {
    installBridge({
      getConfig: vi.fn(async () => createConfig({ appearance: { icon: 'app-icon.png' } })),
    });

    await renderApp();

    expect(document.querySelector('[data-testid="current-icon"]')?.textContent).toBe('app-icon.png');
  });

  it('选择图标后回填文件名、展示预览并随配置保存', async () => {
    const bridge = installBridge();

    await renderApp();
    await clickButton('选择图标');

    expect(bridge.pickIcon).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="current-icon"]')?.textContent).toBe('app-icon.png');
    expect(document.querySelector('img.icon-preview')?.getAttribute('src')).toBe('data:image/png;base64,AA');
    expect(document.body.textContent).toContain('保存并重启后生效');

    await submitForm();
    const saved = bridge.saveConfig.mock.calls[0][0] as { appearance: { icon: string } };
    expect(saved.appearance.icon).toBe('app-icon.png');
  });

  it('选择失败时展示错误且不修改草稿', async () => {
    const bridge = installBridge({
      pickIcon: vi.fn(async () => ({ ok: false, message: '请选择 PNG、ICO 或 ICNS 格式的图标文件' })),
    });

    await renderApp();
    await clickButton('选择图标');

    expect(bridge.pickIcon).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('图标选择失败');
    expect(document.body.textContent).toContain('PNG');
    expect(document.querySelector('[data-testid="current-icon"]')?.textContent).toBe('内置默认图标');
    expect(document.querySelector('img.icon-preview')).toBeNull();
  });

  it('恢复默认清空图标配置', async () => {
    const bridge = installBridge({
      getConfig: vi.fn(async () => createConfig({ appearance: { icon: 'app-icon.png' } })),
    });

    await renderApp();
    await clickButton('恢复默认');

    expect(document.querySelector('[data-testid="current-icon"]')?.textContent).toBe('内置默认图标');
    await submitForm();
    const saved = bridge.saveConfig.mock.calls[0][0] as { appearance: { icon: string } };
    expect(saved.appearance.icon).toBe('');
  });
});
