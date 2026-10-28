/**
 * 跨平台配置路径解析。
 *
 * 规则来源：规格 v2.1 §5.1（解析优先级）、§5.2（预置配置交付规则）
 * 与 `rules/platform.md`「路径与配置」。
 *
 * 该模块是纯函数，不导入 Electron：三条路径优先级都能在单元测试里逐平台注入验证。
 * 真实运行时的 `app.getPath()` 等 Electron 取值由调用方注入，避免平台实现反向拖累可测试性。
 *
 * 注意：所有路径运算都按「目标平台」而不是「宿主机」选择 `path.win32` / `path.posix`。
 * 否则在 Linux 上测试 Windows 路径时，`path.resolve` 会把 `D:\Dir` 当成相对路径拼到 cwd 前面。
 * 在对应平台上运行时两者等价，因此这不改变真实行为，只让解析结果可预测、可跨平台测试。
 */

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** 配置文件名固定为 config.json（规格 §5.1）。 */
export const CONFIG_FILE_NAME = 'config.json';

/** 最近一次有效配置的备份文件名。 */
export const CONFIG_BACKUP_FILE_NAME = 'config.json.bak';

/** 应用名，用于拼装各平台用户配置目录。 */
export const APP_DIR_NAME = 'UniShell';

export type ConfigPathSource =
  | 'cli'
  | 'env'
  | 'portable-windows'
  | 'portable-appimage'
  | 'portable-mac-zip'
  | 'user-config';

export type NodePlatform = 'win32' | 'darwin' | 'linux';

export interface ResolveConfigPathsOptions {
  platform: NodePlatform;
  /** `process.argv` 原始参数，用于解析 `--config-dir=<目录>`。 */
  argv?: readonly string[];
  /** 进程环境变量，至少读取 `UNI_SHELL_CONFIG_DIR`、`APPDATA`、`XDG_CONFIG_HOME`、`APPIMAGE`。 */
  env?: Record<string, string | undefined>;
  /** 可执行文件绝对路径，用于 Windows 便携路径（可执行文件同级目录）。 */
  executablePath?: string;
  /** 便携包内的 `.app` bundle 绝对路径，用于 macOS ZIP 旁置配置。 */
  macAppBundlePath?: string;
  /** 用户主目录，默认取 `os.homedir()`。 */
  homeDir?: string;
  /**
   * 可写性探测。默认只判断「是否受保护目录」；
   * 传入实际探测函数后可识别只读文件系统、权限不足等真实情况。
   */
  probeWritable?: (directory: string) => boolean;
}

export interface ConfigPathCandidate {
  source: ConfigPathSource;
  directory: string;
  /** 该候选是否可用于读取。 */
  readable: boolean;
  /** 该候选是否可用于写入；受保护目录一律为 false。 */
  writable: boolean;
  /** 不可读或不可写的原因，供配置界面展示。 */
  reason?: string;
}

export interface ResolvedConfigPaths {
  /** 实际读取的 config.json 绝对路径。 */
  configPath: string;
  /** 实际读取的目录。 */
  directory: string;
  source: ConfigPathSource;
  /** 按优先级排列的全部候选，便于配置界面展示解析过程。 */
  candidates: ConfigPathCandidate[];
  /** 主路径是否可写。 */
  writable: boolean;
  /** 实际用于写入的目录：主路径可写时即主路径，否则回退到用户配置目录。 */
  writeDirectory: string;
  /** 实际用于写入的 config.json 绝对路径。 */
  writePath: string;
  writeSource: ConfigPathSource;
  /** 回退原因；未回退时为 undefined。 */
  writeFallbackReason?: string;
  /** 最近一次有效配置的备份路径。 */
  backupPath: string;
  /** 损坏配置的隔离文件名绝对前缀，实际文件为 `<prefix><时间戳>`。 */
  invalidFilePrefix: string;
}

const CLI_FLAG = '--config-dir';

type PathApi = typeof posix;

function pathApiFor(platform: NodePlatform): PathApi {
  return platform === 'win32' ? win32 : posix;
}

/** 从 argv 中提取 `--config-dir=<目录>` 或 `--config-dir <目录>`。 */
export function parseConfigDirArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') continue;

    if (arg === CLI_FLAG) {
      const next = argv[index + 1];
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return next;
      continue;
    }

    const prefix = `${CLI_FLAG}=`;
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * 「根本不是配置位置」的目录：macOS `.app` bundle 内部与 AppImage 运行时挂载目录。
 * 这些位置既不读取也不写入。
 */
