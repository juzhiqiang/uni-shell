/**
 * 跨平台日志、诊断与脱敏。
 *
 * 规则来源：规格 v2.1 §12（平台日志目录、必记内容、默认保留 14 天）、
 * §11（代理密码、Cookie、Token 与业务敏感值不得进入日志）
 * 与 `rules/security.md`「配置和日志」。
 *
 * 本模块是纯逻辑：文件系统、时间源、平台与主目录全部可注入，
 * 不导入 Electron，因此可在纯 Node 环境下完整测试。
 * 真实运行时的目录来自平台解析，写入经 `nodeLogFileSystem` 落到磁盘。
 *
 * 设计要点：
 * - 目录按目标平台解析（`path.win32` / `path.posix`），与 config-paths 一致，
 *   避免在 Linux 上测试 Windows 路径时被当成相对路径；
 * - 每条记录一行 JSON，自带版本与平台上下文，单行即可还原现场环境；
 * - 脱敏在写入前统一执行，调用方无法绕过；
 * - 写入先进入内存缓冲，按 200 ms 或累计 50 条批量刷新到长驻追加流，跨自然日轮换
 *   写入口；`flush()` 同步摘缓冲后再把写入链入串行队列，顺序由队列保证；
 * - `close()` 刷新全部挂起写入并等待流 `finish`，供退出流程 await；
 * - 注入面未提供 `openAppendStream` 时回退为按批 `appendFile`（即写即走）；
 * - 初始化、打开写入口、单批写入或流出错一律降级为静默丢弃，绝不抛给调用方。
 */

import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

import type { LogLevel } from '../config/config-types';
import { APP_DIR_NAME, type NodePlatform } from '../platform/config-paths';

/** 默认日志级别；配置 `logging.level` 缺省值同为 info（规格 §12）。 */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** 默认保留天数（规格 §12）。 */
export const DEFAULT_RETENTION_DAYS = 14;

/** 日志文件名前缀；按天滚动为 `<prefix>-YYYY-MM-DD.log`。 */
export const LOG_FILE_PREFIX = 'uni-shell';

/** 批量刷新间隔（ms）；刷新定时器 unref，不阻止进程退出。 */
export const LOG_FLUSH_INTERVAL_MS = 200;

/** 单批最大条数；达到即刷新，不等定时器。 */
export const LOG_FLUSH_MAX_LINES = 50;

/** 脱敏占位符。 */
const REDACTED = '[REDACTED]';

/** 循环引用占位符。 */
const CIRCULAR = '[Circular]';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * 结构化日志契约。
 *
 * `close()` 供退出流程刷新挂起写入（规格 §4 的关闭流程）；
 * `debug` 为可选项：配置允许 debug 级别时由实现提供，调用方按可选方法调用。
 */
export interface Logger {
  info(event: string, data?: unknown): void;
  warn(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
  debug?(event: string, data?: unknown): void;
  /** 刷新挂起写入并释放资源；关闭后不再接受新事件。幂等，不会 reject。 */
  close(): Promise<void>;
}

/**
 * 追加写入口；由 `fs.createWriteStream(path, { flags: 'a' })` 适配而来。
 *
 * `write` 不得同步抛出（错误经 `onError` 异步上报）；`end()` 返回的 Promise 在流
 * `finish` 后 resolve、出错后 reject，重复调用返回同一个 Promise。
 */
export interface LogStream {
  write(chunk: string): void;
  end(): Promise<void>;
  onError(listener: (error: unknown) => void): void;
}

/** 日志文件系统能力；测试注入内存实现。 */
export interface LogFileSystem {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  /**
   * 打开（必要时创建）追加写入口。未提供时写入方回退为按批 `appendFile`：
   * 即写即走、不做定时批量，供未实现流的注入面使用。
   */
  openAppendStream?(path: string): LogStream;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
}

/** 缓冲条目；保留事件名，整批失败时用于归属上报。 */
interface LogEntry {
  event: string;
  line: string;
}

/** 写入出口：流式（批量、跨天轮换）或 appendFile 回写；`LogStream` 结构上满足它。 */
interface LogSink {
  write(chunk: string): void | Promise<void>;
  end(): Promise<void>;
}

/** 默认实现，直接使用 Node fs。 */
export const nodeLogFileSystem: LogFileSystem = {
  // `fs.mkdir` 在 recursive 模式下返回首个被创建的目录路径，这里归一化为 void。
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  appendFile: (path, data) => appendFile(path, data),
  openAppendStream: (path) => openNodeAppendStream(path),
  readdir: (path) => readdir(path),
  unlink: (path) => unlink(path),
};

/** 把 Node 追加写流适配成 `LogStream`：错误有监听、finish 可等待、重复 end 安全。 */
function openNodeAppendStream(path: string): LogStream {
  const stream = createWriteStream(path, { flags: 'a' });
  let failed = false;
  let errorListener: ((error: unknown) => void) | undefined;
  let ended: Promise<void> | undefined;

  // 没有监听者的 error 事件会升级为未捕获异常，必须先挂上。
  stream.on('error', (error: unknown) => {
    failed = true;
    errorListener?.(error);
  });

  return {
    write(chunk: string) {
      // 失败或已结束之后的写入静默丢弃：背压由 Node 内部缓冲，日志量级可忽略。
      if (failed || ended !== undefined) return;
      stream.write(chunk);
    },
    end(): Promise<void> {
      ended ??= failed
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            stream.on('finish', resolve);
            stream.on('error', reject);
            stream.end();
          });
      return ended;
    },
    onError(listener: (error: unknown) => void) {
      errorListener = listener;
    },
  };
}

