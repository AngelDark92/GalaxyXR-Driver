import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_SPECS, DEFAULT_CONTROL_CONTEXT, controlSpec, crossFieldIssues, inertReasons,
  numberInputError, numberBounds,
  type ControlContext, type NumberControlSpec,
} from './control-specs';
import { driverDefaults } from './driver-defaults';
import { ofxrDefaults } from './ofxr';

const ctx = (codec: number): ControlContext => ({ ...DEFAULT_CONTROL_CONTEXT, codec });

function valueAt(root: unknown, path: string): unknown {
  let current: any = root;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function optionValues(key: string): Array<string | number> {
  const spec = controlSpec(key);
  if (!spec || spec.kind !== 'choice') throw new Error(`Not a choice spec: ${key}`);
  return spec.options.map(option => option.value).sort((a, b) => Number(a) - Number(b));
}

describe('control specs', () => {
  it('covers every numeric key that has been migrated with a real settings key', () => {
    for (const spec of CONTROL_SPECS) {
      const isGui = spec.kind === 'number' && spec.source === 'gui';
      const root = isGui ? ofxrDefaults : driverDefaults;
      const path = isGui ? spec.key.replace(/^ofxr\./, '') : spec.key;
      expect(valueAt(root, path), spec.key).not.toBeUndefined();
    }
  });

  it('keeps every slider band inside the hard bounds for every codec', () => {
    for (const spec of CONTROL_SPECS) {
      if (spec.kind !== 'number' || !spec.slider) continue;
      for (const codec of [0, 1, 2]) {
        const { min, max } = numberBounds(spec as NumberControlSpec, ctx(codec));
        expect(spec.slider.min, spec.key).toBeGreaterThanOrEqual(min);
        expect(spec.slider.max, spec.key).toBeLessThanOrEqual(max);
        expect(spec.slider.step, spec.key).toBeGreaterThan(0);
      }
    }
  });

  it('uses a positive step and consistent integer flags', () => {
    for (const spec of CONTROL_SPECS) {
      expect(spec.label.length, spec.key).toBeGreaterThan(0);
      if (spec.kind !== 'number') continue;
      expect(spec.step, spec.key).toBeGreaterThan(0);
      if (spec.integer) expect(Number.isInteger(spec.step), spec.key).toBe(true);
    }
  });

  it('keeps the bandwidth sliders at the 1500 Mbit/s guidance band', () => {
    for (const key of ['galaxyXr.customBandwidthMbit', 'streamFrame.nvencBandwidthOverrideMbit', 'streamFrame.nvencBitrateMbit']) {
      const spec = controlSpec(key);
      expect(spec?.kind, key).toBe('number');
      if (spec?.kind === 'number') expect(spec.slider?.max, key).toBe(1500);
    }
  });

  it('keeps the render sliders at the 8192 guidance band with the 16384 native bound', () => {
    for (const key of ['galaxyXr.renderWidth', 'galaxyXr.renderHeight']) {
      const spec = controlSpec(key);
      expect(spec?.kind, key).toBe('number');
      if (spec?.kind !== 'number') continue;
      expect(spec.slider?.min, key).toBe(16);
      expect(spec.slider?.max, key).toBe(8192);
      expect(spec.slider?.step, key).toBe(16);
      expect(numberBounds(spec, ctx(0)).max, key).toBe(16384);
      expect(numberInputError(key, 8193, ctx(0)), key).toBeUndefined();
      expect(numberInputError(key, 12000, ctx(0)), key).toBeUndefined();
      expect(numberInputError(key, 16385, ctx(0)), key).toBeTruthy();
    }
  });

  it('marks every finite set with storedFallback so a stored value is never replaced', () => {
    for (const spec of CONTROL_SPECS) {
      if (spec.kind === 'choice') expect(spec.storedFallback, spec.key).toBe(true);
    }
  });

  it('matches the native enumeration for every migrated finite set', () => {
    // NvencTap.cpp:1497-1520
    expect(optionValues('streamFrame.nvencSplitMode')).toEqual([0, 1, 2, 3, 4, 15]);
    expect(optionValues('streamFrame.nvencPreset')).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(optionValues('streamFrame.nvencMultiPass')).toEqual([-1, 0, 1, 2]);
    expect(optionValues('streamFrame.nvencH264Entropy')).toEqual([0, 1, 2]);
    expect(optionValues('streamFrame.nvencH264SliceMode')).toEqual([0, 1, 2, 3]);
    expect(optionValues('streamFrame.nvencVuiFullRange')).toEqual([-1, 0, 1]);
  });
});

describe('cross-field rules', () => {
  it('flags min QP above max QP only when max QP is enabled', () => {
    expect(crossFieldIssues({
      'streamFrame.nvencMaxQp': 51, 'streamFrame.nvencMinQp': 60,
    })).toHaveLength(1);
    expect(crossFieldIssues({
      'streamFrame.nvencMaxQp': 0, 'streamFrame.nvencMinQp': 60,
    })).toHaveLength(0);
    expect(crossFieldIssues({
      'streamFrame.nvencMaxQp': 51, 'streamFrame.nvencMinQp': 40, 'streamFrame.nvencMinQpIntra': 51,
    })).toHaveLength(0);
  });

  it('flags a VUI range that contradicts post-pack output', () => {
    expect(crossFieldIssues({
      'streamFrame.postPack.enable': true, 'streamFrame.postPack.limitedRange': true,
      'streamFrame.nvencVuiFullRange': 1,
    })).toHaveLength(1);
    expect(crossFieldIssues({
      'streamFrame.postPack.enable': true, 'streamFrame.postPack.limitedRange': true,
      'streamFrame.nvencVuiFullRange': 0,
    })).toHaveLength(0);
    expect(crossFieldIssues({
      'streamFrame.postPack.enable': false, 'streamFrame.nvencVuiFullRange': 1,
    })).toHaveLength(0);
  });

  it('flags inverted radius and shadow-lift ranges', () => {
    expect(crossFieldIssues({
      'streamFrame.distortion.annulus.rMin': 0.6, 'streamFrame.distortion.annulus.rMax': 0.4,
    })).toHaveLength(1);
    expect(crossFieldIssues({
      'streamFrame.blackFloor.shadowLift': true,
      'streamFrame.blackFloor.floorCode': 12, 'streamFrame.blackFloor.kneeCode': 8,
    })).toHaveLength(1);
    expect(crossFieldIssues({
      'streamFrame.blackFloor.shadowLift': false,
      'streamFrame.blackFloor.floorCode': 12, 'streamFrame.blackFloor.kneeCode': 8,
    })).toHaveLength(0);
  });
});

describe('saved-but-not-applied notes', () => {
  it('explains a low-delay keyframe budget while Force CBR is off', () => {
    const spec = controlSpec('streamFrame.nvencLowDelayKfScale') as NumberControlSpec;
    expect(inertReasons(spec, ctx(0))).toEqual(['Turn on Force CBR to apply this.']);
    expect(inertReasons(spec, { ...ctx(0), forceCbr: true })).toEqual([]);
  });

  it('explains split mode on H.264 and VUI tags on AV1', () => {
    const split = controlSpec('streamFrame.nvencSplitMode')!;
    expect(inertReasons(split, ctx(1))).toHaveLength(1);
    expect(inertReasons(split, ctx(0))).toHaveLength(0);
    const vui = controlSpec('streamFrame.nvencVuiMatrix')!;
    expect(inertReasons(vui, ctx(2))).toHaveLength(1);
    expect(inertReasons(vui, ctx(0))).toHaveLength(0);
  });

  it('explains the Kalman and derive gates', () => {
    const grip = controlSpec('streamFrame.kalmanGripBlend')!;
    expect(inertReasons(grip, ctx(0))).toHaveLength(1);
    expect(inertReasons(grip, { ...ctx(0), gripCompensation: true })).toHaveLength(0);
    const derive = controlSpec('streamFrame.deriveSmoothTauSlowMs')!;
    expect(inertReasons(derive, ctx(0))).toHaveLength(1);
    expect(inertReasons(derive, { ...ctx(0), deriveMode: true })).toHaveLength(0);
    const dup = controlSpec('streamFrame.kalmanDupRScale')!;
    expect(inertReasons(dup, ctx(0))).toHaveLength(1);
    expect(inertReasons(dup, { ...ctx(0), softDuplicates: true })).toHaveLength(0);
  });

  it('uses requires for the OFXR log size gate', () => {
    const log = controlSpec('ofxr.maxLogMb')!;
    expect(inertReasons(log, ctx(0))).toHaveLength(1);
    expect(inertReasons(log, { ...ctx(0), ofxrLogging: true })).toHaveLength(0);
  });
});

describe('tile width capability bound', () => {
  const spec = controlSpec('galaxyXr.customStreamFormatWidth') as NumberControlSpec;

  it('resolves 1024 for H.264 and 2048 for HEVC / AV1', () => {
    expect(numberBounds(spec, ctx(1)).max).toBe(1024);
    expect(numberBounds(spec, ctx(0)).max).toBe(2048);
    expect(numberBounds(spec, ctx(2)).max).toBe(2048);
  });

  it('refuses a tile the selected codec cannot allocate', () => {
    // The session probe requires tile * 4 <= the codec height max.
    expect(numberInputError('galaxyXr.customStreamFormatWidth', 1536, ctx(1))).toBeTruthy();
    expect(numberInputError('galaxyXr.customStreamFormatWidth', 1536, ctx(0))).toBeUndefined();
    expect(numberInputError('galaxyXr.customStreamFormatWidth', 2048, ctx(2))).toBeUndefined();
    expect(numberInputError('galaxyXr.customStreamFormatWidth', 2049, ctx(0))).toBeTruthy();
    expect(numberInputError('galaxyXr.customStreamFormatWidth', 0, ctx(0))).toBeTruthy();
    expect(numberInputError('galaxyXr.customStreamFormatWidth', 1024.5, ctx(0))).toBeTruthy();
  });
});

describe('numeric input validation', () => {
  it('refuses a non-integer where the native contract requires one', () => {
    expect(numberInputError('streamFrame.nvencH264RefFrames', 2.5, ctx(1))).toBeTruthy();
  });

  it('applies the hard bounds and the native mirror together', () => {
    expect(numberInputError('streamFrame.nvencH264RefFrames', 17, ctx(1))).toBeTruthy();
    expect(numberInputError('streamFrame.nvencH264RefFrames', 16, ctx(1))).toBeUndefined();
    expect(numberInputError('streamFrame.nvencSplitMode', 9, ctx(0))).toBeTruthy();
    expect(numberInputError('streamFrame.nvencH264Entropy', 3, ctx(1))).toBeTruthy();
    expect(numberInputError('streamFrame.gamma', 0, ctx(0))).toBeTruthy();
    expect(numberInputError('streamFrame.gamma', 0.5, ctx(0))).toBeUndefined();
    expect(numberInputError('streamFrame.brightness', -1, ctx(0))).toBeTruthy();
  });

  it('keeps the native sentinel ranges writable', () => {
    expect(numberInputError('streamFrame.nvencH264GopFrames', -1, ctx(1))).toBeUndefined();
    expect(numberInputError('streamFrame.nvencH264GopFrames', 0, ctx(1))).toBeUndefined();
    expect(numberInputError('streamFrame.nvencH264GopFrames', -2, ctx(1))).toBeTruthy();
    expect(numberInputError('streamFrame.nvencQpFovea', -20, ctx(0))).toBeUndefined();
    expect(numberInputError('streamFrame.nvencQpFovea', -129, ctx(0))).toBeTruthy();
  });
});

describe('raw numeric controls ratchet', () => {
  // Every new numeric row must render through numberControl()/sliderControl()
  // (which require a spec) or lower this number by migrating an old row.
  // Raising the baseline is a defect: it means an undeclared control was added.
  // 4 remaining raw controls are deliberate: the App Settings scale slider
  // (GUI preference with its own clamp) and the three GUI-only tuner band
  // layout fields, which generate settings.distortion.tune.bands rather than
  // storing a value directly.
  const baseline = 4;
  const featuresDir = decodeURIComponent(fileURLToPath(new URL('../features/', import.meta.url)));

  it('does not grow the number of hand-written app-number / app-slider controls', () => {
    let total = 0;
    for (const file of readdirSync(featuresDir)) {
      if (!file.endsWith('.ts') || file === 'page-base.ts') continue;
      const source = readFileSync(`${featuresDir}${file}`, 'utf8');
      total += (source.match(/<app-number/g) ?? []).length;
      total += (source.match(/<app-slider/g) ?? []).length;
    }
    expect(total).toBeLessThanOrEqual(baseline);
  });

  it('every spec-driven control names a declared spec', () => {
    const helper = /(?:numberControl|choiceControl|sliderControl)\('([^']+)'/g;
    for (const file of readdirSync(featuresDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(`${featuresDir}${file}`, 'utf8');
      for (const match of source.matchAll(helper)) {
        expect(controlSpec(match[1]), `${file}: ${match[1]}`).toBeDefined();
      }
      for (const vector of source.matchAll(/keys:\s*\[([^\]]+)\]/g)) {
        for (const key of vector[1].matchAll(/'([^']+)'/g)) {
          expect(controlSpec(key[1]), `${file}: ${key[1]}`).toBeDefined();
        }
      }
    }
  });
});
