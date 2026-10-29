/**
 * 登录自启与延迟启动。
 *
 * 规则来源：规格 v2.1 §9（开机自启与延迟展示）与 `rules/platform.md`「平台适配」。
 *
 * - Windows 写入当前用户启动项；macOS 使用登录项/LaunchAgent；Linux 写入 XDG autostart；
 * - 延迟逻辑由应用内部状态机控制，不依赖各操作系统精度不同的调度器；
 * - Electron API 通过端口注入，测试不依赖真实登录项。
 */

import type { LaunchContext } from '../instance/single-instance';
import { detectLaunchContext } from '../instance/single-instance';

export { detectLaunchContext };
export type { LaunchContext } from '../instance/single-instance';
export { LOGIN_LAUNCH_FLAG } from '../instance/single-instance';
/** 规格 §6：`startup.delaySec` 为 0～3600 的整数。 */
export const MIN_DELAY_SEC = 0;
export const MAX_DELAY_SEC = 3600;

export interface CancelableDelay {
  cancel(): void;
  readonly pending: boolean;
}

/**
 * 是否需要延迟。
 *
 * 规格 §9：`delayOnlyOnLogin=true` 时延迟只对登录启动生效，手动启动立即执行。
 * 该判断由启动策略持有，供 AppController 决定是否进入 `awaiting-delay`。
 */
export function shouldApplyDelay(config: { delaySec: number; delayOnlyOnLogin: boolean }, context: LaunchContext): boolean {
  return clampDelaySec(config.delaySec) > 0 && (!config.delayOnlyOnLogin || context.source === 'login');
}

/** 把 delaySec 收敛到规格允许的 0～3600 区间；非有限数按 0 处理。 */
export function clampDelaySec(value: number): number {
  if (!Number.isFinite(value)) return MIN_DELAY_SEC;
  const rounded = Math.floor(value);
  if (rounded < MIN_DELAY_SEC) return MIN_DELAY_SEC;
  if (rounded > MAX_DELAY_SEC) return MAX_DELAY_SEC;
  return rounded;
}

/**
 * 延迟到点触发 `onReady`，可取消。
 *
 * 规格 §9：延迟期间保持托盘或最小化状态；托盘「立即显示窗口」取消倒计时。
 * 到点或取消后 `pending` 均为 false，避免泄漏重试定时器。
 */
export function runStartupDelay(
  config: { delaySec: number; delayOnlyOnLogin: boolean },
  context: LaunchContext,
  onReady: () => void,
): CancelableDelay {
  if (!shouldApplyDelay(config, context)) {
    onReady();
    return { cancel: () => {}, get pending() { return false; } };
  }

  let cancelled = false;
  let fired = false;
  const timer = setTimeout(() => {
    if (cancelled) return;
    fired = true;
    onReady();
  }, clampDelaySec(config.delaySec) * 1000);

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
}

export type LoginItemMechanism = 'windows-run-key' | 'macos-login-item' | 'xdg-autostart';

export interface LoginItemResult {
  ok: boolean;
  /** 操作后登录项是否处于启用状态。 */
  enabled: boolean;
  mechanism?: LoginItemMechanism;
  /** 失败或降级原因。 */
  reason?: string;
  /** 实际写入位置，便于诊断。 */
  location?: string;
}

/** Electron 登录项能力的端口抽象。 */
export interface LoginItemPort {
  platform: 'win32' | 'darwin' | 'linux';
  /** 设置或清除登录项。 */
  apply(enabled: boolean): Promise<{ ok: boolean; location?: string; reason?: string }>;
  /** 查询当前状态。 */
  query(): Promise<boolean>;
}

export interface SetOpenAtLoginOptions {
  /** 必须注入；未注入时抛错，避免静默改写失败。 */
  port?: LoginItemPort;
}

function mechanismFor(platform: LoginItemPort['platform']): LoginItemMechanism {
  if (platform === 'win32') return 'windows-run-key';
  if (platform === 'darwin') return 'macos-login-item';
  return 'xdg-autostart';
}

/**
 * 设置或清除登录自启。
 *
 * 规格 §9：Windows 写入当前用户启动项；macOS 创建当前用户 LaunchAgent 或使用登录项 API；
 * Linux 写入 `~/.config/autostart/*.desktop`。
 * 失败时返回 `ok: false` 与可操作原因，不谎报成功。
 */
export async function setOpenAtLogin(
  enabled: boolean,
  options: SetOpenAtLoginOptions = {},
): Promise<LoginItemResult> {
  const port = options.port;
  if (!port) {
    throw new Error('setOpenAtLogin 需要注入 LoginItemPort；缺少端口时无法确认登录项是否写入成功');
  }

  const mechanism = mechanismFor(port.platform);

  try {
    const current = await port.query();
    if (current === enabled) {
      return { ok: true, enabled, mechanism };
    }

    const applied = await port.apply(enabled);
    if (!applied.ok) {
      return { ok: false, enabled: false, mechanism, reason: applied.reason ?? '登录项写入失败' };
    }
    return { ok: true, enabled, mechanism, location: applied.location };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, enabled: false, mechanism, reason: `登录项写入失败：${detail}` };
  }
}
