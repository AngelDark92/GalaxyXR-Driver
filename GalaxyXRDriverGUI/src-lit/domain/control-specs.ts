// Numeric control contracts (2026-10-30).
//
// One declarative spec per numeric setting. Pages render the control from the
// spec instead of hand-writing min/max/step, so a new row cannot drift from the
// native contract or from its context. The seven constraint kinds are:
//   1. finite set      — a code, rendered as a choice (ChoiceControlSpec)
//   2. sentinel        — 0 / -1 / 15 means automatic, off or "leave upstream"
//   3. capability      — bounded by the selected codec / GPU / panel
//   4. context gate    — applies only while another setting is on
//   5. cross-field     — ordering or mutual exclusion with another key
//   6. precision       — integer, step (an input increment, not validity)
//   7. degenerate      — values the math cannot survive (gamma <= 0, ...)
//
// A slider is guidance, never a gate: Fluent clamps the thumb to the track, so
// every slider row keeps its typed number as the authority (typedEscape).
// Hard bounds below refuse a new edit; a stored value outside them is still
// displayed and flagged, never rewritten (settings-authority policy).
import { streamFrameIntegerError } from '../state/galaxy-settings';
import { t } from '../locale/i18n';

export type ControlUnit = 'Mbit/s' | 'ms' | 'us' | '%' | 'px' | 'deg' | 'cm' | 'mm' | 'frames' | 'MB' | 'fps' | 'bits' | 's' | 'm/s' | 'rad/s';

export interface ControlContext {
  /** streamFrame.nvencCodec: 0 HEVC, 1 H.264, 2 AV1. */
  codec: number;
  forceCbr: boolean;
  enhancements: boolean;
  tap: boolean;
  /** streamFrame.kalmanGripEnable. */
  gripCompensation: boolean;
  /** streamFrame.kalmanDirLeadAdaptive. */
  adaptiveDirectionLead: boolean;
  /** streamFrame.kalmanGazeAssist > 0. */
  gazeAssist: boolean;
  /** streamFrame.velocityFixMode === 'derive'. */
  deriveMode: boolean;
  /** streamFrame.kalmanMagSource === 'fast'. */
  fastMagnitude: boolean;
  /** streamFrame.kalmanDupMode === 'soft'. */
  softDuplicates: boolean;
  /** gui-settings.json ofxr.logging. */
  ofxrLogging: boolean;
}

export const DEFAULT_CONTROL_CONTEXT: ControlContext = {
  codec: 0, forceCbr: false, enhancements: true, tap: true,
  gripCompensation: false, adaptiveDirectionLead: false, gazeAssist: false,
  deriveMode: false, fastMagnitude: false, softDuplicates: false, ofxrLogging: false,
};

/** A row-level "saved but not applied" condition. */
export interface ControlCondition {
  /** True when the current context makes the value take effect. */
  active: (ctx: ControlContext) => boolean;
  /** What the user must change; shown next to the control, never auto-changed. */
  message: string;
}

export interface NumberSentinel {
  value: number;
  label: string;
}

export interface NumberControlSpec {
  kind: 'number';
  key: string;
  /** Hard lower bound for a new edit. */
  min: number | ((ctx: ControlContext) => number);
  /** Hard upper bound for a new edit. Infinity = the native contract has none. */
  max: number | ((ctx: ControlContext) => number);
  step: number;
  unit?: ControlUnit;
  integer?: boolean;
  sentinels?: NumberSentinel[];
  /** Narrower guidance band. Must stay inside [min, max]. */
  slider?: { min: number; max: number; step: number; neutral?: number };
  /** Where the bound comes from. Shown in the help popover evidence row. */
  authority: string;
  /** Row-level gate: false = the value is saved but not applied. */
  appliesWhen?: ControlCondition;
  /** Additional gates; each inactive condition adds its own note. */
  requires?: ControlCondition[];
  /** Codec capability the bound is derived from. */
  capability?: { axis: 'width' | 'height'; multiplier: number };
  /** GUI-only key (gui-settings.json) rather than a driver setting. */
  source?: 'gui';
  /** Short label used in generated validation messages. */
  label: string;
}

export interface ChoiceOption {
  value: string | number;
  label: string;
}

export interface ChoiceControlSpec {
  kind: 'choice';
  key: string;
  options: ChoiceOption[];
  /** Render as segmented buttons instead of a dropdown (2-4 options). */
  segmented?: boolean;
  authority: string;
  /** Row-level gate: false = the value is saved but not applied. */
  appliesWhen?: ControlCondition;
  /** Additional gates; each inactive condition adds its own note. */
  requires?: ControlCondition[];
  /** A stored value outside the list is shown as "Stored: X (unsupported)". */
  storedFallback: true;
  label: string;
}

export type ControlSpec = NumberControlSpec | ChoiceControlSpec;

const nvenc = 'NvencTap.cpp ValidateRequest';
const nvencQp = 'NvencTap.cpp ValidateQpMap';
const loader = 'ConfigLoader.cpp reads the value unvalidated';
const none = 'no native validation; the consumer uses the value as-is';

const choice = (spec: Omit<ChoiceControlSpec, 'kind' | 'storedFallback'>): ChoiceControlSpec =>
  ({ kind: 'choice', storedFallback: true, ...spec });

const number = (spec: Omit<NumberControlSpec, 'kind'>): NumberControlSpec =>
  ({ kind: 'number', ...spec });

// ---- Shared row gates ------------------------------------------------------
// These are rendered next to the control as "saved, not applied" notes. They
// never change a value; they only explain which state makes it take effect.

