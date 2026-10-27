// Unit tests for the Galaxy settings state (state/galaxy-settings.ts):
// persisted-schema migrations (schema 2/3/4/5, NVENC v3/v4), defaults
// resolution, per-codec encoder defaults, tuner band/segment generation,
// matrix text parsing, CAS mode switching, calibration lifecycle, and
// profile import semantics.
//
// The class takes the three root services through its constructor, so the
// tests use minimal fakes: the constructor's effects run synchronously and
// migrated saves are queueMicrotask'd, flushed by a macrotask await.
import { describe, it, expect } from 'vitest';
import { GalaxySettingsBase, codecEncoderDefaults, streamFrameIntegerError, streamFrameNumberContracts } from './galaxy-settings';
import { driverDefaults } from '../domain/driver-defaults';

type Harness = {
  gs: GalaxySettingsBase;
  saved: unknown[];
  flush: () => Promise<void>;
};

function buildHarness(stored: Record<string, unknown> | undefined = {}, disValues: unknown = undefined, rawStored: unknown = undefined, readError: unknown = undefined) {
  const saved: unknown[] = [];
  const dss = {
    values: () => stored,
    readFileError: () => readError,
    inspecting: false,
    save: (v: unknown): Promise<boolean> => { saved.push(v); return Promise.resolve(true); },
    ...(rawStored === undefined ? {} : { storedValues: () => rawStored }),
  };
  const dis = { values: () => disValues };
  const appSettings = { values: () => ({ advanceMode: false }) };
  const gs = new GalaxySettingsBase(appSettings as any, dss as any, dis as any);
  const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  return { gs, dss, saved, flush };
}

