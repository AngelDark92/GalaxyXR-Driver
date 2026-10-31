import { effect, signal, untracked } from '../reactive';
import { exists, readTextFile, watchImmediate } from '@tauri-apps/plugin-fs';
import { cleanJsonComments, deepCopy, deepMerge } from '../domain/pure';
import { validateBooleanSettings } from '../domain/settings-inspection';
import { type DebouncedFileWriter, debouncedFileWriter } from '../platform/writer';
import type { AppSetting } from '../domain/types';

export enum FileReadErrorReason {
  NotExists = 'File not exists', ParsingFailed = 'Parsing failed', ReadFailed = 'Read failed',
}
export type FileReadError = { reason: FileReadErrorReason; message?: string };

/** Content-equality for JSON-derived settings trees (key order independent). */
function sameJsonValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => sameJsonValues(entry, b[index]));
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b);
  const held = Object.entries(a as Record<string, unknown>), incoming = Object.entries(b as Record<string, unknown>);
  if (held.length !== incoming.length) return false;
  const incomingKeys = new Map(incoming);
  return held.every(([key, value]) => incomingKeys.has(key) && sameJsonValues(value, incomingKeys.get(key)));
}

export abstract class JsonSettingServiceBase<T> {
  protected _values = signal<T | undefined>(undefined);
  public readonly values = this._values.asReadonly();
  protected _readFileError = signal<FileReadError | undefined>(undefined);
  public readonly readFileError = this._readFileError.asReadonly();
  private _writeFileError = signal<string | undefined>(undefined);
  public readonly writeFileError = this._writeFileError.asReadonly();
  private _storedValues = signal<unknown>(undefined);
  public readonly storedValues = this._storedValues.asReadonly();
  /** True only during an explicit disk inspection; migrations must not write. */
  public inspecting = false;
  protected readonly debouncedFileWriter: DebouncedFileWriter;
  protected _initTask: Promise<void>;
  public get initTask(): Promise<void> { return this._initTask; }
  protected defaults?: T;
  protected verified?: T;
  private saveSequence = 0;
  private pendingSaves = 0;
  private stopWatching?: () => void;
  private stopDefaults?: () => void;
  private disposed = false;
  public get filePath(): string { return this._filePath; }
  /** Snapshot of the authoritative defaults currently backing this service.
   * Used by Setup's read-only settings check; callers must not mutate it. */
  public effectiveDefaults(): T | undefined {
    return this.defaults === undefined ? undefined : structuredClone(this.defaults);
  }
  protected migrateLoadedValues(values: T): T { return values; }
  protected normalizeStoredValues(values: unknown): unknown { return values; }

  constructor(
    private _filePath: string, private _fileDir: string, private defaultValue: () => T | undefined,
    private defaultsWhenMissing: boolean, private watchFileforAutoReload: boolean,
    updateModeProvider: () => AppSetting | undefined,
  ) {
    if (!_filePath || !_fileDir) throw new Error('Settings service received an uninitialized path');
    this.debouncedFileWriter = debouncedFileWriter(_filePath, _fileDir, () => updateModeProvider()?.updateMode === 'rewrite');
    this.defaults = defaultValue() ?? {} as T;
    let defaultsKey = JSON.stringify(this.defaults);
    this._initTask = this.init();
    this.stopDefaults = effect(() => {
      const defaults = this.defaultValue() ?? {} as T;
      const key = JSON.stringify(defaults);
      this.defaults = defaults;
      if (key === defaultsKey) return;
      defaultsKey = key;
      // Changing runtime telemetry must not reload over an edit still in flight.
      void this._initTask.then(async () => {
        await this.debouncedFileWriter.flush();
        if (!this.disposed) await this.loadSetting();
      }).catch(error => console.warn('Could not refresh settings defaults', error));
    });
  }

  protected async init(): Promise<void> {
    try {
      await this.refreshWatch();
      await this.loadSetting();
    } catch (error) {
      this._readFileError.set({ reason: FileReadErrorReason.ReadFailed, message: String(error) });
      this._values.set(undefined);
    }
  }

