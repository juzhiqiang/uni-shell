/**
 * 统一启动状态机与模块编排。
 *
 * 规则来源：规格 v2.1 §4（总体运行流程）与 `rules/architecture.md`「分层职责」。
 *
 * 本模块只做编排：配置读写、窗口、托盘、延迟、平台能力全部通过端口注入，
 * 不直接依赖 Electron 或具体 OS API，因此可在纯 Node 环境下完整测试。
 */

import type { AppConfig } from './config/config-schema';
import type { ConfigLoadResult } from './config/config-store';
import type { ResolveConfigPathsOptions, ResolvedConfigPaths } from './platform/config-paths';
import type { PlatformCapabilities } from './platform/platform-adapter';
import { detectLaunchContext, type LaunchSource } from './instance/single-instance';

export type AppState =
  | 'idle'
  | 'starting'
  | 'awaiting-delay'
  | 'running'
  | 'configuring'
  | 'shutting-down'
  | 'stopped';

export interface LaunchContext {
  source: LaunchSource;
  argv: string[];
  workingDirectory: string;
}

/** 结构化日志接口；Task 9 的 logger 实现可结构性满足它。 */
export interface Logger {
  info(event: string, data?: unknown): void;
  warn(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
}

export interface CancelableDelay {
  cancel(): void;
  readonly pending: boolean;
}

export interface WindowPort {
  openConfigWindow(reason: string): Promise<void>;
  createMainWindow(config: AppConfig): Promise<void>;
  showAndFocusMain(): Promise<void>;
  hideMain(): Promise<void>;
  isMainWindowVisible(): boolean;
  isConfigWindowOpen(): boolean;
  focusConfigWindow(): void;
}

/** 规格 §10 的四个固定托盘动作。 */
export interface TrayActions {
  showWindow(): void | Promise<void>;
  openConfig(): void | Promise<void>;
  reload(): void | Promise<void>;
  quit(): void | Promise<void>;
}

export interface TrayPort {
  create(actions: TrayActions): void;
  destroy(): void;
}

/**
 * 延迟端口契约。Task 7 的 `runStartupDelay` 将提供平台相关实现并替换默认值，
 * 签名保持一致以便直接替换。
 */
export interface DelayPort {
  run(config: AppConfig['startup'], context: LaunchContext, onReady: () => void): CancelableDelay;
}

export interface SingleInstanceHandle {
  release(): void;
}

export interface AppControllerDeps {
  resolvePaths: (options: ResolveConfigPathsOptions) => ResolvedConfigPaths;
  loadConfig: (paths: ResolvedConfigPaths) => Promise<ConfigLoadResult>;
  capabilities: PlatformCapabilities;
  window: WindowPort;
  tray?: TrayPort;
  delay?: DelayPort;
  singleInstance?: SingleInstanceHandle;
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
};

/**
 * 是否需要延迟。
 *
 * 规格 §9：`delayOnlyOnLogin=true` 时延迟只对登录启动生效，手动启动立即执行。
 * 该判断由控制器（启动状态机的所有者）持有，延迟端口退化为纯计时器，
 * 避免同一策略在两处重复实现。
 */
export function shouldApplyDelay(config: AppConfig['startup'], context: LaunchContext): boolean {
  return config.delaySec > 0 && (!config.delayOnlyOnLogin || context.source === 'login');
}

/**
 * 默认延迟实现：到点触发 `onReady`，可取消。
 * Task 7 可提供平台相关实现替换，契约保持一致。
 */
export function createDefaultDelayPort(): DelayPort {
  return {
    run(config, _context, onReady) {
      let cancelled = false;
      let fired = false;
      const timer = setTimeout(() => {
        if (cancelled) return;
        fired = true;
        onReady();
      }, config.delaySec * 1000);

      return {
        cancel() {
          cancelled = true;
          clearTimeout(timer);
        },
        /** 尚未触发且未被取消时为 true。 */
        get pending() {
          return !cancelled && !fired;
        },
      };
    },
  };
}

export class AppController {
  private state: AppState = 'idle';
  private context: LaunchContext | undefined;
  private paths: ResolvedConfigPaths | undefined;
  private config: AppConfig | undefined;
  private delayHandle: CancelableDelay | undefined;
  private mainWindowCreated = false;
  private started = false;

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

    this.paths = this.deps.resolvePaths({
      platform: process.platform as ResolveConfigPathsOptions['platform'],
      argv: options.argv,
      env: options.env,
      executablePath: process.execPath,
    });

    log.info('startup', {
      source: this.context.source,
      platform: this.deps.capabilities.platform,
      arch: this.deps.capabilities.arch,
      wayland: this.deps.capabilities.wayland,
      configPath: this.paths.configPath,
    });

    const result = await this.deps.loadConfig(this.paths);

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
    log.info('config-loaded', { path: result.path, source: result.source });

    this.createTray();
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

    await this.showMainWindow();
    this.state = 'running';
  }

  private async showMainWindow(): Promise<void> {
    const config = this.config;
    if (!config) return;

    if (!this.mainWindowCreated) {
      await this.deps.window.createMainWindow(config);
      this.mainWindowCreated = true;
      return;
    }

    await this.deps.window.showAndFocusMain();
  }

  private createTray(): void {
    const tray = this.deps.tray;
    if (!tray) return;

    tray.create({
      showWindow: () => this.showAndFocusMain(),
      openConfig: () => this.deps.window.openConfigWindow('用户从托盘打开配置界面'),
      reload: () => this.deps.window.showAndFocusMain(),
      quit: () => {
        void this.shutdown();
      },
    });
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

    await this.showMainWindow();
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
    this.deps.tray?.destroy();
    this.deps.singleInstance?.release();

    log.info('shutdown', { configPath: this.paths?.configPath });
    this.state = 'stopped';
  }
}
