/**
 * 统一启动状态机与模块编排。
 *
 * 规则来源：规格 v2.1 §4（总体运行流程）、§7（代理与恢复）、§12（诊断）
 * 与 `rules/architecture.md`「分层职责」。
 *
 * 本模块只做编排：配置读写、窗口、托盘、自启、延迟、平台能力全部通过端口注入，
 * 不直接依赖 Electron 或具体 OS API，因此可在纯 Node 环境下完整测试。
 *
 * 诊断与恢复（Task 9）：结构化日志契约在 `src/main/logging/logger.ts`，
 * 本模块负责把启动、配置、代理、重试、窗口策略、电源与关闭事件接到日志上，
 * 并在关闭时停止重试定时器、移除电源监听、刷新日志。
 *
 * 进程级恢复（Task 15）：远程页面崩溃、OOM 或被外部结束时不产生 `did-fail-load`，
 * 重试控制器不会被触发，因此另由崩溃窗口（`network/crash-guard.ts`）决策自动重载
 * 或离线页降级；渲染进程无响应超过阈值后强制结束，再交给同一套崩溃恢复流程。
 *
 * 依赖方向：控制器依赖平台实现（startup、tray、platform、network），平台实现不得反向依赖本模块。
 */

import type { AppConfig } from './config/config-schema';
import type { NetworkConfig } from './config/config-types';
import type { ConfigService } from './config/config-service';
import type { Logger } from './logging/logger';
import {
  DEFAULT_CRASH_WINDOW_MS,
  decideCrashRecovery,
  isRecoverableRendererExit,
} from './network/crash-guard';
import type { ProxyApplyResult } from './network/proxy-manager';
import {
  RetryController,
  classifyLoadFailure,
  isIgnorableLoadFailure,
  type LoadFailureDetails,
} from './network/retry-controller';
import type { ResolvedConfigPaths } from './platform/config-paths';
import type { PlatformCapabilities } from './platform/platform-adapter';
import { detectLaunchContext, type LaunchContext, type LaunchSource } from './instance/single-instance';
import {
  runStartupDelay,
  setOpenAtLogin,
  shouldApplyDelay,
  type CancelableDelay,
  type LoginItemPort,
  type LoginItemResult,
} from './startup/startup-manager';
import {
  createTray,
  installFocusedShortcut,
  type ShortcutHandle,
  type ShortcutTarget,
  type TrayActions,
  type TrayPort,
} from './tray/tray-manager';
import type { WindowManagerEvent } from './window/window-manager';

export type AppState =
  | 'idle'
  | 'starting'
  | 'awaiting-delay'
  | 'running'
  | 'configuring'
  | 'shutting-down'
  | 'stopped';

/** 代理应用端口；生产环境经 Electron session 注入（Task 5 的 applyProxy）。 */
export interface ProxyPort {
  apply(config: NetworkConfig): Promise<ProxyApplyResult>;
}

/** 启动代理应用失败时请求用户决定是否继续创建远程业务窗口。 */
export type ConfirmProxyFailure = (mode: NetworkConfig['proxyMode']) => Promise<boolean>;

/** 电源监听端口；生产环境注入 Electron `powerMonitor`。 */
export interface PowerMonitorPort {
  onSuspend(handler: () => void): void;
  onResume(handler: () => void): void;
  /** 关闭时移除全部监听，避免监听器泄漏。 */
  removeAllListeners(): void;
}

export interface WindowPort {
  openConfigWindow(reason: string): Promise<void>;
  createMainWindow(config: AppConfig): Promise<void>;
  showAndFocusMain(): Promise<void>;
  hideMain(): Promise<void>;
  /** 重新加载目标网页（托盘「重新加载网页」、唤醒恢复）。 */
  reloadMain(): Promise<void>;
  /** 展示本地离线页（规格 §7 的 offlinePageEnabled）；未提供时不展示。 */
  showOfflinePage?(): Promise<void> | void;
  /** 后台探测目标网址是否可达（规格 §7：先 HEAD 探测再 loadURL）；未提供时直接重载。 */
  probeTarget?(): Promise<boolean>;
  /** 强制结束无响应的渲染进程（规格 §7）；未提供时只记录日志。 */
  forcefullyCrashRenderer?(): void;
  isMainWindowVisible(): boolean;
  isConfigWindowOpen(): boolean;
  focusConfigWindow(): void;
}

