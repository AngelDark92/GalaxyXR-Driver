import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getVersion } from '@tauri-apps/api/app';
import { signal } from '../reactive';
import { AppUpdateService } from './app-update';
import type { AppSetting } from '../domain/types';
import type { SystemDiagnosticService } from './system-diagnostic';

vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn() }));

const latestEndpoint = 'https://api.github.com/repos/AngelDark92/GalaxyXR-Driver/releases/latest';
const releasesEndpoint = 'https://api.github.com/repos/AngelDark92/GalaxyXR-Driver/releases?per_page=30';
const releaseUrl = 'https://github.com/AngelDark92/GalaxyXR-Driver/releases/tag/v1.3.0';
const tagUrl = (tag: string) => `https://github.com/AngelDark92/GalaxyXR-Driver/releases/tag/${tag}`;
const fetchMock = vi.fn<typeof fetch>();

function release(tag = 'v1.3.0') {
  return new Response(JSON.stringify({ tag_name: tag, html_url: releaseUrl }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function releaseList(tags: string[]) {
  return new Response(JSON.stringify(tags.map(tag => ({ tag_name: tag, html_url: tagUrl(tag) }))), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Default-off getter mirrors the pre-Dev-Updates behavior exactly. */
function createService(installedVersion?: string, devUpdatesInitially = false) {
  const driverInstalled = signal<string | undefined>(installedVersion);
  const devUpdates = signal(devUpdatesInitially);
  const service = new AppUpdateService({ driverInstalled } as unknown as SystemDiagnosticService,
    () => ({ devUpdates: devUpdates() } as AppSetting));
  return { service, driverInstalled, devUpdates };
}

beforeEach(() => {
  vi.mocked(getVersion).mockResolvedValue('1.2.2');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AppUpdateService release check', () => {
  it('checks this driver repository and exposes the newer v-prefixed release URL', async () => {
    fetchMock.mockResolvedValueOnce(release());
    const { service } = createService();

    const result = await service.checkUpdate();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(latestEndpoint, expect.objectContaining({
      signal: expect.any(AbortSignal),
      headers: { accept: 'application/vnd.github+json' },
    }));
    expect(result).toMatchObject({
      fetchSuccess: true,
      currentVersion: '1.2.2',
      latestVersion: 'v1.3.0',
      updateAvailable: true,
      url: releaseUrl,
    });
    expect(service.updateInfo()).toEqual(result);
  });

  it.each(['v1.2.2', 'v1.2.1'])('does not advertise an update for release %s', async tag => {
    fetchMock.mockResolvedValueOnce(release(tag));
    const { service } = createService();

    expect(await service.checkUpdate()).toMatchObject({
      fetchSuccess: true,
      latestVersion: tag,
      updateAvailable: false,
    });
  });

  it.each(['HTTP failure', 'network rejection'])('reports %s and allows another check', async failure => {
    if (failure === 'HTTP failure') {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    } else {
      fetchMock.mockRejectedValueOnce(new TypeError('Network unavailable'));
    }
    fetchMock.mockResolvedValueOnce(release());
    const { service } = createService();

    expect(await service.checkUpdate()).toMatchObject({
      fetchSuccess: false,
      updateAvailable: false,
      latestVersion: 'Unknown',
      url: '',
    });
    expect(await service.checkUpdate()).toMatchObject({ fetchSuccess: true, updateAvailable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a stalled request after ten seconds, clears its timer, and permits retry', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')));
    }));
    fetchMock.mockResolvedValueOnce(release());
    const { service } = createService();
    const check = service.checkUpdate();
    await vi.advanceTimersByTimeAsync(0);

    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(requestSignal?.aborted).toBe(true);
    expect(await check).toMatchObject({ fetchSuccess: false, updateAvailable: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(await service.checkUpdate()).toMatchObject({ fetchSuccess: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one pending request between construction and concurrent manual checks', async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveFetch = resolve; }));
    const { service } = createService();
    const first = service.checkUpdate();
    const second = service.checkUpdate();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(release());
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].fetchSuccess).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps installed-driver availability independent from GitHub update availability', async () => {
    fetchMock.mockResolvedValueOnce(release('v1.2.2'));
    const { service, driverInstalled } = createService('1.2.1');
    await service.checkUpdate();
    await Promise.resolve();

    expect(service.updateInfo()).toMatchObject({ updateAvailable: false, installAvailable: true });
    driverInstalled.set('1.2.2');
    await Promise.resolve();
    expect(service.updateInfo()).toMatchObject({ updateAvailable: false, installAvailable: false });

    fetchMock.mockResolvedValueOnce(release());
    await service.checkUpdate();
    await Promise.resolve();
    expect(service.updateInfo()).toMatchObject({ updateAvailable: true, installAvailable: false });
  });
});

describe('AppUpdateService Dev Updates channel', () => {
  it('reads the releases list and reports the newest dev build when Dev Updates is on', async () => {
    fetchMock.mockResolvedValueOnce(releaseList(['v1.9.0-dev.2', 'v1.9.0-dev.1', 'v1.8.0']));
    const { service } = createService(undefined, true);

    const result = await service.checkUpdate();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(releasesEndpoint, expect.objectContaining({
      signal: expect.any(AbortSignal),
      headers: { accept: 'application/vnd.github+json' },
    }));
    expect(result).toMatchObject({
      fetchSuccess: true,
      currentVersion: '1.2.2',
      latestVersion: 'v1.9.0-dev.2',
      updateAvailable: true,
      url: tagUrl('v1.9.0-dev.2'),
    });
    expect(service.updateInfo()).toEqual(result);
  });

  it('keeps a newer stable release ahead of dev builds', async () => {
    fetchMock.mockResolvedValueOnce(releaseList(['v1.10.0', 'v1.9.0-dev.5']));
    const { service } = createService(undefined, true);

    expect(await service.checkUpdate()).toMatchObject({
      fetchSuccess: true,
      latestVersion: 'v1.10.0',
      updateAvailable: true,
      url: tagUrl('v1.10.0'),
    });
  });

  it('updates a running dev build to the next dev build', async () => {
    vi.mocked(getVersion).mockResolvedValue('1.9.0-dev.2');
    fetchMock.mockResolvedValueOnce(releaseList(['v1.9.0-dev.3']));
    const { service } = createService(undefined, true);

    expect(await service.checkUpdate()).toMatchObject({
      fetchSuccess: true,
      currentVersion: '1.9.0-dev.2',
      latestVersion: 'v1.9.0-dev.3',
      updateAvailable: true,
    });
  });

  it('updates a dev build to its matching stable release', async () => {
    vi.mocked(getVersion).mockResolvedValue('1.9.0-dev.2');
    fetchMock.mockResolvedValueOnce(releaseList(['v1.9.0']));
    const { service } = createService(undefined, true);

    expect(await service.checkUpdate()).toMatchObject({
      fetchSuccess: true,
      latestVersion: 'v1.9.0',
      updateAvailable: true,
      url: tagUrl('v1.9.0'),
    });
  });

  it('reports a failed releases list and allows another check', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetchMock.mockResolvedValueOnce(releaseList(['v1.9.0-dev.2']));
    const { service } = createService(undefined, true);

    expect(await service.checkUpdate()).toMatchObject({
      fetchSuccess: false,
      updateAvailable: false,
      latestVersion: 'Unknown',
      url: '',
    });
    expect(await service.checkUpdate()).toMatchObject({
      fetchSuccess: true,
      latestVersion: 'v1.9.0-dev.2',
      updateAvailable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reruns the check when Dev Updates flips after the first check settles', async () => {
    fetchMock.mockResolvedValueOnce(release());
    fetchMock.mockResolvedValueOnce(releaseList(['v1.3.1']));
    const { service, devUpdates } = createService();

    await service.checkUpdate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(latestEndpoint, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    devUpdates.set(true);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(releasesEndpoint, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await vi.waitFor(() => expect(service.updateInfo()?.latestVersion).toBe('v1.3.1'));
    expect(service.updateInfo()).toMatchObject({ fetchSuccess: true, updateAvailable: true, url: tagUrl('v1.3.1') });
  });
});
