// Hardware capability gating unit tests (2026-11-03).
//
// Covers the precedence chain (encoder tap > LUID-matched probe > single
// adapter > ambiguous/unknown) and every verdict surface used by the UI.
import { describe, expect, it } from 'vitest';
import type { AdapterCapabilities, DriverInfo, GpuCapabilities } from './types';
import {
  codecSupport, effectiveAdapter, multipassSupport, nvencTapSupport,
  ofxrNvidiaSupport, presetSupport, splitModeSupport, tenBitSupport, tileWidthMax,
} from './encoder-capabilities';

const now = 100_000;

function adapter(overrides: Partial<AdapterCapabilities> = {}): AdapterCapabilities {
  return {
    adapterLuid: 'luid-1',
    gpuName: 'Test GPU',
    nvenc: true,
    opticalFlow: true,
    apiVersion: 1201,
    codecs: {
      hevc: { supported: true, tenBit: true, maxHeight: 8192, engines: 2, split: true, presets: [0, 1, 2, 3, 4, 5, 6, 7] },
      h264: { supported: true, tenBit: false, maxHeight: 4096, engines: 2, split: true, presets: [0, 1, 2, 3, 4, 5, 6, 7] },
      av1: { supported: true, tenBit: true, maxHeight: 8192, engines: 2, split: true, presets: [0, 1, 2, 3, 4, 5, 6, 7] },
    },
    ...overrides,
  };
}

function gpu(overrides: Partial<GpuCapabilities> = {}): GpuCapabilities {
  return { adapters: [adapter()], checkedAt: now, ...overrides };
}

function tap(overrides: Partial<NonNullable<DriverInfo['encoderTap']>> = {}): NonNullable<DriverInfo['encoderTap']> {
  return {
    enabled: true,
    hookInstalled: true,
    upgradedSessionsRemain: false,
    configPath: '',
    modulePath: '',
    pid: 1234,
    observedAt: now,
    capabilities: adapter(),
    ...overrides,
  };
}

describe('effectiveAdapter precedence', () => {
  it('uses a fresh encoder-tap observation as authoritative', () => {
    const g = gpu({ adapters: [{ ...adapter(), nvenc: false }] });
    const result = effectiveAdapter(g, tap({ capabilities: adapter({ adapterLuid: 'other' }) }), now);
    expect(result.known).toBe(true);
    expect(result.adapter?.nvenc).toBe(true);
  });

  it('uses the single probe adapter when the tap has no capabilities', () => {
    const result = effectiveAdapter(gpu(), tap({ capabilities: undefined }), now);
    expect(result.known).toBe(true);
    expect(result.adapter?.adapterLuid).toBe('luid-1');
  });

  it('falls back to a single unambiguous adapter', () => {
    const result = effectiveAdapter(gpu(), undefined, now);
    expect(result.known).toBe(true);
    expect(result.adapter?.gpuName).toBe('Test GPU');
  });

  it('stays unverified with multiple adapters and no identity', () => {
    const result = effectiveAdapter(gpu({ adapters: [adapter({ adapterLuid: 'a' }), adapter({ adapterLuid: 'b' })] }), undefined, now);
    expect(result.known).toBe(false);
    expect(result.ambiguous).toBe(true);
    expect(result.reason).toContain('Multiple GPUs');
  });

  it('stays unverified when no adapters are reported', () => {
    const result = effectiveAdapter(gpu({ adapters: [] }), undefined, now);
    expect(result.known).toBe(false);
    expect(result.reason).toContain('No GPU adapters');
  });

  it('stays unverified when the probe is absent', () => {
    const result = effectiveAdapter(undefined, undefined, now);
    expect(result.known).toBe(false);
    expect(result.reason).toContain('GPU capability check unavailable');
  });

  it('ignores a stale encoder-tap observation', () => {
    const result = effectiveAdapter(undefined, tap({ observedAt: now - 6000 }), now);
    expect(result.known).toBe(false);
  });

  it('ignores a future-dated encoder-tap observation', () => {
    const result = effectiveAdapter(undefined, tap({ observedAt: now + 3000 }), now);
    expect(result.known).toBe(false);
  });
});

