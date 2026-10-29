import { describe, expect, it } from 'vitest';

import type { SecurityConfig } from '../../../src/main/config/config-types';
import type {
  GuardDownloadItem,
  GuardEvent,
  GuardSession,
  NavigationGuardRecord,
} from '../../../src/main/window/navigation-guard';
import {
  installSessionPolicy,
  LOCAL_CONFIG_PARTITION,
  REMOTE_PARTITION,
} from '../../../src/main/window/session-policy';

class FakeGuardEvent implements GuardEvent {
  prevented = false;

  preventDefault(): void {
    this.prevented = true;
  }
}

class FakeSession implements GuardSession {
  readonly events = new Map<string, Array<(...args: unknown[]) => void>>();
  permissionHandler:
    | ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void)
    | null = null;

  on(event: 'will-download', listener: (...args: unknown[]) => void): unknown {
    const list = this.events.get(event) ?? [];
    list.push(listener);
    this.events.set(event, list);
    return this;
  }

  off(event: 'will-download', listener: (...args: unknown[]) => void): unknown {
    const list = this.events.get(event) ?? [];
    this.events.set(
      event,
      list.filter((registered) => registered !== listener),
    );
    return this;
  }

  setPermissionRequestHandler(
    handler:
      | ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void)
      | null,
  ): void {
    this.permissionHandler = handler;
  }

  emitDownload(item: GuardDownloadItem): boolean {
    const event = new FakeGuardEvent();
    const listeners = [...(this.events.get('will-download') ?? [])];
    for (const listener of listeners) {
      listener(event, item);
    }
    return event.prevented;
  }

  requestPermission(permission: string): boolean | undefined {
    let granted: boolean | undefined;
    this.permissionHandler?.(undefined, permission, (val: boolean) => {
      granted = val;
    });
    return granted;
  }
}

function baseSecurity(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    allowedOrigins: ['https://app.example.com'],
    allowExternalLinks: false,
    allowPopups: false,
    allowDownloads: false,
    ...overrides,
  };
}

describe('SessionPolicy 会话策略', () => {
  it('导出规范约定的分区名称', () => {
    expect(REMOTE_PARTITION).toBe('persist:remote');
    expect(LOCAL_CONFIG_PARTITION).toBe('local-config');
  });

  it('默认拒绝下载；允许时按授权源放行', () => {
    const session = new FakeSession();
    const policy = installSessionPolicy(session, baseSecurity());

    // 默认禁止下载
    expect(session.emitDownload({ getURL: () => 'https://app.example.com/file.pdf' })).toBe(true);

    // 更新为允许下载
    policy.update(baseSecurity({ allowDownloads: true }));
    expect(session.emitDownload({ getURL: () => 'https://app.example.com/file.pdf' })).toBe(false);
    // 未授权源拒绝
    expect(session.emitDownload({ getURL: () => 'https://evil.example.com/file.pdf' })).toBe(true);
  });

  it('Kiosk 模式下一律拒绝下载，即使配置允许', () => {
    const session = new FakeSession();
    installSessionPolicy(session, baseSecurity({ allowDownloads: true }), { kiosk: true });

    expect(session.emitDownload({ getURL: () => 'https://app.example.com/file.pdf' })).toBe(true);
  });

  it('权限请求一律被拒绝', () => {
    const session = new FakeSession();
    installSessionPolicy(session, baseSecurity());

    expect(session.requestPermission('media')).toBe(false);
    expect(session.requestPermission('notifications')).toBe(false);
    expect(session.requestPermission('geolocation')).toBe(false);
  });

  it('决策结果通过 onDecision 回调记录', () => {
    const session = new FakeSession();
    const records: NavigationGuardRecord[] = [];
    installSessionPolicy(session, baseSecurity({ allowDownloads: true }), {
      onDecision: (record) => records.push(record),
    });

    session.emitDownload({ getURL: () => 'https://app.example.com/doc.pdf' });
    session.requestPermission('camera');

    expect(records).toEqual([
      expect.objectContaining({
        kind: 'download',
        url: 'https://app.example.com/doc.pdf',
        action: 'allow',
      }),
      expect.objectContaining({
        kind: 'permission',
        url: 'camera',
        action: 'deny',
      }),
    ]);
  });

  it('dispose 移除 will-download 监听器并将权限处理器置为拒绝', () => {
    const session = new FakeSession();
    const policy = installSessionPolicy(session, baseSecurity({ allowDownloads: true }));

    expect(session.events.get('will-download')?.length).toBe(1);

    policy.dispose();

    expect(session.events.get('will-download')?.length).toBe(0);
    // 卸载后权限依然安全关闭
    expect(session.requestPermission('camera')).toBe(false);
  });
});