const forceCbrOnly: ControlCondition = {
  active: ctx => ctx.forceCbr,
  message: 'Turn on Force CBR to apply this.',
};
const h264Only: ControlCondition = {
  active: ctx => ctx.codec === 1,
  message: 'H.264 only; the saved value is kept.',
};
const splitNotH264: ControlCondition = {
  active: ctx => ctx.codec !== 1,
  message: 'H.264 does not apply split encoding; the saved choice is kept.',
};
const vuiWrittenForHevcH264: ControlCondition = {
  active: ctx => ctx.codec !== 2,
  message: 'AV1 does not write VUI tags; the saved value is kept.',
};
const gripEnabled: ControlCondition = {
  active: ctx => ctx.gripCompensation,
  message: 'Turn on Grip-Point Velocity Compensator to apply this.',
};
const adaptiveLeadEnabled: ControlCondition = {
  active: ctx => ctx.adaptiveDirectionLead,
  message: 'Turn on Adaptive Direction Lead to apply this.',
};
const gazeAssistEnabled: ControlCondition = {
  active: ctx => ctx.gazeAssist,
  message: 'Raise Gaze Aim Assist above 0 to apply this.',
};
const deriveModeOnly: ControlCondition = {
  active: ctx => ctx.deriveMode,
  message: 'Only the retired Derive mode applies this.',
};
const fastMagnitudeOnly: ControlCondition = {
  active: ctx => ctx.fastMagnitude,
  message: 'Select the fast estimator to apply this.',
};
const softDuplicatesOnly: ControlCondition = {
  active: ctx => ctx.softDuplicates,
  message: 'Select Soft duplicate handling to apply this.',
};
const ofxrLoggingOn: ControlCondition = {
  active: ctx => ctx.ofxrLogging,
  message: 'Turn on the Bridge flight recorder to apply this.',
};

// ---- Stream quality ---------------------------------------------------------

/** Tile width is the packed four-tile frame width. The session probe requires
 *  tile * 4 <= the selected codec's real NVENC height max and refuses instead
 *  of lowering the request (NvencTap.cpp:2087-2113). H.264 tops out at 1024
 *  (4096 / 4); HEVC and AV1 at 2048 (8192 / 4, also Config.h:355). */
export const tileWidthSpec = number({
  key: 'galaxyXr.customStreamFormatWidth',
  min: 1,
  max: ctx => (ctx.codec === 1 ? 1024 : 2048),
  step: 1,
  unit: 'px',
  integer: true,
  authority: 'NvencTap.cpp:2087-2113 session allocation check; Config.h:355',
  capability: { axis: 'height', multiplier: 4 },
  label: 'Tile width',
});

export const streamQualitySpecs: ControlSpec[] = [
  tileWidthSpec,
  number({
    key: 'galaxyXr.customBandwidthMbit',
    min: 1, max: Infinity, step: 1, unit: 'Mbit/s', integer: true,
    slider: { min: 1, max: 1500, step: 1 },
    authority: 'GalaxyXR.cpp writes it to the streamer budget; no native range check',
    label: 'Max bitrate',
  }),
  choice({
    key: 'streamFrame.nvencCodec',
    label: 'Video codec',
    options: [
      { value: 0, label: 'HEVC (default)' },
      { value: 1, label: 'H.264' },
      { value: 2, label: 'AV1' },
    ],
    authority: nvenc,
  }),
  number({
    key: 'streamFrame.nvencBandwidthOverrideMbit',
    min: 0, max: Infinity, step: 25, unit: 'Mbit/s', integer: true,
    slider: { min: 0, max: 1500, step: 25 },
    sentinels: [{ value: 0, label: 'Follow Max Bitrate' }],
    authority: nvenc,
    label: 'Bandwidth override',
  }),
  number({
    key: 'streamFrame.nvencVbvFrames',
    min: 0, max: Infinity, step: 1, unit: 'frames', integer: true,
    slider: { min: 0, max: 30, step: 1 },
    sentinels: [{ value: 0, label: "Preserve the caller's VBV" }],
    authority: nvenc,
    label: 'VBV encoder buffer budget',
  }),
  choice({
    key: 'streamFrame.nvencPreset',
    label: 'Encoder quality preset',
    options: [
      { value: 0, label: 'Automatic (by engine count)' },
      { value: 1, label: 'P1 — fastest' },
      { value: 2, label: 'P2' },
      { value: 3, label: 'P3' },
      { value: 4, label: 'P4' },
      { value: 5, label: 'P5' },
      { value: 6, label: 'P6' },
      { value: 7, label: 'P7 — best quality' },
    ],
    authority: nvenc,
  }),
  number({
    key: 'streamFrame.nvencBitrateConstancyPct',
    min: 0, max: 100, step: 5, unit: '%', integer: true,
    slider: { min: 0, max: 100, step: 5, neutral: 0 },
    sentinels: [{ value: 0, label: 'Leave the base curve unchanged' }],
    authority: nvenc,
    label: 'Bitrate constancy',
  }),
  choice({
    key: 'streamFrame.nvencMultiPass',
    label: 'Encoder multipass',
    options: [
      { value: -1, label: 'Automatic (codec / preset)' },
      { value: 0, label: 'Single pass' },
      { value: 1, label: 'Two passes, quarter resolution' },
      { value: 2, label: 'Two passes, full resolution' },
    ],
    authority: nvenc,
  }),
  number({
    key: 'streamFrame.nvencLowDelayKfScale',
    min: 0, max: 255, step: 1, unit: 'frames', integer: true,
    authority: nvenc,
    appliesWhen: forceCbrOnly,
    label: 'Keyframe size budget',
  }),
  choice({
    key: 'streamFrame.nvencSplitMode',
    label: 'Multi-engine encoding',
    options: [
      { value: 0, label: 'Automatic' },
      { value: 1, label: 'Driver-selected strips' },
      { value: 2, label: '2 strips' },
      { value: 3, label: '3 strips' },
      { value: 4, label: '4 strips' },
      { value: 15, label: 'Disabled' },
    ],
    authority: nvenc,
    appliesWhen: splitNotH264,
  }),
  number({
    key: 'streamFrame.nvencQpFovea',
    min: -128, max: 127, step: 1, integer: true,
    slider: { min: -10, max: 0, step: 1, neutral: 0 },
    sentinels: [{ value: 0, label: 'No center offset' }],
    authority: nvencQp,
    label: 'Center quality boost',
  }),
  number({
    key: 'streamFrame.nvencQpPeriphery',
    min: -128, max: 127, step: 1, integer: true,
    slider: { min: 0, max: 10, step: 1, neutral: 0 },
    sentinels: [{ value: 0, label: 'No periphery offset' }],
    authority: nvencQp,
    label: 'Periphery quality offset',
  }),
];

// ---- H.264 recipe (context: codec === 1) ------------------------------------