describe('confirmed settings saves', () => {
  it('notifies views immediately but waits for persistence before confirming success', async () => {
    const { gs, dss, flush } = buildHarness(structuredClone(driverDefaults));
    await flush();
    let confirm!: (saved: boolean) => void;
    dss.save = () => new Promise<boolean>(resolve => { confirm = resolve; });
    const revision = gs.revision();
    let settled = false;
    const saving = gs.save().then(saved => { settled = true; return saved; });
    expect(gs.revision()).toBe(revision + 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    confirm(true);
    await expect(saving).resolves.toBe(true);
  });

  it.each(['failed', 'superseded'])('does not confirm a %s save', async () => {
    const { gs, dss, flush } = buildHarness(structuredClone(driverDefaults));
    await flush();
    dss.save = async () => false;
    await expect(gs.save()).resolves.toBe(false);
  });

  it.each(['inspecting', 'missing settings'])('refuses to save while %s', async reason => {
    const { gs, dss, saved, flush } = buildHarness(structuredClone(driverDefaults));
    await flush();
    saved.length = 0;
    if (reason === 'inspecting') dss.inspecting = true;
    else gs.rootSetting = undefined;
    await expect(gs.save()).resolves.toBe(false);
    expect(saved).toHaveLength(0);
  });
});

describe('stream-frame integer validation', () => {
  // The contracts must mirror the committed NvencTap.cpp ValidateRequest
  // exactly; an invalid value is reported (naming the key and range), never
  // coerced, and stored-tuning preservation continues to outrank validation.
  it('carries a contract for every app-number key the driver validates', () => {
    const contractKeys = Object.keys(streamFrameNumberContracts);
    expect(contractKeys).toContain('galaxyXr.customStreamFormatWidth');
    for (const key of ['streamFrame.nvencH264GopFrames', 'streamFrame.nvencH264IdrFrames', 'streamFrame.nvencH264RefFrames',
      'streamFrame.nvencH264Entropy', 'streamFrame.nvencH264SliceMode', 'streamFrame.nvencH264SliceData',
      'streamFrame.nvencH264VbvInitialDelay', 'streamFrame.nvencMultiPass', 'streamFrame.nvencPreset',
      'streamFrame.nvencSplitMode', 'streamFrame.nvencAqStrength', 'streamFrame.nvencLowDelayKfScale',
      'streamFrame.nvencMaxQp', 'streamFrame.nvencMinQp', 'streamFrame.nvencMinQpIntra',
      'streamFrame.nvencBitrateMbit', 'streamFrame.nvencBitrateConstancyPct', 'streamFrame.nvencMaxBitrateHeadroomPct', 'streamFrame.nvencForceFps',
      'streamFrame.nvencVbvFrames', 'streamFrame.nvencQpFovea', 'streamFrame.nvencQpPeriphery']) {
      expect(contractKeys).toContain(key);
    }
    // 2026-10-21: -1 with the retirement of streamFrame.nvencVrlinkFallbackMode.
    expect(contractKeys).toHaveLength(29);
  });

  it.each([
    ['galaxyXr.customStreamFormatWidth', 1536],
    ['galaxyXr.customStreamFormatWidth', 1],
    ['galaxyXr.customStreamFormatWidth', 1073741823], // 4 * 1073741823 = 4294967292 fits uint32
    ['streamFrame.nvencH264GopFrames', -1],
    ['streamFrame.nvencH264IdrFrames', -1],
    ['streamFrame.nvencH264RefFrames', 16],
    ['streamFrame.nvencH264RefFrames', 0],
    ['streamFrame.nvencH264Entropy', 2],
    ['streamFrame.nvencH264SliceMode', 3],
    ['streamFrame.nvencH264SliceData', 0],
    ['streamFrame.nvencH264VbvInitialDelay', 0],
    ['streamFrame.nvencMultiPass', -1],
    ['streamFrame.nvencMultiPass', 2],
    ['streamFrame.nvencPreset', 0],
    ['streamFrame.nvencPreset', 7],
    ['streamFrame.nvencSplitMode', 0],
    ['streamFrame.nvencSplitMode', 4],
    ['streamFrame.nvencSplitMode', 15],
    ['streamFrame.nvencAqStrength', 15],
    ['streamFrame.nvencLowDelayKfScale', 255],
    ['streamFrame.nvencMaxQp', 0],
    ['streamFrame.nvencMinQpIntra', 51],
    ['streamFrame.nvencBitrateMbit', 0],
    ['streamFrame.nvencMaxBitrateHeadroomPct', 12],
    ['streamFrame.nvencMaxBitrateHeadroomPct', 100],
    ['streamFrame.nvencForceFps', 90],
    ['streamFrame.nvencVbvFrames', 0],
    ['streamFrame.nvencQpFovea', -128],
    ['streamFrame.nvencQpPeriphery', 127],
  ])('accepts %s = %s', (key, value) => {
    expect(streamFrameIntegerError(key as string, value as number)).toBeUndefined();
  });

  it.each([
    ['galaxyXr.customStreamFormatWidth', 0, 'at least 1'],
    ['galaxyXr.customStreamFormatWidth', -64, 'at least 1'],
    ['galaxyXr.customStreamFormatWidth', 1073741824, 'uint32'], // 4 * that no longer fits
    ['streamFrame.nvencH264GopFrames', -2, 'at least -1'],
    ['streamFrame.nvencH264IdrFrames', -9, 'at least -1'],
    ['streamFrame.nvencH264RefFrames', 99, '0 to 16'],
    ['streamFrame.nvencH264Entropy', 18, '0 to 2'],
    ['streamFrame.nvencH264SliceMode', 17, '0 to 3'],
    ['streamFrame.nvencH264SliceData', -4, 'at least 0'],
    ['streamFrame.nvencH264VbvInitialDelay', -4, 'at least 0'],
    ['streamFrame.nvencMultiPass', 17, '-1 to 2'],
    ['streamFrame.nvencPreset', 8, '0 to 7'],
    ['streamFrame.nvencSplitMode', 7, '0 to 4, or 15'],
    ['streamFrame.nvencSplitMode', -1, '0 to 4, or 15'],
    ['streamFrame.nvencAqStrength', 16, '0 to 15'],
    ['streamFrame.nvencLowDelayKfScale', 256, '0 to 255'],
    ['streamFrame.nvencMaxQp', -1, 'nonnegative'],
    ['streamFrame.nvencMinQp', -3, 'nonnegative'],
    ['streamFrame.nvencMinQpIntra', -1, 'nonnegative'],
    ['streamFrame.nvencBitrateMbit', -1, 'nonnegative'],
    ['streamFrame.nvencMaxBitrateHeadroomPct', -1, '0 to 100'],
    ['streamFrame.nvencMaxBitrateHeadroomPct', 101, '0 to 100'],
    ['streamFrame.nvencForceFps', -1, 'nonnegative'],
    ['streamFrame.nvencVbvFrames', -1, 'nonnegative'],
    ['streamFrame.nvencQpFovea', -129, '-128 to 127'],
    ['streamFrame.nvencQpPeriphery', 128, '-128 to 127'],
  ])('names the key and its accepted range for %s = %s', (key, value, range) => {
    const error = streamFrameIntegerError(key as string, value as number)!;
    expect(error).toContain(key as string);
    expect(error).toContain(range as string);
    expect(error).toContain('the entered value is kept');
  });

  it('reports a fractional entry as a whole-number error naming the key', () => {
    const error = streamFrameIntegerError('streamFrame.nvencH264RefFrames', 2.5)!;
    expect(error).toContain('whole number');
    expect(error).toContain('streamFrame.nvencH264RefFrames');
    expect(error).toContain('0 to 16');
  });

  it('passes keys without a contract through untouched and clears on undefined', () => {
    expect(streamFrameIntegerError('streamFrame.saturation', 42.5)).toBeUndefined();
    expect(streamFrameIntegerError('streamFrame.nvencPreset', undefined)).toBeUndefined();
  });
});

describe('schema migrations', () => {
  it.each([false, true])('migrates SDR10 OFF preserving explicit compatibility=%s and tuning', async legacy10bit => {
    const stored = structuredClone(driverDefaults);
    stored.streamFrame!.streamFrameSchema = 5;
    stored.streamFrame!.nvencSettingsVersion = 4;
    stored.galaxyXr!.sdr10Baseline = false;
    stored.galaxyXr!.profileSupports10bit = legacy10bit;
    stored.galaxyXr!.customBandwidthMbit = 177;
    stored.streamFrame!.gamma = 1.8;
    const { saved, flush } = buildHarness(stored);
    await flush();
    expect(stored.galaxyXr!.sdr10SettingsVersion).toBe(2);
    expect(stored.galaxyXr!.profileSupports10bit).toBe(legacy10bit);
    expect(stored.galaxyXr!.customBandwidthMbit).toBe(177);
    expect(stored.streamFrame!.gamma).toBe(1.8);
    expect(saved.length).toBe(1);
    const reopened = buildHarness(JSON.parse(JSON.stringify(stored)));
    await reopened.flush();
    expect(reopened.saved).toHaveLength(0);
  });

  it('retires only an absent SDR compatibility default after service default merging', async () => {
    const raw: any = {
      galaxyXr: { sdr10Baseline: false },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4 },
    };
    const merged = structuredClone(driverDefaults);
    Object.assign(merged.galaxyXr!, raw.galaxyXr);
    Object.assign(merged.streamFrame!, raw.streamFrame);
    const { flush } = buildHarness(merged, undefined, raw);
    await flush();
    expect(merged.galaxyXr!.profileSupports10bit).toBe(false);
    expect(merged.galaxyXr!.sdr10SettingsVersion).toBe(2);
    expect(raw.galaxyXr.profileSupports10bit).toBeUndefined();
  });

  it('preserves explicit SDR compatibility true after service default merging', async () => {
    const raw: any = {
      galaxyXr: { sdr10Baseline: false, profileSupports10bit: true },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 1 },
    };
    const merged = structuredClone(driverDefaults);
    Object.assign(merged.galaxyXr!, raw.galaxyXr);
    Object.assign(merged.streamFrame!, raw.streamFrame);
    const { flush } = buildHarness(merged, undefined, raw);
    await flush();
    expect(merged.galaxyXr!.profileSupports10bit).toBe(true);
    expect(merged.galaxyXr!.sdr10SettingsVersion).toBe(2);
  });

  it.each([false, true])('keeps active SDR10 and its legacy compatibility=%s during migration', async legacy10bit => {
    const stored = structuredClone(driverDefaults);
    stored.streamFrame!.streamFrameSchema = 5;
    stored.streamFrame!.nvencSettingsVersion = 4;
    stored.galaxyXr!.sdr10Baseline = true;
    stored.galaxyXr!.profileSupports10bit = legacy10bit;
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.galaxyXr!.sdr10SettingsVersion).toBe(2);
    expect(stored.galaxyXr!.sdr10Baseline).toBe(true);
    expect(stored.galaxyXr!.profileSupports10bit).toBe(legacy10bit);
  });

  it('chains schema 1 -> 2 -> 3 -> 4 -> 5 for an exact-default legacy kalman config', async () => {
    const stored: any = {
      streamFrame: { velocityFixMode: 'kalman' },
      controllers: {
        rotationOffsetDeg: { x: 9, y: 9, z: 9 },
        positionOffsetCm: { x: 7, y: 7, z: 7 },
        mirrorOffsetsForRightHand: false,
      },
    };
    const { gs, saved, flush } = buildHarness(stored);
    await flush();

    // schema 2: exact-old-default kalman -> kalmanCA with schema-2 CA values
    // schema 3: schema-2 CA values -> ratified schema-3 values
    expect(stored.streamFrame.velocityFixMode).toBe('kalmanCA');
    expect(stored.streamFrame.kalmanCaJerk).toBe(4);
    expect(stored.streamFrame.kalmanCaPosNoiseMm).toBe(1.5);
    expect(stored.streamFrame.kalmanCaOriNoiseDeg).toBe(1.5);
    expect(stored.streamFrame.kalmanCaAccelTauMs).toBe(20);
    expect(stored.streamFrame.kalmanCaExactCov).toBe(true);
    // schema 4: unconditional Direction Lead / Freeze Coast Turn reset +
    // shared controller offsets back to shipped defaults
    expect(stored.streamFrame.kalmanDirLeadMs).toBe(0);
    expect(stored.streamFrame.kalmanFreezeCoastTurn).toBe(0);
    expect(stored.controllers.rotationOffsetDeg).toEqual(driverDefaults.controllers!.rotationOffsetDeg);
    expect(stored.controllers.positionOffsetCm).toEqual(driverDefaults.controllers!.positionOffsetCm);
    expect(stored.controllers.mirrorOffsetsForRightHand).toBe(driverDefaults.controllers!.mirrorOffsetsForRightHand);
    expect(stored.streamFrame.streamFrameSchema).toBe(5);
    // NVENC v3 + v4 ride along
    expect(stored.streamFrame.nvencSettingsVersion).toBe(4);
    expect(stored.streamFrame.postPack.enable).toBe(true);
    expect(stored.streamFrame.postPack.casEnable).toBe(true);
    expect(saved.length).toBeGreaterThan(0);
    // the page-facing settings object is the migrated, default-filled object
    expect(gs.settings).toBe(stored.streamFrame);
    expect(gs.settings!.kalmanCaJerk).toBe(4);
  });

  it('keeps custom (non-default) kalman CV values out of the schema-2 upgrade', async () => {
    const stored: any = { streamFrame: { velocityFixMode: 'kalman', kalmanProcessAccel: 2 } };
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame.velocityFixMode).toBe('kalman');
    expect(stored.streamFrame.kalmanProcessAccel).toBe(2);
    expect(stored.streamFrame.streamFrameSchema).toBe(5);
  });

  it.each([
    ['native', 'kalmanCA'], ['kalmanCAGameLink', 'kalmanCA'], ['nativeGameLink', 'off'],
  ])('turns the old Game Link layout mode %s into mode %s with the layout toggle on', async (oldMode, mode) => {
    const stored: any = { streamFrame: { velocityFixMode: oldMode, streamFrameSchema: 5 }, galaxyXr: { controllerBypass: true } };
    const { saved, flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame.velocityFixMode).toBe(mode);
    expect(stored.galaxyXr.gameLinkLayout).toBe(true);
    expect(stored.galaxyXr.controllerBypass).toBe(true);
    expect(saved.length).toBeGreaterThan(0);
  });

  it('turns the removed velocityOnly mode into kalmanCA and leaves the layout toggle alone', async () => {
    const stored: any = { streamFrame: { velocityFixMode: 'velocityOnly', streamFrameSchema: 5 }, galaxyXr: {} };
    const { saved, flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame.velocityFixMode).toBe('kalmanCA');
    expect(stored.galaxyXr.gameLinkLayout).toBeFalsy();
    expect(saved.length).toBeGreaterThan(0);
  });

  it.each(['off', 'kalman', 'kalmanCA'])('leaves mode %s as chosen and the layout off', async (mode) => {
    const stored: any = { streamFrame: { velocityFixMode: mode, streamFrameSchema: 5 }, galaxyXr: {} };
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame.velocityFixMode).toBe(mode);
    expect(stored.galaxyXr.gameLinkLayout).toBeFalsy();
  });

  it('fills the Game Link layout offsets with their defaults', async () => {
    const stored: any = { streamFrame: { streamFrameSchema: 5 }, controllers: {} };
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.controllers.gameLinkLayout.rotationOffsetDeg).toEqual({ x: 2, y: -5, z: -9 });
    expect(stored.controllers.gameLinkLayout.positionOffsetCm).toEqual({ x: 0.5, y: -1.5, z: 0.5 });
  });

  it('keeps custom kalmanCA tuning intact through schema 3/4', async () => {
    const stored: any = {
      streamFrame: {
        velocityFixMode: 'kalmanCA',
        kalmanCaJerk: 99, kalmanCaPosNoiseMm: 3.3, kalmanCaOriNoiseDeg: 3.3,
        kalmanCaAccelTauMs: 50, kalmanCaExactCov: true,
        streamFrameSchema: 5, nvencSettingsVersion: 4,
      },
    };
    const { saved, flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame.kalmanCaJerk).toBe(99);
    expect(stored.streamFrame.kalmanCaPosNoiseMm).toBe(3.3);
    expect(stored.streamFrame.kalmanCaOriNoiseDeg).toBe(3.3);
    expect(stored.streamFrame.kalmanCaAccelTauMs).toBe(50);
    expect(stored.streamFrame.kalmanCaExactCov).toBe(true);
    // fully current config: no migration block fired, so nothing is re-saved
    expect(saved.length).toBe(0);
  });

  it('normalises the integer kalmanAngularOutFrame to the string enum', async () => {
    const cases: Array<[number, string]> = [[0, 'world'], [1, 'body'], [2, 'zero'], [99, 'body']];
    for (const [raw, expected] of cases) {
      const stored: any = { streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, kalmanAngularOutFrame: raw } };
      const { flush } = buildHarness(stored);
      await flush();
      expect(stored.streamFrame.kalmanAngularOutFrame).toBe(expected);
    }
  });

  it.each([0, 2, 3, 4])('preserves explicit encoder tuning when upgrading schema %s', async version => {
    const chosen = {
      nvencVbvFrames: 5, nvencLowDelayKfScale: 4, nvencMaxBitrateHeadroomPct: 20,
      nvencForceFps: 72, nvencSplitMode: 3, nvencPreset: 7, nvencAqStrength: 4,
      nvencMinQp: 5, nvencMinQpIntra: 7, nvencMaxQp: 31, nvencVuiFullRange: 1,
      nvencVuiMatrix: 1, nvencVuiPrimaries: 1, nvencVuiTransfer: 1,
      nvencBitrateMbit: 123, nvencBandwidthOverrideMbit: 234,
    };
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2, customStreamFormatWidth: 1856 },
      streamFrame: {
        streamFrameSchema: 5, nvencSettingsVersion: version,
        postPack: { enable: false, casEnable: false }, ...chosen,
      },
    };
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame).toMatchObject({ ...chosen, nvencSettingsVersion: 4 });
    expect(stored.galaxyXr.customStreamFormatWidth).toBe(1856);
    const reopened = buildHarness(structuredClone(stored));
    await reopened.flush();
    expect(reopened.saved).toHaveLength(0);
    expect(reopened.gs.settings).toMatchObject(chosen);
  });

  it('migrates the retired bitrate bool to constancy from the stored object', async () => {
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4 },
    };
    const rawStored: any = {
      galaxyXr: { sdr10SettingsVersion: 2 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencBitrateScale: false },
    };
    const { gs, flush } = buildHarness(stored, undefined, rawStored);
    await flush();
    // false (replace outright) becomes 100% constancy, not the default 0.
    expect(gs.settings?.nvencBitrateConstancyPct).toBe(100);
    expect((gs.rootSetting as any).streamFrame.nvencBitrateScale).toBeUndefined();
  });

  // 2026-10-21: the No-fallback select is retired; migration of the stored key
  // lives in DriverSettingService.migrateLoadedValues and driver-setting.test.ts.

  it('preserves explicit pre-v3 encoder and headset-profile Off choices', async () => {
    const off = {
      nvencTap: false, nvencFixLevel: false, nvencForceCbr: false,
      nvencBitrateConstancyPct: 100, nvencPresetMerge: false,
    };
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2, vrlinkHeadsetProfile: false },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 2, ...off },
    };
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame).toMatchObject({ ...off, nvencSettingsVersion: 4 });
    expect(stored.galaxyXr.vrlinkHeadsetProfile).toBe(false);
    const reopened = buildHarness(structuredClone(stored));
    await reopened.flush();
    expect(reopened.saved).toHaveLength(0);
    expect(reopened.gs.settings).toMatchObject(off);
  });

  it.each([-64, 0, 3072])('preserves explicit pre-v3 tile %s for runtime validation', async tile => {
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2, streamQuality: 'custom', customStreamFormatWidth: tile, customBandwidthMbit: 2500 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 2, nvencCodec: 1 },
    };
    const { gs, flush } = buildHarness(stored);
    await flush();
    expect(gs.galaxyXr.customStreamFormatWidth).toBe(tile);
    expect(gs.galaxyXr.customBandwidthMbit).toBe(2500);
    gs.save();
    const reopened = buildHarness(JSON.parse(JSON.stringify(stored)));
    await reopened.flush();
    expect(reopened.gs.galaxyXr.customStreamFormatWidth).toBe(tile);
    expect(reopened.gs.galaxyXr.customBandwidthMbit).toBe(2500);
    expect(reopened.saved).toHaveLength(0);
  });

  it('fills missing legacy encoder toggle values from defaults', async () => {
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 2 },
    };
    const { gs, flush } = buildHarness(stored);
    await flush();
    for (const key of ['nvencTap', 'nvencFixLevel', 'nvencForceCbr', 'nvencBitrateConstancyPct', 'nvencPresetMerge'] as const) {
      expect(stored.streamFrame[key], key).toBe(driverDefaults.streamFrame![key]);
    }
    expect(gs.galaxyXr.vrlinkHeadsetProfile).toBe(driverDefaults.galaxyXr!.vrlinkHeadsetProfile);
  });

  it.each([
    { enable: false }, { casEnable: false },
    { enable: false, casEnable: true }, { enable: true, casEnable: false },
  ])('keeps explicit post-pack mode %j during the v4 migration', async mode => {
    const stored: any = {
      streamFrame: {
        streamFrameSchema: 5, nvencSettingsVersion: 3, nvencTap: true,
        cas: { enable: true, strength: 0.9 }, postPack: { ...mode, foveaStrength: 0.23 },
      },
    };
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame.postPack).toMatchObject({ ...mode, foveaStrength: 0.23 });
    expect(stored.streamFrame.nvencSettingsVersion).toBe(4);
  });

  it.each([false, true])('keeps legacy CAS Off with independent limitedRange=%s', async limitedRange => {
    const stored: any = {
      streamFrame: {
        streamFrameSchema: 5, nvencSettingsVersion: 3, nvencTap: true,
        cas: { enable: false, strength: 0.87 }, postPack: { limitedRange },
      },
    };
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame.cas.enable).toBe(false);
    expect(stored.streamFrame.postPack.casEnable).toBe(false);
    expect(stored.streamFrame.postPack.enable).toBe(limitedRange);
    expect(stored.streamFrame.cas.strength).toBe(0.87);
  });

  it('distinguishes service-filled post-pack defaults from an explicit stored mode', async () => {
    const raw = {
      galaxyXr: { sdr10SettingsVersion: 2 },
      streamFrame: {
        streamFrameSchema: 5, nvencSettingsVersion: 3, nvencTap: true,
        cas: { enable: true, strength: 0.91 },
      },
    };
    const values = structuredClone(driverDefaults);
    values.galaxyXr = { ...values.galaxyXr!, ...raw.galaxyXr };
    Object.assign(values.streamFrame!, raw.streamFrame, {
      cas: { ...values.streamFrame!.cas, ...raw.streamFrame.cas },
    });
    const { flush } = buildHarness(values, undefined, raw);
    await flush();
    expect(values.streamFrame!.cas.enable).toBe(false);
    expect(values.streamFrame!.postPack).toMatchObject({ enable: true, casEnable: true, foveaStrength: 0.91 });
    expect(raw.streamFrame.cas).toEqual({ enable: true, strength: 0.91 });
  });

  it('moves an enabled pre-encode CAS to post-pack when the NVENC tap is on', async () => {
    const stored: any = {
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 3, nvencTap: true, cas: { enable: true, strength: 0.9 } },
    };
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame.cas.enable).toBe(false);
    expect(stored.streamFrame.postPack.enable).toBe(true);
    expect(stored.streamFrame.postPack.casEnable).toBe(true);
    expect(stored.streamFrame.postPack.foveaStrength).toBe(0.9);
    expect(stored.streamFrame.nvencSettingsVersion).toBe(4);
  });

  it('leaves pre-encode CAS enabled when the NVENC tap is off', async () => {
    const stored: any = {
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 3, nvencTap: false, cas: { enable: true, strength: 0.4 } },
    };
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame.cas.enable).toBe(true);
    expect(stored.streamFrame.postPack.enable).toBe(false);
    expect(stored.streamFrame.nvencSettingsVersion).toBe(4);
  });

  it('does not touch a config that is already at the latest schema', async () => {
    const stored: any = {
      streamFrame: {
        velocityFixMode: 'kalmanCA', streamFrameSchema: 5, nvencSettingsVersion: 4,
        kalmanAngularOutFrame: 'body', kalmanDirLeadMs: 3,
      },
    };
    const { saved, flush } = buildHarness(stored);
    await flush();
    // schema-4 is unconditional only for configs BELOW 4; this one is current
    expect(stored.streamFrame.kalmanDirLeadMs).toBe(3);
    expect(stored.streamFrame.streamFrameSchema).toBe(5);
    expect(saved.length).toBe(0);
  });
});

