/**
 * 本地配置界面白名单 IPC 桥（纯逻辑部分）。
 *
 * 规则来源：规格 v2.1 §11 与 `rules/security.md`「远程内容隔离」：
 * - preload 只在本地配置窗口启用，并只公开具名、类型化、白名单 API；
 * - 不提供通用 `send(channel, payload)`、通用文件读写、Shell 或命令执行接口。
 *
 * 本模块不导入 Electron：Electron API 由入口文件 `src/preload/config-preload.ts`
 * 注入，因此白名单与暴露面可以在纯 Node 环境下完整测试。
 */

import type { ValidationResult } from '../main/config/config-schema';
import type { AppConfig, NetworkConfig } from '../main/config/config-types';

/** 配置界面上 `window.uniShell` 的挂载名。 */
export const UNI_SHELL_BRIDGE_KEY = 'uniShell';

/**
 * 白名单 IPC 通道。
 *
 * 主进程侧（Task 8）必须使用同一份通道表注册 `ipcMain.handle`，
 * 并通过 `isConfigIpcChannel` 拒绝表外通道。
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

/**
 * 由注入的 invoke 函数构造桥。
 *
 * 通道返回值类型由主进程侧契约保证（校验与保存都在主进程完成），
 * 因此这里只做通道收敛，不在渲染进程重复校验。
 */
export function createConfigBridge(invoke: ConfigInvoke): ConfigBridge {
  return {
    getConfig: () => invoke(CONFIG_IPC_CHANNELS.getConfig) as Promise<AppConfig>,
    validateConfig: (input) => invoke(CONFIG_IPC_CHANNELS.validateConfig, input) as Promise<ValidationResult<AppConfig>>,
    saveConfig: (input) => invoke(CONFIG_IPC_CHANNELS.saveConfig, input) as Promise<SaveResult>,
    resetConfig: () => invoke(CONFIG_IPC_CHANNELS.resetConfig) as Promise<AppConfig>,
    testConnection: (url, network) =>
      invoke(CONFIG_IPC_CHANNELS.testConnection, url, network) as Promise<ConnectionResult>,
    pickIcon: () => invoke(CONFIG_IPC_CHANNELS.iconPick) as Promise<IconPickResult>,
  };
}

/** 入口文件注入的 Electron API 形状。 */
export interface ConfigPreloadElectronApi {
  contextBridge?: { exposeInMainWorld(name: string, api: unknown): void };
  ipcRenderer?: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
}

/**
 * 在 Electron 渲染进程中安装桥。
 * 返回是否安装成功；非 Electron 环境（单元测试、普通 Node 进程）下安全跳过。
 */
export function installConfigBridge(electronApi: ConfigPreloadElectronApi | undefined): boolean {
  const contextBridge = electronApi?.contextBridge;
  const ipcRenderer = electronApi?.ipcRenderer;
  if (!contextBridge || !ipcRenderer) return false;

  contextBridge.exposeInMainWorld(
    UNI_SHELL_BRIDGE_KEY,
    createConfigBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  );
  return true;
}
