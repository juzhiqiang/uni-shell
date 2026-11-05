import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  createElectronCertificatePolicyPort,
  createElectronPowerMonitorPort,
  createElectronProxyPort,
  createElectronSingleInstancePort,
} from '../../../src/main/platform/electron-ports';
import { createDefaultConfig } from '../../../src/main/config/config-schema';

describe('electron-ports', () => {
  describe('createElectronSingleInstancePort', () => {
    it('正确转发 requestSingleInstanceLock 与 releaseSingleInstanceLock', () => {
      const mockApp = {
        requestSingleInstanceLock: vi.fn(() => true),
        releaseSingleInstanceLock: vi.fn(),
        on: vi.fn(),
      };

      const port = createElectronSingleInstancePort({ app: mockApp });
      expect(port.requestSingleInstanceLock()).toBe(true);
      expect(mockApp.requestSingleInstanceLock).toHaveBeenCalled();

      port.releaseSingleInstanceLock();
      expect(mockApp.releaseSingleInstanceLock).toHaveBeenCalled();
    });

    it('onSecondInstance 注册 second-instance 事件监听', () => {
      let registeredListener: ((event: unknown, argv: string[], workingDirectory: string) => void) | null = null;
      const mockApp = {
        requestSingleInstanceLock: vi.fn(() => true),
        releaseSingleInstanceLock: vi.fn(),
        on: vi.fn((event: string, handler: (event: unknown, argv: string[], workingDirectory: string) => void) => {
          if (event === 'second-instance') registeredListener = handler;
        }),
      };

      const port = createElectronSingleInstancePort({ app: mockApp });
      const handler = vi.fn();
      port.onSecondInstance(handler);

      expect(mockApp.on).toHaveBeenCalledWith('second-instance', expect.any(Function));

      registeredListener?.({}, ['--foo'], '/working/dir');
      expect(handler).toHaveBeenCalledWith(['--foo'], '/working/dir');
    });
  });

  describe('createElectronProxyPort', () => {
    it('调用 applyProxy 应用代理策略', async () => {
      const mockApplyProxy = vi.fn(async () => ({
        mode: 'direct' as const,
        hostCount: 0,
        proxiedHostCount: 0,
        notes: [],
      }));
      const mockSession = {} as Session;
      const port = createElectronProxyPort({
        sessionProvider: () => mockSession,
        applyProxy: mockApplyProxy,
      });

      const config = createDefaultConfig('https://app.example.com/').network;
      await port.apply(config);

      expect(mockApplyProxy).toHaveBeenCalledWith(mockSession, config);
    });
  });

  describe('createElectronCertificatePolicyPort（规格 v2.1.7 §7）', () => {
    it('开启时经远程会话安装证书校验过程，放行并透出记录', () => {
      const procs: Array<((request: unknown, callback: (result: number) => void) => void) | null> = [];
      const records: unknown[] = [];
      const port = createElectronCertificatePolicyPort({
        sessionProvider: () =>
          ({
            setCertificateVerifyProc: (proc) => procs.push(proc),
          }) as unknown as Session,
        onBypass: (record) => records.push(record),
      });

      const applied = port.apply({ ...createDefaultConfig('https://example.com').network, allowUntrustedCertificates: true });

      expect(applied).toEqual({ installed: true });
      const proc = procs[procs.length - 1];
      expect(proc).not.toBeNull();

      let result = Number.NaN;
      proc?.({ hostname: 'erp.internal', verificationResult: 'CERT_AUTHORITY_INVALID', errorCode: -202 }, (value) => {
        result = value;
      });
      expect(result).toBe(0);
      expect(records).toEqual([
        { hostname: 'erp.internal', verificationResult: 'CERT_AUTHORITY_INVALID', errorCode: -202 },
      ]);
    });

    it('关闭时恢复默认校验（setCertificateVerifyProc(null)）', () => {
      const procs: Array<((request: unknown, callback: (result: number) => void) => void) | null> = [];
      const port = createElectronCertificatePolicyPort({
        sessionProvider: () =>
          ({
            setCertificateVerifyProc: (proc) => procs.push(proc),
          }) as unknown as Session,
      });

      const applied = port.apply(createDefaultConfig('https://example.com').network);

      expect(applied).toEqual({ installed: false });
      expect(procs).toEqual([null]);
    });
  });

  describe('createElectronPowerMonitorPort', () => {
    it('注册与移除电源事件监听', () => {
      const listeners: Record<string, () => void> = {};
      const mockPowerMonitor = {
        on: vi.fn((event: string, handler: () => void) => {
          listeners[event] = handler;
        }),
        removeAllListeners: vi.fn(),
      };

      const port = createElectronPowerMonitorPort({
        powerMonitor: mockPowerMonitor,
      });

      const suspendHandler = vi.fn();
      const resumeHandler = vi.fn();

      port.onSuspend(suspendHandler);
      port.onResume(resumeHandler);

      expect(mockPowerMonitor.on).toHaveBeenCalledWith('suspend', suspendHandler);
      expect(mockPowerMonitor.on).toHaveBeenCalledWith('resume', resumeHandler);

      port.removeAllListeners();
      expect(mockPowerMonitor.removeAllListeners).toHaveBeenCalled();
    });
  });
});
