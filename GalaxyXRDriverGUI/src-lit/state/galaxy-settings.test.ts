// Unit tests for the Galaxy settings state (state/galaxy-settings.ts):
// persisted-schema migrations (schema 2/3/4, NVENC v3/v4), defaults
// resolution, tuner band/segment generation, matrix text parsing, CAS
// mode switching, calibration lifecycle, and profile import semantics.
//
// The class takes the three root services through its constructor, so the
// tests use minimal fakes: the constructor's effects run synchronously and
// migrated saves are queueMicrotask'd, flushed by a macrotask await.
import { describe, it, expect } from 'vitest';
import { GalaxySettingsBase } from './galaxy-settings';
import { driverDefaults } from '../domain/driver-defaults';

type Harness = {
  gs: GalaxySettingsBase;
  saved: unknown[];
  flush: () => Promise<void>;
};

function buildHarness(stored: Record<string, unknown> | undefined = {}, disValues: unknown = undefined, rawStored: unknown = undefined) {
  const saved: unknown[] = [];
  const dss = {
    values: () => stored,
    save: (v: unknown) => { saved.push(v); },
    ...(rawStored === undefined ? {} : { storedValues: () => rawStored }),
  };
  const dis = { values: () => disValues };
  const appSettings = { values: () => ({ advanceMode: false }) };
  const gs = new GalaxySettingsBase(appSettings as any, dss as any, dis as any);
  const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  return { gs, saved, flush };
}

describe('schema migrations', () => {
  it.each([false, true])('migrates SDR10 OFF with legacy compatibility=%s without changing tuning', async legacy10bit => {
    const stored = structuredClone(driverDefaults);
    stored.streamFrame!.streamFrameSchema = 4;
    stored.streamFrame!.nvencSettingsVersion = 4;
    stored.galaxyXr!.sdr10Baseline = false;
    stored.galaxyXr!.profileSupports10bit = legacy10bit;
    stored.galaxyXr!.customBandwidthMbit = 177;
    stored.streamFrame!.gamma = 1.8;
    const { saved, flush } = buildHarness(stored);
    await flush();
    expect(stored.galaxyXr!.sdr10SettingsVersion).toBe(2);
    expect(stored.galaxyXr!.profileSupports10bit).toBe(false);
    expect(stored.galaxyXr!.customBandwidthMbit).toBe(177);
    expect(stored.streamFrame!.gamma).toBe(1.8);
    expect(saved.length).toBe(1);
    const reopened = buildHarness(JSON.parse(JSON.stringify(stored)));
    await reopened.flush();
    expect(reopened.saved).toHaveLength(0);
  });

  it.each([false, true])('keeps active SDR10 and its legacy compatibility=%s during migration', async legacy10bit => {
    const stored = structuredClone(driverDefaults);
    stored.streamFrame!.streamFrameSchema = 4;
    stored.streamFrame!.nvencSettingsVersion = 4;
    stored.galaxyXr!.sdr10Baseline = true;
    stored.galaxyXr!.profileSupports10bit = legacy10bit;
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.galaxyXr!.sdr10SettingsVersion).toBe(2);
    expect(stored.galaxyXr!.sdr10Baseline).toBe(true);
    expect(stored.galaxyXr!.profileSupports10bit).toBe(legacy10bit);
  });

  it('chains schema 1 -> 2 -> 3 -> 4 for an exact-default legacy kalman config', async () => {
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
    expect(stored.streamFrame.streamFrameSchema).toBe(4);
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
    expect(stored.streamFrame.streamFrameSchema).toBe(4);
  });

  it('keeps custom kalmanCA tuning intact through schema 3/4', async () => {
    const stored: any = {
      streamFrame: {
        velocityFixMode: 'kalmanCA',
        kalmanCaJerk: 99, kalmanCaPosNoiseMm: 3.3, kalmanCaOriNoiseDeg: 3.3,
        kalmanCaAccelTauMs: 50, kalmanCaExactCov: true,
        streamFrameSchema: 4, nvencSettingsVersion: 4,
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
      const stored: any = { streamFrame: { streamFrameSchema: 4, nvencSettingsVersion: 4, kalmanAngularOutFrame: raw } };
      const { flush } = buildHarness(stored);
      await flush();
      expect(stored.streamFrame.kalmanAngularOutFrame).toBe(expected);
    }
  });

  it('retains intentional pre-v3 scalar resets to the shipped v3 defaults', async () => {
    const d: any = driverDefaults.streamFrame;
    const stored: any = {
      streamFrame: {
        streamFrameSchema: 4, nvencSettingsVersion: 2,
        nvencPreset: 'custom', nvencBitrateMbit: 123, nvencMinQp: 5,
      },
    };
    const { flush } = buildHarness(stored);
    await flush();
    expect(stored.streamFrame.nvencPreset).toBe(d.nvencPreset);
    expect(stored.streamFrame.nvencBitrateMbit).toBe(d.nvencBitrateMbit);
    expect(stored.streamFrame.nvencMinQp).toBe(d.nvencMinQp);
    expect(stored.streamFrame.nvencSettingsVersion).toBe(4);
  });

  it('preserves explicit pre-v3 encoder and headset-profile Off choices', async () => {
    const off = {
      nvencTap: false, nvencFixLevel: false, nvencForceCbr: false,
      nvencBitrateScale: false, nvencPresetMerge: false,
    };
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2, vrlinkHeadsetProfile: false },
      streamFrame: { streamFrameSchema: 4, nvencSettingsVersion: 2, ...off },
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

  it('fills missing legacy encoder toggle values from defaults', async () => {
    const stored: any = {
      galaxyXr: { sdr10SettingsVersion: 2 },
      streamFrame: { streamFrameSchema: 4, nvencSettingsVersion: 2 },
    };
    const { gs, flush } = buildHarness(stored);
    await flush();
    for (const key of ['nvencTap', 'nvencFixLevel', 'nvencForceCbr', 'nvencBitrateScale', 'nvencPresetMerge'] as const) {
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
        streamFrameSchema: 4, nvencSettingsVersion: 3, nvencTap: true,
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
        streamFrameSchema: 4, nvencSettingsVersion: 3, nvencTap: true,
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
        streamFrameSchema: 4, nvencSettingsVersion: 3, nvencTap: true,
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
      streamFrame: { streamFrameSchema: 4, nvencSettingsVersion: 3, nvencTap: true, cas: { enable: true, strength: 0.9 } },
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
      streamFrame: { streamFrameSchema: 4, nvencSettingsVersion: 3, nvencTap: false, cas: { enable: true, strength: 0.4 } },
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
        velocityFixMode: 'kalmanCA', streamFrameSchema: 4, nvencSettingsVersion: 4,
        kalmanAngularOutFrame: 'body', kalmanDirLeadMs: 3,
      },
    };
    const { saved, flush } = buildHarness(stored);
    await flush();
    // schema-4 is unconditional only for configs BELOW 4; this one is at 4
    expect(stored.streamFrame.kalmanDirLeadMs).toBe(3);
    expect(stored.streamFrame.streamFrameSchema).toBe(4);
    expect(saved.length).toBe(0);
  });
});

