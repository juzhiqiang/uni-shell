import type { ConfigBridge } from '../../preload/config-bridge';

declare global {
  interface Window {
    /** 由本地配置窗口 preload 注入的白名单桥；未加载时为 undefined。 */
    uniShell?: ConfigBridge;
  }
}

export {};