export interface DelayPort {
  run(config: AppConfig['startup'], context: LaunchContext, onReady: () => void): CancelableDelay;
}

export interface SingleInstanceHandle {
  release(): void;
}

export interface AppControllerDeps {
  configService: ConfigService;
  capabilities: PlatformCapabilities;
  window: WindowPort;
  tray?: TrayPort;
  delay?: DelayPort;
  /** 登录项端口；提供时由控制器按配置应用开机自启。 */
  loginItem?: LoginItemPort;
  /** 快捷键宿主窗口；提供时按配置安装仅焦点生效的维护快捷键。 */
  shortcutTarget?: ShortcutTarget;
  /** 代理应用端口；提供时启动流程在创建主窗口前应用代理（规格 §7）。 */
  proxy?: ProxyPort;
  /** 启动代理失败确认端口；缺少确认端口时按拒绝处理。 */
  confirmProxyFailure?: ConfirmProxyFailure;
  /** 电源监听端口；提供时记录休眠/唤醒诊断并在唤醒后重载页面（规格 §14.1）。 */
  powerMonitor?: PowerMonitorPort;
  singleInstance?: SingleInstanceHandle;
  /** 主进程提供的启动阶段计时记录器。 */
  startupTiming?: (stage: 'configLoaded' | 'proxyApplied') => void;
  /** 可注入随机源（返回值 ∈ [0, 1]），用于测试重试退避抖动。 */
  retryRandom?: () => number;
  log?: Logger;
}

export interface StartOptions {
  argv: string[];
  workingDirectory: string;
  env: Record<string, string | undefined>;
}

/** 静默日志器，避免未注入日志时反复判空。 */
const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  close: async () => {},
};

/**
 * 规格 §7：渲染进程无响应超过该时长后强制结束渲染进程。
 *
 * 取常量而不进配置 schema：无响应恢复是常驻/Kiosk 场景的保底行为，
 * 现场不需要按部署调整；需要变更时随版本发布，避免配置面继续扩大。
 */
export const UNRESPONSIVE_CRASH_DELAY_MS = 10_000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 规格 §12：启动时记录平台能力摘要，供现场诊断。 */
function summarizeCapabilities(capabilities: PlatformCapabilities): Record<string, unknown> {
  return {
    tray: { available: capabilities.tray.available, protocol: capabilities.tray.protocol },
    alwaysOnTop: {
      supported: capabilities.alwaysOnTop.supported,
      levels: capabilities.alwaysOnTop.levels,
      windowManagerControlled: capabilities.alwaysOnTop.windowManagerControlled,
    },
    fullscreen: capabilities.fullscreen.supported,
    kiosk: capabilities.kiosk.supported,
    loginItem: { supported: capabilities.loginItem.supported, mechanism: capabilities.loginItem.mechanism },
    displays: capabilities.displaySelection.count,
  };
}

/** 默认延迟端口：直接采用 startup-manager 的实现。 */
export function createDefaultDelayPort(): DelayPort {
  return {
    run: (config, context, onReady) => runStartupDelay(config, context, onReady),
  };
}

