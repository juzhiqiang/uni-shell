import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETENTION_DAYS,
  LOG_FILE_PREFIX,
  createLogger,
  isSensitiveKey,
  logFileNameFor,
  parseLogFileDate,
  pruneExpiredLogs,
  redactSensitiveData,
  resolveLogDirectory,
  type LogFileSystem,
  type LoggerOptions,
} from '../../../src/main/logging/logger';

/**
 * 覆盖规格 v2.1 §12（平台日志目录、记录内容、14 天保留）与 §11（脱敏）：
 * 平台目录解析、保留期清理、结构化事件、敏感字段脱敏与关闭时刷新。
 */

/** 内存文件系统；目录只记录不校验，读写都落在 Map 上。 */
function createMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const directories = new Set<string>();
  const failures: Array<{ path: string; error: unknown }> = [];

  const fs: LogFileSystem = {
    async mkdir(path) {
      directories.add(path);
    },
    async appendFile(path, data) {
      files.set(path, `${files.get(path) ?? ''}${data}`);
    },
    async readdir(path) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const names: string[] = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.includes('/')) continue;
        names.push(rest);
      }
      return names;
    },
    async unlink(path) {
      if (!files.delete(path)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' } as NodeJS.ErrnoException);
      }
    },
  };

  return {
    fs,
    files,
    directories,
    /** 让指定路径（前缀匹配）的 mkdir 失败，模拟日志目录不可创建。 */
    failMkdir(path: string) {
      const original = fs.mkdir.bind(fs);
      fs.mkdir = async (target, options) => {
        if (target === path || target.startsWith(path)) {
          const error = Object.assign(new Error(`EACCES: ${target}`), { code: 'EACCES' } as NodeJS.ErrnoException);
          failures.push({ path: target, error });
          throw error;
        }
        return original(target, options);
      };
    },
    /** 让指定文件（精确匹配）的 appendFile 失败一次。 */
    failAppendOnce(path: string) {
      const original = fs.appendFile.bind(fs);
      let failed = false;
      fs.appendFile = async (target, data) => {
        if (!failed && target === path) {
          failed = true;
          throw Object.assign(new Error(`ENOSPC: ${target}`), { code: 'ENOSPC' } as NodeJS.ErrnoException);
        }
        return original(target, data);
      };
    },
  };
}

/** 本地时间构造日期，避免测试结果依赖运行时所在时区。 */
function localDate(year: number, month: number, day: number, hour = 12): Date {
  return new Date(year, month - 1, day, hour, 0, 0, 0);
}

function loggerOptions(overrides: Partial<LoggerOptions> = {}): LoggerOptions {
  return {
    platform: 'linux',
    directory: '/var/log/uni-shell',
    context: {
      appVersion: '0.1.0',
      electronVersion: '45.0.0',
      arch: 'x64',
      desktopEnvironment: 'GNOME',
      sessionType: 'x11',
    },
    now: () => localDate(2026, 10, 28),
    ...overrides,
  };
}

