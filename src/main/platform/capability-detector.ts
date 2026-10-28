/**
 * 平台能力探测与降级。
 *
 * 规则来源：规格 v2.1 §8（置顶层级）、§10（托盘目标）、§2（支持平台基线）
 * 与 `rules/platform.md`「平台适配」。
 *
 * 关键约束：
 * - 不只凭 `process.platform` 判断能力，同时检测系统版本、架构和桌面环境；
 * - 检测失败时安全降级，不崩溃、不静默伪装成功；
 * - Linux Wayland 下 Electron 不支持 always-on-top，按规格明确降级并记录原因；
 * - 不承诺覆盖系统安全桌面、锁屏或系统保护界面。
 *
 * Electron API 一律通过 `PlatformEnvironment` 注入（`rules/testing-release.md`），
 * 因此本模块可在纯 Node 环境下完整测试。
 */

import { release } from 'node:os';

import type { AlwaysOnTopLevel } from '../config/config-types';
import {
  type ElectronAlwaysOnTopLevel,
  type MappedWindowLevel,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PlatformEnvironment,
  type TrayProtocol,
} from './platform-adapter';

/** 规格 §6 的置顶层级全集。 */
const ALL_ALWAYS_ON_TOP_LEVELS: AlwaysOnTopLevel[] = ['normal', 'floating', 'pop-up-menu', 'screen-saver'];

/** 规格 §8：Windows 上 `pop-up-menu` 及以上可覆盖任务栏。 */
const WINDOWS_TASKBAR_COVERING_LEVELS: AlwaysOnTopLevel[] = ['pop-up-menu', 'screen-saver'];