export interface ResolveLogDirectoryOptions {
  platform: NodePlatform;
  /** 进程环境变量，至少读取 `APPDATA`、`XDG_STATE_HOME`。 */
  env?: Record<string, string | undefined>;
  /** 用户主目录，默认取 `os.homedir()`。 */
  homeDir?: string;
}

/**
 * 按规格 §12 解析日志目录：
 * Windows `%APPDATA%\UniShell\logs`、macOS `~/Library/Logs/UniShell`、
 * Linux `$XDG_STATE_HOME/uni-shell/logs`（未设置时 `~/.local/state/uni-shell/logs`）。
 *
 * 与配置目录不同，日志目录不支持便携旁置：标准安装与便携包都写用户目录，
 * 避免向安装目录或 AppImage 挂载点写入。
 */
export function resolveLogDirectory(options: ResolveLogDirectoryOptions): string {
  const { platform } = options;
  const env = options.env ?? {};
  const homeDir = options.homeDir?.trim() ? options.homeDir : homedir();
  const pathApi = platform === 'win32' ? win32 : posix;

  if (platform === 'win32') {
    const appData = env.APPDATA?.trim();
    const base = appData ? appData : pathApi.join(homeDir, 'AppData', 'Roaming');
    return pathApi.join(base, APP_DIR_NAME, 'logs');
  }

  if (platform === 'darwin') {
    return pathApi.join(homeDir, 'Library', 'Logs', APP_DIR_NAME);
  }

  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  const base = xdgStateHome && xdgStateHome.startsWith('/') ? xdgStateHome : pathApi.join(homeDir, '.local', 'state');
  return pathApi.join(base, 'uni-shell', 'logs');
}

/** 生成指定日期的日志文件名（本地时间自然日）。 */
export function logFileNameFor(date: Date, prefix: string = LOG_FILE_PREFIX): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${prefix}-${year}-${month}-${day}.log`;
}

const LOG_FILE_PATTERN = /^(?<prefix>.+)-(?<date>\d{4}-\d{2}-\d{2})\.log$/;

/**
 * 从日志文件名解析日期；不匹配命名规则或日期非法（如 2 月 31 日）时返回 null。
 * 只管理本应用自己生成的文件名，其余文件一律不触碰。
 */
export function parseLogFileDate(fileName: string, prefix: string = LOG_FILE_PREFIX): Date | null {
  const match = LOG_FILE_PATTERN.exec(fileName);
  if (match?.groups === undefined) return null;
  if (match.groups.prefix !== prefix) return null;

  const [year, month, day] = match.groups.date.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  // Date 会把 2026-02-31 归一化成 3 月 3 日，逐项比对可识别非法日期。
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function normalizeRetentionDays(retentionDays: number | undefined): number {
  if (retentionDays === undefined) return DEFAULT_RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays < 1) return DEFAULT_RETENTION_DAYS;
  return Math.floor(retentionDays);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export interface PruneLogsOptions {
  directory: string;
  /** 保留天数；缺省 14（规格 §12）。 */
  retentionDays?: number;
  fs?: LogFileSystem;
  now?: () => Date;
  prefix?: string;
}

/**
 * 删除早于保留期的日志文件，返回被删除的文件名。
 *
 * 只处理符合 `<prefix>-YYYY-MM-DD.log` 命名规则的文件；目录不存在或不可读时
 * 静默返回空列表——清理失败不能影响启动。
 */
export async function pruneExpiredLogs(options: PruneLogsOptions): Promise<string[]> {
  const fs = options.fs ?? nodeLogFileSystem;
  const now = options.now ?? (() => new Date());
  const prefix = options.prefix ?? LOG_FILE_PREFIX;
  const retentionDays = normalizeRetentionDays(options.retentionDays);

  const cutoff = startOfDay(now());
  cutoff.setDate(cutoff.getDate() - retentionDays);

  let entries: string[];
  try {
    entries = await fs.readdir(options.directory);
  } catch {
    return [];
  }

  const deleted: string[] = [];
  for (const entry of entries) {
    const fileDate = parseLogFileDate(entry, prefix);
    if (fileDate === null || fileDate.getTime() >= cutoff.getTime()) continue;
    try {
      await fs.unlink(`${options.directory.replace(/\/$/, '')}/${entry}`);
      deleted.push(entry);
    } catch {
      // 单个文件删除失败不影响其他文件与主流程。
    }
  }
  return deleted;
}

/** 命中即脱敏的字段名片段（归一化后子串匹配）。 */
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'cookie',
  'credential',
  'authorization',
  'apikey',
  'privatekey',
  'accesskey',
  'secretkey',
  'sessionid',
];

/** 查询串中需要脱敏的参数名片段。 */
const SENSITIVE_QUERY_PARAM =
  /([?&])([a-z0-9_]*(?:password|passwd|pwd|token|secret|cookie|credential|apikey|api_key|access_key|signature|sig)[a-z0-9_]*)=([^&\s#]*)/gi;

/** URL 用户凭据：`scheme://user:pass@host` → `scheme://[REDACTED]@host`。 */
const URL_CREDENTIALS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 字段名是否敏感；大小写、连字符与下划线不敏感。 */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized.length === 0) return false;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactString(value: string): string {
  return value.replace(URL_CREDENTIALS, `$1${REDACTED}@`).replace(SENSITIVE_QUERY_PARAM, `$1$2=${REDACTED}`);
}

