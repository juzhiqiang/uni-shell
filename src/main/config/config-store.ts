/**
 * 配置读取与原子持久化。
 *
 * 规则来源：规格 v2.1 §5.2（写入必须临时文件加原子替换并保留备份）、
 * §5.3（读取与校验规则）与 `rules/security.md`「配置和日志」。
 *
 * 文件系统通过 `ConfigFileSystem` 注入，单元测试可在不触碰真实磁盘的前提下
 * 模拟只读目录、写入失败、原子替换顺序和备份行为。
 */

import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

import {
  ConfigValidationError,
  migrateConfig,
  validateConfig,
  type AppConfig,
  type ValidationIssue,
} from './config-schema';
import {
  CONFIG_FILE_NAME,
  type ResolvedConfigPaths,
} from '../platform/config-paths';

export { CONFIG_FILE_NAME };

/** 配置存储需要的最小文件系统能力。 */
export interface ConfigFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  access(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** 默认实现，直接使用 Node fs。 */
export const nodeFileSystem: ConfigFileSystem = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  rename,
  // `fs.mkdir` 在 recursive 模式下会返回首个被创建的目录路径，这里归一化为 void。
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  access,
  unlink,
};

export type ConfigLoadStatus = 'loaded' | 'missing' | 'invalid';

export interface ConfigLoadResult {
  status: ConfigLoadStatus;
  /** 实际读取的路径，供配置界面展示。 */
  path: string;
  source: ResolvedConfigPaths['source'];
  /** `status === 'loaded'` 时的有效配置。 */
  config?: AppConfig;
  /** `status === 'invalid'` 时的字段级问题。 */
  issues?: ValidationIssue[];
  /** `status === 'invalid'` 时损坏文件被隔离到的路径。 */
  quarantinedAs?: string;
  /** 人类可读的失败原因。 */
  reason?: string;
}

export interface LoadConfigOptions {
  paths: ResolvedConfigPaths;
  fs?: ConfigFileSystem;
  /** 时间源，注入以便测试确定性生成时间戳。 */
  now?: () => Date;
}

export interface SaveConfigOptions {
  paths: ResolvedConfigPaths;
  fs?: ConfigFileSystem;
  /** 时间源，注入以便测试确定性生成临时文件名。 */
  now?: () => Date;
}

/** 配置路径不可写或写入失败时抛出，消息必须可操作。 */
export class ConfigWriteError extends Error {
  readonly path: string;
  readonly code?: string;

  constructor(message: string, path: string, code?: string) {
    super(message);
    this.name = 'ConfigWriteError';
    this.path = path;
    this.code = code;
  }
}

function timestamp(now: () => Date): string {
  return now()
    .toISOString()
    .replace(/[:.]/g, '-');
}

function describeWriteFailure(error: unknown, path: string): ConfigWriteError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = error instanceof Error ? error.message : String(error);

  if (code === 'EACCES' || code === 'EPERM') {
    return new ConfigWriteError(
      `没有权限写入配置文件 ${path}。请检查目录权限，或以有写权限的用户身份运行；也可使用 --config-dir 指定其他目录。`,
      path,
      code,
    );
  }
  if (code === 'EROFS') {
    return new ConfigWriteError(
      `配置文件所在文件系统是只读的：${path}。请使用 --config-dir 指定可写目录。`,
      path,
      code,
    );
  }
  if (code === 'EISDIR') {
    return new ConfigWriteError(`配置路径是一个目录而不是文件：${path}`, path, code);
  }
  if (code === 'ENOSPC') {
    return new ConfigWriteError(`磁盘空间不足，无法写入配置文件 ${path}`, path, code);
  }
  return new ConfigWriteError(`写入配置文件失败：${path}（${detail}）`, path, code);
}