describe('codecSupport', () => {
  it('reports supported for a known codec', () => {
    expect(codecSupport(effectiveAdapter(gpu(), undefined, now), 0).verdict).toBe('supported');
  });

  it('reports unsupported when the codec is marked unsupported', () => {
    const a = adapter({ codecs: { hevc: { supported: false }, h264: { supported: true }, av1: { supported: true } } });
    expect(codecSupport({ adapter: a, known: true, ambiguous: false }, 0).verdict).toBe('unsupported');
  });

  it('reports unverified when the codec capability is missing', () => {
    const a = adapter({ codecs: {} });
    expect(codecSupport({ adapter: a, known: true, ambiguous: false }, 0).verdict).toBe('unverified');
  });

  it('reports unverified when the adapter is unknown', () => {
    expect(codecSupport(effectiveAdapter(undefined, undefined, now), 0).verdict).toBe('unverified');
  });
});

describe('tenBitSupport', () => {
  it('is unsupported for H.264 regardless of GPU', () => {
    expect(tenBitSupport(effectiveAdapter(gpu(), undefined, now), 1).verdict).toBe('unsupported');
  });

  it('is supported when the codec reports tenBit true', () => {
    expect(tenBitSupport(effectiveAdapter(gpu(), undefined, now), 0).verdict).toBe('supported');
  });

  it('is unsupported when the codec reports tenBit false', () => {
    const a = adapter({ codecs: { hevc: { tenBit: false }, h264: {}, av1: {} } });
    expect(tenBitSupport({ adapter: a, known: true, ambiguous: false }, 0).verdict).toBe('unsupported');
  });

  it('is unverified when the adapter is unknown', () => {
    expect(tenBitSupport(effectiveAdapter(undefined, undefined, now), 0).verdict).toBe('unverified');
  });
});

describe('nvencTapSupport', () => {
  it('is supported on an NVIDIA adapter', () => {
    expect(nvencTapSupport(effectiveAdapter(gpu(), undefined, now)).verdict).toBe('supported');
  });

  it('is unsupported when nvenc is false', () => {
    const a = adapter({ nvenc: false });
    expect(nvencTapSupport({ adapter: a, known: true, ambiguous: false }).verdict).toBe('unsupported');
  });

  it('is unverified on ambiguous hardware', () => {
    expect(nvencTapSupport(effectiveAdapter(gpu({ adapters: [adapter(), adapter({ adapterLuid: 'b' })] }), undefined, now)).verdict).toBe('unverified');
  });
});

describe('presetSupport', () => {
  it('always allows Auto (0)', () => {
    expect(presetSupport(effectiveAdapter(undefined, undefined, now), 0, 0).verdict).toBe('supported');
  });

  it('allows a reported preset', () => {
    expect(presetSupport(effectiveAdapter(gpu(), undefined, now), 0, 7).verdict).toBe('supported');
  });

  it('refuses a missing preset', () => {
    const a = adapter({ codecs: { hevc: { presets: [0, 1, 2, 3, 4, 5] }, h264: {}, av1: {} } });
    expect(presetSupport({ adapter: a, known: true, ambiguous: false }, 0, 7).verdict).toBe('unsupported');
  });

  it('inherits codec unsupported verdict', () => {
    const a = adapter({ codecs: { hevc: { supported: false }, h264: {}, av1: {} } });
    expect(presetSupport({ adapter: a, known: true, ambiguous: false }, 0, 1).verdict).toBe('unsupported');
  });
});