export const h264Specs: ControlSpec[] = [
  number({
    key: 'streamFrame.nvencH264GopFrames',
    min: -1, max: Infinity, step: 1, unit: 'frames', integer: true,
    sentinels: [
      { value: 0, label: 'Automatic (nominal frame rate)' },
      { value: -1, label: 'Leave upstream GOP unchanged' },
    ],
    authority: nvenc,
    appliesWhen: h264Only,
    label: 'H.264 GOP frames',
  }),
  number({
    key: 'streamFrame.nvencH264IdrFrames',
    min: -1, max: Infinity, step: 1, unit: 'frames', integer: true,
    sentinels: [
      { value: 0, label: 'Automatic (nominal frame rate)' },
      { value: -1, label: 'Leave upstream IDR unchanged' },
    ],
    authority: nvenc,
    appliesWhen: h264Only,
    label: 'H.264 IDR frames',
  }),
  number({
    key: 'streamFrame.nvencH264RefFrames',
    min: 0, max: 16, step: 1, unit: 'frames', integer: true,
    authority: nvenc,
    appliesWhen: h264Only,
    label: 'H.264 reference frames',
  }),
  choice({
    key: 'streamFrame.nvencH264Entropy',
    label: 'H.264 entropy mode',
    segmented: true,
    options: [
      { value: 0, label: 'Auto' },
      { value: 1, label: 'CABAC' },
      { value: 2, label: 'CAVLC' },
    ],
    authority: nvenc,
    appliesWhen: h264Only,
  }),
  choice({
    key: 'streamFrame.nvencH264SliceMode',
    label: 'H.264 slice mode',
    options: [
      { value: 0, label: 'Macroblocks' },
      { value: 1, label: 'Bytes' },
      { value: 2, label: 'Rows' },
      { value: 3, label: 'Slice count' },
    ],
    authority: nvenc,
    appliesWhen: h264Only,
  }),
  number({
    key: 'streamFrame.nvencH264SliceData',
    min: 0, max: Infinity, step: 1, integer: true,
    authority: nvenc,
    appliesWhen: h264Only,
    label: 'H.264 slice value',
  }),
  number({
    key: 'streamFrame.nvencH264VbvInitialDelay',
    min: 0, max: Infinity, step: 1, unit: 'bits', integer: true,
    sentinels: [{ value: 0, label: 'Tested low-latency default' }],
    authority: nvenc,
    appliesWhen: h264Only,
    label: 'H.264 initial VBV delay',
  }),
];

// ---- VUI tags (diagnostic; written for HEVC/H.264 only) --------------------

export const vuiSpecs: ControlSpec[] = [
  choice({
    key: 'streamFrame.nvencVuiFullRange',
    label: 'VUI full range',
    segmented: true,
    options: [
      { value: -1, label: 'Auto' },
      { value: 0, label: 'Limited' },
      { value: 1, label: 'Full' },
    ],
    authority: nvenc,
    appliesWhen: vuiWrittenForHevcH264,
  }),
  choice({
    key: 'streamFrame.nvencVuiMatrix',
    label: 'VUI matrix',
    options: [
      { value: -1, label: 'Automatic' },
      { value: 0, label: '0 — Identity' },
      { value: 1, label: '1 — BT.709' },
      { value: 4, label: '4 — FCC' },
      { value: 5, label: '5 — BT.470BG' },
      { value: 6, label: '6 — SMPTE 170M' },
      { value: 7, label: '7 — SMPTE 240M' },
      { value: 8, label: '8 — YCgCo' },
      { value: 9, label: '9 — BT.2020 non-constant' },
      { value: 10, label: '10 — BT.2020 constant' },
      { value: 11, label: '11 — SMPTE 2085' },
      { value: 12, label: '12 — Chroma-derived NCL' },
      { value: 13, label: '13 — Chroma-derived CL' },
      { value: 14, label: '14 — ICtCp' },
    ],
    authority: nvenc,
    appliesWhen: vuiWrittenForHevcH264,
  }),
  choice({
    key: 'streamFrame.nvencVuiPrimaries',
    label: 'VUI primaries',
    options: [
      { value: -1, label: 'Automatic' },
      { value: 1, label: '1 — BT.709' },
      { value: 4, label: '4 — BT.470M' },
      { value: 5, label: '5 — BT.470BG' },
      { value: 6, label: '6 — SMPTE 170M' },
      { value: 7, label: '7 — SMPTE 240M' },
      { value: 8, label: '8 — Film' },
      { value: 9, label: '9 — BT.2020' },
      { value: 10, label: '10 — SMPTE 428' },
      { value: 11, label: '11 — DCI-P3' },
      { value: 12, label: '12 — Display P3' },
      { value: 22, label: '22 — EBU 3213-E' },
    ],
    authority: nvenc,
    appliesWhen: vuiWrittenForHevcH264,
  }),
  choice({
    key: 'streamFrame.nvencVuiTransfer',
    label: 'VUI transfer',
    options: [
      { value: -1, label: 'Automatic' },
      { value: 1, label: '1 — BT.709' },
      { value: 4, label: '4 — Gamma 2.2' },
      { value: 5, label: '5 — Gamma 2.8' },
      { value: 6, label: '6 — SMPTE 170M' },
      { value: 7, label: '7 — SMPTE 240M' },
      { value: 8, label: '8 — Linear' },
      { value: 9, label: '9 — Log 100' },
      { value: 10, label: '10 — Log 316' },
      { value: 11, label: '11 — IEC 61966-2-4' },
      { value: 12, label: '12 — BT.1361' },
      { value: 13, label: '13 — sRGB' },
      { value: 14, label: '14 — BT.2020 10-bit' },
      { value: 15, label: '15 — BT.2020 12-bit' },
      { value: 16, label: '16 — PQ' },
      { value: 17, label: '17 — SMPTE 428' },
      { value: 18, label: '18 — HLG' },
    ],
    authority: nvenc,
    appliesWhen: vuiWrittenForHevcH264,
  }),
];

// ---- Picture ---------------------------------------------------------------

