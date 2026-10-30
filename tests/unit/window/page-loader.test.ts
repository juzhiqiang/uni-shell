import { describe, expect, it, vi } from 'vitest';

import {
  attachMainWindowDiagnostics,
  isLocalDevelopmentUrl,
  isLocalOfflinePage,
  loadConfigWindow,
  loadOfflinePage,
  type MainWindowDiagnosticCallbacks,
  type WebPageTarget,
} from '../../../src/main/window/page-loader';

describe('page-loader', () => {
  describe('isLocalDevelopmentUrl', () => {
    it('正确识别 localhost / 127.0.0.1 / [::1] 的 http 协议', () => {
      expect(isLocalDevelopmentUrl('http://localhost:5173')).toBe(true);
      expect(isLocalDevelopmentUrl('http://127.0.0.1:3000/path')).toBe(true);
      expect(isLocalDevelopmentUrl('http://[::1]:8080/')).toBe(true);
    });

    it('非法 URL、非本地主机或非 http 协议返回 false', () => {
      expect(isLocalDevelopmentUrl('not-a-url')).toBe(false);
      expect(isLocalDevelopmentUrl('https://example.com')).toBe(false);
      expect(isLocalDevelopmentUrl('http://example.com:5173')).toBe(false);
      expect(isLocalDevelopmentUrl('file:///path/to/index.html')).toBe(false);
    });
  });

  describe('isLocalOfflinePage', () => {
    it('file: 协议的 URL 一律判定为本地离线页', () => {
      expect(isLocalOfflinePage('file:///app/dist/renderer/config/offline.html')).toBe(true);
      expect(isLocalOfflinePage('file:///anything')).toBe(true);
    });

    it('开发模式且 URL 路径为 /offline.html 时判定为离线页', () => {
      expect(
        isLocalOfflinePage('http://localhost:5173/offline.html', 'http://localhost:5173'),
      ).toBe(true);
      expect(
        isLocalOfflinePage('http://localhost:5173/index.html', 'http://localhost:5173'),
      ).toBe(false);
    });

    it('非开发模式或非本地开发服务时不判定为离线页', () => {
      expect(isLocalOfflinePage('http://example.com/offline.html', undefined)).toBe(false);
    });
  });

  describe('loadConfigWindow', () => {
    it('开发模式且开发服务器可用时优先加载 Vite 开发 URL', async () => {
      const target: WebPageTarget = {
        loadURL: vi.fn(async () => {}),
        loadFile: vi.fn(async () => {}),
      };

      await loadConfigWindow(target, {
        configPath: '/path/to/config.json',
        developmentUrl: 'http://localhost:5173',
      });

      expect(target.loadURL).toHaveBeenCalledWith('http://localhost:5173/?configPath=%2Fpath%2Fto%2Fconfig.json');
      expect(target.loadFile).not.toHaveBeenCalled();
    });

    it('开发服务器加载抛错时安全回退到本地文件', async () => {
      const target: WebPageTarget = {
        loadURL: vi.fn(async () => {
          throw new Error('Connection refused');
        }),
        loadFile: vi.fn(async () => {}),
      };

      await loadConfigWindow(target, {
        configPath: '/path/to/config.json',
        developmentUrl: 'http://localhost:5173',
        appPath: '/app',
      });

      expect(target.loadURL).toHaveBeenCalled();
      expect(target.loadFile).toHaveBeenCalledWith(
        expect.stringMatching(/dist[/\\]renderer[/\\]config[/\\]index\.html/),
        { query: { configPath: '/path/to/config.json' } },
      );
    });

    it('无开发环境 URL 时直接加载本地打包 HTML', async () => {
      const target: WebPageTarget = {
        loadURL: vi.fn(async () => {}),
        loadFile: vi.fn(async () => {}),
      };

      await loadConfigWindow(target, {
        configPath: '/custom/config.json',
        appPath: '/app',
      });

      expect(target.loadURL).not.toHaveBeenCalled();
      expect(target.loadFile).toHaveBeenCalledWith(
        expect.stringMatching(/dist[/\\]renderer[/\\]config[/\\]index\.html/),
        { query: { configPath: '/custom/config.json' } },
      );
    });
  });

  describe('loadOfflinePage', () => {
    it('开发模式且服务可用时加载 dev server 下的 offline.html', async () => {
      const target: WebPageTarget = {
        loadURL: vi.fn(async () => {}),
        loadFile: vi.fn(async () => {}),
      };

      await loadOfflinePage(target, {
        developmentUrl: 'http://localhost:5173',
      });

      expect(target.loadURL).toHaveBeenCalledWith('http://localhost:5173/offline.html');
      expect(target.loadFile).not.toHaveBeenCalled();
    });

    it('开发服务不可用或生产模式时回退到打包离线页', async () => {
      const target: WebPageTarget = {
        loadURL: vi.fn(async () => {
          throw new Error('net::ERR_CONNECTION_REFUSED');
        }),
        loadFile: vi.fn(async () => {}),
      };

      await loadOfflinePage(target, {
        developmentUrl: 'http://localhost:5173',
        appPath: '/app',
      });

      expect(target.loadURL).toHaveBeenCalled();
      expect(target.loadFile).toHaveBeenCalledWith(
        expect.stringMatching(/dist[/\\]renderer[/\\]config[/\\]offline\.html/),
      );
    });
  });

  describe('attachMainWindowDiagnostics', () => {
    it('正确监听并向回调派发诊断与生命周期事件', () => {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      const mockWebContents = {
        once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(handler);
        }),
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(handler);
        }),
        emit: (event: string, ...args: unknown[]) => {
          for (const handler of listeners[event] || []) {
            handler({}, ...args);
          }
        },
      };

      const callbacks: MainWindowDiagnosticCallbacks = {
        reportLoadFailure: vi.fn(),
        reportLoadSuccess: vi.fn(),
        reportRendererGone: vi.fn(),
        reportUnresponsive: vi.fn(),
        reportResponsive: vi.fn(),
      };
      const onFirstLoad = vi.fn();

      attachMainWindowDiagnostics(
        { webContents: mockWebContents },
        callbacks,
        onFirstLoad,
      );

      // did-finish-load
      mockWebContents.emit('did-finish-load');
      expect(onFirstLoad).toHaveBeenCalled();

      // did-fail-load
      mockWebContents.emit('did-fail-load', -105, 'NAME_NOT_RESOLVED', 'https://app.example.com', true);
      expect(callbacks.reportLoadFailure).toHaveBeenCalledWith({
        errorCode: -105,
        errorDescription: 'NAME_NOT_RESOLVED',
        isMainFrame: true,
      });

      // did-navigate to offline page 不触发 reportLoadSuccess
      mockWebContents.emit('did-navigate', 'file:///offline.html');
      expect(callbacks.reportLoadSuccess).not.toHaveBeenCalled();

      // did-navigate to target URL 触发 reportLoadSuccess
      mockWebContents.emit('did-navigate', 'https://app.example.com/home');
      expect(callbacks.reportLoadSuccess).toHaveBeenCalled();

      // render-process-gone
      mockWebContents.emit('render-process-gone', { reason: 'crashed', exitCode: 139 });
      expect(callbacks.reportRendererGone).toHaveBeenCalledWith({ reason: 'crashed', exitCode: 139 });

      // unresponsive & responsive
      mockWebContents.emit('unresponsive');
      expect(callbacks.reportUnresponsive).toHaveBeenCalled();

      mockWebContents.emit('responsive');
      expect(callbacks.reportResponsive).toHaveBeenCalled();
    });
  });
});
