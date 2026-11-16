import { describe, expect, it } from 'vitest';
import { encoderEvidenceItems, formatBitrateMbit, formatMultipass, formatPreset, formatTuningInfo, formatVbvBits } from './encoder-evidence';
import type { DriverInfo } from './types';

const baseTap: NonNullable<DriverInfo['encoderTap']> = {
  enabled: true,
  hookInstalled: true,
  upgradedSessionsRemain: false,
  configPath: 'settings.json',
  modulePath: 'driver.dll',
  requestedCodec: 2,
  effectiveCodec: 2,
  effectiveRateControl: 2,
  effectiveSplit: 1,
  encodeWidth: 1920,
  encodeHeight: 3696,
  pid: 42,
  observedAt: 12000,
  effectiveTuningInfo: 0,
  effectivePreset: 5,
  effectiveMultiPass: 2,
  effectiveAverageBitrateMbit: 500,
  effectiveMaxBitrateMbit: 500,
  effectiveVbvBufferSizeBits: 12000000,
  effectiveVbvInitialDelayBits: 12000000,
};

describe('encoder evidence formatters', () => {
  it('formats observed values and reports missing fields as not observed', () => {
    expect(formatBitrateMbit(500)).toMatch('500 Mbit/s');
    expect(formatBitrateMbit(undefined)).toBe('not observed');
    expect(formatPreset(5)).toBe('P5');
    expect(formatPreset(0)).toBe('not observed');
    expect(formatPreset(undefined)).toBe('not observed');
    expect(formatMultipass(0)).toBe('Single pass');
    expect(formatMultipass(1)).toBe('Two passes, quarter resolution');
    expect(formatMultipass(2)).toBe('Two passes, full resolution');
    expect(formatMultipass(undefined)).toBe('not observed');
    expect(formatVbvBits(12000000)).toMatch('12000000 bits');
    expect(formatVbvBits(undefined)).toBe('not observed');
    expect(formatTuningInfo(1)).toBe('High quality');
    expect(formatTuningInfo(2)).toBe('Low latency');
    expect(formatTuningInfo(3)).toBe('Ultra low latency');
    expect(formatTuningInfo(4)).toBe('Lossless');
    expect(formatTuningInfo(5)).toBe('Ultra high quality');
    expect(formatTuningInfo(0)).toBe('Undefined tuning');
    expect(formatTuningInfo(undefined)).toBe('not observed');
    expect(formatTuningInfo(99)).toBe('Unknown (99)');
  });

  it('shows codec mismatch between saved and applied', () => {
    const items = encoderEvidenceItems({ ...baseTap, effectiveCodec: 0 }, { nvencCodec: 2 });
    const codec = items.find(item => item.key === 'Codec')!;
    expect(codec.value).toContain('AV1 saved');
    expect(codec.value).toContain('HEVC applied');
  });

  it('labels resolved Automatic preset and multipass clearly', () => {
    const items = encoderEvidenceItems(baseTap, { nvencCodec: 2, nvencPreset: 0, nvencMultiPass: -1 });
    const preset = items.find(item => item.key === 'Resolved preset')!;
    const multipass = items.find(item => item.key === 'Multipass')!;
    expect(preset.value).toMatch(/^P5/);
    expect(preset.value).toContain('from saved Automatic');
    expect(multipass.value).toMatch(/^Two passes, full resolution/);
    expect(multipass.value).toContain('from saved Automatic');
  });

  it('keeps explicit preset and multipass choices distinct from applied values', () => {
    const items = encoderEvidenceItems(baseTap, { nvencCodec: 2, nvencPreset: 3, nvencMultiPass: 0 });
    const preset = items.find(item => item.key === 'Resolved preset')!;
    const multipass = items.find(item => item.key === 'Multipass')!;
    expect(preset.value).toContain('P3 saved');
    expect(preset.value).toContain('P5 applied');
    expect(multipass.value).toContain('Single pass saved');
    expect(multipass.value).toContain('Two passes, full resolution applied');
  });

  it('includes the Tuning evidence item mapped from effectiveTuningInfo', () => {
    const items = encoderEvidenceItems({ ...baseTap, effectiveTuningInfo: 2 }, { nvencCodec: 2 });
    const tuning = items.find(item => item.key === 'Tuning')!;
    expect(tuning.value).toBe('Low latency');
  });

  it('reports missing telemetry fields without inventing values', () => {
    const sparse: NonNullable<DriverInfo['encoderTap']> = {
      ...baseTap,
      effectiveTuningInfo: undefined,
      effectivePreset: undefined,
      effectiveMultiPass: undefined,
      effectiveAverageBitrateMbit: undefined,
      effectiveMaxBitrateMbit: undefined,
      effectiveVbvBufferSizeBits: undefined,
      effectiveVbvInitialDelayBits: undefined,
    };
    const items = encoderEvidenceItems(sparse, { nvencCodec: 2 });
    for (const key of ['Tuning', 'Average bitrate', 'Max bitrate', 'Resolved preset', 'Multipass', 'VBV buffer', 'VBV initial delay']) {
      expect(items.find(item => item.key === key)?.value).toBe('not observed');
    }
  });
});
