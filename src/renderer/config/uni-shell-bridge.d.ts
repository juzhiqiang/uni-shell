import type { ConfigBridge } from '../../shared/ipc-contract';

declare global {
  interface Window {
    /** 由本地配置窗口 preload 注入的白名单桥；未加载时为 undefined。 */
    uniShell?: ConfigBridge;
  }
}

export {};