describe('defaults resolution', () => {
  it('defaults Hitch Diagnostics to off and resets an explicit opt-in to off', async () => {
    const stored = structuredClone(driverDefaults);
    stored.streamFrame!.streamFrameSchema = 5;
    stored.streamFrame!.nvencSettingsVersion = 4;
    stored.streamFrame!.hitchDiag = true;
    const { gs, flush } = buildHarness(stored);
    await flush();
    expect(gs.defaults.hitchDiag).toBe(false);
    expect(gs.settings!.hitchDiag).toBe(true);
    gs.reset('hitchDiag');
    expect(gs.settings!.hitchDiag).toBe(false);
  });

  it('uses the driver-published defaults when present, TS literals as fallback', () => {
    const { gs } = buildHarness({}, { defaultSettings: { streamFrame: { saturation: 42, gamma: 2.4 } } });
    expect(gs.defaults.saturation).toBe(42);
    expect(gs.defaults.gamma).toBe(2.4);
    // keys the driver did not publish fall back to the TS literals
    expect(gs.defaults.fxaa).toBe(driverDefaults.streamFrame!.fxaa);
    expect(gs.defaults.distortion).toEqual(driverDefaults.streamFrame!.distortion);
  });

  it('falls back to the TS literals when the driver publishes no defaults', () => {
    const { gs } = buildHarness({});
    expect(gs.defaults).toEqual(JSON.parse(JSON.stringify(driverDefaults.streamFrame!)));
  });
});