describe('defaults resolution', () => {
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
  it('migrates legacy v1 tier names to the v3 tier set', () => {
    const { gs } = buildHarness({ galaxyXr: { streamQuality: 'stable' } });
    expect(gs.galaxyXr.streamQuality).toBe('efficient');

    const { gs: gs2 } = buildHarness({ galaxyXr: { streamQuality: 'ultra' } });
    expect(gs2.galaxyXr.streamQuality).toBe('max');

    const { gs: gs3 } = buildHarness({ galaxyXr: { streamQuality: 'quality' } });
    expect(gs3.galaxyXr.streamQuality).toBe('balanced');
  });

  it('fills missing galaxyXr keys with the shipped defaults', () => {
    const { gs } = buildHarness({ galaxyXr: { streamQuality: 'balanced' } });
    expect(gs.galaxyXr.nativeResolution).toBe(true);
    expect(gs.galaxyXr.renderModelScale).toBe(1.15);
    expect(gs.galaxyXr.customBandwidthMbit).toBe(350);
    expect(gs.galaxyXr.synthesizeGripTouch).toBe(true);
    expect(gs.galaxyXr.gripTouchThreshold).toBe(0.03);
  });

  it('creates the whole galaxyXr block with nativeIdentity when absent', () => {
    const { gs } = buildHarness({});
    expect(gs.galaxyXr.nativeIdentity).toBe(true);
    expect(gs.galaxyXr.streamQuality).toBe('balanced');
    expect(gs.galaxyXr.renderModelScale).toBe(1.15);
  });

  it('honours sdr10Baseline and its custom-shader conflict', () => {
    const { gs } = buildHarness({ galaxyXr: { sdr10Baseline: true } });
    expect(gs.sdr10BaselineActive()).toBe(true);

    const { gs: conflicting } = buildHarness({
      galaxyXr: { sdr10Baseline: true },
      customShader: { enable: true, enableForOther: true },
    });
    expect(conflicting.sdr10BaselineConflict()).toBe(true);
    expect(conflicting.sdr10BaselineActive()).toBe(false);
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
