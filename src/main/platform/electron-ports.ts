import { app, powerMonitor, session } from 'electron';
import type { SingleInstancePort } from '../instance/single-instance';
import type { ProxyPort } from '../network/proxy-manager';
import type { PowerMonitorPort } from './power-monitor';
import type { NetworkConfig } from '../config/config-types';
import { applyProxy } from '../network/proxy-manager';
import { REMOTE_PARTITION } from '../window/session-policy';

export interface CreateElectronSingleInstancePortOptions {
  app?: Pick<typeof import('electron').app, 'requestSingleInstanceLock' | 'releaseSingleInstanceLock' | 'on'>;
}

export function createElectronSingleInstancePort(
  options: CreateElectronSingleInstancePortOptions = {},
): SingleInstancePort {
  const electronApp = options.app ?? app;
  return {
    requestSingleInstanceLock: () => electronApp.requestSingleInstanceLock(),
    releaseSingleInstanceLock: () => electronApp.releaseSingleInstanceLock(),
    onSecondInstance: (handler) => {
      electronApp.on('second-instance', (_event, argv, workingDirectory) =>
        handler(argv, workingDirectory),
      );
    },
  };
}

export interface CreateElectronProxyPortOptions {
  partition?: string;
  sessionProvider?: (partition: string) => Parameters<typeof applyProxy>[0];
  applyProxy?: typeof applyProxy;
}

/** 代理端口：目标页面加载前经远程 session 应用代理（规格 §7、§11）。 */
export function createElectronProxyPort(options: CreateElectronProxyPortOptions = {}): ProxyPort {
  const partition = options.partition ?? REMOTE_PARTITION;
  const sessionProvider = options.sessionProvider ?? ((part) => session.fromPartition(part));
  const apply = options.applyProxy ?? applyProxy;

  return {
    apply: (config: NetworkConfig) => apply(sessionProvider(partition), config),
  };
}

export interface CreateElectronPowerMonitorPortOptions {
  powerMonitor?: Pick<typeof import('electron').powerMonitor, 'on' | 'removeAllListeners'>;
}

/** 电源端口：记录休眠/唤醒诊断，并在唤醒后由控制器重载目标页面（规格 §14.1）。 */
export function createElectronPowerMonitorPort(
  options: CreateElectronPowerMonitorPortOptions = {},
): PowerMonitorPort {
  const monitor = options.powerMonitor ?? powerMonitor;
  return {
    onSuspend: (handler) => {
      monitor.on('suspend', handler);
    },
    onResume: (handler) => {
      monitor.on('resume', handler);
    },
    removeAllListeners: () => {
      monitor.removeAllListeners();
    },
  };
}
