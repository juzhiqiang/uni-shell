/**
 * 托盘与焦点快捷键。
 *
 * 规则来源：规格 v2.1 §10（托盘与运维入口）与 `rules/platform.md`「平台适配」。
 *
 * - 托盘目标：Windows 通知区域、macOS 菜单栏、Linux StatusNotifierItem；
 * - 托盘菜单固定包含：打开配置界面、重新加载网页、立即显示窗口、退出程序；
 * - Linux 桌面未提供托盘协议时不得崩溃，应记录降级并保留窗口内配置入口；
 * - 快捷键只在客户端窗口获得焦点时生效，不得注册系统全局快捷键。
 */

import type { PlatformCapabilities, TrayProtocol } from '../platform/platform-adapter';

/** 规格 §10 的四个固定托盘动作。 */
export interface TrayActions {
  showWindow(): void | Promise<void>;
  openConfig(): void | Promise<void>;
  reload(): void | Promise<void>;
  quit(): void | Promise<void>;
}

export interface TrayResult {
  ok: boolean;
  protocol?: TrayProtocol;
  /** 是否发生降级（托盘不可用或创建失败）。 */
  degraded: boolean;
  reason?: string;
  /** 降级时给用户的替代入口提示。 */
  fallback?: string;
}

/** Electron 托盘能力的端口抽象；菜单构建细节由适配层决定。 */
export interface TrayPort {
  create(actions: TrayActions): { ok: boolean; reason?: string };
  destroy(): void;
}

export interface CreateTrayOptions {
  port?: TrayPort;
}

/** 托盘不可用时保留的替代入口（规格 §10）。 */
const TRAY_FALLBACK_HINT = '请使用窗口内配置入口或命令行维护参数';

/**
 * 创建托盘。
 *
 * 能力不可用或创建失败时返回降级结果而不抛出——托盘不可用不得导致主程序退出。
 */
export function createTray(
  actions: TrayActions,
  capabilities: PlatformCapabilities,
  options: CreateTrayOptions = {},
): TrayResult {
  const { tray } = capabilities;
  const protocol = tray.protocol;

  if (!tray.available) {
    return {
      ok: false,
      protocol,
      degraded: true,
      reason: tray.reason ?? '托盘不可用',
      fallback: TRAY_FALLBACK_HINT,
    };
  }

  const port = options.port;
  if (!port) {
    return {
      ok: false,
      protocol,
      degraded: true,
      reason: '未注入 TrayPort，无法创建托盘',
      fallback: TRAY_FALLBACK_HINT,
    };
  }

  const created = port.create(actions);
  if (!created.ok) {
    return {
      ok: false,
      protocol,
      degraded: true,
      reason: created.reason ?? '托盘创建失败',
      fallback: TRAY_FALLBACK_HINT,
    };
  }

  return { ok: true, protocol, degraded: false };
}

export interface KeyBinding {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

const MODIFIER_ALIASES: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
};

/**
 * 解析 `Ctrl+Alt+Shift+F12` 形式的快捷键绑定。
 *
 * 主键取最后一段。以下情况返回 undefined：空串、存在空段（如 `Ctrl+`）、
 * 主键本身是修饰键名（如单独一个 `Ctrl`）、或含无法识别的段。
 * 这样配置里写错的绑定会被发现，而不是静默绑定到一个永不触发的键上。
 */
export function parseKeyBinding(binding: string): KeyBinding | undefined {
  const segments = binding.split('+').map((segment) => segment.trim());

  if (segments.length === 0) return undefined;
  if (segments.some((segment) => segment.length === 0)) return undefined;

  const key = segments[segments.length - 1];
  if (MODIFIER_ALIASES[key.toLowerCase()]) return undefined;

  const modifiers: KeyBinding = { key: key.toUpperCase(), ctrl: false, alt: false, shift: false, meta: false };

  for (const segment of segments.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[segment.toLowerCase()];
    if (!modifier) return undefined;
    modifiers[modifier] = true;
  }

  return modifiers;
}

/** 键盘事件的端口抽象，避免直接依赖 Electron 的 Input 类型。 */
export interface ShortcutTarget {
  isFocused(): boolean;
  onBeforeInput(handler: (event: ShortcutInputEvent) => void): void;
}

export interface ShortcutInputEvent {
  key: string;
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  preventDefault(): void;
}

export interface ShortcutHandle {
  dispose(): void;
}

function matches(binding: KeyBinding, event: ShortcutInputEvent): boolean {
  return (
    event.key.toUpperCase() === binding.key &&
    event.control === binding.ctrl &&
    event.alt === binding.alt &&
    event.shift === binding.shift &&
    event.meta === binding.meta
  );
}

/**
 * 安装仅在本窗口获得焦点时生效的快捷键。
 *
 * 规格 §10 与 `AGENTS.md`：不得注册系统全局快捷键。这里监听窗口自身的
 * `before-input-event`，并在每次触发时复核 `isFocused()`，
 * 因此窗口失焦后同一组合键不会被执行。
 */
export function installFocusedShortcut(
  target: ShortcutTarget,
  binding: string,
  onInvoke: () => void,
): ShortcutHandle | undefined {
  const parsed = parseKeyBinding(binding);
  if (!parsed) return undefined;

  let disposed = false;
  target.onBeforeInput((event) => {
    if (disposed) return;
    // 焦点复核：失焦时不响应，也不阻止默认行为。
    if (!target.isFocused()) return;
    if (!matches(parsed, event)) return;
    event.preventDefault();
    onInvoke();
  });

  return {
    dispose() {
      disposed = true;
    },
  };
}
