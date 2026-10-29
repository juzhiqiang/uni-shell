import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyLoadFailure, isIgnorableLoadFailure, RetryController } from '../../../src/main/network/retry-controller';

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
    const controller = new RetryController({ retryIntervalSec: 3, onRetry, showOfflinePage });
    controller.start();
    controller.onLoadFailed(failure(-105));

    expect(showOfflinePage).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2999);
    expect(onRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('does not create duplicate retry timers for repeated failures', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const controller = new RetryController({ retryIntervalSec: 3, onRetry, showOfflinePage: vi.fn() });
    controller.start();
    controller.onLoadFailed(failure(-105));
    controller.onLoadFailed(failure(-118));

    vi.advanceTimersByTime(3000);
    expect(onRetry).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(3000);
    expect(onRetry).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('keeps retrying when the offline page is disabled', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const showOfflinePage = vi.fn();
    const controller = new RetryController({
      retryIntervalSec: 3,
      offlinePageEnabled: false,
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
    const controller = new RetryController({ retryIntervalSec: 3, onRetry, showOfflinePage: vi.fn() });
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
    controller = new RetryController({ retryIntervalSec: 3, onRetry, showOfflinePage: vi.fn() });
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
