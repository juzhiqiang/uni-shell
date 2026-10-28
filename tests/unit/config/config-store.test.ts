import { win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDefaultConfig, migrateConfig } from '../../../src/main/config/config-schema';
import {
  ConfigWriteError,
  loadConfig,
  saveConfig,
  type ConfigFileSystem,
} from '../../../src/main/config/config-store';
import {
  CONFIG_BACKUP_FILE_NAME,
  CONFIG_FILE_NAME,
  parseConfigDirArgv,
  resolveConfigPaths,
  type ResolveConfigPathsOptions,
} from '../../../src/main/platform/config-paths';

/**
 * 覆盖规格 v2.1 §5.1/§5.2 的路径优先级与持久化规则，
 * 以及 `rules/platform.md`「路径与配置」中的禁止写入项。
 */

const WINDOWS_HOME = 'C:\\Users\\tester';
const MAC_HOME = '/Users/tester';
const LINUX_HOME = '/home/tester';

function windowsOptions(overrides: Partial<ResolveConfigPathsOptions> = {}): ResolveConfigPathsOptions {
  return {
    platform: 'win32',
    homeDir: WINDOWS_HOME,
    env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    ...overrides,
  };
}

function macOptions(overrides: Partial<ResolveConfigPathsOptions> = {}): ResolveConfigPathsOptions {
  return {
    platform: 'darwin',
    homeDir: MAC_HOME,
    env: {},
    ...overrides,
  };
}

function linuxOptions(overrides: Partial<ResolveConfigPathsOptions> = {}): ResolveConfigPathsOptions {
  return {
    platform: 'linux',
    homeDir: LINUX_HOME,
    env: {},
    ...overrides,
  };
}

/** 内存文件系统，记录调用顺序以便验证原子替换。 */
function createMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const operations: string[] = [];

  const failOn = new Set<string>();
  const failWith = new Map<string, NodeJS.ErrnoException>();

  function throwIfFailed(path: string): void {
    // 前缀匹配：临时文件名带 pid 与时间戳，测试只关心目录或文件名前缀。
    for (const [prefix, error] of failWith) {
      if (path === prefix || path.startsWith(prefix)) throw error;
    }
  }

  const fs: ConfigFileSystem = {
    async readFile(path) {
      operations.push(`read:${path}`);
      throwIfFailed(path);
      const value = files.get(path);
      if (value === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' } as NodeJS.ErrnoException);
      }
      return value;
    },
    async writeFile(path, data) {
      operations.push(`write:${path}`);
      throwIfFailed(path);
      files.set(path, data);
    },
    async rename(from, to) {
      operations.push(`rename:${from}->${to}`);
      throwIfFailed(to);
      const value = files.get(from);
      if (value === undefined) {
        throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' } as NodeJS.ErrnoException);
      }
      files.set(to, value);
      files.delete(from);
    },
    async mkdir(path) {
      operations.push(`mkdir:${path}`);
      throwIfFailed(path);
    },
    async access(path) {
      operations.push(`access:${path}`);
      throwIfFailed(path);
      if (!files.has(path)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' } as NodeJS.ErrnoException);
      }
    },
    async unlink(path) {
      operations.push(`unlink:${path}`);
      throwIfFailed(path);
      files.delete(path);
    },
  };

  return {
    fs,
    files,
    operations,
    /** 让 path 及其子路径（含临时文件）以指定 errno 失败。 */
    fail(path: string, code = 'EACCES') {
      failOn.add(path);
      failWith.set(path, Object.assign(new Error(`${code}: ${path}`), { code } as NodeJS.ErrnoException));
    },
  };
}