export const pictureSpecs: ControlSpec[] = [
  number({
    key: 'streamFrame.brightness',
    min: 0.01, max: 4, step: 0.05,
    slider: { min: 0.05, max: 1.5, step: 0.05, neutral: 1 },
    authority: none,
    label: 'Brightness',
  }),
  number({
    key: 'streamFrame.saturation',
    min: 0, max: 100, step: 1,
    slider: { min: 0, max: 100, step: 1, neutral: 50 },
    authority: none,
    label: 'Saturation',
  }),
  number({
    key: 'streamFrame.vibrance',
    min: -100, max: 100, step: 1,
    slider: { min: -100, max: 100, step: 1, neutral: 0 },
    authority: none,
    label: 'Vibrance',
  }),
  number({
    key: 'streamFrame.contrast',
    min: 0, max: 100, step: 1,
    slider: { min: 0, max: 100, step: 1, neutral: 50 },
    authority: none,
    label: 'Contrast',
  }),
  number({
    key: 'streamFrame.contrastMidpoint',
    min: 0, max: 100, step: 1,
    slider: { min: 0, max: 100, step: 1, neutral: 50 },
    authority: none,
    label: 'Contrast midpoint',
  }),
  number({
    key: 'streamFrame.gamma',
    min: 0.5, max: 10, step: 0.01,
    slider: { min: 1.2, max: 3.2, step: 0.01, neutral: 2.2 },
    authority: none,
    label: 'Gamma',
  }),
];

export const colorMultiplierSpecs: ControlSpec[] = ['r', 'g', 'b'].map(channel => number({
  key: `streamFrame.colorMultiplier.${channel}`,
  min: 0, max: 2, step: 0.01,
  authority: none,
  label: `Color multiplier ${channel.toUpperCase()}`,
}));

// ---- Sharpening / dimming --------------------------------------------------

export const sharpeningSpecs: ControlSpec[] = [
  number({
    key: 'streamFrame.postPack.foveaStrength',
    min: 0, max: 1, step: 0.05,
    slider: { min: 0, max: 1, step: 0.05 },
    authority: none,
    label: 'Center sharpness',
  }),
  number({
    key: 'streamFrame.postPack.peripheryStrength',
    min: 0, max: 1, step: 0.05,
    slider: { min: 0, max: 1, step: 0.05 },
    authority: none,
    label: 'Edge sharpness',
  }),
  number({
    key: 'streamFrame.postPack.edgeFalloff',
    min: 0, max: 1, step: 0.02,
    slider: { min: 0, max: 0.5, step: 0.02 },
    authority: nvencQp,
    label: 'Center-edge blend',
  }),
  number({
    key: 'streamFrame.cas.strength',
    min: 0, max: 1, step: 0.05,
    slider: { min: 0, max: 1, step: 0.05 },
    authority: none,
    label: 'CAS strength',
  }),
  number({
    key: 'streamFrame.cas.strengthLeft',
    min: 0, max: 1, step: 0.05,
    slider: { min: 0, max: 1, step: 0.05 },
    authority: none,
    label: 'CAS strength, left eye',
  }),
  number({
    key: 'streamFrame.cas.strengthRight',
    min: 0, max: 1, step: 0.05,
    slider: { min: 0, max: 1, step: 0.05 },
    authority: none,
    label: 'CAS strength, right eye',
  }),
];

// ---- Distortion / alignment -------------------------------------------------

export const distortionSpecs: ControlSpec[] = [
  number({
    key: 'streamFrame.distortion.gain',
    min: -1.5, max: 1.5, step: 0.1,
    slider: { min: -1.5, max: 1.5, step: 0.1, neutral: 0 },
    authority: none,
    label: 'Correction gain',
  }),
  number({
    key: 'streamFrame.k1',
    min: -1, max: 1, step: 0.001,
    slider: { min: -0.1, max: 0.1, step: 0.001, neutral: 0 },
    authority: none,
    label: 'k1',
  }),
  number({
    key: 'streamFrame.k2',
    min: -1, max: 1, step: 0.001,
    slider: { min: -0.1, max: 0.1, step: 0.001, neutral: 0 },
    authority: none,
    label: 'k2',
  }),
  ...['leftH', 'leftV', 'rightH', 'rightV'].map(axis => number({
    key: `streamFrame.alignment.${axis}`,
    min: -0.01, max: 0.01, step: 0.0005,
    slider: { min: -0.01, max: 0.01, step: 0.0005, neutral: 0 },
    authority: none,
    label: `Eye alignment ${axis}`,
  })),
];

// ---- Advanced picture timings ----------------------------------------------

export const advancedSpecs: ControlSpec[] = [
  number({
    key: 'streamFrame.syncTimeoutMs',
    min: 1, max: 100, step: 1, unit: 'ms', integer: true,
    slider: { min: 1, max: 100, step: 1 },
    authority: none,
    label: 'Frame sync timeout',
  }),
  number({
    key: 'streamFrame.eyeGaze.predictionMs',
    min: 0, max: 100, step: 5, unit: 'ms',
    slider: { min: 0, max: 100, step: 5, neutral: 0 },
    sentinels: [{ value: 0, label: 'Off' }],
    authority: none,
    label: 'Gaze prediction',
  }),
  number({
    key: 'streamFrame.stationaryDimming.movementTime',
    min: 2, max: 3600, step: 1, unit: 's',
    slider: { min: 2, max: 120, step: 1 },
    authority: none,
    label: 'Dimming delay',
  }),
  number({
    key: 'streamFrame.stationaryDimming.dimSeconds',
    min: 1, max: 600, step: 1, unit: 's',
    slider: { min: 1, max: 60, step: 1 },
    authority: none,
    label: 'Dimming fade',
  }),
  number({
    key: 'streamFrame.blackFloor.blackPointCode',
    min: 0, max: 255, step: 0.5,
    slider: { min: 0, max: 24, step: 0.5 },
    authority: none,
    label: 'Black point',
  }),
  number({
    key: 'ofxr.maxLogMb',
    min: 1, max: 512, step: 1, unit: 'MB', integer: true,
    source: 'gui',
    requires: [ofxrLoggingOn],
    authority: 'normalizeOfxrPreferences clamps at the IPC boundary (domain/ofxr.ts:46-59)',
    label: 'Flight log size limit',
  }),
];

// ---- Distortion tuner / centre ---------------------------------------------

