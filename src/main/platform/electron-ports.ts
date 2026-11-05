import { app, powerMonitor, session } from 'electron';
import type { SingleInstancePort } from '../instance/single-instance';
import type { ProxyPort } from '../network/proxy-manager';
import {
  applyCertificateVerifyPolicy,
  type CertificateBypassRecord,
  type CertificatePolicyNetwork,
  type CertificatePolicyPort,
  type CertificateVerifySession,
} from '../network/cert-policy';
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

export interface CreateElectronCertificatePolicyPortOptions {
  /** 默认远程业务会话分区 `persist:remote`；测试注入假会话。 */
  partition?: string;
  sessionProvider?: (partition: string) => CertificateVerifySession;
  /** 放行不受信任证书时的记录出口；生产环境接日志（规格 §12）。 */
  onBypass?: (record: CertificateBypassRecord) => void;
}

/**
 * 证书校验策略端口：仅远程业务会话生效（规格 v2.1.7 §7、§11；
 * `rules/security.md`「证书校验绕过只允许经显式配置开关按会话启用」）。
 *
 * 开启时安装 `setCertificateVerifyProc` 放行全部证书错误；关闭时传 `null`
 * 恢复 Chromium 默认校验。本地配置会话（`local-config`）不使用本端口，
 * 始终走系统默认校验。
 */
export function createElectronCertificatePolicyPort(
  options: CreateElectronCertificatePolicyPortOptions = {},
): CertificatePolicyPort {
  const partition = options.partition ?? REMOTE_PARTITION;
  const sessionProvider = options.sessionProvider ?? ((part) => session.fromPartition(part));

  return {
    apply: (network: CertificatePolicyNetwork) =>
      applyCertificateVerifyPolicy(sessionProvider(partition), network.allowUntrustedCertificates === true, {
        onBypass: options.onBypass,
      }),
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