export class AppController {
  private state: AppState = 'idle';
  private context: LaunchContext | undefined;
  private paths: ResolvedConfigPaths | undefined;
  private config: AppConfig | undefined;
  private delayHandle: CancelableDelay | undefined;
  private trayHandle: { destroy(): void } | undefined;
  private shortcutHandle: ShortcutHandle | undefined;
  private mainWindowCreated = false;
  private started = false;
  private retryController: RetryController | undefined;
  private loadFailures = 0;
  /** 崩溃窗口内的渲染进程崩溃时间戳（规格 §7 的 60 秒 / 3 次判定）。 */
  private crashHistory: number[] = [];
  /** 已降级为离线页：自动重载保持停止，直到用户手动重载或加载成功（规格 §7）。 */
  private crashRecoveryStopped = false;
  private crashReloadTimer: ReturnType<typeof setTimeout> | undefined;
  private unresponsiveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: AppControllerDeps) {}

  get currentState(): AppState {
    return this.state;
  }

  /** 当前实际读取的配置路径，供配置界面展示（规格 §5.1）。 */
  get configPaths(): ResolvedConfigPaths | undefined {
    return this.paths;
  }

  get launchContext(): LaunchContext | undefined {
    return this.context;
  }

  /** 按规格 §4 的流程启动：识别来源 → 解析路径 → 读取校验 → 启动策略。 */
  async start(options: StartOptions): Promise<void> {
    if (this.started) return;
    this.started = true;

    const log = this.deps.log ?? noopLogger;
    this.state = 'starting';
    this.context = {
      source: detectLaunchContext(options.argv),
      argv: [...options.argv],
      workingDirectory: options.workingDirectory,
    };

    this.paths = this.deps.configService.paths;

    log.info('startup', {
      source: this.context.source,
      platform: this.deps.capabilities.platform,
      osVersion: this.deps.capabilities.osVersion,
      arch: this.deps.capabilities.arch,
      desktopEnvironment: this.deps.capabilities.desktopEnvironment,
      sessionType: this.deps.capabilities.sessionType,
      wayland: this.deps.capabilities.wayland,
      configPath: this.paths.configPath,
      capabilities: summarizeCapabilities(this.deps.capabilities),
    });

    // 休眠/唤醒诊断覆盖全部启动路径（含配置界面驻留）。
    this.subscribePowerMonitor();

    const result = await this.deps.configService.load();
    this.deps.startupTiming?.('configLoaded');

    if (result.status !== 'loaded' || !result.config) {
      // 规格 §5.3：文件不存在、JSON 错误、字段错误或网址无效时打开配置界面。
      const reason = result.reason ?? '配置不可用';
      log.warn('config-unavailable', { path: result.path, status: result.status, reason });
      await this.deps.window.openConfigWindow(reason);
      this.state = 'configuring';
      this.createTray();
      return;
    }

    this.config = result.config;
    log.info('config-loaded', {
      path: result.path,
      source: result.source,
      proxyMode: result.config.network.proxyMode,
      retryIntervalSec: result.config.network.retryIntervalSec,
    });

    void this.ensureOpenAtLogin();
    this.createTray();
    this.installShortcut();
    // 代理必须先于目标页面加载生效（规格 §7）。
    const proxyApplied = await this.applyProxyConfig(
      result.config.network,
      true,
      () => this.deps.startupTiming?.('proxyApplied'),
    );
    if (!proxyApplied) {
      this.state = 'configuring';
      await this.deps.window.openConfigWindow('启动代理应用失败，用户选择返回配置界面');
      return;
    }
    this.startRetryController();
    await this.applyStartupStrategy();
  }

  /** 初始驻留状态 → 延迟 → 创建或显示主窗口（规格 §4、§9）。 */
  private async applyStartupStrategy(): Promise<void> {
    const config = this.config;
    const context = this.context;
    if (!config || !context) return;

    // 初始驻留为托盘时先保持隐藏；minimized 由窗口层在建窗时处理。
    if (config.startup.initialState === 'tray') {
      await this.deps.window.hideMain();
    }

    if (!shouldApplyDelay(config.startup, context)) {
      await this.onDelayElapsed();
      return;
    }

    const delay = this.deps.delay ?? createDefaultDelayPort();
    this.state = 'awaiting-delay';
    this.delayHandle = delay.run(config.startup, context, () => {
      void this.onDelayElapsed();
    });
  }

  private async onDelayElapsed(): Promise<void> {
    const config = this.config;
    if (!config) return;

    this.delayHandle = undefined;

    // showAfterDelay=false 时延迟到期仍保持驻留，等待用户从托盘触发。
    if (!config.startup.showAfterDelay) {
      this.state = 'running';
      return;
    }

    // 延迟到期属于隐性展示：initialState=minimized 时由窗口层在 ready-to-show
    // 以 showInactive 呈现，不抢占焦点；其余状态需要显式显示并聚焦。
    await this.showMainWindow({ revealAfterCreate: config.startup.initialState !== 'minimized' });
    this.state = 'running';
  }

  /**
   * 创建或显示主窗口。
   *
   * 窗口按 `startup.initialState` 可能是隐藏创建的（`tray` 驻留），因此创建后
   * 是否显式显示由调用方意图决定：托盘、唤醒等显式请求一律显示并聚焦，
   * 延迟到期这类隐性展示在 `minimized` 下交给窗口层的首屏时序处理。
   */
  private async showMainWindow(options: { revealAfterCreate: boolean }): Promise<void> {
    const config = this.config;
    if (!config) return;

    if (!this.mainWindowCreated) {
      await this.deps.window.createMainWindow(config);
      this.mainWindowCreated = true;
      if (options.revealAfterCreate) await this.deps.window.showAndFocusMain();
      return;
    }

    await this.deps.window.showAndFocusMain();
  }

  /** 规格 §10：创建托盘；不可用时降级而不影响主流程。 */
  private createTray(): void {
    const tray = this.deps.tray;
    if (!tray || this.trayHandle) return;

    const actions: TrayActions = {
      showWindow: () => this.showAndFocusMain(),
      openConfig: () => this.deps.window.openConfigWindow('用户从托盘打开配置界面'),
      reload: () => this.reloadMain(),
      // 返回关闭流程的 Promise：即发即弃的调用方不受影响，需要等待
      // 日志刷新完成的调用方（如退出流程）可以 await。
      quit: () => this.shutdown(),
    };

    const result = createTray(actions, this.deps.capabilities, { port: tray });
    if (result.degraded) {
      (this.deps.log ?? noopLogger).warn('tray-degraded', {
        reason: result.reason,
        fallback: result.fallback,
      });
      return;
    }

    this.trayHandle = tray;
  }

  private async reloadMain(): Promise<void> {
    // 用户显式触发（托盘「重新加载网页」、唤醒恢复）即恢复自动重载资格：
    // 清空崩溃窗口与降级状态，重新获得完整配额（规格 §7）。
    this.crashHistory = [];
    this.crashRecoveryStopped = false;
    this.clearCrashReloadTimer();
    if (this.retryController?.isRetrying) {
      this.retryController.retryNow();
      return;
    }
    await this.deps.window.reloadMain();
  }

  /** 规格 §10：安装仅在客户端窗口获得焦点时生效的维护快捷键。 */
  private installShortcut(): void {
    const config = this.config;
    const target = this.deps.shortcutTarget;
    if (!config || !target) return;

    if (!config.maintenance.hotkeyEnabled) {
      (this.deps.log ?? noopLogger).info('shortcut-disabled');
      return;
    }

    this.shortcutHandle = installFocusedShortcut(target, config.maintenance.hotkey, () => {
      void this.showAndFocusMain();
    });

    if (!this.shortcutHandle) {
      (this.deps.log ?? noopLogger).warn('shortcut-invalid-binding', { binding: config.maintenance.hotkey });
    }
  }

  /**
   * 规格 §9：`openAtLogin=true` 时确保登录项已注册。
   *
   * 只为 `true` 主动写入：配置为 `false` 时不动手，避免覆盖用户在操作系统侧
   * 自行设置的登录项。需要关闭时由配置界面显式调用 `applyOpenAtLogin(false)`。
   */
  private async ensureOpenAtLogin(): Promise<void> {
    const config = this.config;
    if (!config?.startup.openAtLogin) return;
    await this.applyOpenAtLogin(true);
  }

  /** 显式设置开机自启；供配置界面保存时调用。 */
  async applyOpenAtLogin(enabled: boolean): Promise<LoginItemResult | undefined> {
    const port = this.deps.loginItem;
    if (!port) return undefined;

    const result = await setOpenAtLogin(enabled, { port });

    (this.deps.log ?? noopLogger).info('login-item', {
      desired: enabled,
      ok: result.ok,
      mechanism: result.mechanism,
      reason: result.reason,
    });

    return result;
  }

  /**
   * 规格 §7：应用接口代理。
   *
   * 启动流程在创建主窗口前调用；启动失败需用户确认，热切换失败沿用现有错误处理。
   * 代理只对 `network.apiProxyHosts` 命中的接口域名生效，其余流量直连。
   */
  async applyProxyConfig(
    network: NetworkConfig,
    startup = false,
    onStartupApplied?: () => void,
  ): Promise<boolean> {
    const port = this.deps.proxy;
    if (!port) {
      if (startup) onStartupApplied?.();
      return true;
    }

    const log = this.deps.log ?? noopLogger;
    if (network.proxyMode !== 'direct' && network.apiProxyHosts.length === 0) {
      log.warn('proxy-scope-empty', { mode: network.proxyMode });
    }

    try {
      const result = await port.apply(network);
      log.info('proxy-applied', {
        mode: result.mode,
        effective: result.effective,
        hostCount: result.hostCount,
        proxiedHostCount: result.proxiedHostCount,
      });
      for (const note of result.notes) {
        log.warn('proxy-degraded', { mode: result.mode, note });
      }
      if (startup) onStartupApplied?.();
      return true;
    } catch {
      // Electron errors can include PAC URLs or proxy credentials; only mode is diagnostic-safe.
      log.error('proxy-apply-failed', { mode: network.proxyMode });
      if (!startup) return false;
      onStartupApplied?.();

      let proceed = false;
      try {
        proceed = await this.deps.confirmProxyFailure?.(network.proxyMode) ?? false;
      } catch {
        log.error('proxy-startup-confirmation-failed', { mode: network.proxyMode });
      }
      log.warn('proxy-startup-decision', {
        mode: network.proxyMode,
        decision: proceed ? 'continue' : 'configure',
      });
      return proceed;
    }
  }

  /**
   * 规格 §7、§14.1：启动远程页面重试控制。
   *
   * 重试控制器由编排层持有：重试触发重新加载、失败先展示本地离线页；
   * 关闭时统一停止定时器（`rules/architecture.md`：定时器必须可取消、资源可释放）。
   */
  private startRetryController(): void {
    const config = this.config;
    if (!config) return;

    this.loadFailures = 0;
    this.retryController = new RetryController({
      retryIntervalSec: config.network.retryIntervalSec,
      offlinePageEnabled: config.network.offlinePageEnabled,
      random: this.deps.retryRandom,
      onRetry: () => {
        void this.performRetryAttempt();
      },
      showOfflinePage: () => {
        (this.deps.log ?? noopLogger).info('offline-page-shown');
        void this.deps.window.showOfflinePage?.();
      },
    });
    this.retryController.start();
  }

  /**
   * 执行一次断网重试：若提供 `probeTarget`，先后台 HEAD 探测可达性，
   * 探测成功后再调用 `reloadMain()`，避免离线页反复重载闪烁（规格 v2.1.3 §7）。
   */
  private async performRetryAttempt(): Promise<void> {
    if (this.state === 'shutting-down' || this.state === 'stopped') return;

    const log = this.deps.log ?? noopLogger;
    const attempt = this.retryController?.attemptCount ?? this.loadFailures;
    log.info('retry-attempt', { attempt });

    if (this.deps.window.probeTarget) {
      try {
        const reachable = await this.deps.window.probeTarget();
        if (!reachable) {
          log.info('retry-probe-failed', { attempt });
          return;
        }
      } catch (error) {
        log.info('retry-probe-failed', { attempt, message: describeError(error) });
        return;
      }
    }

    if (this.currentState === 'shutting-down' || this.currentState === 'stopped') return;
    await this.deps.window.reloadMain();
  }

  /**
   * 规格 §7：检测到网络恢复在线时，若正处于断网重试周期则取消排队等待并立即重试。
   */
  reportNetworkOnline(): void {
    if (this.state !== 'running') return;
    if (!this.retryController?.isRetrying) return;

    const log = this.deps.log ?? noopLogger;
    log.info('network-online-retry');
    this.retryController.retryNow();
  }

  /**
   * 主框架加载失败：记录分类诊断并交给重试控制。
   * 由窗口层的加载失败监听调用（生产装配入口，规格 §12 的页面加载结果）。
   */
  reportLoadFailure(details: LoadFailureDetails): void {
    if (!details.isMainFrame) return;

    const log = this.deps.log ?? noopLogger;
    if (isIgnorableLoadFailure(details)) {
      log.debug?.('page-load-aborted', {
        errorCode: details.errorCode,
        errorDescription: details.errorDescription,
      });
      return;
    }

    this.loadFailures += 1;
    log.warn('page-load-failed', {
      failureKind: classifyLoadFailure(details),
      errorCode: details.errorCode,
      errorDescription: details.errorDescription,
      attempt: this.loadFailures,
      nextRetryInSec: this.config?.network.retryIntervalSec,
    });

    this.retryController?.onLoadFailed(details);
  }

  /** 主框架加载成功：记录结果并停止重试（规格 §14.1 的恢复判定）。 */
  reportLoadSuccess(): void {
    const log = this.deps.log ?? noopLogger;
    const recovered = this.loadFailures > 0;
    this.loadFailures = 0;
    // 页面能正常加载说明进程级故障已恢复，崩溃窗口与降级状态重新累计（规格 §7）。
    this.crashHistory = [];
    this.crashRecoveryStopped = false;
    log.info('page-load-succeeded', { recovered });
    this.retryController?.onLoadSucceeded();
  }

  /**
   * 规格 §7：渲染进程异常退出（崩溃、内存不足被结束、被外部结束）后的自动恢复。
   *
   * 崩溃不产生 `did-fail-load`，重试控制器不会被触发，因此由崩溃窗口独立决策：
   * 窗口内未达阈值按 `retryIntervalSec` 自动重载；达到阈值改为展示离线页并停止
   * 自动重载，直到用户从托盘手动重载或加载成功后恢复。`clean-exit` 属于预期退出，
   * 只记录诊断，不触发恢复。
   */
  reportRendererGone(details: { reason: string; exitCode: number }): void {
    const log = this.deps.log ?? noopLogger;

    // 关闭流程已开始时不再安排任何恢复动作（定时器同样不再新建）。
    if (this.state === 'shutting-down' || this.state === 'stopped') return;

    log.warn('renderer-gone', { reason: details.reason, exitCode: details.exitCode });

    if (!isRecoverableRendererExit(details.reason)) {
      log.info('renderer-gone-ignored', { reason: details.reason, exitCode: details.exitCode });
      return;
    }

    // 已降级：规格 §7 只允许「用户从托盘手动重载」或「加载成功」恢复自动重载，
    // 崩溃记录滑出窗口不构成恢复条件，否则会自动复活。
    if (this.crashRecoveryStopped) {
      log.info('renderer-gone-ignored', {
        reason: details.reason,
        exitCode: details.exitCode,
        recovery: 'stopped',
      });
      return;
    }

    const config = this.config;
    // 配置不可用（驻留配置界面）时没有恢复目标，只保留诊断。
    if (!config) return;

    const decision = decideCrashRecovery(this.crashHistory, Date.now());
    this.crashHistory = decision.history;

    if (decision.action === 'offline') {
      this.crashRecoveryStopped = true;
      log.error('renderer-crash-limit', {
        crashes: this.crashHistory.length,
        windowMs: DEFAULT_CRASH_WINDOW_MS,
      });
      // 停止自动重载：挂起的重载与后续崩溃都不再触发，等待用户或加载成功。
      this.clearCrashReloadTimer();
      if (config.network.offlinePageEnabled) {
        log.info('offline-page-shown');
        // 离线页展示失败不阻塞降级状态：窗口已停在崩溃页，日志留痕即可。
        void Promise.resolve(this.deps.window.showOfflinePage?.()).catch((error) => {
          log.error('offline-page-failed', { message: describeError(error) });
        });
      }
      return;
    }

    log.info('renderer-recovery', {
      action: 'reload',
      crashes: this.crashHistory.length,
      retryInSec: config.network.retryIntervalSec,
    });
    this.scheduleCrashReload(config.network.retryIntervalSec);
  }

  /**
   * 规格 §7：渲染进程无响应。
   *
   * 持续超过 `UNRESPONSIVE_CRASH_DELAY_MS` 后强制结束该渲染进程；随后
   * `render-process-gone` 会接管，按崩溃恢复流程重载。重复事件只保留一个计时器，
   * 避免无响应页面永远等不到强制结束。
   */
  reportUnresponsive(): void {
    const log = this.deps.log ?? noopLogger;
    if (this.state === 'shutting-down' || this.state === 'stopped') return;

    log.warn('renderer-unresponsive', { forceCrashInSec: UNRESPONSIVE_CRASH_DELAY_MS / 1000 });

    this.clearUnresponsiveTimer();
    this.unresponsiveTimer = setTimeout(() => {
      this.unresponsiveTimer = undefined;
      if (this.state === 'shutting-down' || this.state === 'stopped') return;

      log.warn('renderer-force-crashed', { reason: 'unresponsive' });
      this.deps.window.forcefullyCrashRenderer?.();
    }, UNRESPONSIVE_CRASH_DELAY_MS);
  }

  /**
   * 渲染进程恢复响应。
   *
   * 规格 §12 把「恢复响应」列为必记项，因此无条件记录；`cancelledForceCrash`
   * 区分是否真的取消了一次挂起的强制结束。
   */
  reportResponsive(): void {
    const log = this.deps.log ?? noopLogger;
    const cancelledForceCrash = this.unresponsiveTimer !== undefined;

    this.clearUnresponsiveTimer();
    log.info('renderer-responsive', { cancelledForceCrash });
  }

  /**
   * 安排一次崩溃重载。
   *
   * 不重置崩溃窗口：连续崩溃必须累计到阈值才会降级为离线页。崩溃间隔短于重试
   * 间隔时重新计时，避免刚崩溃就又发起重载。
   */
  private scheduleCrashReload(retryIntervalSec: number): void {
    this.clearCrashReloadTimer();
    this.crashReloadTimer = setTimeout(() => {
      this.crashReloadTimer = undefined;
      if (this.state === 'shutting-down' || this.state === 'stopped') return;

      const log = this.deps.log ?? noopLogger;
      // 崩溃重载不重置崩溃窗口：连续崩溃仍应累计到阈值。窗口已销毁时
      // loadURL 会 reject，这里只留痕，不影响后续崩溃计数。
      this.deps.window.reloadMain().catch((error) => {
        log.error('crash-reload-failed', { message: describeError(error) });
      });
    }, retryIntervalSec * 1000);
  }

  private clearCrashReloadTimer(): void {
    if (this.crashReloadTimer) clearTimeout(this.crashReloadTimer);
    this.crashReloadTimer = undefined;
  }

  private clearUnresponsiveTimer(): void {
    if (this.unresponsiveTimer) clearTimeout(this.unresponsiveTimer);
    this.unresponsiveTimer = undefined;
  }

  /** 规格 §12、§14.1：记录休眠/唤醒；唤醒后网络环境可能已变化，主动重载页面。 */
  private subscribePowerMonitor(): void {
    const port = this.deps.powerMonitor;
    if (!port) return;

    const log = this.deps.log ?? noopLogger;
    port.onSuspend(() => {
      log.info('power-suspend');
    });
    port.onResume(() => {
      log.info('power-resume');
      // 倒计时中不抢建窗口：等延迟到期或用户从托盘触发。
      if (this.state === 'running') {
        void this.reloadMain();
      }
    });
  }

  /**
   * 窗口与导航事件转诊断日志（规格 §12 的页面加载结果与窗口策略）。
   * URL 可能带有查询参数，脱敏由 logger 统一处理（规格 §11）。
   */
  reportWindowEvent(event: WindowManagerEvent): void {
    const log = this.deps.log ?? noopLogger;

    switch (event.type) {
      case 'main-window-created':
        log.info('window-created', { window: 'main' });
        break;
      case 'main-window-reused':
        log.info('window-reused', { window: 'main' });
        break;
      case 'main-load-failed':
        log.error('page-load-failed', { window: 'main', url: event.url, message: event.message });
        break;
      case 'config-window-created':
        log.info('window-created', { window: 'config' });
        break;
      case 'config-window-reused':
        log.info('window-reused', { window: 'config' });
        break;
      case 'config-load-failed':
        log.error('page-load-failed', { window: 'config', message: event.message });
        break;
      case 'navigation-guard':
        log.warn('navigation-blocked', {
          window: event.window,
          kind: event.kind,
          url: event.url,
          action: event.action,
          reason: event.reason,
        });
        break;
      case 'window-policy-applied':
        log.info('window-policy-applied', {
          window: event.window,
          mode: event.mode,
          fullscreen: event.fullscreen,
          kiosk: event.kiosk,
          alwaysOnTop: event.alwaysOnTop,
          display: event.display,
        });
        break;
      case 'window-policy-degraded':
        log.warn('window-policy-degraded', { window: event.window, field: event.field, reason: event.reason });
        break;
      case 'close-action':
        log.info('window-close-action', { window: event.window, action: event.action });
        break;
    }
  }

  /**
   * 规格 §4：第二次启动不得创建新窗口。
   * 配置窗口已打开时聚焦它；正在倒计时时取消倒计时并立即显示；
   * 否则显示并聚焦主窗口。
   */
  async handleSecondLaunch(payload: { argv: string[]; workingDirectory: string; source: LaunchSource }): Promise<void> {
    if (this.state === 'shutting-down' || this.state === 'stopped') return;

    const log = this.deps.log ?? noopLogger;
    log.info('second-launch', { source: payload.source, workingDirectory: payload.workingDirectory });

    // 配置窗口优先：用户可能正在编辑配置。
    if (this.deps.window.isConfigWindowOpen()) {
      this.deps.window.focusConfigWindow();
      return;
    }

    if (this.state === 'awaiting-delay') {
      this.cancelDelay();
    }

    if (this.state === 'configuring') {
      await this.deps.window.openConfigWindow('二次启动唤醒：配置尚未完成');
      return;
    }

    await this.showAndFocusMain();
  }

  /** 显示并聚焦主窗口；倒计时中调用会取消倒计时。 */
  async showAndFocusMain(): Promise<void> {
    if (this.state === 'shutting-down' || this.state === 'stopped') return;

    this.cancelDelay();

    if (this.state === 'configuring') {
      await this.deps.window.openConfigWindow('用户请求显示窗口：配置尚未完成');
      return;
    }

    await this.showMainWindow({ revealAfterCreate: true });
    this.state = 'running';
  }

  private cancelDelay(): void {
    this.delayHandle?.cancel();
    this.delayHandle = undefined;
  }

  /** 释放全部资源；幂等。 */
  async shutdown(): Promise<void> {
    if (this.state === 'shutting-down' || this.state === 'stopped') return;

    const log = this.deps.log ?? noopLogger;
    this.state = 'shutting-down';

    this.cancelDelay();
    this.retryController?.stop();
    this.retryController = undefined;
    // Task 15：崩溃重载与无响应强制结束的定时器同样必须可取消。
    this.clearCrashReloadTimer();
    this.clearUnresponsiveTimer();
    this.shortcutHandle?.dispose();
    this.shortcutHandle = undefined;
    this.trayHandle?.destroy();
    this.trayHandle = undefined;
    this.deps.powerMonitor?.removeAllListeners();
    this.deps.singleInstance?.release();

    log.info('shutdown', { configPath: this.paths?.configPath });
    // 规格 §12：退出前刷新日志；刷新失败不阻止关闭流程。
    await log.close().catch(() => undefined);
    this.state = 'stopped';
  }
}