describe('resolveConfigPaths 优先级', () => {
  it('--config-dir 具有最高优先级', () => {
    const paths = resolveConfigPaths(
      windowsOptions({
        argv: ['electron', '--config-dir=D:\\PortableConfig', '--other'],
        env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming', UNI_SHELL_CONFIG_DIR: 'D:\\EnvConfig' },
      }),
    );

    expect(paths.source).toBe('cli');
    expect(paths.directory).toBe('D:\\PortableConfig');
    expect(paths.configPath).toBe(win32.join('D:\\PortableConfig', CONFIG_FILE_NAME));
  });

  it('--config-dir 支持空格分隔形式', () => {
    expect(parseConfigDirArgv(['app', '--config-dir', '/opt/uni'])).toBe('/opt/uni');
    expect(parseConfigDirArgv(['app', '--config-dir=/opt/uni'])).toBe('/opt/uni');
    expect(parseConfigDirArgv(['app', '--other', '--config-dir'])).toBeUndefined();
    expect(parseConfigDirArgv(['app', '--config-dir='])).toBeUndefined();
  });

  it('UNI_SHELL_CONFIG_DIR 次于 --config-dir', () => {
    const paths = resolveConfigPaths(
      windowsOptions({
        argv: ['electron'],
        env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming', UNI_SHELL_CONFIG_DIR: 'D:\\EnvConfig' },
      }),
    );

    expect(paths.source).toBe('env');
    expect(paths.directory).toBe('D:\\EnvConfig');
  });

  it('Windows 便携路径为可执行文件同级目录', () => {
    const paths = resolveConfigPaths(
      windowsOptions({ executablePath: 'D:\\Apps\\UniShell\\UniShell.exe' }),
    );

    expect(paths.source).toBe('portable-windows');
    expect(paths.directory).toBe('D:\\Apps\\UniShell');
  });

  it('Windows 用户配置目录为 %APPDATA%\\UniShell', () => {
    const paths = resolveConfigPaths(windowsOptions());

    expect(paths.source).toBe('user-config');
    expect(paths.directory).toBe('C:\\Users\\tester\\AppData\\Roaming\\UniShell');
  });

  it('Linux AppImage 便携路径为 $APPIMAGE 同级目录', () => {
    const paths = resolveConfigPaths(
      linuxOptions({ env: { APPIMAGE: '/opt/uni-shell/UniShell.AppImage' } }),
    );

    expect(paths.source).toBe('portable-appimage');
    expect(paths.directory).toBe('/opt/uni-shell');
  });

  it('Linux XDG 配置目录优先，未设置时回退 ~/.config/uni-shell', () => {
    expect(resolveConfigPaths(linuxOptions({ env: { XDG_CONFIG_HOME: '/home/tester/.xdg' } })).directory).toBe(
      '/home/tester/.xdg/uni-shell',
    );
    expect(resolveConfigPaths(linuxOptions({ env: {} })).directory).toBe('/home/tester/.config/uni-shell');
    // 相对路径的 XDG_CONFIG_HOME 无效，按规范回退。
    expect(resolveConfigPaths(linuxOptions({ env: { XDG_CONFIG_HOME: 'relative/path' } })).directory).toBe(
      '/home/tester/.config/uni-shell',
    );
  });

  it('macOS 用户配置目录为 ~/Library/Application Support/UniShell', () => {
    const paths = resolveConfigPaths(macOptions());

    expect(paths.source).toBe('user-config');
    expect(paths.directory).toBe('/Users/tester/Library/Application Support/UniShell');
  });

  it('macOS ZIP 便携路径为 .app 同级目录', () => {
    const paths = resolveConfigPaths(
      macOptions({ macAppBundlePath: '/Applications/UniShell.app' }),
    );

    expect(paths.source).toBe('portable-mac-zip');
    expect(paths.directory).toBe('/Applications');
  });

  it('候选列表按优先级排列且包含用户配置目录兜底', () => {
    const paths = resolveConfigPaths(
      windowsOptions({
        argv: ['electron', '--config-dir=D:\\Portable'],
        executablePath: 'D:\\Apps\\UniShell\\UniShell.exe',
      }),
    );

    expect(paths.candidates.map((candidate) => candidate.source)).toEqual([
      'cli',
      'portable-windows',
      'user-config',
    ]);
  });
});

