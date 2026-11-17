// Hardware capability gating for encoder / Optical Flow settings
// (2026-11-03; adapter precedence rewritten 2026-11-17).
//
// Rules, in precedence order:
//   1. A fresh encoder-tap observation for the current driver process is
//      authoritative for the running codec. Same-LUID probe hints fill only the
//      fields the session did not report.
//   2. No probe, or zero reported adapters, stays unknown.
//   3. No NVIDIA adapter in the inventory (every reported vendor differs from
//      0x10de): NVENC is known absent, so only the NVENC Tap is refused, with
//      an explicit no-NVIDIA reason. Tile width, bitrate, render resolution,
//      10-bit and image settings keep applying exactly as with a single
//      adapter.
//   4. Exactly one NVIDIA adapter with NVENC not ruled out: that adapter is the
//      candidate, whatever the other adapters are (iGPU, unreported vendor,
//      Basic Display) and whether or not it is the primary GPU. Which GPU
//      Windows/SteamVR treat as primary is the user's choice and never gates
//      the Tap.
//   5. Several NVIDIA candidates: NVENC exists, so the Tap may arm, but the
//      per-adapter codec/preset/split/multipass/10-bit limits stay unverified
//      WITHOUT a reason string, so no notice renders. There is no "which
//      adapter is in use" warning: the user's primary-GPU choice is their own.
//
// Unsupported saved values are displayed untouched and warned; they are never
// silently rewritten to a fallback.
import type { AdapterCapabilities, CodecCaps, DriverInfo, GpuCapabilities } from './types';
import { t } from '../locale/i18n';

export type KnownCodec = 'hevc' | 'h264' | 'av1';

export const CODEC_INDEX: Record<number, KnownCodec> = {
  0: 'hevc',
  1: 'h264',
  2: 'av1',
};

const FRESH_MS = 5000;

export type SupportVerdict = 'supported' | 'unsupported' | 'unverified';

/** Where the effective adapter identity came from. `known` means "capability
 *  candidate identity", NOT "the stream was verified on it": only
 *  'encoder-session' is the adapter the driver actually opened.
 *  - 'no-nvidia': no NVIDIA adapter is present, so `adapter` only carries the
 *    inventory's non-NVENC fields with NVENC and Optical Flow explicitly false.
 *  - 'nvenc-absent': NVIDIA adapters exist but every one reports NVENC absent.
 *  - 'multiple-nvenc-candidates': several NVIDIA adapters may encode; the Tap is
 *    allowed and per-adapter limits stay unverified. */
export type AdapterSource =
  | 'encoder-session'
  | 'unique-nvenc-candidate'
  | 'single-adapter'
  | 'no-nvidia'
  | 'nvenc-absent'
  | 'multiple-nvenc-candidates'
  | 'unknown';

export interface EffectiveAdapter {
  /** The adapter we should use for capability decisions, if any. */
  adapter?: AdapterCapabilities;
  /** Identity provenance. Absent on hand-built values (treated as unknown). */
  source?: AdapterSource;
  /** We know which adapter is in use (or that NVENC is absent everywhere). */
  known: boolean;
  /** More than one plausible adapter and no identity. */
  ambiguous: boolean;
  /** Human-readable explanation when known is false. */
  reason?: string;
}

function isFreshEncoderTap(tap: NonNullable<DriverInfo['encoderTap']>, now: number): boolean {
  return typeof tap.observedAt === 'number'
    && tap.observedAt <= now + 2000
    && now - tap.observedAt <= FRESH_MS;
}

function normalizeLuid(luid: string | undefined): string | undefined {
  if (!luid) return undefined;
  return luid.trim().toLowerCase();
}

function findAdapterByLuid(gpu: GpuCapabilities | undefined, luid: string | undefined): AdapterCapabilities | undefined {
  const target = normalizeLuid(luid);
  if (!target || !gpu?.adapters?.length) return undefined;
  return gpu.adapters.find(a => normalizeLuid(a.adapterLuid) === target);
}

/** Overlay session-reported fields on a probe entry for the SAME adapter.
 *  Session fields win; fields the session did not report keep the probe hint. */
function mergeAdapter(probe: AdapterCapabilities, session: AdapterCapabilities): AdapterCapabilities {
  const defined = <T extends object>(o: T | undefined): Partial<T> =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
  const codecs: NonNullable<AdapterCapabilities['codecs']> = { ...probe.codecs };
  for (const key of ['hevc', 'h264', 'av1'] as const) {
    if (probe.codecs?.[key] || session.codecs?.[key]) {
      codecs[key] = { ...defined(probe.codecs?.[key]), ...defined(session.codecs?.[key]) };
    }
  }
  return { ...defined(probe), ...defined(session), codecs };
}