export const distortionTuneSpecs: ControlSpec[] = [
  number({
    key: 'streamFrame.distortion.tune.rate',
    min: 0.01, max: 0.5, step: 0.01,
    slider: { min: 0.01, max: 0.5, step: 0.01 },
    authority: none,
    label: 'Tuner adjust rate',
  }),
  number({
    key: 'streamFrame.distortion.tune.stepSize',
    min: 0, max: 0.05, step: 0.001,
    slider: { min: 0, max: 0.05, step: 0.001, neutral: 0 },
    sentinels: [{ value: 0, label: 'Analog (continuous)' }],
    authority: none,
    label: 'Tuner step size',
  }),
  number({
    key: 'streamFrame.distortion.tune.ringOpacity',
    min: 0, max: 1, step: 0.05,
    slider: { min: 0, max: 1, step: 0.05 },
    authority: none,
    label: 'Band ring opacity',
  }),
  number({
    key: 'streamFrame.eyeGaze.gridAngularDeg',
    min: 0.5, max: 30, step: 0.5, unit: 'deg',
    slider: { min: 0.5, max: 30, step: 0.5 },
    authority: none,
    label: 'Grid angular spacing',
  }),
  number({
    key: 'streamFrame.distortion.annulus.rMin',
    min: 0, max: 1, step: 0.05,
    slider: { min: 0, max: 1, step: 0.05 },
    authority: none,
    label: 'Tuning band inner radius',
  }),
  number({
    key: 'streamFrame.distortion.annulus.rMax',
    min: 0, max: 1, step: 0.05,
    slider: { min: 0, max: 1, step: 0.05 },
    authority: none,
    label: 'Tuning band outer radius',
  }),
  number({
    key: 'streamFrame.distortion.annulus.feather',
    min: 0, max: 0.5, step: 0.01,
    slider: { min: 0, max: 0.5, step: 0.01 },
    authority: none,
    label: 'Tuning band feather',
  }),
  number({
    key: 'streamFrame.centerOffsetXLeft',
    min: -0.5, max: 0.5, step: 0.001,
    authority: none,
    label: 'Optical centre X, left',
  }),
  number({
    key: 'streamFrame.centerOffsetXRight',
    min: -0.5, max: 0.5, step: 0.001,
    authority: none,
    label: 'Optical centre X, right',
  }),
  number({
    key: 'streamFrame.centerOffsetY',
    min: -0.5, max: 0.5, step: 0.001,
    authority: none,
    label: 'Optical centre Y',
  }),
];

// ---- Controller tuning -----------------------------------------------------

const triplet = (prefix: string, label: string, unit: ControlUnit, min: number, max: number, step: number,
  condition?: ControlCondition): ControlSpec[] =>
  ['x', 'y', 'z'].map(axis => number({
    key: `${prefix}.${axis}`, min, max, step, unit, authority: none, label,
    ...(condition ? { appliesWhen: condition } : {}),
  }));

export const controllerSpecs: ControlSpec[] = [
  number({
    key: 'galaxyXr.gripTouchThreshold',
    min: 0.005, max: 0.5, step: 0.005,
    slider: { min: 0.005, max: 0.5, step: 0.005 },
    authority: none,
    label: 'Grip touch threshold',
  }),
  number({
    key: 'galaxyXr.renderModelScale',
    min: 0.5, max: 2, step: 0.01,
    slider: { min: 0.5, max: 2, step: 0.01, neutral: 1 },
    authority: none,
    label: 'Controller model scale',
  }),
  ...triplet('controllers.rotationOffsetDeg', 'Controller rotation offset', 'deg', -180, 180, 1),
  ...triplet('controllers.positionOffsetCm', 'Controller position offset', 'cm', -50, 50, 0.5),
  ...triplet('controllers.left.rotationOffsetDeg', 'Hand rotation offset', 'deg', -180, 180, 1),
  ...triplet('controllers.left.positionOffsetCm', 'Hand position offset', 'cm', -50, 50, 0.5),
  ...triplet('controllers.right.rotationOffsetDeg', 'Hand rotation offset', 'deg', -180, 180, 1),
  ...triplet('controllers.right.positionOffsetCm', 'Hand position offset', 'cm', -50, 50, 0.5),
  ...triplet('controllers.gameLinkLayout.rotationOffsetDeg', 'Game Link rotation offset', 'deg', -180, 180, 1),
  ...triplet('controllers.gameLinkLayout.positionOffsetCm', 'Game Link position offset', 'cm', -50, 50, 0.5),
  number({ key: 'galaxyXr.aimTrimXCm', min: -5, max: 5, step: 0.25, unit: 'cm', authority: none, label: 'Aim trim X' }),
  number({ key: 'galaxyXr.aimTrimYCm', min: -5, max: 5, step: 0.25, unit: 'cm', authority: none, label: 'Aim trim Y' }),
  number({ key: 'galaxyXr.aimTrimZCm', min: -5, max: 5, step: 0.25, unit: 'cm', authority: none, label: 'Aim trim Z' }),
];

// ---- Kalman tuning ---------------------------------------------------------

export const kalmanSpecs: ControlSpec[] = [
  number({ key: 'streamFrame.kalmanProcessAccel', min: 1, max: 2000, step: 10, authority: none, label: 'Kalman acceleration noise' }),
  number({ key: 'streamFrame.kalmanPosNoiseMm', min: 0.2, max: 20, step: 0.5, unit: 'mm', authority: none, label: 'Kalman position noise' }),
  number({ key: 'streamFrame.kalmanProcessAngAccel', min: 10, max: 20000, step: 50, authority: none, label: 'Kalman angular noise' }),
  number({ key: 'streamFrame.kalmanOriNoiseDeg', min: 0.05, max: 10, step: 0.1, unit: 'deg', authority: none, label: 'Kalman orientation noise' }),
  number({ key: 'streamFrame.kalmanLeadMs', min: 0, max: 50, step: 5, unit: 'ms', slider: { min: 0, max: 50, step: 5 }, authority: none, label: 'Kalman lead' }),
  number({ key: 'streamFrame.kalmanCaJerk', min: 1, max: 50000, step: 50, authority: none, label: 'Kalman CA jerk noise' }),
  number({ key: 'streamFrame.kalmanCaAngJerk', min: 50, max: 500000, step: 250, authority: none, label: 'Kalman CA angular jerk' }),
  number({ key: 'streamFrame.kalmanCaPosNoiseMm', min: 0.2, max: 20, step: 0.5, unit: 'mm', authority: none, label: 'Kalman CA position noise' }),
  number({ key: 'streamFrame.kalmanCaOriNoiseDeg', min: 0.05, max: 10, step: 0.1, unit: 'deg', authority: none, label: 'Kalman CA orientation noise' }),
  number({ key: 'streamFrame.kalmanCaMagJerk', min: 1, max: 50000, step: 50, authority: none, label: 'Kalman CA speed jerk' }),
  number({ key: 'streamFrame.kalmanCaMagAccelTauMs', min: 20, max: 10000, step: 25, unit: 'ms', authority: none, label: 'Kalman CA speed decay' }),
  number({ key: 'streamFrame.kalmanMagAccel', min: 1, max: 2000, step: 10, authority: none, appliesWhen: fastMagnitudeOnly, label: 'Kalman speed noise' }),
  number({ key: 'streamFrame.kalmanMagScale', min: 0.25, max: 4, step: 0.05, slider: { min: 0.25, max: 4, step: 0.05, neutral: 1 }, authority: none, label: 'Throw strength scale' }),
  number({ key: 'streamFrame.kalmanAngMagScale', min: 0.25, max: 4, step: 0.05, slider: { min: 0.25, max: 4, step: 0.05, neutral: 1 }, authority: none, label: 'Throw spin scale' }),
  number({ key: 'streamFrame.kalmanCaAccelTauMs', min: 20, max: 10000, step: 25, unit: 'ms', authority: none, label: 'Acceleration decay time' }),
  number({ key: 'streamFrame.kalmanLossCoastMs', min: 0, max: 1000, step: 50, unit: 'ms', slider: { min: 0, max: 1000, step: 50, neutral: 0 }, authority: none, label: 'Tracking-loss coasting' }),
  number({ key: 'streamFrame.kalmanDupRScale', min: 1, max: 100, step: 1, slider: { min: 1, max: 100, step: 1 }, authority: none, appliesWhen: softDuplicatesOnly, label: 'Repeat distrust strength' }),
];