async function pathExists(fs: ConfigFileSystem, path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取并校验配置。
 *
 * - 文件不存在 → `missing`（调用方据此打开配置界面）；
 * - JSON 语法错误、字段类型错误或目标网址无效 → `invalid`，
 *   原文件先隔离为 `config.json.invalid.<时间戳>`，不覆盖损坏文件；
 * - 校验通过 → `loaded`，返回迁移并补齐默认值后的配置。
 */
export async function loadConfig(options: LoadConfigOptions): Promise<ConfigLoadResult> {
  const { paths } = options;
  const fs = options.fs ?? nodeFileSystem;
  const now = options.now ?? (() => new Date());
  const { configPath, source } = paths;

  let raw: string;
  try {
    raw = await fs.readFile(configPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return { status: 'missing', path: configPath, source };
    }
    return {
      status: 'invalid',
      path: configPath,
      source,
      reason: `无法读取配置文件 ${configPath}：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const quarantinedAs = await quarantineInvalidFile(fs, paths, configPath, now);
    return {
      status: 'invalid',
      path: configPath,
      source,
      reason: `配置文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      quarantinedAs,
    };
  }

  let config: AppConfig;
  try {
    config = migrateConfig(parsed);
  } catch (error) {
    const quarantined = await quarantineInvalidFile(fs, paths, configPath, now);
    const issues =
      error instanceof ConfigValidationError ? error.issues : [{ path: '', message: String(error), code: 'unknown' }];
    return {
      status: 'invalid',
      path: configPath,
      source,
      issues,
      reason: `配置校验失败：${issues.map((issue) => `${issue.path || '(root)'} ${issue.message}`).join('；')}`,
      quarantinedAs: quarantined,
    };
  }

  // 双保险：迁移已内置校验，这里再跑一次以捕获迁移与校验不一致的情况。
  const verified = validateConfig(config);
  if (!verified.ok) {
    const quarantinedAs = await quarantineInvalidFile(fs, paths, configPath, now);
    return {
      status: 'invalid',
      path: configPath,
      source,
      issues: verified.issues,
      reason: `配置校验失败：${verified.issues.map((issue) => `${issue.path || '(root)'} ${issue.message}`).join('；')}`,
      quarantinedAs,
    };
  }

  return { status: 'loaded', path: configPath, source, config };
}

/** 把损坏的配置文件隔离为 `config.json.invalid.<时间戳>`，失败不影响主流程。 */
async function quarantineInvalidFile(
  fs: ConfigFileSystem,
  paths: ResolvedConfigPaths,
  configPath: string,
  now: () => Date,
): Promise<string | undefined> {
  const target = `${paths.invalidFilePrefix}${timestamp(now)}`;
  try {
    await fs.rename(configPath, target);
    return target;
  } catch {
    return undefined;
  }
}

/**
 * 校验后原子写入配置。
 *
 * 顺序：校验 → 确保目录存在 → 备份上一次有效配置 → 写临时文件 → 原子替换 → 清理临时文件。
 * 任一步失败都抛出 `ConfigWriteError`，且不会留下半截配置。
 */
export async function saveConfig(config: AppConfig, options: SaveConfigOptions): Promise<void> {
  const { paths } = options;
  const fs = options.fs ?? nodeFileSystem;
  const now = options.now ?? (() => new Date());

  const verified = validateConfig(config);
  if (!verified.ok) {
    throw new ConfigValidationError(verified.issues);
  }

  const target = paths.writePath;

  try {
    await fs.mkdir(paths.writeDirectory, { recursive: true });
  } catch (error) {
    throw describeWriteFailure(error, paths.writeDirectory);
  }

  // 保留最近一次有效配置的备份；旧配置损坏时跳过，不覆盖损坏文件。
  if (await pathExists(fs, target)) {
    try {
      await fs.rename(target, paths.backupPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // EXDEV 表示跨设备，此时改用读+写复制；其余错误直接失败。
      if (code !== 'EXDEV') {
        throw describeWriteFailure(error, paths.backupPath);
      }
      try {
        await fs.writeFile(paths.backupPath, await fs.readFile(target));
      } catch (copyError) {
        throw describeWriteFailure(copyError, paths.backupPath);
      }
    }
  }

  const temporary = `${target}.tmp-${process.pid}-${timestamp(now)}`;
  const payload = `${JSON.stringify(verified.value, null, 2)}\n`;

  try {
    await fs.writeFile(temporary, payload);
  } catch (error) {
    await safeUnlink(fs, temporary);
    throw describeWriteFailure(error, target);
  }

  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await safeUnlink(fs, temporary);
    throw describeWriteFailure(error, target);
  }
}

async function safeUnlink(fs: ConfigFileSystem, path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // 临时文件清理失败不影响主流程，交由下次启动或用户清理。
  }
}