function isNonConfigLocation(platform: NodePlatform, directory: string): boolean {
  const normalized = pathApiFor(platform).resolve(directory);

  if (platform === 'darwin') {
    return /\.app(\/|$)/.test(normalized);
  }

  if (platform === 'linux') {
    // AppImage 运行时把自身挂载到 /tmp/.mount_*，是临时挂载点。
    return normalized.startsWith('/tmp/.mount');
  }

  return false;
}

/**
 * 系统安装/受保护目录。
 * 这些位置**可以读取**旁置配置（规格 §5.2：NSIS 安装目录、AppImage 同级保留 config.json），
 * 但**不得写入**（规格与 `rules/platform.md`：禁止写入 `/usr`、`/opt`、Windows 受保护目录）。
 */
function isReadOnlyInstallLocation(platform: NodePlatform, directory: string): boolean {
  const normalized = pathApiFor(platform).resolve(directory);

  if (platform === 'linux') {
    return (
      normalized === '/usr' ||
      normalized.startsWith('/usr/') ||
      normalized === '/opt' ||
      normalized.startsWith('/opt/') ||
      normalized === '/etc' ||
      normalized.startsWith('/etc/')
    );
  }

  if (platform === 'win32') {
    return /^[a-zA-Z]:\\(Program Files( \(x86\))?|Windows)(\\|$)/i.test(normalized);
  }

  return false;
}

function userConfigDirectory(
  platform: NodePlatform,
  pathApi: PathApi,
  homeDir: string,
  env: Record<string, string | undefined>,
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim();
    // 规格 §5.1：Windows 用户配置目录为 %APPDATA%\UniShell。
    return appData ? pathApi.join(appData, APP_DIR_NAME) : pathApi.join(homeDir, 'AppData', 'Roaming', APP_DIR_NAME);
  }

  if (platform === 'darwin') {
    // 规格 §5.1：macOS 为 ~/Library/Application Support/UniShell。
    return pathApi.join(homeDir, 'Library', 'Application Support', APP_DIR_NAME);
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  // 规格 §5.1：Linux 优先 $XDG_CONFIG_HOME/uni-shell，未设置时 ~/.config/uni-shell。
  const base = xdgConfigHome && xdgConfigHome.startsWith('/') ? xdgConfigHome : pathApi.join(homeDir, '.config');
  return pathApi.join(base, 'uni-shell');
}

function windowsPortableDirectory(
  pathApi: PathApi,
  executablePath?: string,
): string | undefined {
  if (!executablePath) return undefined;
  // Windows 便携路径：可执行文件同级目录。
  return pathApi.resolve(executablePath, '..');
}

function appImagePortableDirectory(pathApi: PathApi, env: Record<string, string | undefined>): string | undefined {
  const appImage = env.APPIMAGE?.trim();
  if (!appImage) return undefined;
  // `$APPIMAGE` 指向用户磁盘上的 AppImage 文件本身，其同级目录才是便携目录；
  // 运行时的挂载目录由 isProtectedDirectory 另行拦截。
  return pathApi.resolve(appImage, '..');
}

function macZipPortableDirectory(pathApi: PathApi, macAppBundlePath?: string): string | undefined {
  if (!macAppBundlePath) return undefined;
  // 规格 §5.2：macOS ZIP 的 config.json 与 .app 同级，且该目录可写时才读取。
  return pathApi.resolve(macAppBundlePath, '..');
}

function buildCandidate(
  source: ConfigPathSource,
  platform: NodePlatform,
  directory: string | undefined,
  note: string | undefined,
  probeWritable: ((directory: string) => boolean) | undefined,
): ConfigPathCandidate | undefined {
  if (!directory) return undefined;

  if (isNonConfigLocation(platform, directory)) {
    return {
      source,
      directory,
      readable: false,
      writable: false,
      reason: `${directory} 不是有效的配置位置（${note ?? 'bundle 内部或运行时挂载点'}），不读取也不写入`,
    };
  }

  if (isReadOnlyInstallLocation(platform, directory)) {
    return {
      source,
      directory,
      // 可读取旁置配置，但不得写入。
      readable: true,
      writable: false,
      reason: `${directory} 是系统安装/受保护目录，可读取旁置配置但不得写入`,
    };
  }

  // 未提供探测函数时保守地按可写处理，由写入阶段的真实错误兜底。
  const writable = probeWritable ? probeWritable(directory) : true;
  return {
    source,
    directory,
    readable: true,
    writable,
    reason: writable ? undefined : `${directory} 不可写（只读或权限不足）`,
  };
}

