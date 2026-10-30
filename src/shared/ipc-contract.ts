/**
 * 配置界面 IPC 白名单通道与契约。
 *
 * 规则来源：规格 v2.1.1 §11（白名单 IPC）与 `rules/architecture.md`「分层职责」。
 * 本模块为纯 TypeScript 契约，不得导入 Electron 或 Node 内置模块。
 */

import type { AppConfig, NetworkConfig, ValidationResult } from './config-types';

/** 配置界面上 `window.uniShell` 的挂载名。 */
export const UNI_SHELL_BRIDGE_KEY = 'uniShell';

/**
 * 白名单 IPC 通道。
 *
 * 主进程与 preload 必须使用同一份通道表，并通过 isConfigIpcChannel 拒绝表外通道。
 *
 * 规格 v2.1.1 §11：白名单共六个具名通道；`iconPick` 只打开文件选择对话框
 * 并把选定图标复制到配置目录，不提供通用文件读写能力。
 */
export const CONFIG_IPC_CHANNELS = {
  getConfig: 'uni-shell:config:get',
  validateConfig: 'uni-shell:config:validate',
  saveConfig: 'uni-shell:config:save',
  resetConfig: 'uni-shell:config:reset',
  testConnection: 'uni-shell:network:test',
  iconPick: 'uni-shell:icon:pick',
} as const;

export type ConfigIpcChannel = (typeof CONFIG_IPC_CHANNELS)[keyof typeof CONFIG_IPC_CHANNELS];

const ALLOWED_CHANNELS: ReadonlySet<string> = new Set<string>(Object.values(CONFIG_IPC_CHANNELS));

/** 判断通道是否在白名单内；主进程处理前必须调用，避免暴露任意 IPC。 */
export function isConfigIpcChannel(channel: string): channel is ConfigIpcChannel {
  return ALLOWED_CHANNELS.has(channel);
}

/** 配置保存结果。 */
export interface SaveResult {
  ok: boolean;
  /** 配置保存后的生效方式。 */
  applied?: 'hot' | 'reload' | 'restart';
  /** 配置已写入，但运行时应用失败时的告警。 */
  applyWarning?: string;
  /** 失败时的可操作错误信息。 */
  message?: string;
  /** 实际写入的配置文件路径，供界面展示。 */
  configPath?: string;
  /** 是否需要重启客户端才能生效。 */
  requiresRestart?: boolean;
}

/** 目标地址连通性测试结果。 */
export interface ConnectionResult {
  ok: boolean;
  statusCode?: number;
  message?: string;
  durationMs?: number;
}

/** 图标选择结果（规格 §5.4）。 */
export interface IconPickResult {
  ok: boolean;
  /** 用户取消选择时为 true；界面按无操作处理，不展示错误。 */
  canceled?: boolean;
  /** 成功时复制到配置目录的图标文件名。 */
  fileName?: string;
  /** 成功时供界面展示的预览 data URL。 */
  previewDataUrl?: string;
  /** 失败时的可操作错误信息。 */
  message?: string;
}

/** 白名单调用出口；通道类型受白名单约束，无法传入表外通道。 */
export type ConfigInvoke = (channel: ConfigIpcChannel, ...args: unknown[]) => Promise<unknown>;

/** 暴露给配置界面的 API：固定六个具名方法，没有通用发送能力。 */
export interface ConfigBridge {
  getConfig(): Promise<AppConfig>;
  validateConfig(input: unknown): Promise<ValidationResult<AppConfig>>;
  saveConfig(input: unknown): Promise<SaveResult>;
  resetConfig(): Promise<AppConfig>;
  testConnection(url: string, network: NetworkConfig): Promise<ConnectionResult>;
  pickIcon(): Promise<IconPickResult>;
}