/**
 * 递归脱敏：敏感字段的值整体替换，字符串剥离 URL 凭据与敏感查询参数，
 * Error 归一化为名称与消息。循环引用被截断，不会栈溢出。
 */
export function redactSensitiveData(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactSensitiveData(item, seen);
  }
  return result;
}

/**
 * 安全序列化：bigint 转字符串、循环引用截断，
 * 保证任何调用方数据都不会让写日志失败。
 */
function serialize(line: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(line, (_key, current: unknown) => {
    if (typeof current === 'bigint') return current.toString();
    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) return CIRCULAR;
      seen.add(current);
    }
    return current;
  });
}

/** 随每条记录写入的版本与平台上下文（规格 §12 的必记内容）。 */
export interface LoggerContext {
  /** 客户端版本，通常取 `app.getVersion()`。 */
  appVersion: string;
  /** Electron 版本。 */
  electronVersion: string;
  /** 进程架构，通常取 `process.arch`。 */
  arch: string;
  /** Linux 桌面环境（GNOME、KDE 等）；非 Linux 可缺省。 */
  desktopEnvironment?: string;
  /** Linux 显示服务器会话类型（x11、wayland）；非 Linux 可缺省。 */
  sessionType?: string;
}

export interface LoggerOptions {
  platform: NodePlatform;
  context: LoggerContext;
  /** 日志目录；缺省按平台解析（规格 §12）。 */
  directory?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** 日志级别，低于该级别的事件不写入；默认 info。 */
  level?: LogLevel;
  /** 保留天数，默认 14（规格 §12）。 */
  retentionDays?: number;
  /** 日志文件名前缀，默认 `uni-shell`。 */
  filePrefix?: string;
  fs?: LogFileSystem;
  now?: () => Date;
  /** 打开时是否清理过期日志；默认 true。 */
  pruneOnOpen?: boolean;
  /** 初始化、打开写入口、单批写入或流出错时的出口；用于在控制台等处留下最后线索。 */
  onError?: (error: unknown, event: string) => void;
}

/**
 * 创建文件日志器。
 *
 * 初始化（建目录 + 清理过期日志）在后台进行；写入先进入内存缓冲，按 200 ms 或累计
 * 50 条批量刷新到长驻追加流，跨自然日轮换写入口。注入面未提供 `openAppendStream`
 * 时回退为按批 `appendFile`（即写即走）。初始化失败（如目录不可创建）、打开写入口
 * 失败、单批写入失败或流出错时降级为静默丢弃——记录日志失败绝不能影响主流程。
 */