/**
 * 按规格 §5.1 的优先级解析配置路径。
 *
 * 1. `--config-dir=<目录>`
 * 2. `UNI_SHELL_CONFIG_DIR`
 * 3. Windows 可执行文件同级目录
 * 4. Linux AppImage `$APPIMAGE` 同级目录
 * 5. macOS ZIP `.app` 同级目录
 * 6. 平台用户配置目录
 */
export function resolveConfigPaths(options: ResolveConfigPathsOptions): ResolvedConfigPaths {
  const { platform } = options;
  const env = options.env ?? {};
  const pathApi = pathApiFor(platform);
  const homeDir = options.homeDir?.trim() ? options.homeDir : homedir();
  const probeWritable = options.probeWritable;

  const userDir = userConfigDirectory(platform, pathApi, homeDir, env);

  const portable: ConfigPathCandidate[] = [];
  if (platform === 'win32') {
    const candidate = buildCandidate(
      'portable-windows',
      platform,
      windowsPortableDirectory(pathApi, options.executablePath),
      'Windows 安装目录',
      probeWritable,
    );
    if (candidate) portable.push(candidate);
  } else if (platform === 'linux') {
    const candidate = buildCandidate(
      'portable-appimage',
      platform,
      appImagePortableDirectory(pathApi, env),
      'AppImage',
      probeWritable,
    );
    if (candidate) portable.push(candidate);
  } else {
    const candidate = buildCandidate(
      'portable-mac-zip',
      platform,
      macZipPortableDirectory(pathApi, options.macAppBundlePath),
      'macOS .app bundle',
      probeWritable,
    );
    if (candidate) portable.push(candidate);
  }

  const cliDir = parseConfigDirArgv(options.argv ?? []);
  const envDir = env.UNI_SHELL_CONFIG_DIR?.trim();

  const ordered: ConfigPathCandidate[] = [];
  const pushCandidate = (candidate: ConfigPathCandidate | undefined): void => {
    if (candidate) ordered.push(candidate);
  };

  pushCandidate(
    buildCandidate('cli', platform, cliDir ? pathApi.resolve(cliDir) : undefined, '显式目录', probeWritable),
  );
  pushCandidate(
    buildCandidate('env', platform, envDir ? pathApi.resolve(envDir) : undefined, '环境变量目录', probeWritable),
  );
  ordered.push(...portable);
  pushCandidate(buildCandidate('user-config', platform, userDir, '用户配置目录', probeWritable));

  // 用户配置目录是标准安装场景的默认落点，始终作为可写兜底。
  const userCandidate = ordered[ordered.length - 1];
  userCandidate.writable = true;
  userCandidate.readable = true;
  delete userCandidate.reason;

  const primary = ordered.find((candidate) => candidate.readable) ?? userCandidate;
  const writableCandidate = ordered.find((candidate) => candidate.writable) ?? userCandidate;
  const writeFallbackReason =
    writableCandidate.source === primary.source
      ? undefined
      : `主路径 ${primary.directory} 不可写，已回退到 ${writableCandidate.directory}`;

  return {
    configPath: pathApi.join(primary.directory, CONFIG_FILE_NAME),
    directory: primary.directory,
    source: primary.source,
    candidates: ordered,
    writable: primary.writable,
    writeDirectory: writableCandidate.directory,
    writePath: pathApi.join(writableCandidate.directory, CONFIG_FILE_NAME),
    writeSource: writableCandidate.source,
    writeFallbackReason,
    backupPath: pathApi.join(writableCandidate.directory, CONFIG_BACKUP_FILE_NAME),
    // 隔离文件与被打包的源文件同目录，便于现场排查。
    invalidFilePrefix: pathApi.join(primary.directory, `${CONFIG_FILE_NAME}.invalid.`),
  };
}

/** 读取当前进程的真实取值，供主进程入口调用。 */
export function createDefaultResolveOptions(
  overrides: Partial<ResolveConfigPathsOptions> = {},
): ResolveConfigPathsOptions {
  return {
    platform: process.platform as NodePlatform,
    argv: process.argv,
    env: process.env as Record<string, string | undefined>,
    executablePath: process.execPath,
    ...overrides,
  };
}