/** Pick the adapter that governs capability decisions.
 *
 *  `encoderTap` MUST be process-bound evidence (the result of `encoderEvidence`,
 *  which checks the verified driver process, module/config paths and runtime
 *  freshness). The local observedAt check here is only a defensive extra: a tap
 *  that is not trusted is ignored completely, including its LUID, so a stale
 *  session can never select an adapter. */
export function effectiveAdapter(
  gpu: GpuCapabilities | undefined,
  encoderTap: DriverInfo['encoderTap'] | undefined,
  now = Date.now(),
): EffectiveAdapter {
  // 1. Trusted running encoder evidence is authoritative; same-LUID probe
  //    hints fill only the fields the session did not report.
  if (encoderTap?.capabilities && isFreshEncoderTap(encoderTap, now)) {
    const session = encoderTap.capabilities;
    const matched = findAdapterByLuid(gpu, session.adapterLuid);
    return { adapter: matched ? mergeAdapter(matched, session) : session, source: 'encoder-session', known: true, ambiguous: false };
  }
  // 2. Unambiguous single adapter probe. A tap without fresh capabilities is
  //    never used to pick an adapter by LUID. A single adapter with a reported
  //    non-NVIDIA vendor is NVENC-absent inventory: the same adapter fields
  //    decide codec/10-bit/split, only NVENC is explicitly false.
  if (gpu?.adapters) {
    const adapters = gpu.adapters;
    if (adapters.length === 1) {
      const only = adapters[0];
      if (typeof only.vendorId === 'number' && only.vendorId !== NVIDIA_VENDOR_ID) {
        return { adapter: nvencAbsentAdapter(only), source: 'no-nvidia', known: true, ambiguous: false };
      }
      return { adapter: only, source: 'single-adapter', known: true, ambiguous: false };
    }
    if (adapters.length === 0) {
      return { source: 'unknown', known: false, ambiguous: false, reason: t('No GPU adapters reported.') };
    }
    // 3. Exactly one NVIDIA adapter that may encode is the candidate, no matter
    //    what the other adapters are (iGPU, unreported vendor) or in which order
    //    Windows enumerates them. Which GPU is primary is the user's choice.
    const candidates = adapters.filter(isNvencCandidate);
    if (candidates.length === 1) {
      return { adapter: candidates[0], source: 'unique-nvenc-candidate', known: true, ambiguous: false };
    }
    // 4. Several candidates: NVENC exists, so the Tap is allowed, but no single
    //    adapter can be blamed for a per-adapter limit. No warning at all.
    if (candidates.length > 1) {
      return { source: 'multiple-nvenc-candidates', known: false, ambiguous: false };
    }
    // 5. No candidate: NVIDIA adapters exist but all report NVENC absent, or the
    //    inventory holds no NVIDIA adapter at all.
    const nvidia = adapters.filter(a => a.vendorId === NVIDIA_VENDOR_ID);
    if (nvidia.length) {
      return { adapter: nvencAbsentAdapter(nvidia[0]), source: 'nvenc-absent', known: true, ambiguous: false };
    }
    if (adapters.every(a => typeof a.vendorId === 'number')) {
      return { adapter: nvencAbsentAdapter(adapters[0]), source: 'no-nvidia', known: true, ambiguous: false };
    }
    // An unreported vendor cannot prove NVIDIA is absent (the Windows probe
    // always reports one, so this is a defensive branch only).
    return { source: 'unknown', known: false, ambiguous: true };
  }
  return { source: 'unknown', known: false, ambiguous: false, reason: t('GPU capability check unavailable.') };
}

/** An adapter that cannot encode: same identity and codec hints as the probed
 *  adapter, with NVENC and NVIDIA Optical Flow explicitly absent. */
function nvencAbsentAdapter(a: AdapterCapabilities): AdapterCapabilities {
  return { ...a, nvenc: false, opticalFlow: false };
}

/** An NVIDIA adapter whose NVENC is not ruled out. */
function isNvencCandidate(a: AdapterCapabilities): boolean {
  return a.vendorId === NVIDIA_VENDOR_ID && a.nvenc !== false;
}

/** The single NVIDIA adapter that may encode. Other adapters need no proof of
 *  anything: only the candidate's NVENC capability decides, so a second GPU of
 *  any vendor (or one with an unreported vendor) never hides it. */