/** 读取并解析日志文件的全部行。 */
function readLines(memory: ReturnType<typeof createMemoryFs>, path: string): Array<Record<string, unknown>> {
  const content = memory.files.get(path) ?? '';
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('日志目录解析（规格 §12）', () => {
  it('Windows 使用 %APPDATA%\\UniShell\\logs', () => {
    const directory = resolveLogDirectory({
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    });

    expect(directory).toBe('C:\\Users\\tester\\AppData\\Roaming\\UniShell\\logs');
  });

  it('Windows 缺少 APPDATA 时回退到主目录', () => {
    const directory = resolveLogDirectory({
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      env: {},
    });

    expect(directory).toBe('C:\\Users\\tester\\AppData\\Roaming\\UniShell\\logs');
  });

  it('macOS 使用 ~/Library/Logs/UniShell', () => {
    const directory = resolveLogDirectory({
      platform: 'darwin',
      homeDir: '/Users/tester',
      env: {},
    });

    expect(directory).toBe('/Users/tester/Library/Logs/UniShell');
  });

  it('Linux 优先 $XDG_STATE_HOME/uni-shell/logs', () => {
    const directory = resolveLogDirectory({
      platform: 'linux',
      homeDir: '/home/tester',
      env: { XDG_STATE_HOME: '/home/tester/.local/state-custom' },
    });

    expect(directory).toBe('/home/tester/.local/state-custom/uni-shell/logs');
  });

  it('Linux 未设置 XDG_STATE_HOME 时使用 ~/.local/state/uni-shell/logs', () => {
    const directory = resolveLogDirectory({
      platform: 'linux',
      homeDir: '/home/tester',
      env: {},
    });

    expect(directory).toBe('/home/tester/.local/state/uni-shell/logs');
  });

  it('Linux 的 XDG_STATE_HOME 为相对路径时按未设置处理', () => {
    const directory = resolveLogDirectory({
      platform: 'linux',
      homeDir: '/home/tester',
      env: { XDG_STATE_HOME: 'relative/state' },
    });

    expect(directory).toBe('/home/tester/.local/state/uni-shell/logs');
  });
});

describe('日志文件名', () => {
  it('按自然日生成文件名', () => {
    expect(logFileNameFor(localDate(2026, 10, 28))).toBe(`${LOG_FILE_PREFIX}-2026-10-28.log`);
    expect(logFileNameFor(localDate(2026, 1, 5), 'custom')).toBe('custom-2026-01-05.log');
  });

  it('可从文件名解析回日期', () => {
    const parsed = parseLogFileDate('uni-shell-2026-10-28.log');
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(9);
    expect(parsed?.getDate()).toBe(28);
  });

  it('拒绝非法或不匹配的文件名', () => {
    expect(parseLogFileDate('uni-shell-2026-02-31.log')).toBeNull();
    expect(parseLogFileDate('uni-shell-2026-10-28.log.bak')).toBeNull();
    expect(parseLogFileDate('other-2026-10-28.log')).toBeNull();
    expect(parseLogFileDate('uni-shell-2026-10-28.log', 'custom')).toBeNull();
  });
});

describe('保留期清理（规格 §12：默认 14 天）', () => {
  const now = () => localDate(2026, 10, 28);

  it('删除早于保留期的日志并保留保留期内的日志', async () => {
    const memory = createMemoryFs({
      '/var/log/uni-shell/uni-shell-2026-10-28.log': 'today',
      '/var/log/uni-shell/uni-shell-2026-10-14.log': 'boundary',
      '/var/log/uni-shell/uni-shell-2026-10-13.log': 'expired',
      '/var/log/uni-shell/uni-shell-2026-09-01.log': 'old',
    });

    const deleted = await pruneExpiredLogs({
      directory: '/var/log/uni-shell',
      retentionDays: DEFAULT_RETENTION_DAYS,
      fs: memory.fs,
      now,
    });

    expect(deleted).toEqual(['uni-shell-2026-10-13.log', 'uni-shell-2026-09-01.log']);
    expect(memory.files.has('/var/log/uni-shell/uni-shell-2026-10-14.log')).toBe(true);
    expect(memory.files.has('/var/log/uni-shell/uni-shell-2026-10-28.log')).toBe(true);
  });

  it('不触碰非本应用命名规则的文件', async () => {
    const memory = createMemoryFs({
      '/var/log/uni-shell/other-2020-01-01.log': 'foreign',
      '/var/log/uni-shell/uni-shell-2026-10-28.log.bak': 'backup',
      '/var/log/uni-shell/readme.txt': 'note',
    });

    const deleted = await pruneExpiredLogs({
      directory: '/var/log/uni-shell',
      fs: memory.fs,
      now,
    });

    expect(deleted).toEqual([]);
    expect(memory.files.size).toBe(3);
  });

  it('支持自定义保留天数', async () => {
    const memory = createMemoryFs({
      '/var/log/uni-shell/uni-shell-2026-10-27.log': 'yesterday',
      '/var/log/uni-shell/uni-shell-2026-10-26.log': 'two-days-ago',
    });

    const deleted = await pruneExpiredLogs({
      directory: '/var/log/uni-shell',
      retentionDays: 1,
      fs: memory.fs,
      now,
    });

    expect(deleted).toEqual(['uni-shell-2026-10-26.log']);
  });

  it('目录不存在时静默返回空', async () => {
    const memory = createMemoryFs();

    const deleted = await pruneExpiredLogs({
      directory: '/var/log/missing',
      fs: memory.fs,
      now,
    });

    expect(deleted).toEqual([]);
  });

  it('createLogger 打开时按保留期清理', async () => {
    const memory = createMemoryFs({
      '/var/log/uni-shell/uni-shell-2026-10-01.log': 'old',
      '/var/log/uni-shell/uni-shell-2026-10-20.log': 'recent',
    });

    const logger = createLogger(loggerOptions({ fs: memory.fs }));
    await logger.close();

    expect(memory.files.has('/var/log/uni-shell/uni-shell-2026-10-01.log')).toBe(false);
    expect(memory.files.has('/var/log/uni-shell/uni-shell-2026-10-20.log')).toBe(true);
  });
});

describe('结构化事件与上下文', () => {
  it('每条记录都是带时间、级别、事件与版本上下文的 JSON 行', async () => {
    const memory = createMemoryFs();
    const logger = createLogger(loggerOptions({ fs: memory.fs }));

    logger.info('startup', { source: 'manual' });
    logger.warn('tray-degraded', { reason: '无托盘协议' });
    logger.error('page-load-failed', { failureKind: 'dns' });
    await logger.close();

    const lines = readLines(memory, `/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`);
    expect(lines).toHaveLength(3);

    expect(lines[0]).toMatchObject({
      level: 'info',
      event: 'startup',
      data: { source: 'manual' },
      app: {
        version: '0.1.0',
        electron: '45.0.0',
        platform: 'linux',
        arch: 'x64',
        desktopEnvironment: 'GNOME',
        sessionType: 'x11',
      },
    });
    expect(typeof lines[0].time).toBe('string');
    expect(lines[1].level).toBe('warn');
    expect(lines[2].level).toBe('error');
  });

  it('按天切换日志文件', async () => {
    const memory = createMemoryFs();
    let current = localDate(2026, 10, 28, 23);
    const logger = createLogger(loggerOptions({ fs: memory.fs, now: () => current }));

    logger.info('before-midnight');
    current = localDate(2026, 10, 29, 1);
    logger.info('after-midnight');
    await logger.close();

    expect(memory.files.has(`/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`)).toBe(true);
    expect(memory.files.has(`/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-29.log`)).toBe(true);
    expect(readLines(memory, `/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-29.log`)).toHaveLength(1);
  });

  it('默认级别为 info：debug 事件不写入', async () => {
    const memory = createMemoryFs();
    const logger = createLogger(loggerOptions({ fs: memory.fs }));

    logger.debug?.('debug-only');
    logger.info('visible');
    await logger.close();

    const lines = readLines(memory, `/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`);
    expect(lines.map((line) => line.event)).toEqual(['visible']);
  });

  it('配置为 debug 级别时 debug 事件也写入', async () => {
    const memory = createMemoryFs();
    const logger = createLogger(loggerOptions({ fs: memory.fs, level: 'debug' }));

    logger.debug?.('debug-visible');
    await logger.close();

    const lines = readLines(memory, `/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`);
    expect(lines.map((line) => line.event)).toEqual(['debug-visible']);
  });

  it('配置为 warn 级别时 info 事件被过滤', async () => {
    const memory = createMemoryFs();
    const logger = createLogger(loggerOptions({ fs: memory.fs, level: 'warn' }));

    logger.info('dropped');
    logger.warn('kept');
    await logger.close();

    const lines = readLines(memory, `/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`);
    expect(lines.map((line) => line.event)).toEqual(['kept']);
  });

  it('未显式指定目录时按平台解析（规格 §12）', async () => {
    const memory = createMemoryFs();
    const logger = createLogger(
      loggerOptions({
        platform: 'linux',
        homeDir: '/home/tester',
        env: {},
        directory: undefined,
        fs: memory.fs,
      }),
    );

    logger.info('startup');
    await logger.close();

    expect(memory.directories.has('/home/tester/.local/state/uni-shell/logs')).toBe(true);
    expect(memory.files.has('/home/tester/.local/state/uni-shell/logs/uni-shell-2026-10-28.log')).toBe(true);
  });

  it('非对象数据原样保留，bigint 转为字符串', async () => {
    const memory = createMemoryFs();
    const logger = createLogger(loggerOptions({ fs: memory.fs }));

    logger.info('plain-event', '文本数据');
    logger.info('bigint-event', { bytes: 10n });
    await logger.close();

    const lines = readLines(memory, `/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`);
    expect(lines[0].data).toBe('文本数据');
    expect(lines[1].data).toEqual({ bytes: '10' });
  });

  it('循环引用不会导致写入失败', async () => {
    const memory = createMemoryFs();
    const logger = createLogger(loggerOptions({ fs: memory.fs }));

    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    logger.info('cyclic', cyclic);
    await logger.close();

    const lines = readLines(memory, `/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`);
    expect(lines[0].data).toEqual({ name: 'root', self: '[Circular]' });
  });
});

describe('敏感字段脱敏（规格 §11）', () => {
  it('命中敏感字段名的值一律替换', () => {
    const redacted = redactSensitiveData({
      password: 'p@ss',
      proxyPassword: 'secret',
      token: 'abc',
      nested: { apiKey: 'key', refresh_token: 'rt' },
      list: [{ cookie: 'c=1' }, { Authorization: 'Bearer x' }],
    }) as Record<string, unknown>;

    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.proxyPassword).toBe('[REDACTED]');
    expect(redacted.token).toBe('[REDACTED]');
    expect(redacted.nested).toEqual({ apiKey: '[REDACTED]', refresh_token: '[REDACTED]' });
    expect(redacted.list).toEqual([{ cookie: '[REDACTED]' }, { Authorization: '[REDACTED]' }]);
  });

  it('字段名匹配大小写与分隔符不敏感', () => {
    expect(isSensitiveKey('Password')).toBe(true);
    expect(isSensitiveKey('API_KEY')).toBe(true);
    expect(isSensitiveKey('proxy-authorization')).toBe(true);
    expect(isSensitiveKey('sessionId')).toBe(true);
    expect(isSensitiveKey('')).toBe(false);
  });

  it('不过度脱敏普通诊断字段', () => {
    expect(isSensitiveKey('hotkey')).toBe(false);
    expect(isSensitiveKey('sessionType')).toBe(false);
    expect(isSensitiveKey('targetUrl')).toBe(false);

    const preserved = redactSensitiveData({
      hotkey: 'Ctrl+Alt+Shift+F12',
      sessionType: 'wayland',
      targetUrl: 'https://erp.example.com/app',
      proxyMode: 'fixed',
    }) as Record<string, unknown>;

    expect(preserved).toEqual({
      hotkey: 'Ctrl+Alt+Shift+F12',
      sessionType: 'wayland',
      targetUrl: 'https://erp.example.com/app',
      proxyMode: 'fixed',
    });
  });

  it('URL 中的用户凭据被剥离', () => {
    expect(redactSensitiveData('http://user:pass@proxy.internal:8080')).toBe(
      'http://[REDACTED]@proxy.internal:8080',
    );
    expect(redactSensitiveData('https://erp.example.com/app?a=1')).toBe('https://erp.example.com/app?a=1');
  });

  it('查询串中的敏感参数被替换', () => {
    expect(redactSensitiveData('https://erp.example.com/sso?token=abc123&next=/home')).toBe(
      'https://erp.example.com/sso?token=[REDACTED]&next=/home',
    );
    expect(redactSensitiveData('https://erp.example.com/sso?access_token=abc&sig=xyz')).toBe(
      'https://erp.example.com/sso?access_token=[REDACTED]&sig=[REDACTED]',
    );
  });

  it('Error 归一化为名称与消息，循环引用被截断', () => {
    expect(redactSensitiveData(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });

    const cyclic: Record<string, unknown> = { password: 'x' };
    cyclic.self = cyclic;
    expect(redactSensitiveData(cyclic)).toEqual({ password: '[REDACTED]', self: '[Circular]' });
  });

  it('写入前自动脱敏，调用方无法绕过', async () => {
    const memory = createMemoryFs();
    const logger = createLogger(loggerOptions({ fs: memory.fs }));

    logger.info('proxy-config', {
      proxyMode: 'fixed',
      proxyServer: 'http://user:pass@proxy.internal:8080',
      credentials: { username: 'tester', password: 'p@ssw0rd' },
    });
    await logger.close();

    const content = memory.files.get(`/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`) ?? '';
    expect(content).not.toContain('p@ssw0rd');
    expect(content).not.toContain('user:pass');
    expect(content).toContain('[REDACTED]');
  });
});