export function createLogger(options: LoggerOptions): Logger {
  const fs = options.fs ?? nodeLogFileSystem;
  const now = options.now ?? (() => new Date());
  const prefix = options.filePrefix?.trim() ? options.filePrefix.trim() : LOG_FILE_PREFIX;
  const directory = options.directory?.trim()
    ? options.directory
    : resolveLogDirectory({ platform: options.platform, env: options.env, homeDir: options.homeDir });
  const pathApi = options.platform === 'win32' ? win32 : posix;
  const minOrder = LEVEL_ORDER[options.level ?? DEFAULT_LOG_LEVEL] ?? LEVEL_ORDER[DEFAULT_LOG_LEVEL];
  const pruneOnOpen = options.pruneOnOpen ?? true;
  const openStream = fs.openAppendStream?.bind(fs);

  let closed = false;
  let unavailable = false;
  let closePromise: Promise<void> | undefined;
  let buffer: LogEntry[] = [];
  let bufferPath: string | undefined;
  let sink: LogSink | undefined;
  let sinkPath: string | undefined;
  let flushChain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const init = (async () => {
    try {
      await fs.mkdir(directory, { recursive: true });
      if (pruneOnOpen) {
        await pruneExpiredLogs({ directory, retentionDays: options.retentionDays, fs, now, prefix });
      }
    } catch (error) {
      unavailable = true;
      options.onError?.(error, 'logger-init');
    }
  })();

  function stopTimer(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  /** 记录日志失败不能影响主流程：丢弃缓冲与挂起写入，只经 onError 留线索。 */
  function degrade(error: unknown, event: string): void {
    if (unavailable) return;
    unavailable = true;
    buffer = [];
    bufferPath = undefined;
    stopTimer();
    options.onError?.(error, event);
  }

  function scheduleFlush(): void {
    if (timer !== undefined || closed || unavailable) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, LOG_FLUSH_INTERVAL_MS);
    // 刷新定时器不得阻止进程退出；正常退出的落盘保证由 close() 提供。
    (timer as { unref?: () => void }).unref?.();
  }

  async function openSink(path: string): Promise<LogSink | undefined> {
    if (openStream === undefined) {
      // 回写路径：注入面未提供追加流，按批 appendFile，即写即走。
      return { write: (chunk) => fs.appendFile(path, chunk), end: async () => undefined };
    }
    try {
      const stream = openStream(path);
      stream.onError((error) => degrade(error, 'logger-stream'));
      return stream;
    } catch (error) {
      degrade(error, 'logger-stream');
      return undefined;
    }
  }

  async function endSink(): Promise<void> {
    const current = sink;
    sink = undefined;
    sinkPath = undefined;
    if (current === undefined) return;
    try {
      await current.end();
    } catch (error) {
      degrade(error, 'logger-stream');
    }
  }

  async function writeEntries(entries: LogEntry[], target: string): Promise<void> {
    if (unavailable) return;
    try {
      if (sink === undefined || sinkPath !== target) {
        // 首写或跨自然日：先结束旧写入口，再打开目标日期的入口。
        await endSink();
        const opened = await openSink(target);
        if (opened === undefined) return;
        sink = opened;
        sinkPath = target;
      }
      await sink.write(entries.map((entry) => entry.line).join(''));
    } catch (error) {
      // 整批失败：丢弃本批并降级，不抛给调用方。
      degrade(error, entries[0].event);
    }
  }

  /** 同步摘下当前缓冲，再把写入链入串行队列；顺序由队列保证。 */
  function flush(): Promise<void> {
    const entries = buffer;
    const target = bufferPath;
    buffer = [];
    bufferPath = undefined;
    if (entries.length === 0 || target === undefined || unavailable) return flushChain;

    flushChain = flushChain.then(() => writeEntries(entries, target));
    return flushChain;
  }

  function enqueue(event: string, level: LogLevel, data: unknown): void {
    if (closed || unavailable) return;
    if (LEVEL_ORDER[level] < minOrder) return;

    const timestamp = now();
    const line = `${serialize({
      time: timestamp.toISOString(),
      level,
      event,
      data: redactSensitiveData(data),
      app: {
        version: options.context.appVersion,
        electron: options.context.electronVersion,
        platform: options.platform,
        arch: options.context.arch,
        ...(options.context.desktopEnvironment ? { desktopEnvironment: options.context.desktopEnvironment } : {}),
        ...(options.context.sessionType ? { sessionType: options.context.sessionType } : {}),
      },
    })}\n`;
    const path = pathApi.join(directory, logFileNameFor(timestamp, prefix));

    // 跨自然日：先把上一天的缓冲整体刷出，保证一批缓冲不跨天混装。
    if (bufferPath !== undefined && bufferPath !== path) void flush();

    buffer.push({ event, line });
    bufferPath = path;

    // 回写路径即写即走；流式路径按批量阈值或定时器刷新。
    if (openStream === undefined) {
      void flush();
      return;
    }
    if (buffer.length >= LOG_FLUSH_MAX_LINES) {
      void flush();
      return;
    }
    scheduleFlush();
  }

  return {
    info: (event, data) => enqueue(event, 'info', data),
    warn: (event, data) => enqueue(event, 'warn', data),
    error: (event, data) => enqueue(event, 'error', data),
    debug: (event, data) => enqueue(event, 'debug', data),
    close(): Promise<void> {
      closed = true;
      stopTimer();
      closePromise ??= (async () => {
        try {
          await init;
          await flush();
          await endSink();
        } catch {
          // close 永不 reject：退出流程不应被日志写入失败拖倒。
        }
      })();
      return closePromise;
    },
  };
}