  public async refreshWatch(): Promise<void> {
    this.stopWatching?.();
    this.stopWatching = undefined;
    if (!this.watchFileforAutoReload || this.disposed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visibilityListener: (() => void) | undefined;
    let hiddenReloadPending = false;
    const normalize = (path: string) => path.replaceAll('\\', '/').toLowerCase();
    // Driver heartbeat rewrites keep arriving while the window is hidden (or in
    // a headless test environment, where document does not exist and behavior
    // must stay "always visible"). Hide-period reloads are deferred, not dropped.
    const windowHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const onVisibility = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      if (!hiddenReloadPending) return;
      hiddenReloadPending = false;
      if (this.disposed || this.inspecting || this.debouncedFileWriter.isSavingFile()) return;
      void this.loadSetting(); // Run the one missed reload, not every missed rewrite.
    };
    const stopWatchResources = () => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (visibilityListener !== undefined) {
        document.removeEventListener('visibilitychange', visibilityListener);
        visibilityListener = undefined;
      }
    };
    try {
      if (!await exists(this._fileDir)) return;
      const unwatch = await watchImmediate(this._fileDir, event => {
        if (this.disposed || this.inspecting || this.debouncedFileWriter.isSavingFile()) return;
        if (!event.paths.some(path => normalize(path) === normalize(this._filePath))) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          if (this.disposed || this.inspecting || this.debouncedFileWriter.isSavingFile()) return;
          // Defer the debounced reload while the settings window is hidden.
          if (windowHidden()) { hiddenReloadPending = true; return; }
          void this.loadSetting();
        }, 100);
      });
      if (typeof document !== 'undefined') {
        visibilityListener = onVisibility;
        document.addEventListener('visibilitychange', onVisibility);
      }
      this.stopWatching = () => { unwatch(); stopWatchResources(); };
    } catch (error) {
      stopWatchResources();
      console.warn('Cannot watch settings directory; the Setup check can reload it manually', error);
    }
  }

  async loadSetting(): Promise<boolean> {
    // 2026-09-26: a watcher/runtime-default read can finish after a newer UI
    // save. Discard that result, including its errors and rollback snapshot.
    const sequence = this.saveSequence;
    const stale = () => this.disposed || sequence !== this.saveSequence;
    return navigator.locks.request(`loadfile_${this._filePath}`, async () => {
      if (stale()) return false;
      // A read requested after save() starts must see the completed write too.
      if (this.debouncedFileWriter.isSavingFile()) {
        try { await this.debouncedFileWriter.flush(); }
        catch { return false; } // save() owns write errors and rollback.
      }
      // save() can still be waiting for initialization before scheduling its
      // writer. Do not read in that gap, or wait for save() here: init itself
      // calls loadSetting(), so waiting would deadlock the initial save.
      if (stale() || this.pendingSaves > 0) return false;
      try {
        const fileExists = await exists(this._filePath);
        if (stale()) return false;
        if (!fileExists) {
          if (this.defaultsWhenMissing) {
            this.defaults = this.defaultValue() ?? {} as T;
            this._storedValues.set(undefined);
            this.verified = structuredClone(this.defaults);
            this._values.set(structuredClone(this.defaults));
            this._readFileError.set(undefined);
            return true;
          }
          this._readFileError.set({ reason: FileReadErrorReason.NotExists });
        } else {
          // Separate I/O failure from malformed JSON; neither represents Off.
          const text = await readTextFile(this._filePath);
          if (stale() || this.pendingSaves > 0) return false;
          try {
            this.defaults = this.defaultValue() ?? {} as T;
            const parsed = this.normalizeStoredValues(JSON.parse(cleanJsonComments(text)));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Settings must be a JSON object');
            validateBooleanSettings(parsed, this.defaults);
            const values = this.migrateLoadedValues(deepMerge(deepCopy(this.defaults) as any, parsed));
            // The driver rewrites files in this directory every couple of
            // seconds. A clean read that parses to the same stored and computed
            // values must not replace the held objects: fresh identities make
            // signal listeners re-render over an unchanged document. Reads are
            // untracked because they observe held state, not effect inputs.
            // First loads and changed/error reads still notify below.
            if (sameJsonValues(parsed, untracked(() => this._storedValues())) &&
                sameJsonValues(values, untracked(() => this._values()))) {
              this._readFileError.set(undefined);
              return true;
            }
            this._storedValues.set(structuredClone(parsed));
            this.verified = structuredClone(values);
            this._values.set(values);
            this._readFileError.set(undefined);
            return true;
          } catch (error) {
            this._readFileError.set({ reason: FileReadErrorReason.ParsingFailed, message: String(error) });
          }
        }
      } catch (error) {
        if (stale()) return false;
        this._readFileError.set({ reason: FileReadErrorReason.ReadFailed, message: String(error) });
      }
      this._storedValues.set(undefined);
      this._values.set(undefined);
      return false;
    });
  }

  /** Called after a confirmed native reset, never merely to hide save errors. */
  public async reloadAfterReset(): Promise<boolean> {
    ++this.saveSequence;
    const loaded = await this.loadSetting();
    if (loaded) this._writeFileError.set(undefined);
    return loaded;
  }

  public flush(): Promise<void> { return this.debouncedFileWriter.flush(); }

  /** Invalidate stale reads/writes after native removal, without creating files. */
  public clearAfterUninstall(): void {
    ++this.saveSequence;
    this.debouncedFileWriter.cancelPending();
    this.stopWatching?.(); this.stopWatching = undefined;
    this._storedValues.set(undefined);
    this.defaults = this.defaultValue() ?? {} as T;
    this.verified = this.defaultsWhenMissing ? structuredClone(this.defaults) : undefined;
    this._values.set(this.verified === undefined ? undefined : structuredClone(this.verified));
    this._writeFileError.set(undefined);
    this._readFileError.set(this.defaultsWhenMissing ? undefined : { reason: FileReadErrorReason.NotExists });
  }

  /**
   * Serializes the snapshot that save() writes. The default keeps only values
   * that differ from the effective defaults; subclasses may change the policy.
   */
  protected serializeForSave(snapshot: T): string {
    return JSON.stringify(deepCopy(snapshot, this.defaults ?? {}), undefined, 4);
  }

  async save(values: T): Promise<boolean> {
    if (this.inspecting || this.disposed) return false;
    const snapshot = structuredClone(values);
    const sequence = ++this.saveSequence;
    ++this.pendingSaves;
    try {
      await this._initTask;
      if (this.inspecting || this.disposed || sequence !== this.saveSequence) return false;
      this._values.set(snapshot);
      try {
        await this.debouncedFileWriter.save(this.serializeForSave(snapshot));
        this.verified = structuredClone(snapshot);
        this._writeFileError.set(undefined);
        return true;
      } catch (error) {
        if (sequence === this.saveSequence) {
          this._writeFileError.set(String(error));
          this._values.set(this.verified === undefined ? undefined : structuredClone(this.verified));
        }
        return false;
      }
    } finally {
      --this.pendingSaves;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching?.(); this.stopDefaults?.();
    this.debouncedFileWriter.dispose();
  }
}
