import { computed, signal } from '../reactive';
import { t } from '../locale/i18n';
import { get_windows_startup, set_windows_startup, type WindowsStartupStatus } from '../platform/tauri';

/** Windows owns the setting. No preference mirror or automatic repair writes. */
export class WindowsStartupService {
  readonly status = signal<WindowsStartupStatus | undefined>(undefined);
  readonly error = signal<string | undefined>(undefined);
  readonly changing = signal(false);
  readonly enabled = computed(() => ['current', 'other-copy'].includes(this.status()?.state ?? ''));
  private disposed = false;
  private started?: Promise<void>;
  private activeChange?: Promise<void>;
  private revision = 0;
  private readonly onFocus = () => { void this.refresh(); };

  constructor(private readonly vendor: string) {}

  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.started) {
      window.addEventListener('focus', this.onFocus);
      this.started = this.refresh();
    }
    return this.started;
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.changing()) return;
    const revision = ++this.revision;
    try {
      const status = await get_windows_startup(this.vendor);
      if (this.disposed || revision !== this.revision) return;
      this.status.set(status);
      this.error.set(undefined);
    } catch (error) {
      if (this.disposed || revision !== this.revision) return;
      this.status.set(undefined);
      this.error.set(String(error));
    }
  }

  /** Enabling another copy is called only by the explicit Use this copy action. */
  setEnabled(enabled: boolean): Promise<void> {
    const status = this.status();
    if (this.disposed || this.changing() || !status?.supported || status.state === 'conflict') return Promise.resolve();
    this.changing.set(true);
    ++this.revision; // An older focus query cannot overwrite the mutation result.
    const task = this.apply(enabled, status.command);
    this.activeChange = task;
    return task.finally(() => { if (this.activeChange === task) this.activeChange = undefined; });
  }

  private async apply(enabled: boolean, expected: string | null): Promise<void> {
    this.error.set(undefined);
    try {
      const status = await set_windows_startup(this.vendor, enabled, expected);
      if (!this.disposed) this.status.set(status);
    } catch (error) {
      // A failed rollback can leave a different OS state. Query, never assume.
      let message = t('Windows startup could not be changed.') + ` ${String(error)}`;
      try {
        const status = await get_windows_startup(this.vendor);
        if (!this.disposed) this.status.set(status);
      } catch (readError) {
        if (!this.disposed) this.status.set(undefined);
        message += ` ${String(readError)}`;
      }
      if (!this.disposed) this.error.set(message);
    } finally {
      this.changing.set(false);
    }
  }

  idle(): Promise<void> { return this.activeChange ?? Promise.resolve(); }

  dispose(): void {
    this.disposed = true;
    ++this.revision;
    window.removeEventListener('focus', this.onFocus);
  }
}