describe('splitModeSupport', () => {
  it('allows forced modes when split and engines are sufficient', () => {
    expect(splitModeSupport(effectiveAdapter(gpu(), undefined, now), 0, 2).verdict).toBe('supported');
  });

  it('refuses forced mode when split is false', () => {
    const a = adapter({ codecs: { hevc: { split: false, engines: 4 }, h264: {}, av1: {} } });
    expect(splitModeSupport({ adapter: a, known: true, ambiguous: false }, 0, 2).verdict).toBe('unsupported');
  });

  it('refuses forced mode when not enough engines', () => {
    const a = adapter({ codecs: { hevc: { split: true, engines: 2 }, h264: {}, av1: {} } });
    expect(splitModeSupport({ adapter: a, known: true, ambiguous: false }, 0, 4).verdict).toBe('unsupported');
  });

  it('keeps auto/driver-chosen/disabled selectable with an inactive notice when split is unavailable', () => {
    const a = adapter({ codecs: { hevc: { split: false, engines: 0 }, h264: {}, av1: {} } });
    for (const mode of [0, 1]) {
      const r = splitModeSupport({ adapter: a, known: true, ambiguous: false }, 0, mode);
      expect(r.verdict).toBe('supported');
      expect(r.reason).toContain('no effect');
    }
    expect(splitModeSupport({ adapter: a, known: true, ambiguous: false }, 0, 15).verdict).toBe('supported');
  });

  it('judges missing capability fields independently', () => {
    const known = (codecs: AdapterCapabilities['codecs']) => ({ adapter: adapter({ codecs }), known: true, ambiguous: false });
    // Absent engines, explicit split:false => explicit negative fails the gate.
    expect(splitModeSupport(known({ hevc: { split: false }, h264: {}, av1: {} }), 0, 2).verdict).toBe('unsupported');
    // Absent split, explicit low engine count => fails.
    expect(splitModeSupport(known({ hevc: { engines: 1 }, h264: {}, av1: {} }), 0, 2).verdict).toBe('unsupported');
    // Nothing reported => unverified, auto stays selectable.
    expect(splitModeSupport(known({ hevc: {}, h264: {}, av1: {} }), 0, 3).verdict).toBe('unverified');
    expect(splitModeSupport(known({ hevc: {}, h264: {}, av1: {} }), 0, 0).verdict).toBe('supported');
  });
});

describe('multipassSupport', () => {
  it('allows single pass and automatic modes', () => {
    expect(multipassSupport(effectiveAdapter(gpu(), undefined, now), 0, 0).verdict).toBe('supported');
    expect(multipassSupport(effectiveAdapter(gpu(), undefined, now), 0, -1).verdict).toBe('supported');
  });

  it('allows two-pass on NVENC hardware regardless of API version', () => {
    expect(multipassSupport(effectiveAdapter(gpu(), undefined, now), 0, 2).verdict).toBe('supported');
    const old = adapter({ apiVersion: 1200 });
    expect(multipassSupport({ adapter: old, known: true, ambiguous: false }, 0, 2).verdict).toBe('supported');
  });

  it('refuses two-pass only when NVENC is absent', () => {
    const a = adapter({ nvenc: false });
    const r = multipassSupport({ adapter: a, known: true, ambiguous: false }, 0, 2);
    expect(r.verdict).toBe('unsupported');
    expect(r.reason).not.toContain('12.1');
  });

  it('is unverified when the adapter is unknown', () => {
    expect(multipassSupport(effectiveAdapter(undefined, undefined, now), 0, 2).verdict).toBe('unverified');
  });
});

describe('ofxrNvidiaSupport', () => {
  it('is supported when the single adapter has optical flow', () => {
    expect(ofxrNvidiaSupport(gpu()).verdict).toBe('supported');
  });

  it('is unsupported when every adapter lacks optical flow', () => {
    expect(ofxrNvidiaSupport(gpu({ adapters: [adapter({ opticalFlow: false })] })).verdict).toBe('unsupported');
  });

  it('is independent of NVENC availability', () => {
    expect(ofxrNvidiaSupport(gpu({ adapters: [adapter({ nvenc: false, opticalFlow: true })] })).verdict).toBe('supported');
    expect(ofxrNvidiaSupport(gpu({ adapters: [adapter({ nvenc: true, opticalFlow: false })] })).verdict).toBe('unsupported');
  });

  it('does not use the encoder adapter: mixed inventory is unverified', () => {
    const mixed = gpu({ adapters: [adapter({ adapterLuid: 'a', opticalFlow: true }), adapter({ adapterLuid: 'b', opticalFlow: false })] });
    expect(ofxrNvidiaSupport(mixed).verdict).toBe('unverified');
  });

  it('treats non-NVIDIA vendors as lacking NVIDIA Optical Flow', () => {
    expect(ofxrNvidiaSupport(gpu({ adapters: [adapter({ vendorId: 0x1002, opticalFlow: undefined })] })).verdict).toBe('unsupported');
  });

  it('is unverified without a probe or with unreported flow', () => {
    expect(ofxrNvidiaSupport(undefined).verdict).toBe('unverified');
    expect(ofxrNvidiaSupport(gpu({ adapters: [adapter({ opticalFlow: undefined })] })).verdict).toBe('unverified');
  });
});