describe('advancedMode', () => {
  it('mirrors the appSetting advanceMode flag', () => {
    const { gs } = buildHarness({});
    expect(gs.advancedMode).toBe(false);
  });
});

describe('Debug Mode preservation', () => {
  it('defaults a missing master to Off and keeps unreadable settings hidden', () => {
    expect(driverDefaults.debugMode).toBe(false);
    expect(buildHarness({}).gs.debugMode).toBe(false);
    expect(buildHarness({ debugMode: true }, undefined, undefined, { reason: 'Read failed' }).gs.debugMode).toBe(false);
  });

  it.each([false, true])('preserves explicit master=%s and selected diagnostics through schema 5', async debugMode => {
    const chosen = {
      hitchDiag: true, poseLogging: false, poseLogBurst: true, nvencVerbose: true,
      eyeGaze: { debugRing: true, predictionMs: 35 },
      blackFloor: { rampBar: true, blackPointCode: 7 },
      gamma: 1.8, nvencPreset: 3, nvencForceFps: 72,
    };
    const stored: any = {
      debugMode, galaxyXr: { sdr10SettingsVersion: 2, vrlinkDebugOverlay: true },
      streamFrame: { streamFrameSchema: 4, nvencSettingsVersion: 4, ...chosen },
    };
    const { gs, saved, flush } = buildHarness(stored);
    await flush();
    expect(gs.debugMode).toBe(debugMode);
    expect(stored.streamFrame).toMatchObject({ streamFrameSchema: 5, ...chosen });
    expect(stored.galaxyXr.vrlinkDebugOverlay).toBe(true);
    expect(saved).toHaveLength(1);
    const reopened = buildHarness(structuredClone(saved[0] as Record<string, unknown>));
    await reopened.flush();
    expect(reopened.gs.debugMode).toBe(debugMode);
    expect(reopened.gs.settings).toMatchObject(chosen);
    expect(reopened.gs.galaxyXr.vrlinkDebugOverlay).toBe(true);
    expect(reopened.saved).toHaveLength(0);
  });
});

describe('tuner bands and segment layout', () => {
  it('generates evenly spaced bands between first and last', () => {
    const { gs } = buildHarness({});
    gs.tuneBandCount = 7;
    gs.tuneBandFirst = 0.15;
    gs.tuneBandLast = 0.65;
    gs.updateBands();
    expect(gs.settings!.distortion!.tune!.bands).toEqual([0.15, 0.233, 0.317, 0.4, 0.483, 0.567, 0.65]);
  });

  it('clamps band count to [2, 12]', () => {
    const { gs } = buildHarness({});
    gs.tuneBandCount = 1; gs.tuneBandFirst = 0.1; gs.tuneBandLast = 0.5;
    gs.updateBands();
    expect(gs.settings!.distortion!.tune!.bands).toHaveLength(2);
    expect(gs.tuneBandCount).toBe(2);

    gs.tuneBandCount = 99;
    gs.updateBands();
    expect(gs.settings!.distortion!.tune!.bands).toHaveLength(12);
    expect(gs.tuneBandCount).toBe(12);
  });

  it('clamps band bounds (first > 0.02, last in (first, 1.2])', () => {
    const { gs } = buildHarness({});
    gs.tuneBandCount = 3; gs.tuneBandFirst = 0; gs.tuneBandLast = 0;
    gs.updateBands();
    expect(gs.tuneBandFirst).toBe(0.02);
    expect(gs.tuneBandLast).toBeCloseTo(0.07, 10);

    gs.tuneBandFirst = 0.1; gs.tuneBandLast = 2;
    gs.updateBands();
    expect(gs.tuneBandLast).toBe(1.2);
  });

  it('parses and clamps the segment layout text', () => {
    const { gs } = buildHarness({});
    gs.segLayoutText = '1 2 3 4';
    gs.updateSegLayout();
    expect(gs.settings!.distortion!.tune!.segmentLayout).toEqual([1, 2, 3, 4]);

    gs.segLayoutText = '0 40 abc';
    gs.updateSegLayout();
    expect(gs.settings!.distortion!.tune!.segmentLayout).toEqual([1, 32, 1]);

    gs.segLayoutText = '';
    gs.updateSegLayout();
    expect(gs.settings!.distortion!.tune!.segmentLayout).toEqual([]);
  });
});

describe('srgb matrix text', () => {
  it('accepts exactly 9 finite numbers', () => {
    const { gs } = buildHarness({});
    gs.onMatrixTextChanged('1, 0, 0, 0, 1, 0, 0, 0, 1');
    expect(gs.settings!.srgbMatrix).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(gs.matrixError()).toBe('');
  });

  it('rejects wrong counts and non-numeric entries', () => {
    const { gs } = buildHarness({});
    const before = JSON.stringify(gs.settings!.srgbMatrix);
    gs.onMatrixTextChanged('1 2 3 4 5 6 7 8');
    expect(gs.settings!.srgbMatrix).toEqual(JSON.parse(before));
    expect(gs.matrixError()).toBe('Needs exactly 9 numbers (row major 3x3), or empty to disable');

    gs.onMatrixTextChanged('1, x, 0, 0, 1, 0, 0, 0, 1');
    expect(gs.matrixError()).toBe('Needs exactly 9 numbers (row major 3x3), or empty to disable');
  });

  it('disables the matrix on empty input', () => {
    const { gs } = buildHarness({});
    gs.onMatrixTextChanged('1 0 0 0 1 0 0 0 1');
    gs.onMatrixTextChanged('   ');
    expect(gs.settings!.srgbMatrix).toEqual([]);
    expect(gs.matrixError()).toBe('');
  });
});

describe('CAS mode', () => {
  it('switches between post-pack, pre-encode and off', () => {
    const { gs } = buildHarness({});
    const s = gs.settings!;

    gs.casMode = 'postpack';
    expect(gs.casMode).toBe('postpack');
    expect(s.postPack!.enable).toBe(true);
    expect(s.postPack!.casEnable).toBe(true);
    expect(s.cas!.enable).toBe(false);

    gs.casMode = 'preencode';
    expect(gs.casMode).toBe('preencode');
    expect(s.postPack!.casEnable).toBe(false);
    expect(s.postPack!.enable).toBe(s.postPack!.limitedRange);
    expect(s.cas!.enable).toBe(true);

    gs.casMode = 'off';
    expect(gs.casMode).toBe('off');
    expect(s.postPack!.casEnable).toBe(false);
    expect(s.cas!.enable).toBe(false);
  });
});

describe('calibration lifecycle', () => {
  it('reports active when any calibration flag is on, and stops them all', () => {
    const { gs } = buildHarness({});
    expect(gs.calibrationActive()).toBe(false);
    gs.settings!.distortion!.tune!.enable = true;
    expect(gs.calibrationActive()).toBe(true);
    gs.stopCalibration();
    expect(gs.settings!.distortion!.tune!.enable).toBe(false);
    expect(gs.settings!.distortion!.centerTune!.enable).toBe(false);
    expect(gs.settings!.eyeGaze!.probeCapture).toBe(false);
    expect(gs.settings!.eyeGaze!.debugGrid).toBe(false);
    expect(gs.calibrationActive()).toBe(false);
  });

  it('creates the calib block lazily on first blackout toggle', () => {
    const { gs } = buildHarness({});
    expect(gs.settings!.calib).toBeUndefined();
    gs.setBlackout(true);
    expect(gs.settings!.calib).toEqual({ blackout: true, eye: -1, patternBrightness: 1, captureMode: false, pattern: -1, patternBits: 10 });
    gs.setBlackout(false);
    expect(gs.settings!.calib!.blackout).toBe(false);
  });
});

describe('controller offsets', () => {
  it('detects dirty per-hand offsets and resets to zero', () => {
    const { gs, saved } = buildHarness({});
    expect(gs.handOffsetsDirty('left')).toBe(false);
    gs.controllerSettings!.left!.rotationOffsetDeg!.x = 5;
    expect(gs.handOffsetsDirty('left')).toBe(true);
    expect(gs.handOffsetsDirty('right')).toBe(false);
    gs.resetHandOffsets('left');
    expect(gs.controllerSettings!.left!.rotationOffsetDeg).toEqual({ x: 0, y: 0, z: 0 });
    expect(saved.length).toBeGreaterThan(0);
  });
});

