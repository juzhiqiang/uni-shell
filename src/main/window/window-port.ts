import { BrowserWindow, net, session } from 'electron';
import type { WindowPort } from '../app-controller';
import type { ConfigService } from '../config/config-service';
import type { AppConfig } from '../config/config-schema';
import type { BrowserWindowConstructorOptions } from './window-manager';
import type { PlatformCapabilities } from '../platform/platform-adapter';
import { REMOTE_PARTITION } from './session-policy';
import { loadOfflinePage } from './page-loader';

/**
 * 窗口工厂：把窗口层的中立选项映射为 Electron 的构造选项，并注入应用图标（规格 §5.4）。
 * `icon` 在启动前解析（用户图标或内置默认图标）；Windows 任务栏图标随窗口图标生效。
 */
export function createBrowserWindowFactory(getWindowIcon: () => Electron.NativeImage | undefined) {
  return (options: BrowserWindowConstructorOptions): BrowserWindow => {
    const icon = getWindowIcon();
    return new BrowserWindow({
      ...options,
      ...(icon !== undefined ? { icon } : {}),
    } as unknown as Electron.BrowserWindowConstructorOptions);
  };
}

export interface WindowPortAdapter extends WindowPort {
  closeStaleWindows(): void;
}

export interface MinimalMainWindowTarget {
  isVisible(): boolean;
  hide(): void;
  loadURL(url: string): Promise<void>;
  webContents: {
    forcefullyCrashRenderer(): void;
  };
}

export interface WindowPortManager<W = BrowserWindow> {
  createMainWindow(config: AppConfig): Promise<unknown>;
  openConfigWindow(reason?: string): void;
  showMainWindow(): boolean;
  getMainWindow(): W | null;
  getConfigWindow(): unknown | null;
  focusConfigWindow(): void;
  closeAll(): void;
  applyWindowPolicy(config: AppConfig['window'], capabilities: PlatformCapabilities): void;
  updateSecurity(security: AppConfig['security'], targetUrl?: string): void;
}

export interface ElectronSessionNetworkTarget {
  preconnect(options: { url: string; numSockets?: number }): void;
  fetch(url: string, init?: RequestInit): Promise<{ status: number }>;
}

export interface CreateWindowPortAdapterOptions<W extends MinimalMainWindowTarget = BrowserWindow> {
  windowManager: WindowPortManager<W>;
  capabilities: PlatformCapabilities;
  configService: ConfigService;
  netOnline?: () => boolean;
  sessionProvider?: (partition: string) => ElectronSessionNetworkTarget;
  loadOffline?: (window: W) => Promise<void>;
  partition?: string;
}

/**
 * 把 WindowManager 适配到控制器的 WindowPort。
 * 记住最近一次配置：托盘「重新加载网页」与唤醒恢复都要重新加载目标网址，
 * 离线页展示后更不能重载离线页本身。
 */
export function createWindowPortAdapter<W extends MinimalMainWindowTarget = BrowserWindow>(
  options: CreateWindowPortAdapterOptions<W>,
): WindowPortAdapter {
  const {
    windowManager,
    configService,
    netOnline = () => net.isOnline(),
    sessionProvider = (part) => session.fromPartition(part),
    loadOffline = (win) => loadOfflinePage(win as unknown as BrowserWindow),
    partition = REMOTE_PARTITION,
  } = options;

  const createMain = async (config: AppConfig): Promise<void> => {
    sessionProvider(partition).preconnect({ url: config.targetUrl, numSockets: 1 });
    await windowManager.createMainWindow(config);
  };

  return {
    async openConfigWindow(reason?: string) {
      windowManager.openConfigWindow(reason);
    },

    createMainWindow: createMain,

    applyConfig(config: AppConfig) {
      windowManager.applyWindowPolicy(config.window, options.capabilities);
      windowManager.updateSecurity(config.security, config.targetUrl);
    },

    async showAndFocusMain() {
      // 窗口已被销毁（如关闭后再次唤醒）时按最近配置重建；重建窗口可能按
      // `startup.initialState` 隐藏创建，调用方已明确要展示，因此显式显示。
      const current = configService.current();
      if (!windowManager.showMainWindow() && current !== undefined) {
        await createMain(current);
        windowManager.showMainWindow();
      }
    },

    async hideMain() {
      windowManager.getMainWindow()?.hide();
    },

    async reloadMain() {
      const main = windowManager.getMainWindow();
      const current = configService.current();
      // 主窗口只可能由 createMainWindow 创建，因此窗口存在即有最近配置；
      // 离线页展示后必须重新加载目标网址，而不是重载离线页本身。
      if (main !== null && current !== undefined) {
        await main.loadURL(current.targetUrl);
        return;
      }
      if (current !== undefined) {
        await createMain(current);
        windowManager.showMainWindow();
      }
    },

    async showOfflinePage() {
      const main = windowManager.getMainWindow();
      if (main !== null) await loadOffline(main);
    },

    async probeTarget() {
      const current = configService.current();
      if (current === undefined) return false;
      if (!netOnline()) return false;
      try {
        // 规格 §7、§11：经远程会话分区的 Chromium 网络栈发起 HEAD 探测，
        // 确保遵循同一分区的接口代理、TLS 与凭据策略。
        const response = await sessionProvider(partition).fetch(current.targetUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(current.network.requestTimeoutSec * 1000),
        });
        return response.status > 0;
      } catch {
        return false;
      }
    },

    forcefullyCrashRenderer() {
      // 规格 §7：无响应渲染进程由控制器判定后强制结束；随后 render-process-gone
      // 会接手，按崩溃窗口决定自动重载或离线页降级。窗口不存在时无需处理。
      //
      // 前提：主窗口与配置窗口必须处于不同 session/partition。Electron 明确警告
      // 共享渲染进程的 webContents 会被同时 crash；当前远程页用 persist:remote、
      // 配置页用 local-config，互不影响。若将来合并分区，这里要重新评估。
      windowManager.getMainWindow()?.webContents.forcefullyCrashRenderer();
    },

    isMainWindowVisible: () => windowManager.getMainWindow()?.isVisible() ?? false,
    isConfigWindowOpen: () => windowManager.getConfigWindow() !== null,
    focusConfigWindow() {
      // 走窗口管理器：配置窗口首帧未就绪时挂起显示，避免占位底色空窗。
      windowManager.focusConfigWindow();
    },
    /** 受控重启前关闭陈旧窗口；与 app.relaunch()/app.exit() 配合使用。 */
    closeStaleWindows() {
      windowManager.closeAll();
    },
  };
}