// ---- Retired experiments (graveyard) ---------------------------------------

export const graveyardSpecs: ControlSpec[] = [
  number({ key: 'streamFrame.kalmanFreezeCoastTurn', min: 0, max: 1, step: 0.25, authority: none, label: 'Freeze coast turn' }),
  number({ key: 'streamFrame.kalmanDirLeadMs', min: 0, max: 0, step: 1, unit: 'ms', authority: none, label: 'Direction lead (retired)' }),
  number({ key: 'streamFrame.kalmanPosFreezeVelDecayMs', min: 0, max: 2000, step: 20, unit: 'ms', authority: none, label: 'Position-freeze velocity decay' }),
  number({ key: 'galaxyXr.skeletonOffsetXCm', min: -10, max: 10, step: 0.25, unit: 'cm', authority: none, label: 'Skeleton hand offset X' }),
  number({ key: 'galaxyXr.skeletonOffsetYCm', min: -10, max: 10, step: 0.25, unit: 'cm', authority: none, label: 'Skeleton hand offset Y' }),
  number({ key: 'galaxyXr.skeletonOffsetZCm', min: -10, max: 10, step: 0.25, unit: 'cm', authority: none, label: 'Skeleton hand offset Z' }),
  ...['x', 'y', 'z'].map(axis => number({
    key: `galaxyXr.meshOffset${axis.toUpperCase()}Cm`, min: -10, max: 10, step: 0.25, unit: 'cm', authority: none, label: 'Controller mesh offset',
  })),
  ...['x', 'y', 'z'].map(axis => number({
    key: `galaxyXr.handAnchor${axis.toUpperCase()}Cm`, min: -20, max: 20, step: 0.25, unit: 'cm', authority: none, label: 'Hand anchor translation',
  })),
  number({ key: 'galaxyXr.handAnchorPitchDeg', min: -90, max: 90, step: 1, unit: 'deg', authority: none, label: 'Hand anchor pitch' }),
  number({ key: 'galaxyXr.handAnchorYawDeg', min: -90, max: 90, step: 1, unit: 'deg', authority: none, label: 'Hand anchor yaw' }),
  number({ key: 'galaxyXr.handAnchorRollDeg', min: -90, max: 90, step: 1, unit: 'deg', authority: none, label: 'Hand anchor roll' }),
  number({ key: 'streamFrame.kalmanDirLeadBaseMs', min: 0, max: 30, step: 1, unit: 'ms', authority: none, appliesWhen: adaptiveLeadEnabled, label: 'Adaptive direction lead base' }),
  number({ key: 'streamFrame.kalmanDirLeadWMs', min: 0, max: 1, step: 0.05, authority: none, appliesWhen: adaptiveLeadEnabled, label: 'Adaptive direction lead slope' }),
  number({ key: 'streamFrame.kalmanAdaptiveRMaxDiv', min: 1, max: 100, step: 2, authority: none, label: 'Adaptive measurement trust limit' }),
  number({ key: 'streamFrame.kalmanGripBlend', min: 0, max: 2, step: 0.1, authority: none, appliesWhen: gripEnabled, label: 'Grip-point blend' }),
  ...triplet('streamFrame.kalmanGripLeftCm', 'Grip point, left', 'cm', -20, 20, 0.5, gripEnabled),
  ...triplet('streamFrame.kalmanGripRightCm', 'Grip point, right', 'cm', -20, 20, 0.5, gripEnabled),
  number({ key: 'streamFrame.blackFloor.floorCode', min: 0, max: 16, step: 0.5, authority: none, label: 'Shadow-lift floor' }),
  number({ key: 'streamFrame.blackFloor.kneeCode', min: 2, max: 48, step: 1, authority: none, label: 'Shadow-lift knee' }),
  number({ key: 'streamFrame.nvencAqStrength', min: 0, max: 15, step: 1, authority: nvenc, label: 'NVENC AQ strength' }),
  number({ key: 'streamFrame.nvencMaxQp', min: 0, max: 63, step: 1, authority: nvenc, label: 'NVENC max QP' }),
  number({ key: 'streamFrame.nvencMinQp', min: 0, max: 63, step: 1, authority: nvenc, label: 'NVENC min QP' }),
  number({ key: 'streamFrame.nvencMinQpIntra', min: 0, max: 63, step: 1, authority: nvenc, label: 'NVENC min QP, intra' }),
  number({ key: 'galaxyXr.customEncodeWidth', min: 512, max: 8192, step: 256, unit: 'px', integer: true, authority: 'ConfigLoader.cpp:430 (no range check)', label: 'Encode width (retired)' }),
  number({ key: 'galaxyXr.vrlinkMaxVideoQueueLatencyUs', min: 0, max: 200000, step: 1000, unit: 'us', integer: true, sentinels: [{ value: 0, label: 'Streamer default' }], authority: none, label: 'Max video queue latency' }),
  number({ key: 'galaxyXr.vrlinkBackoffRecoveryCoefficient', min: 0, max: 100, step: 0.1, sentinels: [{ value: 0, label: 'Streamer default' }], authority: none, label: 'Backoff recovery coefficient' }),
  number({ key: 'streamFrame.eyeGaze.tanHalfFovX', min: 0.3, max: 3, step: 0.02, authority: none, label: 'Gaze FOV tangent X' }),
  number({ key: 'streamFrame.eyeGaze.tanHalfFovY', min: 0.3, max: 3, step: 0.02, authority: none, label: 'Gaze FOV tangent Y' }),
  number({ key: 'streamFrame.kalmanSmoothLagMs', min: 0, max: 100, step: 5, unit: 'ms', authority: none, label: 'Smoothed reporting lag' }),
  number({ key: 'streamFrame.kalmanGazeAssist', min: 0, max: 20, step: 0.1, authority: none, label: 'Gaze aim assist strength' }),
  number({ key: 'streamFrame.kalmanGazeMaxDeg', min: 5, max: 180, step: 5, unit: 'deg', authority: none, appliesWhen: gazeAssistEnabled, label: 'Gaze aim assist max bend' }),
  number({ key: 'streamFrame.kalmanGazeMinSpeed', min: 0.3, max: 4, step: 0.1, unit: 'm/s', authority: none, appliesWhen: gazeAssistEnabled, label: 'Gaze aim assist min speed' }),
  number({ key: 'streamFrame.kalmanDupCoastMaxMs', min: 10, max: 500, step: 10, unit: 'ms', authority: none, label: 'Duplicate-coast cap' }),
  number({ key: 'streamFrame.kalmanDirSmoothMs', min: 0, max: 300, step: 10, unit: 'ms', authority: none, label: 'Direction smoothing' }),
  number({ key: 'streamFrame.kalmanAngDirSmoothMs', min: 0, max: 300, step: 10, unit: 'ms', authority: none, label: 'Angular direction smoothing' }),
  number({ key: 'streamFrame.kalmanReleaseRewindMs', min: 0, max: 150, step: 5, unit: 'ms', authority: none, label: 'Release rewind' }),
  number({ key: 'streamFrame.kalmanRewindHoldMs', min: 20, max: 300, step: 10, unit: 'ms', authority: none, label: 'Rewind hold' }),
  number({ key: 'streamFrame.deriveSmoothTauSlowMs', min: 1, max: 300, step: 5, unit: 'ms', authority: none, label: 'Derive smoothing tau slow' }),
  number({ key: 'streamFrame.deriveSmoothTauFastMs', min: 1, max: 60, step: 1, unit: 'ms', authority: none, label: 'Derive smoothing tau fast' }),
  number({ key: 'streamFrame.deriveSmoothSpeedLow', min: 0, max: 3, step: 0.05, unit: 'm/s', authority: none, label: 'Derive speed low' }),
  number({ key: 'streamFrame.deriveSmoothSpeedHigh', min: 0.1, max: 5, step: 0.05, unit: 'm/s', authority: none, label: 'Derive speed high' }),
  number({ key: 'streamFrame.deriveSmoothAngTauSlowMs', min: 1, max: 300, step: 5, unit: 'ms', authority: none, label: 'Derive angular tau slow' }),
  number({ key: 'streamFrame.deriveSmoothAngTauFastMs', min: 1, max: 60, step: 1, unit: 'ms', authority: none, label: 'Derive angular tau fast' }),
  number({ key: 'streamFrame.deriveSmoothAngSpeedLow', min: 0, max: 30, step: 0.1, unit: 'rad/s', authority: none, label: 'Derive angular speed low' }),
  number({ key: 'streamFrame.deriveSmoothAngSpeedHigh', min: 0.5, max: 60, step: 0.5, unit: 'rad/s', authority: none, label: 'Derive angular speed high' }),
  number({ key: 'streamFrame.deriveLatchAngMinSpeed', min: 0, max: 30, step: 0.5, unit: 'rad/s', authority: none, label: 'Latch angular min speed' }),
  number({ key: 'streamFrame.derivePreSmoothMs', min: 0, max: 100, step: 5, unit: 'ms', authority: none, label: 'Input pre-smoothing' }),
  number({ key: 'streamFrame.deriveLatchWindowMs', min: 40, max: 400, step: 10, unit: 'ms', authority: none, label: 'Release latch window' }),
  number({ key: 'streamFrame.deriveLatchHoldMs', min: 40, max: 400, step: 10, unit: 'ms', authority: none, label: 'Release latch hold' }),
  number({ key: 'streamFrame.deriveLatchMinSpeed', min: 0, max: 3, step: 0.1, unit: 'm/s', authority: none, label: 'Release latch min speed' }),
  number({ key: 'streamFrame.deriveDirWindowMs', min: 5, max: 200, step: 5, unit: 'ms', authority: none, label: 'Split direction window' }),
  number({ key: 'streamFrame.deriveDirWeightPow', min: 0, max: 6, step: 0.5, authority: none, label: 'Split direction weight power' }),
];

