import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AdapterCapabilities, DriverInfo, GpuCapabilities } from './types';
import type { DriverRuntimeStatus } from '../platform/tauri';
import { codecSupport, effectiveAdapter, ofxrNvidiaSupport, uniqueNvencCandidate } from './encoder-capabilities';
import { encoderGpuNotice, gpuMismatch, graphicsAdapterEvidence } from './gpu-mismatch';
import { encoderEvidence } from './encoder-tap-status';

const now = 100_000;
const intel: AdapterCapabilities = { adapterLuid: 'intel', gpuName: 'Intel Arc', vendorId: 0x8086, nvenc: false };
const nv = (overrides: Partial<AdapterCapabilities> = {}): AdapterCapabilities =>
  ({ adapterLuid: 'nv', gpuName: 'RTX 4080', vendorId: 0x10de, nvenc: true, ...overrides });
const gpu = (...adapters: AdapterCapabilities[]): GpuCapabilities => ({ adapters, checkedAt: now });

const runtime = (overrides: Partial<DriverRuntimeStatus> = {}): DriverRuntimeStatus => ({
  state: 'initialized', detail: '', steamvrRunning: true, driverInitialized: true, headsetConnected: true,
  driverVersion: '1', serverPid: 42, checkedAt: now, ...overrides,
});
const graphics = (overrides: Partial<NonNullable<DriverInfo['graphicsAdapter']>> = {}) =>
  ({ adapterLuid: 'intel', pid: 42, observedAt: now, ...overrides });
const info = (extra: Partial<DriverInfo> = {}) => extra as DriverInfo;

describe('effectiveAdapter unique NVENC candidate', () => {
  it('prefers the only NVIDIA adapter next to Intel, as unverified-source candidate', () => {
    const r = effectiveAdapter(gpu(intel, nv()), undefined, now);
    expect(r.known).toBe(true);
    expect(r.source).toBe('unique-nvenc-candidate');
    expect(r.adapter?.adapterLuid).toBe('nv');
  });
  it('keeps known negative codec gates of the candidate', () => {
    const g = gpu(intel, nv({ codecs: { av1: { supported: false } } }));
    expect(codecSupport(effectiveAdapter(g, undefined, now), 2).verdict).toBe('unsupported');
  });
  it('stays ambiguous with two NVIDIA candidates', () => {
    const r = effectiveAdapter(gpu(nv({ adapterLuid: 'a' }), nv({ adapterLuid: 'b' })), undefined, now);
    expect(r.known).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(r.source).toBe('unknown');
  });
  it('never treats a missing vendor as proven non-NVIDIA', () => {
    expect(uniqueNvencCandidate([nv(), { adapterLuid: 'x', gpuName: 'Unknown' }])).toBeUndefined();
  });
  it('accepts an NVIDIA adapter with nvenc false as proven non-encoder', () => {
    expect(uniqueNvencCandidate([nv(), nv({ adapterLuid: 'old', nvenc: false })])?.adapterLuid).toBe('nv');
  });
  it('accepts unknown nvenc on the candidate', () => {
    expect(uniqueNvencCandidate([intel, nv({ nvenc: undefined })])?.adapterLuid).toBe('nv');
  });
  it('keeps single-adapter provenance and encoder-session override', () => {
    expect(effectiveAdapter(gpu(nv()), undefined, now).source).toBe('single-adapter');
    const tap = { enabled: true, hookInstalled: true, upgradedSessionsRemain: false, configPath: '', modulePath: '',
      observedAt: now, capabilities: intel } as NonNullable<DriverInfo['encoderTap']>;
    const r = effectiveAdapter(gpu(intel, nv()), tap, now);
    expect(r.source).toBe('encoder-session');
    expect(r.adapter?.adapterLuid).toBe('intel');
  });
  it('leaves the Optical Flow inventory rule unchanged', () => {
    expect(ofxrNvidiaSupport(gpu(intel, nv({ opticalFlow: true }))).verdict).toBe('unverified');
  });
});

