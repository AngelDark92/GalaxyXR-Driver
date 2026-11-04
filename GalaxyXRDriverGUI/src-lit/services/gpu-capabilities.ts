// GPU capability probe lifecycle (2026-11-03).
//
// Holds the result of the Tauri `get_gpu_capabilities` command. The adapter
// inventory is static for a process, so a successful result stays in place
// until a newer one replaces it: it is never dropped on a timer, which would
// make hardware gates vanish seconds after launch. Refreshes are bounded:
// a probe that does not answer within PROBE_TIMEOUT_MS is abandoned (the
// previous result, or "unknown", stays on screen) so startup never waits on a
// hung probe. A failed or timed-out refresh keeps the previous result.
import { signal } from '../reactive';
import { get_gpu_capabilities, type DriverRuntimeStatus } from '../platform/tauri';
import type { GpuCapabilities } from '../domain/types';

/** Re-probe interval and the window in which a result counts as fresh. */
export const GPU_REFRESH_MS = 60_000;
/** Longest a single probe may take before it is abandoned. */
export const GPU_PROBE_TIMEOUT_MS = 8_000;

export class GpuCapabilitiesService {
  private readonly _caps = signal<GpuCapabilities | undefined>(undefined);
  readonly caps = this._caps.asReadonly();
  private readonly _error = signal<string | undefined>(undefined);
  readonly error = this._error.asReadonly();
  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();
  /** Resolves after the first refresh attempt finishes (success, error or timeout). */
  readonly ready: Promise<void>;
  private running?: Promise<void>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private lastSuccessAt?: number;
  private lastAttemptAt?: number;
  private disposed = false;

  constructor(private readonly startupStatus: { (): DriverRuntimeStatus | undefined }) {
    this.invalidate();
    // Start the initial probe immediately; downstream consumers (OFXR restore)
    // can await ready so hardware gates are not evaluated against undefined.
    this.ready = this.refresh().catch(() => {});
  }

  /** Drop any cached result and cancel the refresh timer. */
  invalidate(): void {
    this._caps.set(undefined);
    this._error.set(undefined);
    this._loading.set(false);
    this.lastSuccessAt = undefined;
    this.clearRefreshTimer();
  }

  /** Request a fresh probe. Concurrent calls share the in-flight promise. */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    if (this.disposed) return Promise.resolve();
    this._loading.set(true);
    this.lastAttemptAt = Date.now();
    this.running = (async () => {
      try {
        const result = await withTimeout(get_gpu_capabilities(), GPU_PROBE_TIMEOUT_MS);
        if (this.disposed) return;
        if (!result || !Array.isArray(result.adapters) || typeof result.checkedAt !== 'number') {
          throw new Error('The backend returned an invalid GPU capability report.');
        }
        if (result.error) {
          // The backend reported a problem. Valid adapter entries are still
          // usable (individual hints may be unknown), but this is not a clean
          // success: surface the reason and do not mark the probe fresh. An
          // empty inventory keeps the previous result.
          if (result.adapters.length > 0) this._caps.set(result);
          this._error.set(result.error);
          return;
        }
        this._caps.set(result);
        this._error.set(undefined);
        this.lastSuccessAt = Date.now();
      } catch (error) {
        // Keep the previous result: a transient failure must not flip the UI.
        if (!this.disposed) this._error.set(String(error));
      } finally {
        this._loading.set(false);
        this.armRefreshTimer();
      }
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  /** Refresh only when the last attempt is older than the refresh window. */
  refreshIfStale(now = Date.now()): Promise<void> {
    if (this.running) return this.running;
    if (this.lastAttemptAt !== undefined && now - this.lastAttemptAt < GPU_REFRESH_MS) return Promise.resolve();
    return this.refresh();
  }

  /** True when a successful probe happened inside the refresh window. */
  isFresh(now = Date.now()): boolean {
    return this.lastSuccessAt !== undefined && now - this.lastSuccessAt <= GPU_REFRESH_MS;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private armRefreshTimer(): void {
    this.clearRefreshTimer();
    if (this.disposed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, GPU_REFRESH_MS);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The GPU capability probe timed out.')), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