describe('velocity modes', () => {
  it('classifies kalman-family modes and retired modes', () => {
    const { gs } = buildHarness({});
    gs.settings!.velocityFixMode = 'kalmanCA';
    expect(gs.isKalmanMode()).toBe(true);
    gs.settings!.velocityFixMode = 'kalman';
    expect(gs.isKalmanMode()).toBe(true);
    gs.settings!.velocityFixMode = 'off';
    expect(gs.isKalmanMode()).toBe(false);

    expect(gs.isRetiredVelocityMode('kalmanCAM')).toBe(true);
    expect(gs.isRetiredVelocityMode('kalmanCA')).toBe(false);
    expect(gs.isRetiredVelocityMode(undefined)).toBe(false);
  });
});

describe('reset', () => {
  it('restores a key to the published default and saves', () => {
    const { gs, saved } = buildHarness({});
    gs.settings!.gamma = 99;
    gs.reset('gamma');
    expect(gs.settings!.gamma).toBe(driverDefaults.streamFrame!.gamma);
    expect(saved.length).toBeGreaterThan(0);
  });

  it('resets the srgb matrix text with the restored default', () => {
    const { gs } = buildHarness({});
    gs.onMatrixTextChanged('1 2 3 4 5 6 7 8 9');
    gs.reset('srgbMatrix');
    const expected = driverDefaults.streamFrame!.srgbMatrix;
    expect(gs.settings!.srgbMatrix).toEqual(expected);
    expect(gs.matrixText()).toEqual((expected ?? []).join(', '));
    expect(gs.matrixError()).toBe('');
  });

  it('reports alignment dirty vs default', () => {
    const { gs } = buildHarness({});
    expect(gs.alignmentDirty()).toBe(false);
    gs.settings!.alignment!.leftH = 0.5;
    expect(gs.alignmentDirty()).toBe(true);
    gs.reset('alignment');
    expect(gs.alignmentDirty()).toBe(false);
  });
});

describe('galaxyXr config', () => {
  it('keeps legacy tier selections and fills only missing custom values', () => {
    const { gs } = buildHarness({ galaxyXr: { streamQuality: 'stable' } });
    expect(gs.galaxyXr.streamQuality).toBe('stable');
    expect(gs.galaxyXr.customStreamFormatWidth).toBe(1536);
    expect(gs.galaxyXr.customBandwidthMbit).toBe(300);

    const { gs: gs2 } = buildHarness({ galaxyXr: { streamQuality: 'ultra' } });
    expect(gs2.galaxyXr.streamQuality).toBe('ultra');
    expect(gs2.galaxyXr.customStreamFormatWidth).toBe(2048);
    expect(gs2.galaxyXr.customBandwidthMbit).toBe(450);

    const { gs: gs3 } = buildHarness({ galaxyXr: { streamQuality: 'sharp' } });
    expect(gs3.galaxyXr.streamQuality).toBe('sharp');
    expect(gs3.galaxyXr.customBandwidthMbit).toBe(450);

    // A legacy tier can remain authoritative at runtime without overwriting
    // the user's saved values for a later explicit switch to custom.
    const { gs: gs4 } = buildHarness({ galaxyXr: { streamQuality: 'sharp', customStreamFormatWidth: 1536, customBandwidthMbit: 100 } });
    expect(gs4.galaxyXr.streamQuality).toBe('sharp');
    expect(gs4.galaxyXr.customBandwidthMbit).toBe(100);
    expect(gs4.galaxyXr.customStreamFormatWidth).toBe(1536);
  });

  it('uses the native defaults and raises a one-shot notice for an unrecognized streamQuality', () => {
    const { gs } = buildHarness({ galaxyXr: { streamQuality: 'mystery', customStreamFormatWidth: 2048, customBandwidthMbit: 500 } });
    // The driver cannot resolve this name and applies the native defaults; the
    // page must show the same values instead of the inert custom pair.
    expect(gs.streamQualityValues).toEqual({ width: 1536, bandwidth: 350 });
    expect(gs.streamQualityNotice()).toEqual({ name: 'mystery', tile: 1536, bandwidth: 350 });
    // A nonzero Advanced bandwidth override replaces the fallback budget; the
    // notice must quote the value the driver will actually use.
    const { gs: overrideNotice } = buildHarness({
      galaxyXr: { streamQuality: 'mystery' },
      streamFrame: { nvencBandwidthOverrideMbit: 600 },
    });
    expect(overrideNotice.streamQualityNotice()).toEqual({ name: 'mystery', tile: 1536, bandwidth: 600 });
    // The first explicit edit switches to custom and adopts the displayed
    // defaults for the other field, so what the rows show is what is saved.
    gs.setStreamQualityValue('width', 1024);
    expect(gs.galaxyXr.streamQuality).toBe('custom');
    expect(gs.galaxyXr.customStreamFormatWidth).toBe(1024);
    expect(gs.galaxyXr.customBandwidthMbit).toBe(350);
  });

  it('does not raise the fallback notice for custom, tiers or aliases', () => {
    for (const quality of ['custom', 'balanced', 'ultra', 'sharp']) {
      const { gs } = buildHarness({ galaxyXr: { streamQuality: quality } });
      expect(gs.streamQualityNotice()).toBeUndefined();
    }
  });

  it('fills missing galaxyXr keys with the shipped defaults', () => {
    const { gs } = buildHarness({ galaxyXr: { streamQuality: 'balanced' } });
    expect(gs.galaxyXr.nativeResolution).toBe(true);
    expect(gs.galaxyXr.sdr10Baseline).toBe(true);
    expect(gs.galaxyXr.renderModelScale).toBe(1.15);
    expect(gs.galaxyXr.customBandwidthMbit).toBe(350);
    expect(gs.galaxyXr.synthesizeGripTouch).toBe(true);
    expect(gs.galaxyXr.gripTouchThreshold).toBe(0.03);
  });

  it('creates the whole galaxyXr block with nativeIdentity when absent', () => {
    const { gs } = buildHarness({});
    expect(gs.galaxyXr.nativeIdentity).toBe(true);
    expect(gs.galaxyXr.streamQuality).toBe('custom');
    expect(gs.galaxyXr.renderModelScale).toBe(1.15);
  });

  it('honours sdr10Baseline and its custom-shader conflict', () => {
    // 2026-10-23 (owner directive): the shipped default is On.
    const { gs: defaulted } = buildHarness(structuredClone(driverDefaults));
    expect(defaulted.sdr10BaselineActive()).toBe(true);
    const { gs: filled } = buildHarness({ galaxyXr: {} });
    expect(filled.galaxyXr.sdr10Baseline).toBe(true);
    expect(filled.sdr10BaselineActive()).toBe(true);

    const { gs } = buildHarness({ galaxyXr: { sdr10Baseline: true } });
    expect(gs.sdr10BaselineActive()).toBe(true);

    const { gs: conflicting } = buildHarness({
      galaxyXr: { sdr10Baseline: true },
      customShader: { enable: true, enableForOther: true },
    });
    expect(conflicting.sdr10BaselineConflict()).toBe(true);
    expect(conflicting.sdr10BaselineActive()).toBe(false);

    // H.264 is 8-bit only: the stored On is suppressed, matching the
    // disabled switch and the driver's codec gate.
    const { gs: h264 } = buildHarness({ galaxyXr: { sdr10Baseline: true }, streamFrame: { nvencCodec: 1 } });
    expect(h264.sdr10BaselineActive()).toBe(false);
  });
});

