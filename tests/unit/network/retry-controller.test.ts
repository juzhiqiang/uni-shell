import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyLoadFailure,
  computeRetryDelayMs,
  isIgnorableLoadFailure,
  MAX_RETRY_INTERVAL_SEC,
  RetryController,
} from '../../../src/main/network/retry-controller';

function failure(
  errorCode: number,
  overrides: Partial<Electron.DidFailLoadEvent> & { httpResponseCode?: number } = {},
): Electron.DidFailLoadEvent & { httpResponseCode?: number } {
  return {
    errorCode,
    errorDescription: '',
    validatedURL: 'https://example.com/',
    isMainFrame: true,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe('classifyLoadFailure', () => {
  it.each([
    [-105, 'dns'],
    [-102, 'connection'],
    [-118, 'timeout'],
    [-200, 'tls'],
    [-324, 'http'],
    [-999, 'other'],
  ] as const)('classifies Chromium error %i as %s', (errorCode, kind) => {
    expect(classifyLoadFailure(failure(errorCode))).toBe(kind);
  });

  it.each([404, 500])('classifies HTTP %i responses', (httpResponseCode) => {
    expect(classifyLoadFailure(failure(-324, { httpResponseCode }))).toBe('http');
  });
});

describe('isIgnorableLoadFailure', () => {
  it('recognizes Chromium ERR_ABORTED', () => {
    expect(isIgnorableLoadFailure(failure(-3))).toBe(true);
    expect(isIgnorableLoadFailure(failure(-105))).toBe(false);
  });
});

describe('RetryController', () => {
  afterEach(() => vi.useRealTimers());

  it('ignores subframe failures', () => {
    const onRetry = vi.fn();
    const showOfflinePage = vi.fn();
    const controller = new RetryController({ retryIntervalSec: 3, onRetry, showOfflinePage });
    controller.start();

    controller.onLoadFailed(failure(-105, { isMainFrame: false }));

    expect(onRetry).not.toHaveBeenCalled();
    expect(showOfflinePage).not.toHaveBeenCalled();
    controller.stop();
  });

  it('does not show offline page or schedule retries for ERR_ABORTED', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const showOfflinePage = vi.fn();
    const controller = new RetryController({ retryIntervalSec: 3, onRetry, showOfflinePage });
    controller.start();

    controller.onLoadFailed(failure(-3));
    vi.advanceTimersByTime(3000);

    expect(showOfflinePage).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    controller.stop();
  });

  it('shows the offline page and retries at the configured interval', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const showOfflinePage = vi.fn();
    const controller = new RetryController({
      retryIntervalSec: 3,
      random: () => 0.5,
      onRetry,
      showOfflinePage,
    });
    controller.start();
    controller.onLoadFailed(failure(-105));

    expect(showOfflinePage).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2999);
    expect(onRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('does not create duplicate retry timers for repeated failures and only shows offline page once', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const showOfflinePage = vi.fn();
    const controller = new RetryController({
      retryIntervalSec: 3,
      random: () => 0.5,
      onRetry,
      showOfflinePage,
    });
    controller.start();
    controller.onLoadFailed(failure(-105));
    controller.onLoadFailed(failure(-118));

    expect(showOfflinePage).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(3000);
    expect(onRetry).toHaveBeenCalledOnce();

    // 后续重试再次触发失败时，不重复加载离线页
    controller.onLoadFailed(failure(-105));
    expect(showOfflinePage).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(6000);
    expect(onRetry).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('doubles retry interval on each attempt and caps at 300s', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const controller = new RetryController({
      retryIntervalSec: 50,
      random: () => 0.5,
      onRetry,
      showOfflinePage: vi.fn(),
    });
    controller.start();
    controller.onLoadFailed(failure(-105));

    // 第 1 次重试：50s
    vi.advanceTimersByTime(49_999);
    expect(onRetry).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledTimes(1);

    // 第 2 次重试：100s
    vi.advanceTimersByTime(99_999);
    expect(onRetry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledTimes(2);

    // 第 3 次重试：200s
    vi.advanceTimersByTime(199_999);
    expect(onRetry).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledTimes(3);

    // 第 4 次重试：min(400s, 300s) = 300s
    expect(MAX_RETRY_INTERVAL_SEC).toBe(300);
    vi.advanceTimersByTime(299_999);
    expect(onRetry).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledTimes(4);

    controller.stop();
  });

  it('applies ±20% jitter using injected random source', () => {
    // random() = 0 -> -20% (0.8x)
    expect(computeRetryDelayMs(10, 1, { random: () => 0 })).toBe(8_000);
    // random() = 0.5 -> 0% (1.0x)
    expect(computeRetryDelayMs(10, 1, { random: () => 0.5 })).toBe(10_000);
    // random() = 1 -> +20% (1.2x)
    expect(computeRetryDelayMs(10, 1, { random: () => 1 })).toBe(12_000);
    // 上限 300s 后同样按 ±20% 抖动（240s ~ 360s）
    expect(computeRetryDelayMs(100, 5, { random: () => 0 })).toBe(240_000);
    expect(computeRetryDelayMs(100, 5, { random: () => 1 })).toBe(360_000);
  });

  it('retryNow cancels queued timer and executes retry immediately', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const controller = new RetryController({
      retryIntervalSec: 10,
      random: () => 0.5,
      onRetry,
      showOfflinePage: vi.fn(),
    });
    controller.start();
    controller.onLoadFailed(failure(-105));

    // 原计划在 10s 时触发第 1 次重试；在 3s 时调用 retryNow()
    vi.advanceTimersByTime(3_000);
    expect(onRetry).not.toHaveBeenCalled();

    controller.retryNow();
    expect(onRetry).toHaveBeenCalledTimes(1);

    // 原 10s 定时器已被取消，到 10s 时不会额外触发
    vi.advanceTimersByTime(7_000);
    expect(onRetry).toHaveBeenCalledTimes(1);

    // 下一轮退避（20s）在 3s + 20s = 23s 时触发
    vi.advanceTimersByTime(13_000);
    expect(onRetry).toHaveBeenCalledTimes(2);

    controller.stop();
  });

  it('resets backoff count and offline page state after load succeeds', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const showOfflinePage = vi.fn();
    const controller = new RetryController({
      retryIntervalSec: 3,
      random: () => 0.5,
      onRetry,
      showOfflinePage,
    });
    controller.start();
    controller.onLoadFailed(failure(-105));

    // 经历两次重试（3s、6s）
    vi.advanceTimersByTime(3_000);
    vi.advanceTimersByTime(6_000);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(showOfflinePage).toHaveBeenCalledTimes(1);

    // 加载成功：退避计数与离线页状态归零
    controller.onLoadSucceeded();

    // 再次失败：离线页重新展示，且第 1 次重试间隔回到初始 3s（而非 12s）
    controller.onLoadFailed(failure(-105));
    expect(showOfflinePage).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(3_000);
    expect(onRetry).toHaveBeenCalledTimes(3);
    controller.stop();
  });

  it('keeps retrying when the offline page is disabled', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const showOfflinePage = vi.fn();
    const controller = new RetryController({
      retryIntervalSec: 3,
      offlinePageEnabled: false,
      random: () => 0.5,
      onRetry,
      showOfflinePage,
    });
    controller.start();
    controller.onLoadFailed(failure(-105));
    vi.advanceTimersByTime(3000);

    expect(onRetry).toHaveBeenCalledOnce();
    expect(showOfflinePage).not.toHaveBeenCalled();
    controller.stop();
  });

  it('keeps retrying until a successful load, then cancels the pending retry', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const controller = new RetryController({
      retryIntervalSec: 3,
      random: () => 0.5,
      onRetry,
      showOfflinePage: vi.fn(),
    });
    controller.start();
    controller.onLoadFailed(failure(-102));
    vi.advanceTimersByTime(3000);
    expect(onRetry).toHaveBeenCalledOnce();

    controller.onLoadSucceeded();
    vi.advanceTimersByTime(9000);
    expect(onRetry).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('does not restart the retry timer when a retry succeeds synchronously', () => {
    vi.useFakeTimers();
    let controller: InstanceType<typeof RetryController>;
    const onRetry = vi.fn(() => controller.onLoadSucceeded());
    controller = new RetryController({
      retryIntervalSec: 3,
      random: () => 0.5,
      onRetry,
      showOfflinePage: vi.fn(),
    });
    controller.start();
    controller.onLoadFailed(failure(-105));

    vi.advanceTimersByTime(9000);

    expect(onRetry).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('clears its timer on stop and does not schedule work before start', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const controller = new RetryController({ retryIntervalSec: 3, onRetry, showOfflinePage: vi.fn() });
    controller.onLoadFailed(failure(-105));
    vi.advanceTimersByTime(6000);
    expect(onRetry).not.toHaveBeenCalled();

    controller.start();
    controller.onLoadFailed(failure(-105));
    controller.stop();
    vi.advanceTimersByTime(6000);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('does not depend on network assets', () => {
    const html = readFileSync(new URL('../../../src/renderer/offline/offline.html', import.meta.url), 'utf8');

    expect(html).toContain('离线');
    expect(html).not.toMatch(/(?:src|href)=["']https?:\/\//i);
  });
});
