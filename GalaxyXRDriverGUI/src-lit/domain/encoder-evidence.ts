import { t } from '../locale/i18n';
import type { DriverInfo } from './types';

/** One labelled value in the encoder telemetry strip. */
export type EncoderEvidenceItem = {
  key: string;
  value: string;
};

export function formatBitrateMbit(value: number | undefined): string {
  return Number.isFinite(value) ? t('{value} Mbit/s', { value: String(value) }) : t('not observed');
}

export function formatPreset(value: number | undefined): string {
  if (!Number.isFinite(value) || value === 0) return t('not observed');
  return t('P{value}', { value: String(value) });
}

/** Maps NV_ENC_TUNING_INFO enum values exactly as declared in ThirdParty/nvenc/nvEncodeAPI.h.
 *  Do not substitute custom names: the numeric constants are verified from the header. */
export function formatTuningInfo(value: number | undefined): string {
  if (!Number.isFinite(value)) return t('not observed');
  if (value === 0) return t('Undefined tuning');
  if (value === 1) return t('High quality');
  if (value === 2) return t('Low latency');
  if (value === 3) return t('Ultra low latency');
  if (value === 4) return t('Lossless');
  if (value === 5) return t('Ultra high quality');
  return t('Unknown ({value})', { value: String(value) });
}

export function formatMultipass(value: number | undefined): string {
  if (!Number.isFinite(value)) return t('not observed');
  if (value === 0) return t('Single pass');
  if (value === 1) return t('Two passes, quarter resolution');
  if (value === 2) return t('Two passes, full resolution');
  return t('Unknown ({value})', { value: String(value) });
}

export function formatVbvBits(value: number | undefined): string {
  return Number.isFinite(value) ? t('{value} bits', { value: String(value) }) : t('not observed');
}

const CODEC_NAMES = ['HEVC', 'H.264', 'AV1'];

function codecName(codec: number | undefined): string {
  return CODEC_NAMES[codec ?? -1] ?? t('Unknown');
}

/**
 * Build the applied-configuration evidence row from fresh, process-bound
 * encoder telemetry. Missing optional fields are reported as not observed
 * rather than synthesized. The saved selection is shown alongside the applied
 * value so the user can see where a resolved Automatic preset/multipass came
 * from.
 */
export function encoderEvidenceItems(
  tap: NonNullable<DriverInfo['encoderTap']>,
  saved: {
    nvencCodec?: number;
    nvencPreset?: number;
    nvencMultiPass?: number;
  }
): EncoderEvidenceItem[] {
  const savedCodecName = codecName(saved.nvencCodec);
  const appliedCodecName = codecName(tap.effectiveCodec);
  const codec = tap.effectiveCodec === saved.nvencCodec
    ? savedCodecName
    : t('{saved} saved, {applied} applied', { saved: savedCodecName, applied: appliedCodecName });

  const rateControl = tap.effectiveRateControl === 2 ? t('CBR')
    : tap.effectiveRateControl === 1 ? t('VBR')
    : tap.effectiveRateControl === 0 ? t('Constant QP')
    : t('Unknown');

  const split = tap.effectiveSplit === -1 ? t('Not applicable')
    : Number.isFinite(tap.effectiveSplit) ? String(tap.effectiveSplit)
    : t('Unknown');

  const appliedPreset = formatPreset(tap.effectivePreset);
  const preset = saved.nvencPreset === undefined
    ? appliedPreset
    : saved.nvencPreset === 0
      ? t('{applied} (from saved Automatic)', { applied: appliedPreset })
      : t('{saved} saved, {applied} applied', { saved: formatPreset(saved.nvencPreset), applied: appliedPreset });

  const appliedMultipass = formatMultipass(tap.effectiveMultiPass);
  const multipass = saved.nvencMultiPass === undefined
    ? appliedMultipass
    : saved.nvencMultiPass === -1
      ? t('{applied} (from saved Automatic)', { applied: appliedMultipass })
      : t('{saved} saved, {applied} applied', { saved: formatMultipass(saved.nvencMultiPass), applied: appliedMultipass });

  return [
    { key: t('Codec'), value: codec },
    { key: t('Frame'), value: `${tap.encodeWidth ?? 0} × ${tap.encodeHeight ?? 0}` },
    { key: t('Rate control'), value: rateControl },
    { key: t('Tuning'), value: formatTuningInfo(tap.effectiveTuningInfo) },
    { key: t('Split'), value: split },
    { key: t('Average bitrate'), value: formatBitrateMbit(tap.effectiveAverageBitrateMbit) },
    { key: t('Max bitrate'), value: formatBitrateMbit(tap.effectiveMaxBitrateMbit) },
    { key: t('Resolved preset'), value: preset },
    { key: t('Multipass'), value: multipass },
    { key: t('VBV buffer'), value: formatVbvBits(tap.effectiveVbvBufferSizeBits) },
    { key: t('VBV initial delay'), value: formatVbvBits(tap.effectiveVbvInitialDelayBits) },
  ];
}