describe('受保护目录与只读路径', () => {
  it('不向 macOS .app bundle 内写入配置', () => {
    const paths = resolveConfigPaths(
      macOptions({ macAppBundlePath: '/Applications/UniShell.app' }),
    );

    expect(paths.directory).toBe('/Applications');
    expect(paths.configPath).toBe('/Applications/config.json');
    expect(paths.configPath).not.toContain('.app/');
  });

  it('macOS .app 同级目录被判定为受保护时不读取也不写入', () => {
    const paths = resolveConfigPaths(
      macOptions({ macAppBundlePath: '/Applications/UniShell.app/Contents/MacOS/UniShell' }),
    );

    const portable = paths.candidates.find((candidate) => candidate.source === 'portable-mac-zip');
    expect(portable?.readable).toBe(false);
    expect(portable?.writable).toBe(false);
    expect(portable?.reason).toContain('不是有效的配置位置');
    // 回退到用户配置目录。
    expect(paths.source).toBe('user-config');
  });

  it('不向 Linux AppImage 挂载目录写入配置', () => {
    const paths = resolveConfigPaths(
      linuxOptions({ env: { APPIMAGE: '/tmp/.mount_UniShe/usr/bin/UniShell' } }),
    );

    const portable = paths.candidates.find((candidate) => candidate.source === 'portable-appimage');
    expect(portable?.writable).toBe(false);
    expect(paths.source).toBe('user-config');
  });

  it('不向 Linux /usr、/opt、/etc 写入配置，但可读取旁置配置', () => {
    for (const dir of ['/usr/share/uni-shell', '/opt/uni-shell', '/etc/uni-shell']) {
      const paths = resolveConfigPaths(linuxOptions({ argv: ['app', `--config-dir=${dir}`] }));
      const cli = paths.candidates.find((candidate) => candidate.source === 'cli');
      // 规格 §5.2 允许读取安装目录旁置的 config.json，但禁止写入。
      expect(cli?.readable, `${dir} 应可读取`).toBe(true);
      expect(cli?.writable, `${dir} 不应可写`).toBe(false);
      expect(paths.writeSource).toBe('user-config');
    }
  });

  it('不向 Windows Program Files 与 Windows 目录写入配置，但可读取旁置配置', () => {
    for (const dir of [
      'C:\\Program Files\\UniShell',
      'C:\\Program Files (x86)\\UniShell',
      'C:\\Windows\\System32',
    ]) {
      const paths = resolveConfigPaths(windowsOptions({ argv: ['app', `--config-dir=${dir}`] }));
      const cli = paths.candidates.find((candidate) => candidate.source === 'cli');
      expect(cli?.readable, `${dir} 应可读取`).toBe(true);
      expect(cli?.writable, `${dir} 不应可写`).toBe(false);
      expect(paths.writeSource).toBe('user-config');
    }
  });

  it('主路径只读时回退到用户配置目录并给出原因', () => {
    const paths = resolveConfigPaths(
      windowsOptions({
        argv: ['app', '--config-dir=D:\\ReadOnly'],
        probeWritable: (directory) => directory !== 'D:\\ReadOnly',
      }),
    );

    expect(paths.writable).toBe(false);
    expect(paths.source).toBe('cli');
    expect(paths.writeDirectory).toBe('C:\\Users\\tester\\AppData\\Roaming\\UniShell');
    expect(paths.writeFallbackReason).toContain('D:\\ReadOnly');
  });

  it('备份路径与损坏文件前缀位于写入目录', () => {
    const paths = resolveConfigPaths(windowsOptions());

    expect(paths.backupPath).toBe('C:\\Users\\tester\\AppData\\Roaming\\UniShell\\' + CONFIG_BACKUP_FILE_NAME);
    // 隔离前缀是绝对路径，存储层无需再知道平台路径规则。
    expect(paths.invalidFilePrefix).toBe(
      'C:\\Users\\tester\\AppData\\Roaming\\UniShell\\config.json.invalid.',
    );
  });
});