describe('graphicsAdapterEvidence', () => {
  const base = info({ graphicsAdapter: graphics() });
  it('accepts fresh evidence for the current process', () => {
    expect(graphicsAdapterEvidence(base, runtime(), now)?.adapterLuid).toBe('intel');
  });
  it.each([
    ['stopped SteamVR', runtime({ steamvrRunning: false })],
    ['driver not initialized', runtime({ driverInitialized: false })],
    ['wrong PID', runtime({ serverPid: 7 })],
    ['stale runtime', runtime({ checkedAt: now - 6000 })],
  ])('clears on %s', (_n, rt) => {
    expect(graphicsAdapterEvidence(base, rt, now)).toBeUndefined();
  });
  it('clears on old or missing observation and missing runtime', () => {
    expect(graphicsAdapterEvidence(info({ graphicsAdapter: graphics({ observedAt: now - 6000 }) }), runtime(), now)).toBeUndefined();
    expect(graphicsAdapterEvidence(info({ graphicsAdapter: graphics({ observedAt: now + 3000 }) }), runtime(), now)).toBeUndefined();
    expect(graphicsAdapterEvidence(info({}), runtime(), now)).toBeUndefined();
    expect(graphicsAdapterEvidence(base, undefined, now)).toBeUndefined();
  });
  it('clears when loaded module paths differ', () => {
    const i = info({ graphicsAdapter: graphics(), encoderTap: { modulePath: 'a.dll', configPath: 'a.json' } as DriverInfo['encoderTap'] });
    const rt = runtime({ encoderTap: { state: 'enabled', modulePath: 'b.dll', configPath: 'a.json' } });
    expect(graphicsAdapterEvidence(i, rt, now)).toBeUndefined();
  });
});

describe('NaN guards', () => {
  it('rejects non-finite timestamps and pids', () => {
    for (const bad of [NaN, Infinity]) {
      expect(graphicsAdapterEvidence(info({ graphicsAdapter: graphics({ observedAt: bad }) }), runtime(), now)).toBeUndefined();
      expect(graphicsAdapterEvidence(info({ graphicsAdapter: graphics({ pid: bad }) }), runtime(), now)).toBeUndefined();
      expect(graphicsAdapterEvidence(info({ graphicsAdapter: graphics() }), runtime({ checkedAt: bad }), now)).toBeUndefined();
    }
    expect(graphicsAdapterEvidence(info({ graphicsAdapter: graphics() }), runtime(), NaN)).toBeUndefined();
  });
});

describe('preferred target is NVIDIA only', () => {
  it('has no preferred target for a lone AMD, Intel or nvenc=false GPU, so no mismatch', () => {
    const live = { capabilities: { adapterLuid: 'other' } } as DriverInfo['encoderTap'];
    const amd: AdapterCapabilities = { adapterLuid: 'amd', vendorId: 0x1002 };
    for (const only of [amd, intel, nv({ nvenc: false }), { adapterLuid: 'novendor' }]) {
      expect(gpuMismatch(gpu(only), live, graphics())).toEqual({});
      expect(encoderGpuNotice(gpu(only), undefined)).toBeUndefined();
    }
  });
  it('still prefers a lone NVIDIA GPU', () => {
    expect(gpuMismatch(gpu(nv()), undefined, graphics()).renderer).toBeDefined();
  });
});

describe('encoderGpuNotice', () => {
  it('names the preferred candidate as awaiting verification', () => {
    const n = encoderGpuNotice(gpu(intel, nv()), undefined);
    expect(n?.compact).toBe(true);
    expect(n?.title).toContain('RTX 4080');
    expect(n?.title).toContain('Awaiting encoder session verification');
    expect(encoderGpuNotice(gpu(nv()), undefined)?.title).toContain('Awaiting');
  });
  it('labels a live session GPU as driver-verified instead', () => {
    const live = { capabilities: { adapterLuid: 'intel', gpuName: 'Intel Arc' } } as DriverInfo['encoderTap'];
    const n = encoderGpuNotice(gpu(intel, nv()), live);
    expect(n?.title).toContain('Driver-verified');
    expect(n?.title).not.toContain('Awaiting');
  });
  it('shows nothing for an ambiguous inventory', () => {
    expect(encoderGpuNotice(gpu(nv({ adapterLuid: 'a' }), nv({ adapterLuid: 'b' })), undefined)).toBeUndefined();
  });
});

