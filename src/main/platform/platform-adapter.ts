/**
 * 平台能力适配接口。
 *
 * 规则来源：规格 v2.1 §8（置顶层级实现策略）、§10（托盘目标）
 * 与 `rules/platform.md`「平台适配」。
 *
 * 设计约束（`rules/architecture.md`）：
 * - 平台差异通过能力对象表达，业务代码不散布 `process.platform` 与桌面环境判断；
 * - 能力不可用时返回明确的降级结果，不静默伪装成功；
 * - 不得承诺覆盖系统安全桌面、锁屏或系统保护界面。
 */

import type { AlwaysOnTopLevel } from '../config/config-types';

export type { AlwaysOnTopLevel } from '../config/config-types';

/** Electron `setAlwaysOnTop(flag, level)` 接受的层级名。 */
export type ElectronAlwaysOnTopLevel =
  | 'normal'
  | 'floating'
  | 'pop-up-menu'
  | 'modal-panel'
  | 'main-menu'
  | 'status'
  | 'control'
  | 'screen-saver'
  | 'torn-off-menu';

export type TrayProtocol = 'windows-notification-area' | 'macos-menu-bar' | 'statusnotifier' | 'gtk-status-icon';

export interface TraySupport {
  available: boolean;
  protocol?: TrayProtocol;
  /** 不可用或降级时的原因，需记录日志。 */
  reason?: string;
}

export interface AlwaysOnTopSupport {
  /** 平台是否支持任何形式的置顶。 */
  supported: boolean;
  /** 平台可用的层级；空数组表示完全不支持。 */
  levels: AlwaysOnTopLevel[];
  /** 层级是否由窗口管理器最终决定（Linux X11）。 */
  windowManagerControlled: boolean;
  reason?: string;
}

export interface FullscreenSupport {
  supported: boolean;
  reason?: string;
}

export interface KioskSupport {
  supported: boolean;
  reason?: string;
}

export type LoginItemMechanism = 'windows-run-key' | 'macos-login-item' | 'xdg-autostart';

export interface LoginItemSupport {
  supported: boolean;
  mechanism?: LoginItemMechanism;
  reason?: string;
}

export interface DisplaySupport {
  available: boolean;
  count: number;
  reason?: string;
}

export interface PlatformCapabilities {
  platform: 'win32' | 'darwin' | 'linux';
  /** `os.release()` 之类的人类可读系统版本。 */
  osVersion: string;
  /** `process.arch`。 */
  arch: string;
  /** Linux 桌面环境，例如 `GNOME`、`KDE`；非 Linux 为 undefined。 */
  desktopEnvironment?: string;
  /** Linux 显示服务器会话类型，例如 `x11`、`wayland`。 */
  sessionType?: string;
  wayland: boolean;
  tray: TraySupport;
  alwaysOnTop: AlwaysOnTopSupport;
  fullscreen: FullscreenSupport;
  kiosk: KioskSupport;
  loginItem: LoginItemSupport;
  displaySelection: DisplaySupport;
}

/** 探测平台能力所需的原始环境事实，全部可注入以便测试。 */
export interface PlatformEnvironment {
  platform: 'win32' | 'darwin' | 'linux';
  osRelease: string;
  arch: string;
  env: Record<string, string | undefined>;
  /** 显示器探测结果；探测失败时传 undefined，按「不可用」降级。 */
  displays?: { count: number };
  /** 托盘协议探测结果；未提供时按桌面环境约定推断。 */
  trayProtocol?: TrayProtocol;
  /** 托盘协议探测是否已执行；false 表示无法确认。 */
  trayProbed?: boolean;
}

export interface MappedWindowLevel {
  requested: AlwaysOnTopLevel;
  /** 传给 Electron `setAlwaysOnTop` 的层级。 */
  electronLevel: ElectronAlwaysOnTopLevel;
  /** 是否应当请求置顶。 */
  alwaysOnTop: boolean;
  /** 实际可达成的层级；完全不支持时为 `none`。 */
  effective: AlwaysOnTopLevel | 'none';
  /** 是否发生降级。 */
  degraded: boolean;
  /** 实际层级由窗口管理器决定（Linux X11）。 */
  windowManagerControlled: boolean;
  /** 是否可以覆盖任务栏/Dock；仅 Windows 在规格允许的层级下为 true。 */
  canCoverTaskbar: boolean;
  /**
   * 是否覆盖系统安全界面。规格 §8 明确三平台都不承诺，因此恒为 false。
   * 保留字段是为了让调用点显式面对这个约束。
   */
  coversSystemSecureUi: false;
  /** 是否需要在目标平台上实测确认（macOS 非 normal 层级）。 */
  requiresDeviceVerification: boolean;
  reason?: string;
}

export interface PlatformAdapter {
  readonly capabilities: PlatformCapabilities;
  detectCapabilities(): Promise<PlatformCapabilities>;
  mapAlwaysOnTopLevel(level: AlwaysOnTopLevel): MappedWindowLevel;
  /** 原始环境事实，便于日志与诊断。 */
  describeEnvironment(): PlatformEnvironment;
}