describe('profile import/export', () => {
  function sampleProfile(): Record<string, unknown> {
    return {
      type: 'streamFrameDistortionProfile',
      version: 1,
      name: 'Test Profile',
      distortion: {
        mode: 'spline', perEye: true, perAxis: false, segments: 8,
        points: [{ r: 0, scale: 1 }, { r: 1, scale: 1.1 }],
        curves: { left: { k1: 0.1, k2: 0.2, points: [{ r: 0, scale: 1 }] } },
        annulus: { enable: true }, tune: { enable: true }, centerTune: { enable: true },
      },
      k1: 0.01, k2: 0.02,
      centerOffsetXLeft: 0.01, centerOffsetXRight: -0.01, centerOffsetY: 0.02,
    };
  }

  it('rejects invalid JSON', () => {
    const { gs } = buildHarness({});
    gs.shareText.set('{ not json');
    gs.importProfile();
    expect(gs.shareStatus()).toContain('Not valid JSON');
  });

  it('rejects non-profile documents', () => {
    const { gs } = buildHarness({});
    gs.shareText.set(JSON.stringify({ hello: 'world' }));
    gs.importProfile();
    expect(gs.shareStatus()).toBe('Not a stream frame distortion profile.');
  });

  it('applies a full profile and strips the tuning diagnostics', () => {
    const { gs, saved } = buildHarness({});
    gs.shareText.set(JSON.stringify(sampleProfile()));
    gs.importProfile();
    const d = gs.settings!.distortion!;
    expect(d.mode).toBe('spline');
    expect(d.perEye).toBe(true);
    expect(d.perAxis).toBe(false);
    expect(d.segments).toBe(8);
    expect(d.points).toEqual([{ r: 0, scale: 1 }, { r: 1, scale: 1.1 }]);
    expect(d.curves!.left).toEqual({ k1: 0.1, k2: 0.2, points: [{ r: 0, scale: 1 }] });
    expect(gs.settings!.k1).toBe(0.01);
    expect(gs.settings!.k2).toBe(0.02);
    expect(gs.settings!.centerOffsetXLeft).toBe(0.01);
    expect(gs.settings!.centerOffsetXRight).toBe(-0.01);
    expect(gs.settings!.centerOffsetY).toBe(0.02);
    expect(saved.length).toBeGreaterThan(0);
    expect(gs.shareStatus()).toBe('Profile applied: Test Profile');
  });

  it('falls back to safe values for malformed profile fields', () => {
    const { gs } = buildHarness({});
    gs.shareText.set(JSON.stringify({
      type: 'streamFrameDistortionProfile',
      distortion: { mode: 'bogus', perEye: true, perAxis: true, segments: 99, points: 'nope', curves: { left: { k1: 'x', points: [{ r: 'y', scale: 2 }] } } },
      k1: 'nope', centerOffsetXLeft: true,
    }));
    gs.importProfile();
    const d = gs.settings!.distortion!;
    expect(d.mode).toBe('k1k2'); // not 'spline'
    expect(d.segments).toBe(1); // out of [2, 32]
    expect(d.points).toEqual([]);
    expect(d.curves!.left.k1).toBe(0);
    expect(d.curves!.left.points).toEqual([]);
    expect(gs.settings!.k1).toBe(0);
  });

  it('imports controller-aligner saves straight into the offset fields', () => {
    const { gs, saved } = buildHarness({});
    gs.shareText.set(JSON.stringify({
      controllers: { rotationOffsetDeg: { x: 1, y: 2, z: 3 }, positionOffsetCm: { x: 4, y: 5, z: 6 } },
    }));
    gs.importProfile();
    expect(gs.controllerSettings!.rotationOffsetDeg).toEqual({ x: 1, y: 2, z: 3 });
    expect(gs.controllerSettings!.positionOffsetCm).toEqual({ x: 4, y: 5, z: 6 });
    expect(gs.shareStatus()).toBe('Controller offsets imported and applied.');
    expect(saved.length).toBeGreaterThan(0);
  });

  it('applies only center offsets for centersOnly saves (curves untouched)', () => {
    const { gs } = buildHarness({});
    const modeBefore = gs.settings!.distortion!.mode;
    gs.shareText.set(JSON.stringify({
      type: 'streamFrameDistortionProfile',
      centersOnly: true,
      centerOffsetXLeft: 0.5, centerOffsetXRight: -0.5, centerOffsetY: 0.25,
      distortion: { mode: 'spline', points: [{ r: 0, scale: 9 }] },
    }));
    gs.importProfile();
    expect(gs.settings!.centerOffsetXLeft).toBe(0.5);
    expect(gs.settings!.centerOffsetXRight).toBe(-0.5);
    expect(gs.settings!.centerOffsetY).toBe(0.25);
    expect(gs.settings!.distortion!.mode).toBe(modeBefore);
    expect(gs.shareStatus()).toContain('curves untouched');
  });

  it('drops the displacement map when the profile has none', () => {
    const { gs } = buildHarness({});
    gs.settings!.distortion!.map = { enable: true, cols: 2, rows: 2, left: [1, 2, 3, 4], right: [5, 6, 7, 8], source: 'old' } as any;
    gs.shareText.set(JSON.stringify(sampleProfile()));
    gs.importProfile();
    expect(gs.settings!.distortion!.map).toBeUndefined();
  });

  it('applies a valid dense displacement map from v2 profiles', () => {
    const { gs } = buildHarness({});
    gs.shareText.set(JSON.stringify({
      ...sampleProfile(),
      distortion: { ...sampleProfile().distortion as object, map: { enable: true, cols: 2, rows: 2, left: [0, 1, 2, 3, 4, 5, 6, 7], right: [8, 9, 10, 11, 12, 13, 14, 15], source: 'cam' } },
    }));
    gs.importProfile();
    expect(gs.settings!.distortion!.map).toEqual({ enable: true, cols: 2, rows: 2, left: [0, 1, 2, 3, 4, 5, 6, 7], right: [8, 9, 10, 11, 12, 13, 14, 15], source: 'cam' });
  });
});