describe('Stream Frame page wiring (source fixture)', () => {
  const page = readFileSync(new URL('../features/stream-frame-page.ts', import.meta.url), 'utf8');
  it('gates mismatch errors on the requested Tap and uses error severity', () => {
    const block = page.slice(page.indexOf('Wrong-GPU errors'), page.indexOf('const tapAdapter'));
    expect(block).toMatch(/if \(settings\.nvencTap\) \{/);
    expect(block).toContain("statusMessage('error', ENCODER_MISMATCH_TITLE()");
    expect(block).toContain("statusMessage('error', RENDERER_MISMATCH_TITLE()");
    expect(block).toContain('graphicsAdapterEvidence(this.ctx.dis.values(), this.ctx.startup.status())');
    expect(block).toContain('gpuMismatch(this.ctx.gpu.caps(), evidence, graphics)');
  });
  it('renders the compact GPU notice only with the Tap on, in the Tap row', () => {
    expect(page).toContain('settings.nvencTap ? encoderGpuNotice(this.ctx.gpu.caps(), evidence) : undefined');
    expect(page).toContain('tapNotices.push(gpuNotice)');
  });
  it('expires and re-renders on graphicsAdapter timestamps with finite guards', () => {
    expect(page).toContain('graphicsAdapter?.observedAt');
    expect(page).toContain('Number.isFinite(v)');
    expect(page).toMatch(/observedAt \+ 5001 - Date\.now\(\)/);
  });
});

describe('gpuMismatch', () => {
  const g = gpu(intel, nv());
  const encoderOn = (luid: string) => ({ capabilities: { adapterLuid: luid, gpuName: 'X' } }) as DriverInfo['encoderTap'];

  it('reports a renderer mismatch before the encoder opens (Intel renders, NVIDIA preferred)', () => {
    const m = gpuMismatch(g, undefined, graphics());
    expect(m.renderer?.expected).toContain('RTX 4080');
    expect(m.renderer?.actual).toContain('Intel Arc');
    expect(m.encoder).toBeUndefined();
  });
  it('reports nothing without fresh identity (awaiting verification)', () => {
    expect(gpuMismatch(g, undefined, undefined)).toEqual({});
  });
  it('reports an encoder mismatch naming both GPUs; actual caps still win', () => {
    const m = gpuMismatch(g, encoderOn('intel'), undefined);
    expect(m.encoder?.expected).toContain('nv');
    expect(m.encoder?.actual).toContain('Intel Arc');
    expect(effectiveAdapter(g, { ...encoderOn('intel'), observedAt: now } as DriverInfo['encoderTap'], now).adapter?.adapterLuid).toBe('intel');
  });
  it('shows both when encoder and renderer both differ', () => {
    const m = gpuMismatch(g, encoderOn('intel'), graphics());
    expect(m.encoder && m.renderer).toBeTruthy();
  });
  it('shows only the renderer when the encoder matches but the HMD differs', () => {
    const m = gpuMismatch(g, encoderOn('nv'), graphics());
    expect(m.encoder).toBeUndefined();
    expect(m.renderer).toBeDefined();
  });
  it('matching LUIDs (case-insensitive) produce no error', () => {
    expect(gpuMismatch(g, encoderOn('NV'), graphics({ adapterLuid: 'Nv' }))).toEqual({});
  });
  it('has no preferred candidate with ambiguous or unknown inventories', () => {
    expect(gpuMismatch(gpu(nv({ adapterLuid: 'a' }), nv({ adapterLuid: 'b' })), encoderOn('c'), graphics())).toEqual({});
    expect(gpuMismatch(undefined, encoderOn('c'), graphics())).toEqual({});
  });
  it('only fresh process-bound encoder evidence reaches the comparison', () => {
    const stale = info({ encoderTap: { pid: 42, observedAt: now - 9000, modulePath: 'm', configPath: 'c', capabilities: { adapterLuid: 'intel' } } as DriverInfo['encoderTap'] });
    const rt = runtime({ encoderTap: { state: 'enabled', modulePath: 'm', configPath: 'c' } });
    expect(encoderEvidence(stale, rt, now)).toBeUndefined();
    expect(gpuMismatch(g, encoderEvidence(stale, rt, now), undefined)).toEqual({});
  });
  it('clears when the stream stops (graphics evidence gone)', () => {
    const i = info({ graphicsAdapter: graphics() });
    expect(gpuMismatch(g, undefined, graphicsAdapterEvidence(i, runtime({ steamvrRunning: false }), now))).toEqual({});
  });
});