export function uniqueNvencCandidate(adapters: readonly AdapterCapabilities[]): AdapterCapabilities | undefined {
  const candidates = adapters.filter(isNvencCandidate);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Preferred NVENC GPU (unique candidate or the single adapter) with a LUID.
 *  Always an NVIDIA adapter with NVENC not ruled out, even when it is the only
 *  adapter: a lone AMD/Intel or nvenc=false GPU is never a preferred target. */
export function preferredEncoderAdapter(gpu: GpuCapabilities | undefined): AdapterCapabilities | undefined {
  const eff = effectiveAdapter(gpu, undefined);
  if (eff.source !== 'unique-nvenc-candidate' && eff.source !== 'single-adapter') return undefined;
  const a = eff.adapter;
  if (!a || a.vendorId !== NVIDIA_VENDOR_ID || a.nvenc === false) return undefined;
  return normalizeLuid(a.adapterLuid) ? a : undefined;
}

/** Return the codec capability block for the selected codec index. */
export function codecCapsForCodec(adapter: AdapterCapabilities | undefined, codec: number): CodecCaps | undefined {
  const known = CODEC_INDEX[codec];
  if (!known || !adapter?.codecs) return undefined;
  return adapter.codecs[known];
}

function combine(adapter: EffectiveAdapter, own: SupportVerdict, reason?: string): { verdict: SupportVerdict; reason?: string } {
  if (!adapter.known) return { verdict: 'unverified', reason: adapter.reason };
  if (own === 'unsupported') return { verdict: 'unsupported', reason };
  return { verdict: own };
}

/** Whether the selected codec is supported by the effective adapter. */
export function codecSupport(adapter: EffectiveAdapter, codec: number): { verdict: SupportVerdict; reason?: string } {
  const caps = codecCapsForCodec(adapter.adapter, codec);
  if (!adapter.known) return { verdict: 'unverified', reason: adapter.reason };
  if (caps?.supported === false) {
    const name = CODEC_INDEX[codec]?.toUpperCase() ?? String(codec);
    return { verdict: 'unsupported', reason: t('{codec} is not supported by the current GPU.', { codec: name }) };
  }
  if (caps?.supported === true) return { verdict: 'supported' };
  return { verdict: 'unverified', reason: t('{codec} capability is not reported for this GPU.', { codec: CODEC_INDEX[codec]?.toUpperCase() ?? String(codec) }) };
}

/** Whether 10-bit output is applicable for the selected codec/profile. */
export function tenBitSupport(adapter: EffectiveAdapter, codec: number): { verdict: SupportVerdict; reason?: string } {
  if (codec === 1) {
    return { verdict: 'unsupported', reason: t('H.264 uses High profile 8-bit in this path.') };
  }
  if (!adapter.known) return { verdict: 'unverified', reason: adapter.reason };
  const caps = codecCapsForCodec(adapter.adapter, codec);
  if (caps?.tenBit === false) {
    return { verdict: 'unsupported', reason: t('10-bit output is not supported for this codec on the current GPU.') };
  }
  if (caps?.tenBit === true) return { verdict: 'supported' };
  return { verdict: 'unverified', reason: t('10-bit capability is not reported for this codec.') };
}

/** Reason to show beside the 10-bit switch. Only an explicit negative warns:
 *  "not reported" (the GPU probe never carries tenBit, and the encoder session
 *  report goes stale when no stream is running) is unknown, not unsupported,
 *  and must not tell the user their working 10-bit setting cannot apply. */
export function tenBitNoticeReason(support: { verdict: SupportVerdict; reason?: string }): string | undefined {
  return support.verdict === 'unsupported' ? support.reason : undefined;
}

/** Whether the NVENC Tap can arm on the effective adapter. Two or more NVIDIA
 *  candidates allow it: NVENC exists, and the exact adapter is the user's
 *  choice. A non-NVIDIA inventory names the missing NVIDIA GPU explicitly while
 *  every other setting keeps applying. */
export function nvencTapSupport(adapter: EffectiveAdapter): { verdict: SupportVerdict; reason?: string } {
  if (adapter.source === 'multiple-nvenc-candidates') return { verdict: 'supported' };
  if (!adapter.known) return { verdict: 'unverified', reason: adapter.reason };
  if (adapter.adapter?.nvenc === false) {
    return {
      verdict: 'unsupported',
      reason: adapter.source === 'no-nvidia'
        ? t('No NVIDIA GPU found. The NVENC Tap cannot apply; tile width, bitrate, render resolution, 10-bit and image settings still apply.')
        : t('NVIDIA NVENC is not available; NVENC Tap cannot arm.'),
    };
  }
  return { verdict: adapter.adapter?.nvenc === true ? 'supported' : 'unverified' };
}

/** Whether an encoder preset value is usable. Auto (0) is always usable. */
export function presetSupport(adapter: EffectiveAdapter, codec: number, preset: number): { verdict: SupportVerdict; reason?: string } {
  if (preset === 0) return { verdict: 'supported' };
  const base = codecSupport(adapter, codec);
  if (base.verdict === 'unsupported') return base;
  if (!adapter.known) return { verdict: 'unverified', reason: adapter.reason };
  const caps = codecCapsForCodec(adapter.adapter, codec);
  if (caps?.presets && !caps.presets.includes(preset)) {
    return { verdict: 'unsupported', reason: t('Preset P{preset} is not supported by the current GPU.', { preset }) };
  }
  return { verdict: 'supported' };
}

/** Whether a split-mode value is usable. Forced 2/3/4 need split + enough engines.
 *  Automatic (0), driver-selected (1) and Disabled (15) are always selectable:
 *  on hardware known to lack splitting they stay choosable (so a saved value can
 *  always be recovered) and carry an "inactive" notice instead of a block.
 *  H.264 inert-ness is handled by the row-level appliesWhen; this gate covers
 *  hardware capability only. Each capability field is judged independently: an
 *  absent field means "not reported", never "unsupported". */
export function splitModeSupport(adapter: EffectiveAdapter, codec: number, mode: number): { verdict: SupportVerdict; reason?: string } {
  if (mode === 15) return { verdict: 'supported' };
  if (!adapter.known) {
    return mode === 0 || mode === 1 ? { verdict: 'supported' } : { verdict: 'unverified', reason: adapter.reason };
  }
  const caps = codecCapsForCodec(adapter.adapter, codec);
  const noSplit = caps?.split === false;
  const fewEngines = typeof caps?.engines === 'number' && caps.engines < 2;
  if (mode === 0 || mode === 1) {
    if (noSplit || fewEngines) {
      return { verdict: 'supported', reason: t('Multi-engine encoding is not available on the current GPU, so this choice has no effect.') };
    }
    return { verdict: 'supported' };
  }
  if (mode >= 2 && mode <= 4) {
    if (noSplit) {
      return { verdict: 'unsupported', reason: t('Forced split encoding is not supported by the current GPU.') };
    }
    if (typeof caps?.engines === 'number' && caps.engines < mode) {
      return { verdict: 'unsupported', reason: t('This split count needs {mode} encoder engines; the GPU reports {engines}.', { mode, engines: caps.engines }) };
    }
    if (caps?.split === true && typeof caps.engines === 'number') return { verdict: 'supported' };
    return { verdict: 'unverified', reason: t('Multi-engine encoding capability is not reported for this codec.') };
  }
  return { verdict: 'supported' };
}

/** Whether a multipass value is usable. NvencTap ValidateRequest only checks the
 *  range -1..2 and NVENC multipass exists on every NVENC GPU, so the only
 *  hardware gate is NVENC being absent. No API-version restriction is claimed. */
export function multipassSupport(adapter: EffectiveAdapter, _codec: number, mode: number): { verdict: SupportVerdict; reason?: string } {
  if (mode <= 0) return { verdict: 'supported' };
  if (!adapter.known) return { verdict: 'unverified', reason: adapter.reason };
  if (adapter.adapter?.nvenc === false) {
    return { verdict: 'unsupported', reason: t('NVIDIA NVENC is not available; multipass encoding cannot run.') };
  }
  return { verdict: 'supported' };
}

const NVIDIA_VENDOR_ID = 0x10de;

function adapterOpticalFlow(a: AdapterCapabilities): SupportVerdict {
  if (typeof a.vendorId === 'number' && a.vendorId !== NVIDIA_VENDOR_ID) return 'unsupported';
  if (a.opticalFlow === false) return 'unsupported';
  return a.opticalFlow === true ? 'supported' : 'unverified';
}

/** Whether NVIDIA Optical Flow modes are usable. Optical Flow is independent of
 *  NVENC. The OpenXR adapter is not identified by the encoder adapter in a
 *  hybrid system, so the whole inventory decides: unsupported only when every
 *  adapter lacks it (the backend's rule), supported only when every adapter
 *  has it, otherwise unverified. */
export function ofxrNvidiaSupport(gpu: GpuCapabilities | undefined): { verdict: SupportVerdict; reason?: string } {
  if (!gpu?.adapters?.length) return { verdict: 'unverified', reason: t('GPU capability check unavailable.') };
  const verdicts = gpu.adapters.map(adapterOpticalFlow);
  if (verdicts.every(v => v === 'unsupported')) {
    return { verdict: 'unsupported', reason: t('NVIDIA Optical Flow is not available on the current GPU.') };
  }
  if (verdicts.every(v => v === 'supported')) return { verdict: 'supported' };
  return { verdict: 'unverified' };
}

/** Maximum tile width for the selected codec, capped by the encoder height. */
export function tileWidthMax(
  gpu: GpuCapabilities | undefined,
  encoderTap: DriverInfo['encoderTap'] | undefined,
  codec: number,
  now = Date.now(),
): number {
  const base = codec === 1 ? 1024 : 2048;
  const adapter = effectiveAdapter(gpu, encoderTap, now);
  if (!adapter.known) return base;
  const caps = codecCapsForCodec(adapter.adapter, codec);
  if (typeof caps?.maxHeight !== 'number' || !Number.isFinite(caps.maxHeight)) return base;
  return Math.min(base, Math.max(1, Math.floor(caps.maxHeight / 4)));
}
