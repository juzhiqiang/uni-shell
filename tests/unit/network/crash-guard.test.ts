import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CRASH_WINDOW_MS,
  DEFAULT_MAX_CRASHES,
  decideCrashRecovery,
  isRecoverableRendererExit,
} from '../../../src/main/network/crash-guard';

/**
 * 规格 §7：渲染进程异常退出后的自动重载与离线页降级判定。
 * 决策保持纯函数：时间戳历史由调用方（AppController）持有，便于在纯 Node 下测试。
 */
describe('decideCrashRecovery', () => {
  it('首次崩溃按间隔自动重载，并把本次时间计入历史', () => {
    const decision = decideCrashRecovery([], 1_000);

    expect(decision.action).toBe('reload');
    expect(decision.history).toEqual([1_000]);
  });

  it('窗口内前两次崩溃仍自动重载', () => {
    const first = decideCrashRecovery([], 1_000);
    const second = decideCrashRecovery(first.history, 2_000);

    expect(second.action).toBe('reload');
    expect(second.history).toEqual([1_000, 2_000]);
  });

  it('窗口内连续崩溃达到阈值时改为展示离线页', () => {
    const first = decideCrashRecovery([], 1_000);
    const second = decideCrashRecovery(first.history, 2_000);
    const third = decideCrashRecovery(second.history, 3_000);

    expect(third.action).toBe('offline');
    expect(third.history).toEqual([1_000, 2_000, 3_000]);
  });

  it('达到阈值后继续崩溃仍保持离线页，不回到自动重载', () => {
    const third = decideCrashRecovery([1_000, 2_000], 3_000);
    expect(third.action).toBe('offline');

    const fourth = decideCrashRecovery(third.history, 4_000);

    expect(fourth.action).toBe('offline');
  });

  it('淘汰窗口外的旧崩溃记录', () => {
    const decision = decideCrashRecovery([0, 1_000], DEFAULT_CRASH_WINDOW_MS + 2_000);

    expect(decision.action).toBe('reload');
    expect(decision.history).toEqual([DEFAULT_CRASH_WINDOW_MS + 2_000]);
  });

  it('窗口边界上的旧记录同样被淘汰', () => {
    // 恰好 windowMs 之前的记录已超出窗口；59 秒前的记录仍在窗口内。
    const decision = decideCrashRecovery([0, DEFAULT_CRASH_WINDOW_MS - 1_000], DEFAULT_CRASH_WINDOW_MS);

    expect(decision.history).toEqual([DEFAULT_CRASH_WINDOW_MS - 1_000, DEFAULT_CRASH_WINDOW_MS]);
    expect(decision.action).toBe('reload');
  });

  it('旧记录淘汰后重新获得完整的崩溃配额', () => {
    // 60 秒外的两次崩溃不计入窗口：本次是窗口内第 1 次。
    const decision = decideCrashRecovery([0, 500], DEFAULT_CRASH_WINDOW_MS + 1);

    expect(decision.action).toBe('reload');
    const second = decideCrashRecovery(decision.history, DEFAULT_CRASH_WINDOW_MS + 2);
    const third = decideCrashRecovery(second.history, DEFAULT_CRASH_WINDOW_MS + 3);

    expect(third.action).toBe('offline');
  });

  it('支持自定义窗口长度与阈值', () => {
    const options = { windowMs: 5_000, maxCrashes: 2 };
    const first = decideCrashRecovery([], 1_000, options);
    const second = decideCrashRecovery(first.history, 2_000, options);

    expect(second.action).toBe('offline');

    // 超出 5 秒窗口后旧记录失效，配额重新计算。
    const later = decideCrashRecovery(second.history, 9_000, options);
    expect(later.action).toBe('reload');
  });

  it('不修改调用方传入的历史数组', () => {
    const history = [1_000, 2_000];

    const decision = decideCrashRecovery(history, 3_000);

    expect(history).toEqual([1_000, 2_000]);
    expect(decision.history).not.toBe(history);
  });

  it('默认窗口与阈值对应规格 §7 的 60 秒 / 3 次', () => {
    expect(DEFAULT_CRASH_WINDOW_MS).toBe(60_000);
    expect(DEFAULT_MAX_CRASHES).toBe(3);
  });
});

describe('isRecoverableRendererExit', () => {
  it('clean-exit 属于预期退出，不触发自动重载', () => {
    expect(isRecoverableRendererExit('clean-exit')).toBe(false);
  });

  it.each(['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'])(
    '渲染进程 %s 需要自动恢复',
    (reason) => {
      expect(isRecoverableRendererExit(reason)).toBe(true);
    },
  );
});
