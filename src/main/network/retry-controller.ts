export type LoadFailureKind = 'dns' | 'connection' | 'timeout' | 'tls' | 'http' | 'other';

export type LoadFailureDetails = Pick<Electron.DidFailLoadEvent, 'errorCode' | 'errorDescription' | 'isMainFrame'> & {
  /** Supplied by navigation events when an HTTP response code is available. */
  httpResponseCode?: number;
};

const dnsErrorCodes = new Set([-105, -137, -800, -801, -802, -803, -804, -805, -806, -807, -808, -809]);
const connectionErrorCodes = new Set([-101, -102, -103, -104, -106, -109, -111, -118]);
const tlsErrorCodes = new Set([-107, -110, -113, -115, -117]);

/** Maps Chromium net error codes to operational categories for logging and recovery. */
export function classifyLoadFailure(details: Electron.DidFailLoadEvent & { httpResponseCode?: number }): LoadFailureKind {
  if (details.httpResponseCode !== undefined && details.httpResponseCode >= 400) return 'http';
  const { errorCode } = details;
  if (dnsErrorCodes.has(errorCode)) return 'dns';
  if (connectionErrorCodes.has(errorCode)) return errorCode === -118 ? 'timeout' : 'connection';
  if (errorCode === -7) return 'timeout';
  if (tlsErrorCodes.has(errorCode) || (errorCode <= -200 && errorCode >= -299)) return 'tls';
  if (errorCode === -324) return 'http';
  return 'other';
}

export interface RetryControllerOptions {
  retryIntervalSec: number;
  offlinePageEnabled?: boolean;
  onRetry: () => void;
  showOfflinePage: () => void;
}

/** Owns the single retry timer for remote main-frame navigation. */
export class RetryController {
  private readonly retryIntervalMs: number;
  private readonly offlinePageEnabled: boolean;
  private readonly onRetry: () => void;
  private readonly showOfflinePage: () => void;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RetryControllerOptions) {
    if (!Number.isInteger(options.retryIntervalSec) || options.retryIntervalSec < 1) {
      throw new RangeError('retryIntervalSec 必须是大于 0 的整数');
    }
    this.retryIntervalMs = options.retryIntervalSec * 1000;
    this.offlinePageEnabled = options.offlinePageEnabled ?? true;
    this.onRetry = options.onRetry;
    this.showOfflinePage = options.showOfflinePage;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.clearRetryTimer();
  }

  onLoadFailed(details: LoadFailureDetails): void {
    if (!this.running || !details.isMainFrame) return;

    if (this.offlinePageEnabled) this.showOfflinePage();
    this.scheduleRetry();
  }

  onLoadSucceeded(): void {
    this.clearRetryTimer();
  }

  private scheduleRetry(): void {
    if (!this.running || this.timer) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running) return;

      this.scheduleRetry();
      this.onRetry();
    }, this.retryIntervalMs);
  }

  private clearRetryTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
