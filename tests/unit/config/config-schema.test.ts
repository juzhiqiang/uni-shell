import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONFIG_SCHEMA_VERSION,
  ConfigValidationError,
  createDefaultConfig,
  migrateConfig,
  validateConfig,
} from '../../../src/main/config/config-schema';

/**
 * 规格 v2.1 §6 的配置结构是本测试的唯一契约来源。
 * 覆盖：URL 协议/主机规则、枚举值、delaySec 范围、未知字段、默认值、schemaVersion 迁移。
 */
describe('config schema', () => {
  describe('targetUrl 规则', () => {
    it('接受 http 与 https 且包含主机名', () => {
      for (const url of ['https://example.com', 'http://example.com', 'https://example.com:8443/path?q=1']) {
        const result = validateConfig(buildConfigWith('targetUrl', url));
        expect(result.ok, `应当接受 ${url}`).toBe(true);
      }
    });

    it('拒绝非 http/https 协议', () => {
      for (const url of [
        'ftp://example.com',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'data:text/html,hello',
        'uni-shell://open',
      ]) {
        const result = validateConfig({ targetUrl: url });
        expect(result.ok, `应当拒绝 ${url}`).toBe(false);
        if (!result.ok) {
          expect(result.issues.some((issue) => issue.path === 'targetUrl')).toBe(true);
        }
      }
    });

    it('拒绝缺少主机名的地址', () => {
      for (const url of ['https://', 'http://', 'https:///path']) {
        const result = validateConfig({ targetUrl: url });
        expect(result.ok, `应当拒绝 ${url}`).toBe(false);
      }
    });

    it('拒绝空白、空串和非字符串类型', () => {
      for (const value of ['', '   ', '\t\n', 42, null, undefined, {}, ['https://a.b']]) {
        const result = validateConfig({ targetUrl: value });
        expect(result.ok, `应当拒绝 ${JSON.stringify(value)}`).toBe(false);
      }
    });

    it('targetUrl 缺失时报告该字段缺失', () => {
      const result = validateConfig({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.path === 'targetUrl')).toBe(true);
      }
    });
  });

  describe('枚举值', () => {
    const cases: Array<[string, string[], string[]]> = [
      ['window.mode', ['window', 'fullscreen', 'kiosk'], ['maximized', 'borderless', '']],
      [
        'window.alwaysOnTopLevel',
        ['normal', 'floating', 'pop-up-menu', 'screen-saver'],
        ['topmost', 'above', 'normal '],
      ],
      ['startup.initialState', ['tray', 'minimized'], ['hidden', 'shown', '']],
      ['network.proxyMode', ['direct', 'system', 'fixed', 'pac'], ['auto', 'none', 'manual']],
      ['logging.level', ['debug', 'info', 'warn', 'error'], ['trace', 'verbose', 'INFO']],
      ['window.closeAction', ['hide', 'quit'], ['close', 'minimize', '']],
    ];

    for (const [path, allowed, rejected] of cases) {
      it(`${path} 接受合法值`, () => {
        for (const value of allowed) {
          const config = buildConfigWith(path, value);
          if (path === 'network.proxyMode' && value === 'fixed') {
            const network = config.network as Record<string, unknown>;
            network.proxyServer = 'proxy.example.com:8080';
          }
          if (path === 'network.proxyMode' && value === 'pac') {
            const network = config.network as Record<string, unknown>;
            network.proxyServer = 'https://proxy.example.com/proxy.pac';
          }
          const result = validateConfig(config);
          expect(result.ok, `${path}=${value} 应当被接受`).toBe(true);
        }
      });

      it(`${path} 拒绝非法值`, () => {
        for (const value of rejected) {
          const result = validateConfig(buildConfigWith(path, value));
          expect(result.ok, `${path}=${value} 应当被拒绝`).toBe(false);
          if (!result.ok) {
            expect(result.issues.some((issue) => issue.path === path)).toBe(true);
          }
        }
      });
    }

    it('布尔字段拒绝非布尔值', () => {
      for (const path of [
        'window.alwaysOnTop',
        'startup.openAtLogin',
        'startup.delayOnlyOnLogin',
        'startup.showAfterDelay',
        'maintenance.hotkeyEnabled',
        'maintenance.trayConfigEnabled',
        'security.allowExternalLinks',
        'security.allowPopups',
        'security.allowDownloads',
        'network.offlinePageEnabled',
      ]) {
        const result = validateConfig(buildConfigWith(path, 'yes'));
        expect(result.ok, `${path} 应当拒绝字符串 "yes"`).toBe(false);
      }
    });
  });

  describe('数值范围', () => {
    it('delaySec 接受 0～3600 的整数', () => {
      for (const value of [0, 1, 60, 1800, 3600]) {
        const result = validateConfig(buildConfigWith('startup.delaySec', value));
        expect(result.ok, `delaySec=${value} 应当被接受`).toBe(true);
      }
    });

    it('delaySec 拒绝越界、小数和非整数类型', () => {
      for (const value of [-1, 3601, 7200, 1.5, '3', null, true]) {
        const result = validateConfig(buildConfigWith('startup.delaySec', value));
        expect(result.ok, `delaySec=${JSON.stringify(value)} 应当被拒绝`).toBe(false);
        if (!result.ok) {
          expect(result.issues.some((issue) => issue.path === 'startup.delaySec')).toBe(true);
        }
      }
    });

    it('retryIntervalSec 与 requestTimeoutSec 拒绝 0 和负数', () => {
      for (const path of ['network.retryIntervalSec', 'network.requestTimeoutSec']) {
        for (const value of [0, -1, 1.5, '10']) {
          const result = validateConfig(buildConfigWith(path, value));
          expect(result.ok, `${path}=${JSON.stringify(value)} 应当被拒绝`).toBe(false);
        }
      }
    });

    it('retentionDays 拒绝 0、负数和小数', () => {
      for (const value of [0, -1, 1.5, '14']) {
        const result = validateConfig(buildConfigWith('logging.retentionDays', value));
        expect(result.ok, `retentionDays=${JSON.stringify(value)} 应当被拒绝`).toBe(false);
      }
    });
  });

  describe('未知字段兼容', () => {
    it('未知顶层字段不导致校验失败', () => {
      const result = validateConfig({
        schemaVersion: CONFIG_SCHEMA_VERSION,
        targetUrl: 'https://example.com',
        futureFeature: { enabled: true },
        anotherUnknown: 'value',
      });
      expect(result.ok).toBe(true);
    });

    it('未知嵌套字段不导致校验失败', () => {
      const result = validateConfig({
        schemaVersion: CONFIG_SCHEMA_VERSION,
        targetUrl: 'https://example.com',
        window: { mode: 'fullscreen', unknownWindowField: 1 },
      });
      expect(result.ok).toBe(true);
    });

    it('迁移后保留未知顶层字段以便跨版本往返', () => {
      const migrated = migrateConfig({
        targetUrl: 'https://example.com',
        futureFeature: { enabled: true },
      });
      expect(migrated.futureFeature).toEqual({ enabled: true });
    });

    it('未知字段不与已声明字段冲突', () => {
      const result = validateConfig({
        schemaVersion: CONFIG_SCHEMA_VERSION,
        targetUrl: 'https://example.com',
        targetUrlBackup: 'https://other.example.com',
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('默认值', () => {
    it('仅提供 targetUrl 时补齐全部默认值', () => {
      const migrated = migrateConfig({ targetUrl: 'https://example.com' });

      expect(migrated.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
      expect(migrated.targetUrl).toBe('https://example.com');
      expect(migrated.window).toEqual({
        mode: 'window',
        alwaysOnTop: false,
        alwaysOnTopLevel: 'normal',
        display: 'primary',
        closeAction: 'hide',
      });
      expect(migrated.network).toEqual({
        proxyMode: 'direct',
        proxyServer: '',
        proxyBypass: '',
        retryIntervalSec: 3,
        requestTimeoutSec: 20,
        offlinePageEnabled: true,
      });
      expect(migrated.startup).toEqual({
        openAtLogin: false,
        initialState: 'tray',
        delaySec: 0,
        delayOnlyOnLogin: false,
        showAfterDelay: true,
      });
      expect(migrated.maintenance).toEqual({
        hotkeyEnabled: true,
        hotkey: 'Ctrl+Alt+Shift+F12',
        trayConfigEnabled: true,
      });
      expect(migrated.security).toEqual({
        allowedOrigins: [],
        allowExternalLinks: false,
        allowPopups: false,
        allowDownloads: false,
      });
      expect(migrated.logging).toEqual({ level: 'info', retentionDays: 14 });
    });

    it('空对象迁移时使用 createDefaultConfig 的默认目标地址', () => {
      const config = createDefaultConfig('https://default.example.com');
      expect(config.targetUrl).toBe('https://default.example.com');
      expect(config.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
      expect(migrateConfig(config)).toEqual(config);
    });

    it('部分提供的嵌套对象只补齐缺失字段', () => {
      const migrated = migrateConfig({
        targetUrl: 'https://example.com',
        window: { mode: 'kiosk' },
        network: { proxyMode: 'fixed', proxyServer: 'http://proxy.internal:3128' },
      });
      expect(migrated.window.mode).toBe('kiosk');
      expect(migrated.window.alwaysOnTop).toBe(false);
      expect(migrated.network.proxyMode).toBe('fixed');
      expect(migrated.network.proxyServer).toBe('http://proxy.internal:3128');
      expect(migrated.network.retryIntervalSec).toBe(3);
    });
  });

  describe('schemaVersion 迁移', () => {
    it('缺少 schemaVersion 时按旧版本迁移并写入当前版本号', () => {
      const migrated = migrateConfig({ targetUrl: 'https://example.com' });
      expect(migrated.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    });

    it('schemaVersion 为当前版本时保持不变', () => {
      const input = createDefaultConfig('https://example.com');
      const migrated = migrateConfig(input);
      expect(migrated.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
      expect(migrated.targetUrl).toBe('https://example.com');
    });

    it('schemaVersion 高于当前版本时拒绝并给出可操作错误', () => {
      const result = validateConfig({
        ...createDefaultConfig('https://example.com'),
        schemaVersion: CONFIG_SCHEMA_VERSION + 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.path === 'schemaVersion')).toBe(true);
      }

      expect(() =>
        migrateConfig({ ...createDefaultConfig('https://example.com'), schemaVersion: 99 }),
      ).toThrow(ConfigValidationError);
    });

    it('schemaVersion 为非整数或负数时拒绝', () => {
      for (const value of [0, -1, 1.5, '1', null]) {
        const result = validateConfig({ ...createDefaultConfig('https://example.com'), schemaVersion: value });
        expect(result.ok, `schemaVersion=${JSON.stringify(value)} 应当被拒绝`).toBe(false);
      }
    });

    it('迁移失败时抛出带 issues 的 ConfigValidationError', () => {
      try {
        migrateConfig({ targetUrl: 'ftp://example.com' });
        expect.unreachable('应当抛出 ConfigValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe('security.allowedOrigins', () => {
    it('接受合法的 http/https 源', () => {
      const result = validateConfig(
        buildConfigWith('security.allowedOrigins', ['https://a.example.com', 'http://b.example.com:8080']),
      );
      expect(result.ok).toBe(true);
    });

    it('拒绝非法协议或缺少主机名的源', () => {
      const result = validateConfig(
        buildConfigWith('security.allowedOrigins', ['ftp://a.example.com', 'https://', 42]),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.path.startsWith('security.allowedOrigins'))).toBe(true);
      }
    });
  });

  describe('maintenance.hotkey', () => {
    it('接受非空字符串', () => {
      const result = validateConfig(buildConfigWith('maintenance.hotkey', 'Ctrl+Alt+Shift+F12'));
      expect(result.ok).toBe(true);
    });

    it('拒绝空字符串和非字符串', () => {
      for (const value of ['', '   ', 12, null]) {
        const result = validateConfig(buildConfigWith('maintenance.hotkey', value));
        expect(result.ok, `hotkey=${JSON.stringify(value)} 应当被拒绝`).toBe(false);
      }
    });
  });

  describe('network proxy credentials', () => {
    it('rejects proxy credentials in config regardless of the selected mode', () => {
      for (const proxyMode of ['direct', 'system', 'fixed', 'pac']) {
        const result = validateConfig({
          ...createDefaultConfig('https://example.com'),
          network: { proxyMode, proxyServer: 'http://operator:secret@proxy.example.com:8080' },
        });

        expect(result.ok, `${proxyMode} 模式不应持久化代理凭据`).toBe(false);
        if (!result.ok) {
          expect(result.issues.some((issue) => issue.path === 'network.proxyServer')).toBe(true);
        }
      }
    });

    it('rejects credentials in a malformed proxy URL instead of persisting it', () => {
      const result = validateConfig({
        ...createDefaultConfig('https://example.com'),
        network: { proxyMode: 'direct', proxyServer: 'http://operator:secret@' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.path === 'network.proxyServer')).toBe(true);
      }
    });

    it('rejects credentials in a PAC URL even when its query contains equals signs', () => {
      const result = validateConfig({
        ...createDefaultConfig('https://example.com'),
        network: {
          proxyMode: 'pac',
          proxyServer: 'https://operator:secret@proxy.example.com/proxy.pac?token=a=b',
        },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.path === 'network.proxyServer')).toBe(true);
      }
    });

    it('requires a server value for fixed and PAC proxy modes', () => {
      for (const proxyMode of ['fixed', 'pac']) {
        const result = validateConfig({
          ...createDefaultConfig('https://example.com'),
          network: { proxyMode, proxyServer: '' },
        });

        expect(result.ok, `${proxyMode} 模式应要求 proxyServer`).toBe(false);
      }
    });

    it('rejects a non-HTTP PAC address before saving', () => {
      const result = validateConfig({
        ...createDefaultConfig('https://example.com'),
        network: { proxyMode: 'pac', proxyServer: 'file:///proxy.pac' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.path === 'network.proxyServer')).toBe(true);
      }
    });
  });

  describe('随包配置模板', () => {
    it('resources/config.example.json 能通过校验', () => {
      const raw = readFileSync(resolve(process.cwd(), 'resources/config.example.json'), 'utf8');
      const result = validateConfig(JSON.parse(raw));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
        expect(result.value.targetUrl).toBe('https://example.com');
      }
    });

    it('迁移后与自身相等（模板是稳定的当前版本配置）', () => {
      const raw = readFileSync(resolve(process.cwd(), 'resources/config.example.json'), 'utf8');
      const migrated = migrateConfig(JSON.parse(raw));
      expect(migrateConfig(migrated)).toEqual(migrated);
    });
  });
});

/**
 * 按点号路径把 value 写进一份合法配置，用于逐字段校验。
 * 这些用例断言「一份完整配置在替换某字段后是否被接受」，
 * 因此必须带上当前 schemaVersion——只有 migrateConfig 会补齐它。
 */
function buildConfigWith(path: string, value: unknown): Record<string, unknown> {
  const config: Record<string, unknown> = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    targetUrl: 'https://example.com',
  };
  const segments = path.split('.');
  let cursor = config;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const existing = cursor[segment];
    if (typeof existing !== 'object' || existing === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
  return config;
}