// ---- Debug -----------------------------------------------------------------

export const debugSpecs: ControlSpec[] = [
  number({
    key: 'streamFrame.nvencMaxBitrateHeadroomPct',
    min: 0, max: 100, step: 5, unit: '%', integer: true,
    slider: { min: 0, max: 100, step: 5 },
    sentinels: [{ value: 0, label: 'Use the whole budget' }],
    authority: nvenc,
    label: 'Bitrate headroom',
  }),
  number({
    key: 'streamFrame.nvencForceFps',
    min: 0, max: Infinity, step: 1, unit: 'fps', integer: true,
    slider: { min: 0, max: 120, step: 1 },
    sentinels: [{ value: 0, label: "Use the caller's frame rate" }],
    authority: nvenc,
    label: 'Force FPS',
  }),
  number({
    key: 'streamFrame.nvencBitrateMbit',
    min: 0, max: Infinity, step: 25, unit: 'Mbit/s', integer: true,
    slider: { min: 0, max: 1500, step: 25 },
    sentinels: [{ value: 0, label: 'Follow the pacer bandwidth' }],
    authority: nvenc,
    label: 'Encoder bitrate override',
  }),
];

// ---- Resolution ------------------------------------------------------------

export const renderSpecs: ControlSpec[] = [
  number({
    key: 'galaxyXr.renderWidth',
    min: 1, max: 16384, step: 1, unit: 'px', integer: true,
    // 2026-10-30: the slider is a guidance band; the number keeps the
    // native 1..16384 contract so a stored larger value stays editable.
    slider: { min: 16, max: 8192, step: 16 },
    authority: 'ConfigLoader.cpp:418-424 rejects values outside 1..16384',
    label: 'Render width per eye',
  }),
  number({
    key: 'galaxyXr.renderHeight',
    min: 1, max: 16384, step: 1, unit: 'px', integer: true,
    slider: { min: 16, max: 8192, step: 16 },
    authority: 'ConfigLoader.cpp:418-424 rejects values outside 1..16384',
    label: 'Render height per eye',
  }),
];

