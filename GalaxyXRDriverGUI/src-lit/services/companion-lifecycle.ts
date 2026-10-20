import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { computed, signal } from '../reactive';
import { subscribeLocale, t } from '../locale/i18n';
import { complete_companion_quit, sync_companion_lifecycle } from '../platform/tauri';
import { flushFileWrites } from '../platform/writer';
import type { AppSettingService } from './app-setting';

/** GUI preferences own persistence; native lifecycle sees confirmed values only. */
export class CompanionLifecycleService {
  private preferenceError = signal<string | undefined>(undefined);
  private nativeError = signal<string | undefined>(undefined);
  private operationError = signal<string | undefined>(undefined);
  public readonly error = computed(() => {
    const errors = [this.operationError(), this.nativeError(), this.preferenceError()].filter(Boolean);
    return errors.length ? [...new Set(errors)].join(' ') : undefined;
  }).asReadonly();
  private _changing = signal(false);
  public readonly changing = this._changing.asReadonly();
  private _quitting = signal(false);
  public readonly quitting = this._quitting.asReadonly();
  private activeChange?: Promise<void>;
  private started?: Promise<void>;
  private stops: UnlistenFn[] = [];
  private disposed = false;
  private ready = false;
  private queue: Promise<void> = Promise.resolve();
  private lastRequested = '';
  private quitTokens = new Set<number>();

  constructor(private readonly appSetting: AppSettingService) {}

  public start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.started ??= this.initialize();
  }

  private async attach<T>(name: string, callback: (payload: T) => void): Promise<void> {
    const stop = await listen<T>(name, event => { if (!this.disposed) callback(event.payload); });
    if (this.disposed) stop();
    else this.stops.push(stop);
  }

  private async initialize(): Promise<void> {
    try {
      // Register before enabling native close interception: Quit needs its ack.
      await this.attach<number>('companion-quit-requested', token => { void this.quit(token); });
      if (this.disposed) return;
      await this.attach<string>('companion-lifecycle-error', error => this.nativeError.set(error));
      if (this.disposed) return;
      await this.attach<number>('companion-quit-aborted', token => {
        this.quitTokens.delete(token);
        if (!this.quitTokens.size) this._quitting.set(false);
      });
      if (this.disposed) return;
      this.stops.push(
        this.appSetting.confirmedValues.subscribe(() => { void this.synchronize(); }),
        this.appSetting.readFileError.subscribe(() => { void this.synchronize(); }),
        subscribeLocale(() => { void this.synchronize(); }),
      );
      this.ready = true;
      await this.synchronize();
    } catch (error) {
      this.nativeError.set(String(error));
      for (const stop of this.stops.splice(0)) stop();
    }
  }

  private synchronize(): Promise<void> {
    if (!this.ready || this.disposed) return Promise.resolve();
    const confirmed = this.appSetting.confirmedValues();
    const valid = confirmed !== undefined && this.appSetting.readFileError() === undefined;
    this.preferenceError.set(valid ? undefined : t('App preferences could not be read. The Companion will stay accessible in the taskbar.'));
    // Invalid preferences must never enable hiding using an in-memory default.
    const enabled = valid ? confirmed.minimizeToTray : false;
    const labels = { open: t('Open Companion'), quit: t('Quit'), tooltip: t('Galaxy XR Companion') };
    const key = JSON.stringify({ enabled, labels });
    if (key === this.lastRequested) return this.queue;
    this.lastRequested = key;
    this.queue = this.queue.then(async () => {
      if (this.disposed) return;
      try {
        await sync_companion_lifecycle(enabled, labels);
        if (!this.disposed) this.nativeError.set(undefined);
      } catch (error) {
        if (key === this.lastRequested) this.lastRequested = '';
        if (!this.disposed) this.nativeError.set(String(error));
      }
    });
    return this.queue;
  }

  public setMinimizeToTray(enabled: boolean): Promise<void> {
    if (this.disposed || this._changing() || this._quitting()) return Promise.resolve();
    const task = this.applyMinimizeToTray(enabled);
    this.activeChange = task;
    return task.finally(() => { if (this.activeChange === task) this.activeChange = undefined; });
  }

  private async applyMinimizeToTray(enabled: boolean): Promise<void> {
    this._changing.set(true);
    this.operationError.set(undefined);
    try {
      const saved = await this.appSetting.save({ ...this.appSetting.values(), minimizeToTray: enabled });
      if (this.disposed) return;
      if (!saved) {
        const detail = this.appSetting.writeFileError();
        this.operationError.set(t('App preferences could not be saved. Tray behavior was not changed.') + (detail ? ` ${detail}` : ''));
        return;
      }
      await this.synchronize();
    } catch (error) {
      if (!this.disposed) this.operationError.set(String(error));
    } finally {
      this._changing.set(false);
    }
  }

  private async quit(token: number): Promise<void> {
    if (this.quitTokens.has(token)) return;
    this.quitTokens.add(token);
    // The shell becomes inert from this signal before any asynchronous flush.
    // Hold it through acknowledgement so no control can queue a later write.
    this._quitting.set(true);
    try {
      let error: string | null = null;
      try {
        await this.activeChange;
        if (!this.quitTokens.has(token)) return;
        // save() first awaits initialized services. Let already-requested saves
        // schedule their writer before taking the global flush snapshot.
        await Promise.resolve();
        if (!this.quitTokens.has(token)) return;
        await flushFileWrites();
      } catch (failure) {
        if (!this.quitTokens.has(token)) return;
        error = t('Could not save settings before quitting: {error}', { error: String(failure) });
        if (!this.disposed) this.operationError.set(error);
      }
      // Native timeout recovery may release editing while a save is hung. Its
      // eventual completion belongs to the cancelled token and cannot quit later.
      if (!this.quitTokens.has(token)) return;
      try { await complete_companion_quit(token, error); }
      catch (failure) { if (!this.disposed) this.nativeError.set(String(failure)); }
    } finally {
      this.quitTokens.delete(token);
      if (!this.quitTokens.size) this._quitting.set(false);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.ready = false;
    for (const stop of this.stops.splice(0)) stop();
  }
}