describe('per-codec encoder defaults', () => {
  // each codec owns a default rate-control profile (galaxy-settings.ts):
  // Force CBR is OFF in every row (owner directive 2026-10-23); HEVC/AV1 carry a 2-frame VBV, H.264 one frame
  // (splitMode stays 1 everywhere — it also opens the 12.1 session; the
  // tap skips the split bits for codec 1 itself). 2026-10-16 owner directive:
  // a codec switch applies that codec's table row at once — tile, bandwidth
  // and the four dependent encoder rows replace the previous codec's values;
  // table-independent rows and values entered for the new codec survive
  // until the next explicit switch. The switch is simulated exactly as the
  // page does it: set nvencCodec, then applyCodecEncoderDefaults (which
  // saves).
  it('switches to H.264 loading its optimized defaults over entered values', async () => {
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2, customStreamFormatWidth: 2048, customBandwidthMbit: 600 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 0, nvencForceCbr: false, nvencVbvFrames: 9, nvencLowDelayKfScale: 3, nvencSplitMode: 2 },
    };
    const { gs, saved, flush } = buildHarness(stored);
    await flush();
    expect(saved).toHaveLength(0); // the load itself rewrites nothing
    gs.settings!.nvencCodec = 1;
    gs.applyCodecEncoderDefaults(1);
    expect(gs.settings!.nvencCodec).toBe(1);
    // the H.264 table row replaced every codec-owned value
    const h264 = codecEncoderDefaults[1];
    expect(gs.settings!.nvencForceCbr).toBe(h264.forceCbr);
    expect(gs.settings!.nvencVbvFrames).toBe(h264.vbvFrames);
    expect(gs.settings!.nvencLowDelayKfScale).toBe(h264.lowDelayKfScale);
    expect(gs.settings!.nvencSplitMode).toBe(h264.splitMode);
    expect(gs.galaxyXr.customStreamFormatWidth).toBe(h264.streamFormatWidth);
    expect(gs.galaxyXr.customBandwidthMbit).toBe(h264.bandwidthMbit);
    expect(gs.galaxyXr.streamQuality).toBe('custom');
    expect(saved).toHaveLength(1); // applyCodecEncoderDefaults saves once
    const reopened = buildHarness(structuredClone(saved[0]) as any);
    await reopened.flush();
    expect(reopened.saved).toHaveLength(0);
    expect(reopened.gs.galaxyXr.customBandwidthMbit).toBe(500);
    expect(reopened.gs.settings?.nvencForceCbr).toBe(false);
  });

  it.each([0, 2])('switches to codec %s loading its optimized defaults', async codec => {
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2, customStreamFormatWidth: 2048, customBandwidthMbit: 600 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 1, nvencForceCbr: false, nvencVbvFrames: 1, nvencLowDelayKfScale: 3, nvencSplitMode: 2 },
    };
    const { gs, saved, flush } = buildHarness(stored);
    await flush();
    expect(saved).toHaveLength(0);
    gs.settings!.nvencCodec = codec as number;
    gs.applyCodecEncoderDefaults(codec as number);
    const def = codecEncoderDefaults[codec as number];
    expect(gs.settings!.nvencCodec).toBe(codec as number);
    // the table row — including the entered tile/bandwidth — is replaced
    expect(gs.settings!.nvencForceCbr).toBe(def.forceCbr);
    expect(gs.settings!.nvencVbvFrames).toBe(def.vbvFrames);
    expect(gs.settings!.nvencLowDelayKfScale).toBe(def.lowDelayKfScale);
    expect(gs.settings!.nvencSplitMode).toBe(def.splitMode);
    expect(gs.galaxyXr.customStreamFormatWidth).toBe(def.streamFormatWidth);
    expect(gs.galaxyXr.customBandwidthMbit).toBe(def.bandwidthMbit);
    expect(saved).toHaveLength(1);
  });

  it('switches only the codec and the codec-owned keys that actually differ (HEVC -> AV1)', () => {
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2, streamQuality: 'custom', customStreamFormatWidth: 1536, customBandwidthMbit: 350 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 0, nvencForceCbr: false, nvencVbvFrames: 2, nvencLowDelayKfScale: 2, nvencSplitMode: 1 },
    };
    const { gs } = buildHarness(stored);
    void gs.galaxyXr; void gs.settings; // materialize getter default fills before the baseline clone
    const before = structuredClone(gs.rootSetting) as any;
    gs.settings!.nvencCodec = 2;
    gs.applyCodecEncoderDefaults(2);
    const after = structuredClone(gs.rootSetting) as any;
    // HEVC and AV1 share every optimized value except the bandwidth: both
    // rows carry splitMode 1 (2026-10-17 evening — AV1's row applies the
    // portable forced split, so the switch changes no split value).
    before.streamFrame.nvencCodec = 2;
    before.galaxyXr.customBandwidthMbit = 280;
    expect(after).toEqual(before);
  });

  it('preserves the H.264 recipe across every codec switch and reopen', async () => {
    const chosen = {
      nvencQpFovea: -2, nvencQpPeriphery: 3,
      nvencH264GopFrames: 144, nvencH264IdrFrames: 288, nvencH264RefFrames: 2,
      nvencH264Entropy: 2, nvencH264SliceMode: 0, nvencH264SliceData: 12,
      nvencH264Aud: false, nvencH264RepeatHeaders: false,
      nvencH264DisableHeaders: true, nvencH264BitstreamRestriction: false,
      nvencH264VbvInitialDelay: 12345, nvencMultiPass: 2,
      postPack: { enable: true, limitedRange: true },
    };
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2, streamQuality: 'custom' },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 1, ...chosen },
    };
    let harness = buildHarness(stored);
    await harness.flush();
    expect(harness.saved).toHaveLength(0);
    for (const codec of [0, 2, 1]) {
      harness.gs.settings!.nvencCodec = codec;
      harness.gs.applyCodecEncoderDefaults(codec);
      expect(harness.saved).toHaveLength(1);
      const persisted = JSON.parse(JSON.stringify(harness.saved[0]));
      // table-independent rows keep the entered choices through the switch
      expect(persisted.streamFrame).toMatchObject(chosen);
      harness = buildHarness(persisted);
      await harness.flush();
      expect(harness.saved).toHaveLength(0);
      expect(harness.gs.settings).toMatchObject({ nvencCodec: codec, ...chosen });
    }
    // the final apply (codec 1) replaced the codec-owned rows with the table
    expect(harness.gs.settings!.nvencForceCbr).toBe(false);
    expect(harness.gs.settings!.nvencVbvFrames).toBe(1);
    expect(harness.gs.settings!.nvencLowDelayKfScale).toBe(2);
    expect(harness.gs.settings!.nvencSplitMode).toBe(1);
    expect(harness.gs.galaxyXr.customStreamFormatWidth).toBe(codecEncoderDefaults[1].streamFormatWidth); // the switch applies the codec's negotiated-carryable row (H.264 = 1024)
    expect(harness.gs.galaxyXr.customBandwidthMbit).toBe(500);
  });

  it('turns the SDR 10-bit baseline off when switching to H.264 and leaves it off on switch-away', async () => {
    // 2026-10-17 (owner directive): H.264 cannot carry 10-bit. Selecting it
    // writes sdr10Baseline false only; the retired consent key and the
    // explicit advanced 10-bit capability request stay user-owned and
    // untouched, and switching away never silently re-enables the baseline.
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2, sdr10Baseline: true, sdr10AllowEnhancements: true, profileSupports10bit: true },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 0 },
    };
    const { gs, saved, flush } = buildHarness(stored);
    await flush();
    expect(saved).toHaveLength(0); // the load itself rewrites nothing
    gs.settings!.nvencCodec = 1;
    gs.applyCodecEncoderDefaults(1);
    expect(saved).toHaveLength(1);
    const persisted = JSON.parse(JSON.stringify(saved[0]));
    expect(persisted.galaxyXr.sdr10Baseline).toBe(false);
    expect(persisted.galaxyXr.profileSupports10bit).toBe(true);
    gs.settings!.nvencCodec = 0;
    gs.applyCodecEncoderDefaults(0);
    expect(saved).toHaveLength(2);
    expect(gs.galaxyXr.sdr10Baseline).toBe(false); // never silently re-enabled
  });

  it('preserves unsupported encoder inputs until runtime can report validation errors', async () => {
    const chosen = {
      nvencH264GopFrames: -8, nvencH264IdrFrames: -9, nvencH264RefFrames: 99,
      nvencH264Entropy: 18, nvencH264SliceMode: 17, nvencH264SliceData: -4,
      nvencH264VbvInitialDelay: -4, nvencMultiPass: 17, nvencSplitMode: 7,
    };
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 1, ...chosen },
    };
    const { gs, saved, flush } = buildHarness(stored);
    await flush();
    expect(saved).toHaveLength(0);
    gs.save();
    const persisted = JSON.parse(JSON.stringify(saved[0]));
    expect(persisted.streamFrame).toMatchObject(chosen);
    const reopened = buildHarness(persisted);
    await reopened.flush();
    expect(reopened.gs.settings).toMatchObject(chosen);
    expect(reopened.saved).toHaveLength(0);
  });

  it('keeps entered tile/bandwidth and encoder rows through a codec-1 reload', async () => {
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2, customStreamFormatWidth: 2048, customBandwidthMbit: 600 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 1, nvencForceCbr: false, nvencVbvFrames: 9, nvencLowDelayKfScale: 3, nvencSplitMode: 2 },
    };
    const { gs, saved, flush } = buildHarness(stored);
    await flush();
    expect(saved).toHaveLength(0); // no stamp — the load rewrites nothing
    expect(gs.galaxyXr.customStreamFormatWidth).toBe(2048);
    expect(gs.galaxyXr.customBandwidthMbit).toBe(600);
    expect(gs.settings?.nvencForceCbr).toBe(false);
    expect(gs.settings?.nvencVbvFrames).toBe(9);
    const reopened = buildHarness(structuredClone(stored));
    await reopened.flush();
    expect(reopened.saved).toHaveLength(0);
    expect(reopened.gs.galaxyXr.customBandwidthMbit).toBe(600);
    expect(reopened.gs.settings?.nvencForceCbr).toBe(false);
  });

  it('keeps the defaults table internally consistent', () => {
    // AV1 matches HEVC on every key except its own default bandwidth; both
    // rows carry splitMode 1 (2026-10-17 evening owner directive: portable
    // forced split, live-validated; explicit strip counts stay a user choice).
    const { bandwidthMbit: av1Bandwidth, splitMode: av1Split, ...av1Rest } = codecEncoderDefaults[2];
    const { bandwidthMbit: hevcBandwidth, splitMode: hevcSplit, ...hevcRest } = codecEncoderDefaults[0];
    expect(av1Rest).toEqual(hevcRest);
    expect(av1Bandwidth).toBe(280);
    expect(av1Split).toBe(1);
    expect(hevcSplit).toBe(1);
    expect(hevcBandwidth).toBe(350);
    expect(codecEncoderDefaults[1].forceCbr).toBe(false);
    expect(codecEncoderDefaults[1].vbvFrames).toBe(1);
    expect(codecEncoderDefaults[1].splitMode).toBe(1); // split bits are skipped for codec 1 in the tap, but the key still opens the 12.1 session
    expect(codecEncoderDefaults[1].lowDelayKfScale).toBe(codecEncoderDefaults[0].lowDelayKfScale);
    expect(codecEncoderDefaults[1].streamFormatWidth).toBe(1024); // owner-verified 2026-10-17: the Steam Link client negotiates the H.264 1024x4096 tile class
    expect(codecEncoderDefaults[1].bandwidthMbit).toBe(500);
    // the codec-0 row must stay pinned to the GENERATED driver defaults:
    // a Config.h default change + regeneration must desync loudly here,
    // not silently in the reset arrows (streamFrameDefaults forces the
    // nvenc* arrows onto the bundled row).
    expect(codecEncoderDefaults[0].forceCbr).toBe(driverDefaults.streamFrame!.nvencForceCbr);
    expect(codecEncoderDefaults[0].vbvFrames).toBe(driverDefaults.streamFrame!.nvencVbvFrames);
    expect(codecEncoderDefaults[0].lowDelayKfScale).toBe(driverDefaults.streamFrame!.nvencLowDelayKfScale);
    expect(codecEncoderDefaults[0].splitMode).toBe(driverDefaults.streamFrame!.nvencSplitMode);
    expect(codecEncoderDefaults[0].streamFormatWidth).toBe(driverDefaults.galaxyXr!.customStreamFormatWidth);
    expect(codecEncoderDefaults[0].bandwidthMbit).toBe(driverDefaults.galaxyXr!.customBandwidthMbit);
  });
});

describe('Async Spacewarp toggle (2026-10-17; semantics 2026-10-26)', () => {
  it('defaults to false; a never-set Spacewarp key keeps the dated stamp absent', async () => {
    expect(driverDefaults.streamFrame!.spacewarpEnable).toBe(false);
    expect(driverDefaults.streamFrame!.spacewarpMode).toBe(0);
    expect(driverDefaults.streamFrame!.spacewarpSettingsVersion).toBe(1);
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 0 },
    };
    const { gs, saved, flush } = buildHarness(stored);
    await flush();
    expect(saved).toHaveLength(0); // never-set feature: no migration, no silent stamp
    expect(gs.settings?.spacewarpEnable).toBe(false);
    const reopened = buildHarness(structuredClone(stored));
    await reopened.flush();
    expect(reopened.saved).toHaveLength(0);
  });

  it('keeps an explicit toggle and forces the stored mode through reset and round-trip', async () => {
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, spacewarpEnable: true, spacewarpMode: 1 },
    };
    const raw = structuredClone(stored);
    const { gs, saved, flush } = buildHarness(stored, undefined, raw);
    await flush();
    expect(saved).toHaveLength(1); // dated semantics stamp (the selection itself stays)
    const stamped = JSON.parse(JSON.stringify(saved[0]));
    expect(stamped.streamFrame.spacewarpEnable).toBe(true);
    expect(stamped.streamFrame.spacewarpMode).toBe(1);
    expect(stamped.streamFrame.spacewarpSettingsVersion).toBe(2);
    expect(gs.settings?.spacewarpEnable).toBe(true);
    expect(gs.settings?.spacewarpMode).toBe(1);
    gs.reset('spacewarpEnable');
    expect(gs.settings?.spacewarpEnable).toBe(false); // native default
    expect(gs.settings?.spacewarpMode).toBe(1); // the separate Force row is not reset with ASW
    gs.reset('spacewarpMode');
    expect(gs.settings?.spacewarpMode).toBe(0); // Automatic
    const persisted = JSON.parse(JSON.stringify(saved[saved.length - 1]));
    expect(persisted.streamFrame.spacewarpEnable).toBe(false);
    expect(persisted.streamFrame.spacewarpMode).toBe(0);
    const reopened = buildHarness(persisted);
    await reopened.flush();
    expect(reopened.gs.settings?.spacewarpEnable).toBe(false);
    expect(reopened.gs.settings?.spacewarpMode).toBe(0);
  });
});