// ---- Cross-field rules -----------------------------------------------------

export interface CrossFieldIssue {
  key: string;
  message: string;
}

type FieldValue = number | boolean | undefined;
type FieldValues = Record<string, FieldValue>;

const asNumber = (value: FieldValue): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const CROSS_FIELD_RULES: Array<{
  key: string;
  check: (values: FieldValues) => boolean;
  message: string;
}> = [
  {
    // NvencTap.cpp:1513: minQp / minQpIntra must not exceed maxQp when maxQp > 0.
    key: 'streamFrame.nvencMaxQp',
    check: values => {
      const max = asNumber(values['streamFrame.nvencMaxQp']);
      if (!max) return true;
      return (asNumber(values['streamFrame.nvencMinQp']) ?? 0) <= max
        && (asNumber(values['streamFrame.nvencMinQpIntra']) ?? 0) <= max;
    },
    message: 'Min QP must not exceed Max QP.',
  },
  {
    // NvencTap.cpp:1516: an explicit VUI range must agree with post-pack output.
    key: 'streamFrame.nvencVuiFullRange',
    check: values => {
      if (!values['streamFrame.postPack.enable']) return true;
      const full = asNumber(values['streamFrame.nvencVuiFullRange']);
      if (full === undefined || full < 0) return true;
      return full === (values['streamFrame.postPack.limitedRange'] ? 0 : 1);
    },
    message: 'VUI full range conflicts with the lifted-blacks fix.',
  },
  {
    key: 'streamFrame.distortion.annulus.rMin',
    check: values => {
      const min = asNumber(values['streamFrame.distortion.annulus.rMin']);
      const max = asNumber(values['streamFrame.distortion.annulus.rMax']);
      return min === undefined || max === undefined || min < max;
    },
    message: 'The tuning band inner radius must be below the outer radius.',
  },
  {
    key: 'streamFrame.blackFloor.floorCode',
    check: values => {
      if (!values['streamFrame.blackFloor.shadowLift']) return true;
      const floor = asNumber(values['streamFrame.blackFloor.floorCode']);
      const knee = asNumber(values['streamFrame.blackFloor.kneeCode']);
      return floor === undefined || knee === undefined || floor < knee;
    },
    message: 'The shadow-lift floor must be below the knee.',
  },
];

/** Cross-field contradictions that the native layer refuses or that leave a
 *  control inert. Returns one issue per owning key; pages render them as
 *  warnings and never rewrite the values. */
export function crossFieldIssues(values: FieldValues): CrossFieldIssue[] {
  return CROSS_FIELD_RULES
    .filter(rule => !rule.check(values))
    .map(rule => ({ key: rule.key, message: rule.message }));
}

export const CONTROL_SPECS: readonly ControlSpec[] = [
  ...streamQualitySpecs,
  ...h264Specs,
  ...vuiSpecs,
  ...pictureSpecs,
  ...colorMultiplierSpecs,
  ...sharpeningSpecs,
  ...distortionSpecs,
  ...advancedSpecs,
  ...distortionTuneSpecs,
  ...controllerSpecs,
  ...kalmanSpecs,
  ...graveyardSpecs.map(spec => spec.key.startsWith('streamFrame.derive')
    ? { ...spec, appliesWhen: deriveModeOnly } : spec),
  ...debugSpecs,
  ...renderSpecs,
];

const byKey = new Map(CONTROL_SPECS.map(spec => [spec.key, spec]));

export function controlSpec(key: string): ControlSpec | undefined {
  return byKey.get(key);
}

/** Reasons the row's value is saved but not applied. Empty = it is live. */
export function inertReasons(spec: ControlSpec, ctx: ControlContext): string[] {
  const reasons: string[] = [];
  if (spec.appliesWhen && !spec.appliesWhen.active(ctx)) reasons.push(spec.appliesWhen.message);
  for (const requirement of spec.requires ?? []) {
    if (!requirement.active(ctx)) reasons.push(requirement.message);
  }
  return reasons;
}

export function resolveBound(bound: number | ((ctx: ControlContext) => number), ctx: ControlContext): number {
  return typeof bound === 'function' ? bound(ctx) : bound;
}

export function numberBounds(spec: NumberControlSpec, ctx: ControlContext): { min: number; max: number } {
  return { min: resolveBound(spec.min, ctx), max: resolveBound(spec.max, ctx) };
}

function unitSuffix(unit: ControlUnit | undefined): string {
  return unit ? ` ${unit}` : '';
}

function formatBound(value: number): string {
  return Number.isFinite(value) ? String(value) : '∞';
}

/**
 * Validation for a new edit. Returns undefined when the value may be written.
 * Delegates to the native mirror (streamFrameIntegerError) for keys that have
 * one, then applies the control bound and context.
 */
export function numberInputError(key: string, value: number | undefined, ctx: ControlContext): string | undefined {
  if (value === undefined) return undefined;
  const spec = controlSpec(key);
  if (!spec || spec.kind !== 'number') return streamFrameIntegerError(key, value, { forceCbr: ctx.forceCbr });
  if (spec.integer && !Number.isInteger(value)) {
    return t('{label} must be a whole number.', { label: t(spec.label) });
  }
  const { min, max } = numberBounds(spec, ctx);
  if (Number.isFinite(min) && value < min) {
    return t('{label} must be {min} to {max}{unit}.', {
      label: t(spec.label), min: formatBound(min), max: formatBound(max), unit: unitSuffix(spec.unit),
    });
  }
  if (Number.isFinite(max) && value > max) {
    return t('{label} must be {min} to {max}{unit}.', {
      label: t(spec.label), min: formatBound(min), max: formatBound(max), unit: unitSuffix(spec.unit),
    });
  }
  return streamFrameIntegerError(key, value, { forceCbr: ctx.forceCbr });
}
