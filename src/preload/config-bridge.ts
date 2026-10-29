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

import type { ValidationResult, AppConfig } from '../shared/config-types';
import {
  CONFIG_IPC_CHANNELS,
  UNI_SHELL_BRIDGE_KEY,
  isConfigIpcChannel,
  type ConfigBridge,
  type ConfigInvoke,
  type ConfigIpcChannel,
  type ConnectionResult,
  type IconPickResult,
  type SaveResult,
} from '../shared/ipc-contract';

export {
  CONFIG_IPC_CHANNELS,
  UNI_SHELL_BRIDGE_KEY,
  isConfigIpcChannel,
  type ConfigBridge,
  type ConfigInvoke,
  type ConfigIpcChannel,
  type ConnectionResult,
  type IconPickResult,
  type SaveResult,
};

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
