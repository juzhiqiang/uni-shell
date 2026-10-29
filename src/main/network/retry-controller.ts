export type LoadFailureKind = 'dns' | 'connection' | 'timeout' | 'tls' | 'http' | 'other';

export type LoadFailureDetails = Pick<Electron.DidFailLoadEvent, 'errorCode' | 'errorDescription' | 'isMainFrame'> & {
  /** Supplied by navigation events when an HTTP response code is available. */
  httpResponseCode?: number;
};

/** Navigation cancellations are expected during redirects and user-initiated navigation. */
export function isIgnorableLoadFailure(details: LoadFailureDetails): boolean {
  return details.errorCode === -3;
}

const dnsErrorCodes = new Set([-105, -137, -800, -801, -802, -803, -804, -805, -806, -807, -808, -809]);
const connectionErrorCodes = new Set([-101, -102, -103, -104, -106, -109, -111, -118]);
const tlsErrorCodes = new Set([-107, -110, -113, -115, -117]);

/**
 * Maps Chromium net error codes to operational categories for logging and recovery.
 *
 * 入参收敛到 `LoadFailureDetails`：分类只读取 errorCode / httpResponseCode，
 * 调用方（如 Task 9 的诊断编排）无需构造完整的 `DidFailLoadEvent`。
 */
export function classifyLoadFailure(details: LoadFailureDetails): LoadFailureKind {
  if (details.httpResponseCode !== undefined && details.httpResponseCode >= 400) return 'http';
  const { errorCode } = details;
  if (dnsErrorCodes.has(errorCode)) return 'dns';
  if (connectionErrorCodes.has(errorCode)) return errorCode === -118 ? 'timeout' : 'connection';
  if (errorCode === -7) return 'timeout';
  if (tlsErrorCodes.has(errorCode) || (errorCode <= -200 && errorCode >= -299)) return 'tls';
  if (errorCode === -324) return 'http';
  return 'other';
}

/** 指数退避的最大基准间隔（秒），规格 v2.1.3 §7。 */
export const MAX_RETRY_INTERVAL_SEC = 300;

/** 退避抖动幅度（±20%），规格 v2.1.3 §7。 */
export const RETRY_JITTER_RATIO = 0.2;

/**
 * 计算第 `attempt` 次重试（从 1 开始）的等待毫秒数：
 * `delay = min(retryIntervalSec × 2^(attempt - 1), maxIntervalSec) × (1 ± jitterRatio)`
 */
export function computeRetryDelayMs(
  retryIntervalSec: number,
  attempt: number,
  options: {
    maxIntervalSec?: number;
    jitterRatio?: number;
    random?: () => number;
  } = {},
): number {
  const maxIntervalSec = options.maxIntervalSec ?? MAX_RETRY_INTERVAL_SEC;
  const jitterRatio = options.jitterRatio ?? RETRY_JITTER_RATIO;
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, attempt - 1);
  const cappedSec = Math.min(retryIntervalSec * Math.pow(2, exponent), maxIntervalSec);
  const clampedRandom = Math.min(1, Math.max(0, random()));
  const jitterFactor = 1 + (clampedRandom * 2 - 1) * jitterRatio;
  return Math.round(cappedSec * 1000 * jitterFactor);
}

export interface RetryControllerOptions {
  retryIntervalSec: number;
  maxRetryIntervalSec?: number;
  offlinePageEnabled?: boolean;
  onRetry: () => void;
  showOfflinePage: () => void;
  /** 可注入随机源（返回值 ∈ [0, 1]），用于测试 ±20% 退避抖动。 */
  random?: () => number;
}

/** Owns the single retry timer for remote main-frame navigation. */
export class RetryController {
  private readonly retryIntervalSec: number;
  private readonly maxRetryIntervalSec: number;
  private readonly offlinePageEnabled: boolean;
  private readonly onRetry: () => void;
  private readonly showOfflinePage: () => void;
  private readonly random: () => number;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private offlinePageShown = false;
  private lastScheduledDelayMs: number | undefined;

  constructor(options: RetryControllerOptions) {
    if (!Number.isInteger(options.retryIntervalSec) || options.retryIntervalSec < 1) {
      throw new RangeError('retryIntervalSec 必须是大于 0 的整数');
    }
    this.retryIntervalSec = options.retryIntervalSec;
    this.maxRetryIntervalSec = options.maxRetryIntervalSec ?? MAX_RETRY_INTERVAL_SEC;
    this.offlinePageEnabled = options.offlinePageEnabled ?? true;
    this.onRetry = options.onRetry;
    this.showOfflinePage = options.showOfflinePage;
    this.random = options.random ?? Math.random;
  }

  /** 当前累计的退避轮次（加载成功后归零）。 */
  get attemptCount(): number {
    return this.attempts;
  }

  /** 当前故障周期内是否已展示过离线页。 */
  get isOfflinePageShown(): boolean {
    return this.offlinePageShown;
  }

  /** 是否正处于失败重试周期中。 */
  get isRetrying(): boolean {
    return this.attempts > 0 || this.timer !== undefined;
  }

  /** 最近一次排队的退避等待时长（毫秒）。 */
  get nextRetryDelayMs(): number | undefined {
    return this.lastScheduledDelayMs;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.attempts = 0;
    this.offlinePageShown = false;
    this.clearRetryTimer();
  }

  onLoadFailed(details: LoadFailureDetails): void {
    if (!this.running || !details.isMainFrame || isIgnorableLoadFailure(details)) return;

    // 规格 §7：离线页只在首次失败时展示一次，避免后续重试反复刷新离线页导致闪烁。
    if (this.offlinePageEnabled && !this.offlinePageShown) {
      this.offlinePageShown = true;
      this.showOfflinePage();
    }
    this.scheduleRetry();
  }

  onLoadSucceeded(): void {
    this.attempts = 0;
    this.offlinePageShown = false;
    this.clearRetryTimer();
  }

  /**
   * 立即触发一次重试（休眠唤醒、网络恢复或用户手动触发）：
   * 取消已排队的退避定时器并立即执行 `onRetry`；若处于重试周期内则排队下一轮退避兜底。
   */
  retryNow(): void {
    if (!this.running) return;
    const wasRetrying = this.isRetrying;
    this.clearRetryTimer();
    if (wasRetrying) {
      this.scheduleRetry();
    }
    this.onRetry();
  }

  private scheduleRetry(): void {
    if (!this.running || this.timer) return;

    this.attempts += 1;
    const delayMs = computeRetryDelayMs(this.retryIntervalSec, this.attempts, {
      maxIntervalSec: this.maxRetryIntervalSec,
      random: this.random,
    });
    this.lastScheduledDelayMs = delayMs;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running) return;

      this.scheduleRetry();
      this.onRetry();
    }, delayMs);
  }

  private clearRetryTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.lastScheduledDelayMs = undefined;
  }
}
