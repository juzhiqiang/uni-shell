/**
 * 会话级安全策略：下载控制与权限请求拦截。
 *
 * 规则来源：规格 v2.1 §11（安全要求）与 `rules/security.md`「会话分区与策略隔离」：
 * - 远程业务窗口与本地配置窗口强制会话分区隔离：
 *   - 远程业务窗口：`persist:remote`
 *   - 本地配置窗口：`local-config`
 * - 下载、权限请求等会话级策略必须通过 SessionPolicy 单点安装在对应的 session 上，
 *   避免被多次窗口创建/关闭覆盖或干扰。
 */

import type { SecurityConfig } from '../config/config-types';
import {
  decideDownload,
  decidePermission,
  readDownloadUrl,
  type GuardDownloadItem,
  type GuardEvent,
  type GuardSession,
  type NavigationGuardRecord,
} from './navigation-guard';

/** 远程业务窗口持久化会话分区。 */
export const REMOTE_PARTITION = 'persist:remote';

/** 本地配置窗口纯内存会话分区。 */
export const LOCAL_CONFIG_PARTITION = 'local-config';

export interface SessionPolicyOptions {
  /** 是否处于 Kiosk 模式（禁止下载）。 */
  kiosk?: boolean;
  /** 决策日志回调。 */
  onDecision?: (record: NavigationGuardRecord) => void;
}

export interface SessionPolicyHandle {
  /** 热更新安全配置。 */
  update(security: SecurityConfig): void;
  /** 卸载会话守卫，保持失败关闭。 */
  dispose(): void;
}

/**
 * 为指定 session 安装下载与权限守卫。
 */
export function installSessionPolicy(
  session: GuardSession,
  security: SecurityConfig,
  options: SessionPolicyOptions = {},
): SessionPolicyHandle {
  const holder: { security: SecurityConfig; kiosk: boolean } = {
    security,
    kiosk: options.kiosk === true,
  };

  const record = (
    kind: 'download' | 'permission',
    url: string,
    action: NavigationGuardRecord['action'],
    reason: string,
  ): void => {
    options.onDecision?.({ kind, url, action, reason });
  };

  const onWillDownload = (event: GuardEvent, item: GuardDownloadItem): void => {
    const url = readDownloadUrl(item);
    const decision = decideDownload(url, holder.security, { kiosk: holder.kiosk });
    record('download', url, decision.action, decision.reason);
    if (decision.action !== 'allow') {
      event.preventDefault();
    }
  };

  const onPermissionRequest = (
    _contents: unknown,
    permission: string,
    callback: (granted: boolean) => void,
  ): void => {
    const decision = decidePermission(permission);
    record('permission', permission, decision.action, decision.reason);
    callback(false);
  };

  session.on('will-download', onWillDownload);
  session.setPermissionRequestHandler(onPermissionRequest);

  return {
    update(next: SecurityConfig): void {
      holder.security = next;
    },
    dispose(): void {
      try {
        session.off('will-download', onWillDownload);
        session.setPermissionRequestHandler((_contents, _perm, cb) => cb(false));
      } catch {
        // session 销毁或不可用时静默退出
      }
    },
  };
}
