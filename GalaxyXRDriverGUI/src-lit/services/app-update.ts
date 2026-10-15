// Update info service, ported from src/app/services/app-update.service.ts.
// HttpClient is replaced by fetch with a one-in-flight guard preserved.
// "a newer GUI release exists" (updateAvailable) stays separate from
// "the staged GUI's corresponding driver should be installed"
// (installAvailable = the app is newer than the installed driver).
import { effect, signal } from '../reactive';
import { getVersion } from '@tauri-apps/api/app';
import { isNewVersion } from '../domain/pure';
import { latestReleaseApiUrl, releasesApiUrl } from '../domain/project';
import type { AppSetting } from '../domain/types';
import type { SystemDiagnosticService } from './system-diagnostic';

export type GitHubRelease = {
  tag_name: string,
  html_url: string
}
export type AppUpdateInfoSuccess = {
  fetchSuccess: boolean;
  latestVersion: string;
  currentVersion: string;
  updateAvailable: boolean;
  installAvailable: boolean;
  url: string;
};
export type AppUpdateInfo = AppUpdateInfoSuccess;

/** Dev Updates channel: the newest version-shaped tag of a releases list.
 * /releases/latest excludes pre-releases, so the list endpoint is used when
 * the channel is on; tags that are not version-shaped are skipped.
 * devChannel applies the owner's dev ordering (2026-10-15): on an equal
 * x.y.z base a pre-release ranks ABOVE its stable, so the newest dev build
 * wins even when its stable release also exists. */
export function selectNewestRelease(releases: GitHubRelease[], devChannel = false): GitHubRelease | undefined {
  let best: GitHubRelease | undefined;
  for (const candidate of releases) {
    if (!/^v?\d+\.\d+\.\d+/.test(candidate.tag_name)) continue;
    if (!best || isNewVersion(best.tag_name, candidate.tag_name, devChannel)) best = candidate;
  }
  return best;
}

export class AppUpdateService {
  private _updateInfo = signal<AppUpdateInfoSuccess | undefined>(undefined);
  public readonly updateInfo = this._updateInfo.asReadonly()
  constructor(public sds: SystemDiagnosticService, private appSettingGetter: () => AppSetting) {
    this.checkUpdate();
    effect(() => {
      const driverVersion = this.sds.driverInstalled();
      const updateInfo = this._updateInfo();
      if (driverVersion && updateInfo) {
        const current = updateInfo.currentVersion;
        const next = { ...updateInfo };
        next.installAvailable = isNewVersion(driverVersion, current);
        if (next.installAvailable !== updateInfo.installAvailable) this._updateInfo.set(next);
      }
    });
    // Dev Updates channel: a flip must take effect even when a check for the
    // previous channel is still in flight (2026-10-15). Chain a fresh check
    // after it settles instead of coalescing into a result for the old value.
    let observedDevUpdates: boolean | undefined;
    effect(() => {
      const devUpdates = !!this.appSettingGetter().devUpdates;
      if (observedDevUpdates !== undefined && devUpdates !== observedDevUpdates) {
        const rerun = () => { void this.checkUpdate(); };
        const pending = this.currentCheckTask;
        if (pending) pending.then(rerun, rerun);
        else rerun();
      }
      observedDevUpdates = devUpdates;
    });
  }
  private currentCheckTask?: Promise<AppUpdateInfo>;
  private async checkUpdateInternal(): Promise<AppUpdateInfo> {
    // getVersion is a core Tauri API, but a failure here must not escape as
    // an unhandled rejection (the constructor fires this without awaiting);
    // fall back to "Unknown" and let the check report its normal shape.
    let current = "Unknown";
    try {
      current = await getVersion();
    } catch (e) {
      console.warn(e);
    }
    // Read the channel once per run so this check stays internally consistent.
    const useDevUpdates = !!this.appSettingGetter().devUpdates;
    const result: AppUpdateInfoSuccess = {
      fetchSuccess: false,
      latestVersion: "Unknown",
      currentVersion: current,
      updateAvailable: false,
      installAvailable: false,
      url: ""
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(useDevUpdates ? releasesApiUrl : latestReleaseApiUrl, {
        signal: controller.signal,
        headers: { accept: 'application/vnd.github+json' },
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (useDevUpdates) {
        const releases: GitHubRelease[] = await response.json();
        // Dev ordering: on an equal x.y.z base a pre-release outranks its
        // stable, so a freshly promoted stable never reads as an update over
        // the dev build the user already runs.
        const release = selectNewestRelease(releases, true);
        result.fetchSuccess = true;
        // An empty (or fully non-version) list is a successful read with no
        // applicable release: no update and no URL.
        if (release) {
          result.latestVersion = release.tag_name
          result.updateAvailable = isNewVersion(current, release.tag_name, true)
          result.url = release.html_url
        }
      } else {
        const release: GitHubRelease = await response.json();
        result.fetchSuccess = true;
        result.latestVersion = release.tag_name
        result.updateAvailable = isNewVersion(current, release.tag_name)
        result.url = release.html_url
      }
    } catch (e) {
      console.warn(e)
    } finally {
      this.currentCheckTask = undefined;
      this._updateInfo.set(result);
      clearTimeout(timeout);
    }
    return result;
  }
  async checkUpdate(): Promise<AppUpdateInfo> {
    if (this.currentCheckTask) {
      return this.currentCheckTask;
    }
    return this.currentCheckTask = this.checkUpdateInternal()
  }
}
