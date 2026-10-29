/**
 * 渲染进程崩溃恢复决策（规格 §7）。
 *
 * 远程页面崩溃、OOM 或被外部结束时不会产生 `did-fail-load`，重试控制器
 * （`retry-controller.ts`）不会被触发，主窗口会停留在白屏或 Chromium 崩溃页。
 * 本模块提供这类进程级故障的纯逻辑判定：滑动窗口内的崩溃计数决定
 * 「按 `retryIntervalSec` 自动重载」还是「展示离线页并停止自动重载」。
 *
 * 只做判定，不持有定时器与窗口：时间戳历史由调用方（AppController）持有并回传，
 * 因此可在纯 Node 环境下完整测试，也不依赖 Electron。
 */

/** 崩溃恢复动作：`reload` 按间隔自动重载；`offline` 转离线页并停止自动重载。 */
export type CrashRecoveryAction = 'reload' | 'offline';

/** 规格 §7：60 秒内连续崩溃 3 次即降级为离线页。 */
export const DEFAULT_CRASH_WINDOW_MS = 60_000;
export const DEFAULT_MAX_CRASHES = 3;

export interface CrashGuardOptions {
  /** 滑动窗口长度（毫秒）；窗口外的崩溃记录被淘汰。默认 60 秒。 */
  windowMs?: number;
  /** 窗口内触发离线页降级的连续崩溃次数。默认 3 次。 */
  maxCrashes?: number;
}

export interface CrashDecision {
  action: CrashRecoveryAction;
  /** 淘汰旧记录并纳入本次崩溃后的历史，供下一次决策继续使用。 */
  history: number[];
}

/**
 * `clean-exit` 属于预期退出：窗口关闭、页面正常销毁或用户主动结束进程。
 * 这类退出不应触发自动重载，也不计入崩溃窗口（规格 §7）。
 */
export function isRecoverableRendererExit(reason: string): boolean {
  return reason !== 'clean-exit';
}

/**
 * 判定一次渲染进程异常退出后的恢复动作。
 *
 * 入参 `history` 是窗口内此前的崩溃时间戳（毫秒），`now` 是本次崩溃时间；
 * 返回的 `history` 已淘汰窗口外记录并纳入本次崩溃，调用方应保存它。
 * 纯函数：不修改入参，可安全用于重放与测试。
 */
export function decideCrashRecovery(
  history: number[],
  now: number,
  options: CrashGuardOptions = {},
): CrashDecision {
  const windowMs = options.windowMs ?? DEFAULT_CRASH_WINDOW_MS;
  const maxCrashes = options.maxCrashes ?? DEFAULT_MAX_CRASHES;

  // 边界上的旧记录（恰好 windowMs 之前）已超出窗口，一并淘汰。
  const withinWindow = history.filter((at) => now - at < windowMs);
  const next = [...withinWindow, now];

  return { action: next.length >= maxCrashes ? 'offline' : 'reload', history: next };
}
