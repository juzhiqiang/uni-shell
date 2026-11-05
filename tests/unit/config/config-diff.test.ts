import { describe, expect, it } from 'vitest';

import { classifyConfigChange } from '../../../src/main/config/config-diff';
import { createDefaultConfig } from '../../../src/main/config/config-schema';

const base = createDefaultConfig('https://example.com');

describe('classifyConfigChange', () => {
  it('classifies nested hot-applied fields and startup.openAtLogin as hot', () => {
    const next = structuredClone(base);
    next.window.mode = 'fullscreen';
    next.network.retryIntervalSec = 9;
    next.security.allowPopups = true;
    next.maintenance.hotkeyEnabled = false;
    next.logging.level = 'debug';
    next.startup.openAtLogin = true;

    expect(classifyConfigChange(base, next)).toMatchObject({
      level: 'hot',
      changedPaths: expect.arrayContaining([
        'window.mode', 'network.retryIntervalSec', 'security.allowPopups',
        'maintenance.hotkeyEnabled', 'logging.level', 'startup.openAtLogin',
      ]),
    });
  });

  it('classifies targetUrl as reload and restart-only fields as restart', () => {
    const target = { ...base, targetUrl: 'https://new.example.com' };
    expect(classifyConfigChange(base, target).level).toBe('reload');

    // 规格 §5.2、§7：证书校验只发生在新发起的 TLS 连接上，
    // 已停留在证书错误页/离线页的窗口必须重载页面开关才生效。
    const certPolicy = structuredClone(base);
    certPolicy.network.allowUntrustedCertificates = true;
    expect(classifyConfigChange(base, certPolicy).level).toBe('reload');
    expect(classifyConfigChange(base, certPolicy).changedPaths).toContain('network.allowUntrustedCertificates');

    const restart = structuredClone(base);
    restart.appearance.icon = 'app-icon.png';
    expect(classifyConfigChange(base, restart).level).toBe('restart');
    restart.appearance.icon = '';
    restart.startup.delaySec = 10;
    expect(classifyConfigChange(base, restart).level).toBe('restart');
    restart.startup.delaySec = 0;
    restart.logging.retentionDays = 30;
    expect(classifyConfigChange(base, restart).level).toBe('restart');
  });

  it('chooses the most disruptive action for mixed changes and recognizes schema migration', () => {
    const next = structuredClone(base);
    next.targetUrl = 'https://new.example.com';
    next.window.mode = 'window';
    expect(classifyConfigChange(base, next).level).toBe('reload');

    next.logging.retentionDays = 30;
    expect(classifyConfigChange(base, next).level).toBe('restart');

    const migrated = { ...base, schemaVersion: base.schemaVersion + 1 };
    expect(classifyConfigChange(base, migrated).level).toBe('restart');
  });

  it('treats absent previous config and no-op changes deterministically', () => {
    expect(classifyConfigChange(undefined, base).level).toBe('restart');
    expect(classifyConfigChange(base, base)).toEqual({ level: 'hot', changedPaths: [] });
  });
});