describe('loadConfig', () => {
  const basePaths = () =>
    resolveConfigPaths(
      windowsOptions({ argv: ['app', '--config-dir=D:\\Config'] }),
    );

  it('文件不存在时返回 missing', async () => {
    const memory = createMemoryFs();
    const result = await loadConfig({ paths: basePaths(), fs: memory.fs });

    expect(result.status).toBe('missing');
    expect(result.path).toBe('D:\\Config\\config.json');
  });

  it('读取并迁移有效配置', async () => {
    const memory = createMemoryFs({
      'D:\\Config\\config.json': JSON.stringify({ targetUrl: 'https://example.com' }),
    });

    const result = await loadConfig({ paths: basePaths(), fs: memory.fs });

    expect(result.status).toBe('loaded');
    expect(result.config?.targetUrl).toBe('https://example.com');
    expect(result.config?.network.retryIntervalSec).toBe(3);
    expect(result.config?.schemaVersion).toBe(1);
  });

  it('未知字段被保留，不因多余字段失败', async () => {
    const memory = createMemoryFs({
      'D:\\Config\\config.json': JSON.stringify({ targetUrl: 'https://example.com', vendor: { a: 1 } }),
    });

    const result = await loadConfig({ paths: basePaths(), fs: memory.fs });

    expect(result.status).toBe('loaded');
    expect(result.config?.vendor).toEqual({ a: 1 });
  });

  it('JSON 语法错误时隔离为 config.json.invalid.<时间戳>', async () => {
    const memory = createMemoryFs({ 'D:\\Config\\config.json': '{ not json' });
    const now = () => new Date('2026-10-28T10:00:00.000Z');

    const result = await loadConfig({ paths: basePaths(), fs: memory.fs, now });

    expect(result.status).toBe('invalid');
    expect(result.quarantinedAs).toBe('D:\\Config\\config.json.invalid.2026-10-28T10-00-00-000Z');
    expect(memory.files.has('D:\\Config\\config.json.invalid.2026-10-28T10-00-00-000Z')).toBe(true);
    expect(memory.files.has('D:\\Config\\config.json')).toBe(false);
  });
  it('字段非法时给出字段级 issues 并隔离原文件', async () => {
    const memory = createMemoryFs({
      'D:\\Config\\config.json': JSON.stringify({ targetUrl: 'ftp://example.com' }),
    });

    const result = await loadConfig({ paths: basePaths(), fs: memory.fs });

    expect(result.status).toBe('invalid');
    expect(result.issues?.some((issue) => issue.path === 'targetUrl')).toBe(true);
    expect(result.quarantinedAs).toContain('config.json.invalid.');
  });

  it('schemaVersion 高于当前版本时报告可操作错误', async () => {
    const memory = createMemoryFs({
      'D:\\Config\\config.json': JSON.stringify({ ...createDefaultConfig('https://a.b'), schemaVersion: 99 }),
    });

    const result = await loadConfig({ paths: basePaths(), fs: memory.fs });

    expect(result.status).toBe('invalid');
    expect(result.issues?.[0]?.path).toBe('schemaVersion');
    expect(result.issues?.[0]?.message).toContain('升级客户端');
  });

  it('读取失败但不是 ENOENT 时返回 invalid 并说明原因', async () => {
    const memory = createMemoryFs();
    memory.fail('D:\\Config\\config.json', 'EACCES');

    const result = await loadConfig({ paths: basePaths(), fs: memory.fs });

    expect(result.status).toBe('invalid');
    expect(result.reason).toContain('无法读取配置文件');
  });
});

