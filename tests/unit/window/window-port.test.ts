import { describe, expect, it, vi } from 'vitest';
import { BrowserWindow } from 'electron';

import {
  createBrowserWindowFactory,
  createWindowPortAdapter,
  type WindowPortManager,
} from '../../../src/main/window/window-port';
import { createDefaultConfig } from '../../../src/main/config/config-schema';
import type { ConfigService } from '../../../src/main/config/config-service';

function createMockConfigService(targetUrl = 'https://app.example.com/'): ConfigService {
  const config = createDefaultConfig(targetUrl);
  return {
    getPaths: vi.fn(),
    current: vi.fn(() => config),
    load: vi.fn(),
    save: vi.fn(),
  };
}

describe('window-port', () => {
  function createMockWindowManager() {
    let visible = true;
    const mockMain = {
      isVisible: () => visible,
      hide: vi.fn(() => {
        visible = false;
      }),
      loadURL: vi.fn(async () => {}),
      webContents: {
        forcefullyCrashRenderer: vi.fn(),
      },
    };

    let mainWindowInstance: typeof mockMain | null = mockMain;
    let configWindowInstance: object | null = null;

    const manager: WindowPortManager<typeof mockMain> = {
      createMainWindow: vi.fn(async () => {
        mainWindowInstance = mockMain;
      }),
      openConfigWindow: vi.fn(() => {
        configWindowInstance = {};
      }),
      showMainWindow: vi.fn(() => {
        if (mainWindowInstance === null) return false;
        visible = true;
        return true;
      }),
      getMainWindow: vi.fn(() => mainWindowInstance),
      getConfigWindow: vi.fn(() => configWindowInstance),
      focusConfigWindow: vi.fn(),
      closeAll: vi.fn(() => {
        mainWindowInstance = null;
        configWindowInstance = null;
      }),
    };

    return { manager, mockMain, setMainWindow: (val: typeof mockMain | null) => { mainWindowInstance = val; } };
  }

  it('createMainWindow 触发 session.preconnect 并调用 windowManager', async () => {
    const { manager } = createMockWindowManager();
    const preconnect = vi.fn();
    const configService = createMockConfigService('https://app.example.com/');

    const adapter = createWindowPortAdapter({
      windowManager: manager,
      configService,
      sessionProvider: () => ({
        preconnect,
        fetch: vi.fn(),
      }),
    });

    const config = createDefaultConfig('https://app.example.com/');
    await adapter.createMainWindow(config);

    expect(preconnect).toHaveBeenCalledWith({ url: 'https://app.example.com/', numSockets: 1 });
    expect(manager.createMainWindow).toHaveBeenCalledWith(config);
  });

  it('showAndFocusMain 窗口已存在时直接展示，销毁时按当前配置重建', async () => {
    const { manager, setMainWindow } = createMockWindowManager();
    const configService = createMockConfigService();
    const adapter = createWindowPortAdapter({
      windowManager: manager,
      configService,
      sessionProvider: () => ({ preconnect: vi.fn(), fetch: vi.fn() }),
    });

    // 窗口存在
    await adapter.showAndFocusMain();
    expect(manager.showMainWindow).toHaveBeenCalled();

    // 窗口销毁（showMainWindow 返回 false）
    vi.mocked(manager.showMainWindow).mockReturnValueOnce(false).mockReturnValueOnce(true);
    setMainWindow(null);

    await adapter.showAndFocusMain();
    expect(manager.createMainWindow).toHaveBeenCalled();
  });

  it('reloadMain 窗口存在时加载目标 URL，不存在时重建并展示', async () => {
    const { manager, mockMain, setMainWindow } = createMockWindowManager();
    const configService = createMockConfigService('https://new.example.com/');
    const adapter = createWindowPortAdapter({
      windowManager: manager,
      configService,
      sessionProvider: () => ({ preconnect: vi.fn(), fetch: vi.fn() }),
    });

    // 窗口存在
    await adapter.reloadMain();
    expect(mockMain.loadURL).toHaveBeenCalledWith('https://new.example.com/');

    // 窗口不存在
    setMainWindow(null);
    await adapter.reloadMain();
    expect(manager.createMainWindow).toHaveBeenCalled();
    expect(manager.showMainWindow).toHaveBeenCalled();
  });

  it('showOfflinePage 委托给 loadOffline', async () => {
    const { manager, mockMain } = createMockWindowManager();
    const configService = createMockConfigService();
    const loadOffline = vi.fn(async () => {});

    const adapter = createWindowPortAdapter({
      windowManager: manager,
      configService,
      loadOffline,
      sessionProvider: () => ({ preconnect: vi.fn(), fetch: vi.fn() }),
    });

    await adapter.showOfflinePage();
    expect(loadOffline).toHaveBeenCalledWith(mockMain);
  });

  it('probeTarget 在离线、配置缺失或网络异常时返回 false，成功探测返回 true', async () => {
    const { manager } = createMockWindowManager();
    const configService = createMockConfigService('https://probe.example.com/');
    const fetch = vi.fn(async () => ({ status: 200 }));

    let online = true;
    const adapter = createWindowPortAdapter({
      windowManager: manager,
      configService,
      netOnline: () => online,
      sessionProvider: () => ({ preconnect: vi.fn(), fetch }),
    });

    // 成功
    const ok = await adapter.probeTarget();
    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith('https://probe.example.com/', expect.objectContaining({ method: 'HEAD' }));

    // 离线状态
    online = false;
    expect(await adapter.probeTarget()).toBe(false);

    // 请求异常
    online = true;
    fetch.mockRejectedValueOnce(new Error('Network error'));
    expect(await adapter.probeTarget()).toBe(false);
  });

  it('forcefullyCrashRenderer 与 closeStaleWindows 正确委托', () => {
    const { manager, mockMain } = createMockWindowManager();
    const configService = createMockConfigService();
    const adapter = createWindowPortAdapter({
      windowManager: manager,
      configService,
      sessionProvider: () => ({ preconnect: vi.fn(), fetch: vi.fn() }),
    });

    adapter.forcefullyCrashRenderer();
    expect(mockMain.webContents.forcefullyCrashRenderer).toHaveBeenCalled();

    adapter.closeStaleWindows();
    expect(manager.closeAll).toHaveBeenCalled();
  });

  describe('createBrowserWindowFactory', () => {
    it('创建窗口时注入 icon、调用 setIcon 并在 Windows 平台设置 setAppDetails', () => {
      const setIconSpy = vi.spyOn(BrowserWindow.prototype, 'setIcon');
      const setAppDetailsSpy = vi.spyOn(BrowserWindow.prototype, 'setAppDetails');
      const mockIcon = { isEmpty: () => false } as unknown as Electron.NativeImage;

      const originalPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        const factory = createBrowserWindowFactory(
          () => mockIcon,
          () => ({ appId: 'com.unishell.desktop.custom.icon', appIconPath: 'C:\\path\\app-icon.ico' }),
        );

        const win = factory({ width: 800, height: 600 });
        expect(win).toBeDefined();
        expect(setIconSpy).toHaveBeenCalledWith(mockIcon);
        expect(setAppDetailsSpy).toHaveBeenCalledWith({
          appId: 'com.unishell.desktop.custom.icon',
          appIconPath: 'C:\\path\\app-icon.ico',
          appIconIndex: 0,
        });
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        setIconSpy.mockRestore();
        setAppDetailsSpy.mockRestore();
      }
    });

    it('无自定义详情时 setAppDetails 仅设置 appId 恢复默认', () => {
      const setAppDetailsSpy = vi.spyOn(BrowserWindow.prototype, 'setAppDetails');
      const mockIcon = { isEmpty: () => false } as unknown as Electron.NativeImage;

      const originalPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        const factory = createBrowserWindowFactory(
          () => mockIcon,
          () => ({ appId: 'com.unishell.desktop' }),
        );

        const win = factory({ width: 800, height: 600 });
        expect(win).toBeDefined();
        expect(setAppDetailsSpy).toHaveBeenCalledWith({
          appId: 'com.unishell.desktop',
        });
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        setAppDetailsSpy.mockRestore();
      }
    });
  });
});