describe('关闭与刷新', () => {
  it('close 会等待挂起写入落盘', async () => {
    const memory = createMemoryFs();
    const logger = createLogger(loggerOptions({ fs: memory.fs }));

    logger.info('event-1');
    logger.info('event-2');
    logger.info('event-3');
    // 不等待任何微任务，直接关闭：三条记录都必须已刷新。
    await logger.close();

    const lines = readLines(memory, `/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`);
    expect(lines.map((line) => line.event)).toEqual(['event-1', 'event-2', 'event-3']);
  });

  it('close 之后不再接受新事件', async () => {
    const memory = createMemoryFs();
    const logger = createLogger(loggerOptions({ fs: memory.fs }));

    logger.info('before-close');
    await logger.close();
    logger.info('after-close');

    const lines = readLines(memory, `/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`);
    expect(lines.map((line) => line.event)).toEqual(['before-close']);
  });

  it('close 是幂等的', async () => {
    const memory = createMemoryFs();
    const logger = createLogger(loggerOptions({ fs: memory.fs }));

    logger.info('event');
    await logger.close();
    await logger.close();

    const lines = readLines(memory, `/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`);
    expect(lines).toHaveLength(1);
  });

  it('单次写入失败不影响后续写入，并经 onError 上报', async () => {
    const memory = createMemoryFs();
    memory.failAppendOnce(`/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`);
    const errors: Array<{ event: string; code: unknown }> = [];
    const logger = createLogger(
      loggerOptions({
        fs: memory.fs,
        onError: (error, event) => {
          errors.push({ event, code: (error as NodeJS.ErrnoException).code });
        },
      }),
    );

    logger.info('first');
    logger.info('second');
    await logger.close();

    const lines = readLines(memory, `/var/log/uni-shell/${LOG_FILE_PREFIX}-2026-10-28.log`);
    expect(lines.map((line) => line.event)).toEqual(['second']);
    expect(errors).toEqual([{ event: 'first', code: 'ENOSPC' }]);
  });

  it('日志目录不可创建时降级为静默丢弃，不影响调用方', async () => {
    const memory = createMemoryFs();
    memory.failMkdir('/var/log/uni-shell');
    const errors: unknown[] = [];
    const logger = createLogger(
      loggerOptions({
        fs: memory.fs,
        onError: (error) => {
          errors.push(error);
        },
      }),
    );

    expect(() => logger.info('event')).not.toThrow();
    await logger.close();

    expect(errors).toHaveLength(1);
    expect(memory.files.size).toBe(0);
  });
});