describe('saveConfig', () => {
  const basePaths = () =>
    resolveConfigPaths(
      windowsOptions({ argv: ['app', '--config-dir=D:\\Config'] }),
    );

  const config = () => createDefaultConfig('https://example.com');

  it('写入前先校验，非法配置不落盘', async () => {
    const memory = createMemoryFs();
    const invalid = { ...config(), targetUrl: 'ftp://example.com' } as ReturnType<typeof config>;

    await expect(saveConfig(invalid, { paths: basePaths(), fs: memory.fs })).rejects.toThrow();
    expect(memory.operations.some((operation) => operation.startsWith('write:'))).toBe(false);
  });

  it('通过临时文件加原子替换写入', async () => {
    const memory = createMemoryFs();
    const paths = basePaths();

    await saveConfig(config(), { paths, fs: memory.fs, now: () => new Date('2026-10-28T10:00:00.000Z') });

    const target = 'D:\\Config\\config.json';
    expect(memory.files.get(target)).toContain('"targetUrl": "https://example.com"');

    const writes = memory.operations.filter((operation) => operation.startsWith('write:'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/config\.json\.tmp-\d+-2026-10-28T10-00-00-000Z$/);

    // 临时文件必须被改名而不是留下。
    expect(memory.operations.some((operation) => operation === `rename:${writes[0].slice('write:'.length)}->${target}`)).toBe(
      true,
    );
    expect(memory.operations.some((operation) => operation.includes('.tmp-'))).toBe(true);
    expect([...memory.files.keys()].some((path) => path.includes('.tmp-'))).toBe(false);
  });

  it('写入前确保目录存在', async () => {
    const memory = createMemoryFs();
    await saveConfig(config(), { paths: basePaths(), fs: memory.fs });

    expect(memory.operations[0]).toBe('mkdir:D:\\Config');
  });

  it('保留最近一次有效配置的 .bak 备份', async () => {
    const previous = JSON.stringify(createDefaultConfig('https://previous.example.com'));
    const memory = createMemoryFs({ 'D:\\Config\\config.json': previous });
    const paths = basePaths();

    await saveConfig(config(), { paths, fs: memory.fs });

    expect(memory.files.get('D:\\Config\\config.json.bak')).toBe(previous);
    expect(memory.files.get('D:\\Config\\config.json')).toContain('"https://example.com"');
  });

  it('旧配置损坏时不覆盖 .bak', async () => {
    const memory = createMemoryFs({ 'D:\\Config\\config.json': '{ broken' });
    const paths = basePaths();

    await saveConfig(config(), { paths, fs: memory.fs });

    expect(memory.files.get('D:\\Config\\config.json.bak')).toBe('{ broken');
  });

  it('已存在 .bak 时被新备份替换', async () => {
    const older = JSON.stringify(createDefaultConfig('https://older.example.com'));
    const previous = JSON.stringify(createDefaultConfig('https://previous.example.com'));
    const memory = createMemoryFs({
      'D:\\Config\\config.json': previous,
      'D:\\Config\\config.json.bak': older,
    });

    await saveConfig(config(), { paths: basePaths(), fs: memory.fs });

    expect(memory.files.get('D:\\Config\\config.json.bak')).toBe(previous);
  });

  it('写入到 writePath 而非只读的主路径', async () => {
    const paths = resolveConfigPaths(
      windowsOptions({
        argv: ['app', '--config-dir=D:\\ReadOnly'],
        probeWritable: (directory) => directory !== 'D:\\ReadOnly',
      }),
    );
    const memory = createMemoryFs();

    await saveConfig(config(), { paths, fs: memory.fs });

    expect(memory.files.has('D:\\ReadOnly\\config.json')).toBe(false);
    expect(memory.files.has('C:\\Users\\tester\\AppData\\Roaming\\UniShell\\config.json')).toBe(true);
  });

  it('EACCES 时给出可操作的权限错误', async () => {
    const memory = createMemoryFs();
    memory.fail('D:\\Config\\config.json.tmp-', 'EACCES');

    await expect(saveConfig(config(), { paths: basePaths(), fs: memory.fs })).rejects.toThrow(ConfigWriteError);
  });

  it('EROFS 时提示改用 --config-dir', async () => {
    const paths = resolveConfigPaths(linuxOptions({ argv: ['app', '--config-dir=/mnt/ro'] }));
    const memory = createMemoryFs();
    memory.fail('/mnt/ro/config.json.tmp-', 'EROFS');

    await expect(saveConfig(config(), { paths, fs: memory.fs })).rejects.toThrow(/--config-dir/);
  });

  it('临时文件写入失败时清理临时文件', async () => {
    const memory = createMemoryFs();
    const target = 'D:\\Config\\config.json';
    memory.fail(`${target}.tmp-`, 'ENOSPC');

    await expect(saveConfig(config(), { paths: basePaths(), fs: memory.fs })).rejects.toThrow(/磁盘空间不足/);
    expect(memory.operations.some((operation) => operation.startsWith('unlink:'))).toBe(true);
    expect(memory.files.has(target)).toBe(false);
  });

  it('目录创建失败时抛出 ConfigWriteError', async () => {
    const memory = createMemoryFs();
    memory.fail('D:\\Config', 'EACCES');

    await expect(saveConfig(config(), { paths: basePaths(), fs: memory.fs })).rejects.toThrow(ConfigWriteError);
  });
});

describe('往返一致性', () => {
  it('保存后再读取得到等价配置', async () => {
    const paths = resolveConfigPaths(windowsOptions({ argv: ['app', '--config-dir=D:\\Config'] }));
    const memory = createMemoryFs();
    const original = migrateConfig({
      targetUrl: 'https://example.com',
      window: { mode: 'kiosk', alwaysOnTop: true, alwaysOnTopLevel: 'floating' },
      network: { proxyMode: 'fixed', proxyServer: 'http://proxy:3128' },
      startup: { delaySec: 30, delayOnlyOnLogin: true },
    });

    await saveConfig(original, { paths, fs: memory.fs });
    const loaded = await loadConfig({ paths, fs: memory.fs });

    expect(loaded.status).toBe('loaded');
    expect(loaded.config).toEqual(original);
  });

  it('连续保存两次后 .bak 保存的是上一次配置', async () => {
    const paths = resolveConfigPaths(windowsOptions({ argv: ['app', '--config-dir=D:\\Config'] }));
    const memory = createMemoryFs();

    await saveConfig(createDefaultConfig('https://first.example.com'), { paths, fs: memory.fs });
    await saveConfig(createDefaultConfig('https://second.example.com'), { paths, fs: memory.fs });

    expect(memory.files.get('D:\\Config\\config.json.bak')).toContain('https://first.example.com');
    expect(memory.files.get('D:\\Config\\config.json')).toContain('https://second.example.com');
  });
});
