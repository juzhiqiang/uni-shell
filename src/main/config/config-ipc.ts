/**
 * 配置界面 IPC 主进程侧注册与受控保存流程。
 *
 * 规则来源：规格 v2.1.1 §5.1（界面展示实际路径）、§5.2（临时文件加原子替换并保留备份）、
 * §5.3（未保存关闭不得修改原配置）、§5.4（自定义图标）、§14.1（保存、重启和目标页面加载）
 * 与 `rules/security.md`「preload 只暴露显式白名单 IPC」。
 *
 * 通道表与白名单判定复用 `src/preload/config-bridge.ts`（纯模块，不导入 Electron），
 * 主进程只注册表内六个通道，渲染进程只能经 `window.uniShell` 的六个具名方法到达这里。
 *
 * 本模块不直接导入 Electron：`ipcMain`、文件系统、连接测试出口都由调用方注入，
 * 因此可在纯 Node 环境下完整测试。
 */

import type { AppConfig, NetworkConfig } from './config-types';
import { createDefaultConfig, validateConfig, type ValidationIssue } from './config-schema';
import type { ConfigFileSystem, ConfigLoadResult, SaveConfigOptions } from './config-store';
import type { ResolvedConfigPaths } from '../platform/config-paths';
import type { Logger } from '../logging/logger';
import {
  CONFIG_IPC_CHANNELS,
  isConfigIpcChannel,
  type ConfigIpcChannel,
  type ConnectionResult,
  type IconPickResult,
  type SaveResult,
} from '../../shared/ipc-contract';

/** `ipcMain` 的最小读取面；测试注入内存实现。 */
export interface ConfigIpcHost {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>): void;
}

export interface ConfigIpcDeps {
  /** 通道注册宿主；生产环境传 Electron `ipcMain`。 */
  host: ConfigIpcHost;
  /** 当前生效的配置路径；启动流程完成前为 undefined。 */
  paths(): ResolvedConfigPaths | undefined;
  loadConfig(paths: ResolvedConfigPaths): Promise<ConfigLoadResult>;
  saveConfig(config: AppConfig, options: SaveConfigOptions): Promise<void>;
  /** 文件系统；缺省时由 config-store 使用 Node fs。 */
  fs?: ConfigFileSystem;
  /** 时间源，注入以便测试确定性生成备份与临时文件名。 */
  now?: () => Date;
  logger?: Logger;
  /** 写入成功并落盘后调用，用于同步登录项等副作用；失败不阻塞重启。 */
  onSaved?(config: AppConfig, previous: AppConfig | undefined): Promise<void> | void;
  /** 关闭陈旧窗口（配置窗口与主窗口），在重启前调用。 */
  closeStaleWindows?(): void;
  /** 受控重启（relaunch + exit）；仅在写入成功后调用。 */
  restart?(): void;
  /** 连通性测试出口；缺省时使用本文件内置的 fetch 实现。 */
  testConnection?(url: string, network: NetworkConfig): Promise<ConnectionResult>;
  /** 图标选择出口（规格 §5.4）；由主进程用文件对话框 + icon-manager 注入。 */
  pickIcon?(): Promise<IconPickResult>;
}