function normalizeDesktopEnvironment(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  // `XDG_CURRENT_DESKTOP` 形如 `ubuntu:GNOME`，取最后一段。
  const parts = trimmed.split(':').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

function deriveSessionType(env: Record<string, string | undefined>): string | undefined {
  const declared = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  if (declared) return declared;
  if (env.WAYLAND_DISPLAY?.trim()) return 'wayland';
  if (env.DISPLAY?.trim()) return 'x11';
  return undefined;
}

function deriveTray(environment: PlatformEnvironment): PlatformCapabilities['tray'] {
  const { platform } = environment;

  if (platform === 'win32') {
    return { available: true, protocol: 'windows-notification-area' };
  }

  if (platform === 'darwin') {
    return { available: true, protocol: 'macos-menu-bar' };
  }

  const protocol: TrayProtocol | undefined = environment.trayProtocol;
  if (protocol) {
    return { available: true, protocol };
  }

  // Linux：未确认到托盘协议时必须降级，且保留窗口内配置入口（规格 §10）。
  const probed = environment.trayProbed === true;
  return {
    available: false,
    reason: probed
      ? 'Linux 桌面未提供托盘协议（无 StatusNotifierItem 或 GTK 状态图标），已降级；请使用窗口内配置入口或命令行维护参数'
      : '尚未探测到托盘协议，按不可用处理；请使用窗口内配置入口或命令行维护参数',
  };
}

function deriveAlwaysOnTop(
  environment: PlatformEnvironment,
  wayland: boolean,
): PlatformCapabilities['alwaysOnTop'] {
  const { platform } = environment;

  if (platform === 'win32') {
    return {
      supported: true,
      levels: ALL_ALWAYS_ON_TOP_LEVELS,
      windowManagerControlled: false,
    };
  }

  if (platform === 'darwin') {
    return {
      supported: true,
      levels: ALL_ALWAYS_ON_TOP_LEVELS,
      windowManagerControlled: false,
      reason: 'macOS 映射为 Electron 的 NSWindow 层级，非 normal 层级需在目标 macOS 版本实测确认',
    };
  }

  // Linux X11：通过窗口管理器 always-on-top hint 请求，具体层级由 WM 决定。
  if (!wayland) {
    return {
      supported: true,
      levels: ALL_ALWAYS_ON_TOP_LEVELS,
      windowManagerControlled: true,
      reason: 'Linux X11 通过窗口管理器 always-on-top hint 请求置顶，具体层级由窗口管理器决定',
    };
  }

  // 规格 §8：Linux Wayland 下 Electron 当前不支持 always-on-top。
  return {
    supported: false,
    levels: [],
    windowManagerControlled: false,
    reason: 'Linux Wayland 下 Electron 当前不支持 always-on-top，已明确降级为不置顶',
  };
}

function deriveLoginItem(platform: PlatformCapabilities['platform']): PlatformCapabilities['loginItem'] {
  if (platform === 'win32') return { supported: true, mechanism: 'windows-run-key' };
  if (platform === 'darwin') return { supported: true, mechanism: 'macos-login-item' };
  return { supported: true, mechanism: 'xdg-autostart' };
}

function deriveDisplaySelection(environment: PlatformEnvironment): PlatformCapabilities['displaySelection'] {
  const count = environment.displays?.count;

  if (count === undefined) {
    return {
      available: false,
      count: 0,
      reason: '未注入显示器探测结果，暂按不可用处理；主进程应注入 Electron screen 模块的显示器列表',
    };
  }

  if (count <= 0) {
    return { available: false, count: 0, reason: '未探测到可用显示器' };
  }

  return { available: true, count };
}

/** 由注入的环境事实推导能力对象。纯函数，可跨平台测试。 */
export function deriveCapabilities(environment: PlatformEnvironment): PlatformCapabilities {
  // 会话类型、Wayland 与桌面环境都是 Linux 概念（`rules/platform.md`：Linux 必须区分 X11 与 Wayland）。
  // 非 Linux 平台上即使存在 XDG_* 变量也不据此判断能力，避免误判导致置顶被错误降级。
  const isLinux = environment.platform === 'linux';
  const sessionType = isLinux ? deriveSessionType(environment.env) : undefined;
  const wayland = isLinux && sessionType === 'wayland';

  return {
    platform: environment.platform,
    osVersion: environment.osRelease,
    arch: environment.arch,
    desktopEnvironment: isLinux ? normalizeDesktopEnvironment(environment.env.XDG_CURRENT_DESKTOP) : undefined,
    sessionType,
    wayland,
    tray: deriveTray(environment),
    alwaysOnTop: deriveAlwaysOnTop(environment, wayland),
    fullscreen: { supported: true },
    kiosk: { supported: true },
    loginItem: deriveLoginItem(environment.platform),
    displaySelection: deriveDisplaySelection(environment),
  };
}

/** 采集当前进程的真实环境事实。不导入 Electron，显示器需由调用方注入。 */
export async function collectPlatformEnvironment(
  overrides: Partial<PlatformEnvironment> = {},
): Promise<PlatformEnvironment> {
  const base: PlatformEnvironment = {
    platform: process.platform as PlatformEnvironment['platform'],
    osRelease: release(),
    arch: process.arch,
    env: process.env as Record<string, string | undefined>,
  };

  return { ...base, ...overrides };
}

/**
 * 探测平台能力。
 *
 * 默认采集当前进程事实；测试可注入 `PlatformEnvironment` 覆盖任意一项，
 * 从而在单一宿主机上验证 Windows、macOS、Linux X11 与 Linux Wayland 四种情况。
 */
export async function detectPlatformCapabilities(
  overrides: Partial<PlatformEnvironment> = {},
): Promise<PlatformCapabilities> {
  const environment = await collectPlatformEnvironment(overrides);
  return deriveCapabilities(environment);
}

/**
 * 把配置里的置顶层级映射为 Electron 调用参数与可达结果。
 *
 * 规格 §8 的逐平台策略：
 * - Windows：四层都支持；`pop-up-menu` 及以上可覆盖任务栏，但不覆盖 UAC、锁屏和安全桌面；
 * - macOS：映射为 Electron 的 NSWindow 层级，非 normal 层级需实测确认，不覆盖系统安全界面；
 * - Linux X11：请求 always-on-top hint，具体层级由窗口管理器决定；
 * - Linux Wayland：不支持，明确降级为不置顶。
 */
export function mapAlwaysOnTopLevel(
  level: AlwaysOnTopLevel,
  capabilities: PlatformCapabilities,
): MappedWindowLevel {
  const { alwaysOnTop } = capabilities;

  // `normal` 表示不请求置顶，任何平台都天然可达。
  if (level === 'normal') {
    return {
      requested: 'normal',
      electronLevel: 'normal',
      alwaysOnTop: false,
      effective: 'normal',
      degraded: false,
      windowManagerControlled: alwaysOnTop.windowManagerControlled,
      canCoverTaskbar: false,
      coversSystemSecureUi: false,
      requiresDeviceVerification: false,
    };
  }

  const levelSupported = alwaysOnTop.supported && alwaysOnTop.levels.includes(level);
  if (!levelSupported) {
    return {
      requested: level,
      electronLevel: 'normal',
      alwaysOnTop: false,
      effective: 'none',
      degraded: true,
      windowManagerControlled: false,
      canCoverTaskbar: false,
      coversSystemSecureUi: false,
      requiresDeviceVerification: false,
      reason:
        alwaysOnTop.reason ?? `平台不支持置顶层级 ${level}，已降级为不置顶`,
    };
  }

  // Linux X11：能请求置顶，但具体层级由窗口管理器决定，只能保证「在普通窗口之上」。
  if (alwaysOnTop.windowManagerControlled) {
    return {
      requested: level,
      electronLevel: level as ElectronAlwaysOnTopLevel,
      alwaysOnTop: true,
      effective: 'normal',
      degraded: true,
      windowManagerControlled: true,
      canCoverTaskbar: false,
      coversSystemSecureUi: false,
      requiresDeviceVerification: false,
      reason: `Linux X11 只能请求 always-on-top hint，具体层级由窗口管理器决定，无法保证达到 ${level}`,
    };
  }

  // macOS：层级可映射，但需在目标版本实测；不承诺覆盖 Dock。
  if (capabilities.platform === 'darwin') {
    return {
      requested: level,
      electronLevel: level as ElectronAlwaysOnTopLevel,
      alwaysOnTop: true,
      effective: level,
      degraded: false,
      windowManagerControlled: false,
      canCoverTaskbar: false,
      coversSystemSecureUi: false,
      requiresDeviceVerification: true,
      reason: `macOS 的 ${level} 层级映射为 Electron NSWindow 层级，需在目标 macOS 版本实测确认`,
    };
  }

  // Windows：四层都支持，按规格决定是否可覆盖任务栏。
  return {
    requested: level,
    electronLevel: level as ElectronAlwaysOnTopLevel,
    alwaysOnTop: true,
    effective: level,
    degraded: false,
    windowManagerControlled: false,
    canCoverTaskbar: WINDOWS_TASKBAR_COVERING_LEVELS.includes(level),
    coversSystemSecureUi: false,
    requiresDeviceVerification: false,
  };
}

/** 创建平台适配器，把能力对象与映射函数打包成单一入口。 */
export function createPlatformAdapter(
  capabilities: PlatformCapabilities,
  environment: PlatformEnvironment,
): PlatformAdapter {
  return {
    capabilities,
    detectCapabilities: async () => capabilities,
    mapAlwaysOnTopLevel: (level) => mapAlwaysOnTopLevel(level, capabilities),
    describeEnvironment: () => environment,
  };
}