describe('H.264 stored-profile migration', () => {
  // 2026-10-16 (owner policy): the load stamp is retired — user-entered
  // values are authoritative for every codec and nothing is rewritten
  // silently on load. a pre-wave stored codec-1 profile carrying the
  // codec-0 default shape (the codec switch no longer adapts it) loads as
  // stored: the shipped codec-0-shaped values stay, and an explicit 2048
  // tile stays too.
  it('keeps a codec-0-shaped H.264 profile as stored (no 500 stamp); an explicit 2048 tile stays', async () => {
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2, customStreamFormatWidth: 1536, customBandwidthMbit: 350 },
      streamFrame: {
        streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 1,
        nvencForceCbr: true, nvencVbvFrames: 2, nvencLowDelayKfScale: 2, nvencSplitMode: 1,
      },
    };
    const { gs, saved, flush } = buildHarness(stored);
    await flush();
    expect(saved).toHaveLength(0); // the load rewrote nothing — no 500 stamp
    expect(stored.galaxyXr.customBandwidthMbit).toBe(350);
    expect(gs.galaxyXr.customBandwidthMbit).toBe(350);
    expect(gs.galaxyXr.customStreamFormatWidth).toBe(1536);
    expect(gs.settings?.nvencForceCbr).toBe(true);
    expect(gs.settings?.nvencVbvFrames).toBe(2);
    expect(gs.settings?.nvencLowDelayKfScale).toBe(2);
    expect(gs.settings?.nvencSplitMode).toBe(1);
    const reopened = buildHarness(structuredClone(stored));
    await reopened.flush();
    expect(reopened.saved).toHaveLength(0);
    expect(reopened.gs.galaxyXr.customBandwidthMbit).toBe(350);
    expect(reopened.gs.settings?.nvencForceCbr).toBe(true);
    // an explicit 2048 tile (and its entered bandwidth) under H.264 stays
    const explicit: any = {
      galaxyXr: { sdr10SettingsVersion: 2, customStreamFormatWidth: 2048, customBandwidthMbit: 600 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 1 },
    };
    const { gs: gsExplicit, saved: savedExplicit, flush: flushExplicit } = buildHarness(explicit);
    await flushExplicit();
    expect(savedExplicit).toHaveLength(0);
    expect(gsExplicit.galaxyXr.customStreamFormatWidth).toBe(2048);
    expect(gsExplicit.galaxyXr.customBandwidthMbit).toBe(600);
    expect(gsExplicit.settings?.nvencCodec).toBe(1);
  });

  it('keeps a deviated H.264 profile untouched (explicit user choices)', async () => {
    const stored: any = {
      streamFrame: {
        streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 1,
        nvencForceCbr: true, nvencVbvFrames: 1,
      },
    };
    const { gs, flush } = buildHarness(stored);
    await flush();
    expect(gs.settings?.nvencForceCbr).toBe(true);
    expect(gs.settings?.nvencVbvFrames).toBe(1);
    expect(gs.galaxyXr.customBandwidthMbit).toBe(350);
    const reopened = buildHarness(structuredClone(stored));
    await reopened.flush();
    // The first explicit getter read created a previously absent headset
    // block. Its first reopen advances only the SDR migration marker.
    expect(reopened.saved).toHaveLength(1);
    expect(reopened.gs.galaxyXr.profileSupports10bit).toBe(false);
    expect(reopened.gs.settings?.nvencForceCbr).toBe(true);
    const reopenedAgain = buildHarness(structuredClone(reopened.gs.rootSetting));
    await reopenedAgain.flush();
    expect(reopenedAgain.saved).toHaveLength(0);
  });

  it('keeps a legacy tier selection and its default bandwidth without a codec stamp', async () => {
    const stored: any = {
      galaxyXr: { streamQuality: 'sharp' },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 1 },
    };
    const { gs, flush } = buildHarness(stored);
    await flush();
    expect(gs.galaxyXr.customBandwidthMbit).toBe(450);
    expect(gs.galaxyXr.customStreamFormatWidth).toBe(1536);
    expect(gs.galaxyXr.streamQuality).toBe('sharp');
    expect(gs.settings?.nvencForceCbr).toBe(false);
    expect(gs.settings?.nvencVbvFrames).toBe(2);
  });

  it.each(['width', 'bandwidth'] as const)('editing %s leaves the other displayed legacy-tier value unchanged', async key => {
    const { gs, flush } = buildHarness({
      galaxyXr: { streamQuality: 'max', customStreamFormatWidth: 1536, customBandwidthMbit: 350, sdr10SettingsVersion: 2 },
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4 }
    });
    await flush();
    expect(gs.streamQualityValues).toEqual({ width: 2048, bandwidth: 450 });
    gs.setStreamQualityValue(key, key === 'width' ? 768 : 600);
    expect(gs.galaxyXr.streamQuality).toBe('custom');
    expect(gs.streamQualityValues).toEqual(key === 'width' ? { width: 768, bandwidth: 450 } : { width: 2048, bandwidth: 600 });
  });

  it('leaves HEVC profiles untouched', async () => {
    const stored: any = {
      streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, nvencCodec: 0 },
    };
    const { gs, flush } = buildHarness(stored);
    await flush();
    expect(gs.settings?.nvencForceCbr).toBe(false);
    expect(gs.settings?.nvencVbvFrames).toBe(2);
    const reopened = buildHarness(structuredClone(stored));
    await reopened.flush();
    expect(reopened.saved).toHaveLength(0);
  });
});

describe('seven-point custom bitrate curve', () => {
  it('seeds Custom from the visible preset, validates points and resets both keys', async () => {
    const { gs, saved, flush } = buildHarness({});
    await flush();
    gs.setBitrateCurve(1);
    expect(gs.settings?.nvencBitrateCurve).toBe(1);
    gs.setBitrateCurve(3);
    expect(gs.settings?.nvencBitrateCurve).toBe(3);
    const seeded = gs.settings!.nvencBitrateCurvePoints;
    expect(seeded).toHaveLength(7);
    expect(seeded[3].y).toBeGreaterThan(0.5); // power-knee shape, not the linear default

    const moved = seeded.map(point => ({ ...point }));
    moved[2] = { x: 0.5, y: 0.5 };
    expect(gs.setCustomBitrateCurve(moved)).toBe(true);
    expect(gs.settings?.nvencBitrateCurvePoints[2]).toEqual({ x: 0.5, y: 0.5 });
    expect(gs.setCustomBitrateCurve([{ x: 0, y: 0 }])).toBe(false);
    expect(gs.settings?.nvencBitrateCurvePoints[2]).toEqual({ x: 0.5, y: 0.5 });

    gs.resetBitrateCurve();
    expect(gs.settings?.nvencBitrateCurve).toBe(0);
    expect(gs.settings?.nvencBitrateCurvePoints.map(point => ({ ...point }))).toEqual([
      { x: 0, y: 0 }, { x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }, { x: 0.6, y: 0.6 },
      { x: 0.8, y: 0.8 }, { x: 1, y: 1 }, { x: 1, y: 1 },
    ]);
    expect(saved.length).toBeGreaterThan(0);
    const reopened = buildHarness(structuredClone(saved[saved.length - 1] as any));
    await reopened.flush();
    expect(reopened.gs.settings?.nvencBitrateCurve).toBe(0);
  });

  it('upgrades a stored five-point custom shape on load and persists seven points', async () => {
    const stored = {
      streamFrame: {
        streamFrameSchema: 5, nvencSettingsVersion: 4, nvencBitrateCurve: 3,
        nvencBitrateCurvePoints: [
          { x: 0, y: 0 }, { x: 0.1, y: 0.05 }, { x: 0.4, y: 0.3 },
          { x: 0.7, y: 0.9 }, { x: 1, y: 1 },
        ],
      },
    };
    const { gs, saved, flush } = buildHarness(stored);
    await flush();
    expect(gs.settings?.nvencBitrateCurvePoints).toEqual([
      { x: 0, y: 0 }, { x: 0.1, y: 0.05 }, { x: 0.4, y: 0.3 },
      { x: 0.7, y: 0.9 }, { x: 0.85, y: 0.95 }, { x: 1, y: 1 }, { x: 1, y: 1 },
    ]);
    expect(saved.length).toBeGreaterThan(0);
    const persisted = saved[saved.length - 1] as any;
    expect(persisted.streamFrame.nvencBitrateCurvePoints).toHaveLength(7);
    const reopened = buildHarness(persisted);
    await reopened.flush();
    expect(reopened.saved).toHaveLength(0);
    expect(reopened.gs.settings?.nvencBitrateCurvePoints).toHaveLength(7);
  });
});