describe('effectiveAdapter session merge and trust', () => {
  it('fills fields the session did not report from the same-LUID probe', () => {
    const g = gpu({ adapters: [adapter({ adapterLuid: 'luid-1', opticalFlow: true })] });
    const session = adapter({ adapterLuid: 'luid-1', opticalFlow: undefined, gpuName: 'Session GPU' });
    const result = effectiveAdapter(g, tap({ capabilities: session }), now);
    expect(result.adapter?.opticalFlow).toBe(true);
    expect(result.adapter?.gpuName).toBe('Session GPU');
  });

  it('does not borrow hints from a different adapter', () => {
    const g = gpu({ adapters: [adapter({ adapterLuid: 'other', opticalFlow: true })] });
    const session = adapter({ adapterLuid: 'luid-1', opticalFlow: undefined });
    expect(effectiveAdapter(g, tap({ capabilities: session }), now).adapter?.opticalFlow).toBeUndefined();
  });

  it('ignores a stale tap LUID entirely', () => {
    const g = gpu({ adapters: [adapter({ adapterLuid: 'a' }), adapter({ adapterLuid: 'b' })] });
    const result = effectiveAdapter(g, tap({ observedAt: now - 6000, capabilities: adapter({ adapterLuid: 'a' }) }), now);
    expect(result.known).toBe(false);
    expect(result.ambiguous).toBe(true);
  });
});

describe('tileWidthMax', () => {
  it('defaults to 1024 for H.264 and 2048 for HEVC/AV1', () => {
    expect(tileWidthMax(undefined, undefined, 1, now)).toBe(1024);
    expect(tileWidthMax(undefined, undefined, 0, now)).toBe(2048);
    expect(tileWidthMax(undefined, undefined, 2, now)).toBe(2048);
  });

  it('caps at a quarter of the codec maxHeight', () => {
    const g = gpu({ adapters: [adapter({ codecs: { hevc: { maxHeight: 4096 }, h264: {}, av1: {} } })] });
    expect(tileWidthMax(g, undefined, 0, now)).toBe(1024);
  });

  it('prefers the encoder-tap height over the probe', () => {
    const g = gpu({ adapters: [adapter({ codecs: { hevc: { maxHeight: 8192 }, h264: {}, av1: {} } })] });
    const t = tap({ capabilities: adapter({ codecs: { hevc: { maxHeight: 1600 }, h264: {}, av1: {} } }) });
    expect(tileWidthMax(g, t, 0, now)).toBe(400);
  });

  it('ignores a stale tap and uses the probe', () => {
    const g = gpu({ adapters: [adapter({ codecs: { hevc: { maxHeight: 1600 }, h264: {}, av1: {} } })] });
    const t = tap({ capabilities: adapter({ codecs: { hevc: { maxHeight: 8192 }, h264: {}, av1: {} } }), observedAt: now - 6000 });
    expect(tileWidthMax(g, t, 0, now)).toBe(400);
  });

  it('never returns less than 1', () => {
    const g = gpu({ adapters: [adapter({ codecs: { hevc: { maxHeight: 1 }, h264: {}, av1: {} } })] });
    expect(tileWidthMax(g, undefined, 0, now)).toBe(1);
  });
});

describe('unsupported saved values stay displayed', () => {
  it('returns a reason for an unsupported codec while keeping the value selectable', () => {
    const a = adapter({ codecs: { hevc: { supported: false }, h264: { supported: true }, av1: { supported: true } } });
    const reason = codecSupport({ adapter: a, known: true, ambiguous: false }, 0).reason;
    expect(reason).toContain('HEVC');
    expect(reason).toContain('not supported');
  });

  it('returns a reason for an unsupported split mode', () => {
    const a = adapter({ codecs: { hevc: { split: true, engines: 1 }, h264: {}, av1: {} } });
    const reason = splitModeSupport({ adapter: a, known: true, ambiguous: false }, 0, 2).reason;
    expect(reason).toContain('2');
    expect(reason).toContain('1');
  });
});