export interface ConfigIpcRegistration {
  /** 最近一次经主进程加载或保存的配置；尚未加载过时为 undefined。 */
  getLastConfig(): AppConfig | undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path || '(root)'} ${issue.message}`).join('；');
}

/**
 * 首次启动或配置损坏时的空白起点：默认值加空 `targetUrl`。
 *
 * `createDefaultConfig` 要求一个合法网址（否则迁移校验失败），界面拿到的配置
 * 必须先能渲染，因此这里用占位地址生成默认值、再把 `targetUrl` 清空交还用户填写。
 */
function blankConfig(): AppConfig {
  const defaults = createDefaultConfig('http://localhost');
  return { ...defaults, targetUrl: '' };
}

/** 注册六个白名单通道；返回最近一次有效配置的读取入口。 */
export function registerConfigIpc(deps: ConfigIpcDeps): ConfigIpcRegistration {
  let lastConfig: AppConfig | undefined;

  async function handleGetConfig(): Promise<AppConfig> {
    const paths = deps.paths();
    if (paths === undefined) {
      throw new Error('配置路径尚未解析，无法读取配置');
    }

    const result = await deps.loadConfig(paths);
    if (result.status === 'loaded' && result.config !== undefined) {
      lastConfig = result.config;
      return result.config;
    }

    // 规格 §5.3：文件不存在、损坏或字段无效时界面照常打开，只是从空白默认值开始编辑。
    deps.logger?.warn('config-unavailable-for-ui', {
      path: result.path,
      status: result.status,
      reason: result.reason,
    });
    lastConfig = blankConfig();
    return lastConfig;
  }

  async function handleSaveConfig(input: unknown): Promise<SaveResult> {
    const validation = validateConfig(input);
    if (!validation.ok) {
      deps.logger?.warn('config-save-rejected', { issues: validation.issues });
      return { ok: false, message: `配置校验失败：${formatIssues(validation.issues)}` };
    }

    const paths = deps.paths();
    if (paths === undefined) {
      return { ok: false, message: '配置路径尚未解析，无法保存' };
    }

    try {
      await deps.saveConfig(validation.value, { paths, fs: deps.fs, now: deps.now });
    } catch (error) {
      // 规格 §5.2：写入失败不得静默，错误信息必须可操作，且不触达重启流程。
      deps.logger?.error('config-save-failed', { path: paths.writePath, message: describeError(error) });
      return { ok: false, message: describeError(error), configPath: paths.writePath };
    }

    const previous = lastConfig;
    lastConfig = validation.value;
    deps.logger?.info('config-saved', { path: paths.writePath, source: paths.writeSource });

    try {
      await deps.onSaved?.(validation.value, previous);
    } catch (error) {
      // 登录项等副作用失败不阻塞重启，但必须记录，供 Task 9 诊断消费。
      deps.logger?.warn('config-save-side-effects-failed', { message: describeError(error) });
    }

    // 规格 §14.1：写入成功后关闭陈旧窗口并受控重启；失败路径在上面已经返回。
    deps.closeStaleWindows?.();
    deps.restart?.();

    return { ok: true, configPath: paths.writePath, requiresRestart: true };
  }

  async function handleResetConfig(): Promise<AppConfig> {
    // 重置只影响界面草稿：保留最近一次有效 targetUrl（首次启动为空），其余恢复默认值。
    // 不写盘、不更新 lastConfig——是否落盘完全由用户显式保存决定（规格 §5.3）。
    const targetUrl = lastConfig?.targetUrl ?? '';
    const defaults = createDefaultConfig(targetUrl.length > 0 ? targetUrl : 'http://localhost');
    const reset: AppConfig = { ...defaults, targetUrl };
    deps.logger?.info('config-reset-defaults', { targetUrlPreserved: targetUrl.length > 0 });
    return reset;
  }

  async function handleTestConnection(args: unknown[]): Promise<ConnectionResult> {
    const [url, network] = args as [unknown, unknown];
    if (typeof url !== 'string' || typeof network !== 'object' || network === null) {
      return { ok: false, message: '测试连接参数不完整' };
    }

    // 用当前配置做壳复用权威校验：网址与网络段（含 fixed/PAC 必填、凭据拒绝）不过就不测。
    const base = lastConfig ?? blankConfig();
    const validation = validateConfig({ ...base, targetUrl: url, network });
    if (!validation.ok) {
      return { ok: false, message: `配置校验失败：${formatIssues(validation.issues)}` };
    }

    if (deps.testConnection !== undefined) {
      return deps.testConnection(url, network as NetworkConfig);
    }
    return testTargetConnection(url, network as NetworkConfig);
  }

  /**
   * 规格 §5.4：打开文件选择对话框并把选定图标复制到配置目录。
   * 只回传文件名与预览 data URL；不向渲染进程暴露任意文件路径读写能力。
   */
  async function handlePickIcon(): Promise<IconPickResult> {
    if (deps.pickIcon === undefined) {
      return { ok: false, message: '当前环境不支持选择图标文件' };
    }
    try {
      const result = await deps.pickIcon();
      if (result.canceled) {
        deps.logger?.info('icon-pick-canceled');
      } else if (result.ok) {
        deps.logger?.info('icon-picked', { fileName: result.fileName });
      } else {
        deps.logger?.warn('icon-pick-rejected', { message: result.message });
      }
      return result;
    } catch (error) {
      deps.logger?.warn('icon-pick-failed', { message: describeError(error) });
      return { ok: false, message: describeError(error) };
    }
  }

  const listeners = new Map<ConfigIpcChannel, (args: unknown[]) => Promise<unknown>>([
    [CONFIG_IPC_CHANNELS.getConfig, () => handleGetConfig()],
    [CONFIG_IPC_CHANNELS.validateConfig, (args) => Promise.resolve(validateConfig(args[0]))],
    [CONFIG_IPC_CHANNELS.saveConfig, (args) => handleSaveConfig(args[0])],
    [CONFIG_IPC_CHANNELS.resetConfig, () => handleResetConfig()],
    [CONFIG_IPC_CHANNELS.testConnection, (args) => handleTestConnection(args)],
    [CONFIG_IPC_CHANNELS.iconPick, () => handlePickIcon()],
  ]);

  for (const channel of Object.values(CONFIG_IPC_CHANNELS)) {
    // 双保险：白名单表自身被误改时，拒绝注册表外通道。
    if (!isConfigIpcChannel(channel)) {
      throw new Error(`拒绝注册白名单外的 IPC 通道：${channel}`);
    }
    const listener = listeners.get(channel);
    if (listener === undefined) {
      throw new Error(`白名单通道缺少处理器：${channel}`);
    }
    deps.host.handle(channel, (_event, ...args) => listener(args));
  }

  return { getLastConfig: () => lastConfig };
}

/** 连通性测试的可注入出口。 */
export interface ConnectionTestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function clampTimeout(requestTimeoutSec: number): number {
  if (!Number.isFinite(requestTimeoutSec) || requestTimeoutSec <= 0) return 10_000;
  return Math.min(Math.max(requestTimeoutSec * 1000, 1_000), 60_000);
}

/** 把常见网络故障归类为界面可读原因；规则来源：规格 §7（失败分类）。 */
export function classifyConnectionError(error: unknown): string {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  switch (cause?.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'DNS 解析失败';
    case 'ECONNREFUSED':
      return '连接被拒绝';
    case 'ETIMEDOUT':
      return '连接超时';
    case 'ECONNRESET':
      return '连接被重置';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'TLS 证书校验失败';
    default:
      break;
  }
  // 中止原因通常是 DOMException（name=TimeoutError/AbortError），不保证是 Error 实例，故按名称判定。
  const name = (error as { name?: unknown } | undefined)?.name;
  if (name === 'TimeoutError') return '连接超时';
  if (name === 'AbortError') return '连接已取消';
  return `连接失败：${describeError(error)}`;
}

/**
 * 目标网址连通性测试：一次手动重定向的 GET，只读响应头。
 *
 * 说明：fixed/pac 代理模式下的测试不经过代理（结果中会标注），
 * 因为代理在配置保存并重启后才对目标页面生效；本任务不引入会话级代理注入。
 */
export async function testTargetConnection(
  url: string,
  network: NetworkConfig,
  options: ConnectionTestOptions = {},
): Promise<ConnectionResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? clampTimeout(network.requestTimeoutSec);
  const proxyNote =
    network.proxyMode === 'direct' || network.proxyMode === 'system' ? '' : '（测试未经过代理）';
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 连通性测试只关心响应头，主动取消响应体，避免下载整个页面。
    void response.body?.cancel().catch(() => undefined);

    const durationMs = Date.now() - startedAt;
    const statusCode = response.status;
    if (statusCode >= 400) {
      return { ok: false, statusCode, durationMs, message: `目标返回 HTTP ${statusCode}${proxyNote}` };
    }
    return { ok: true, statusCode, durationMs, message: `连接成功（HTTP ${statusCode}，${durationMs} ms）${proxyNote}` };
  } catch (error) {
    return { ok: false, durationMs: Date.now() - startedAt, message: classifyConnectionError(error) };
  }
}
