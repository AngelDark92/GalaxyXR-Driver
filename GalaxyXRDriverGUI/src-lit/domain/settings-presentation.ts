import type { AppSetting, Settings } from './types';
import type { SettingCheck, SettingSource } from './settings-inspection';
import { imageEnhancementsEnabled } from './image-mode';
import { ROUTE_LABELS, settingHref, type Route } from './navigation';

/** Presentation-only catalog (2026-09-26). The checker and fields share these
 * labels and IDs; inspecting or revealing a control never changes its value. */
export interface SettingPresentation {
  id: string;
  label: string;
  route: Route;
  containers: string[];
  sections: string[];
  keys: string[];
  source: SettingSource;
  advanced: boolean;
  gate?: 'vendor' | 'enhancements' | 'postpack' | 'preencode' | 'encoder' | 'h264' | 'kalman' | 'kalman-ca' | 'graveyard' | 'grid' | 'camera-grid' | 'tuner' | 'native-input-profile' | 'controllers';
  vendorOnly?: boolean;
  /** Non-boolean rows use value formatting in the check report. */
  kind?: 'boolean' | 'value';
}

const catalog: SettingPresentation[] = [];
function group(route: Route, containers: string[], sections: string[], advanced = false,
  gate?: SettingPresentation['gate'], vendorOnly = false) {
  return (key: string, label: string, options: Partial<SettingPresentation> = {}) => {
    catalog.push({ id: key, keys: [key], label, route, containers, sections, advanced, gate,
      vendorOnly, source: 'settings.json', ...options });
  };
}
const headset = group('driver-settings', ['Headset'], ['headset']);
headset('galaxyXr.nativeIdentity', 'Galaxy XR Recognition', { advanced: true });
headset('galaxyXr.nativeResolution', 'Override Render Resolution');
headset('galaxyXr.renderWidth', 'Render Width per Eye', { kind: 'value' });
headset('galaxyXr.renderHeight', 'Render Height per Eye', { kind: 'value' });
// GUI-only preference for the proportional render sliders (2026-10-30).
headset('renderResolutionLinked', 'Render Resolution Sliders', { source: 'gui-settings.json' });
headset('galaxyXr.vrlinkHeadsetProfile', 'Galaxy XR Headset Profile', { advanced: true });
headset('galaxyXr.sdr10Baseline', '10-Bit SDR Mode');
const controllers = group('driver-settings', ['Controllers'], ['controllers'], false, 'vendor');
group('driver-settings', ['Controllers'], ['controllers'])('galaxyXr.controllerBypass', 'Disable All Controller Features');
controllers('galaxyXr.nativeInputProfile', 'Official Controller Layout');
controllers('galaxyXr.synthesizeGripTouch', 'Grip Touch From Pressure', { gate: 'native-input-profile', vendorOnly: true });
controllers('galaxyXr.officialComponents', 'Official Pose Components');
group('driver-settings', ['Controllers', 'Controller Fix'], ['controllers', 'ctrlFix'], false, 'vendor')('galaxyXr.gripConvention', 'Grip Convention');
group('driver-settings', ['Controllers', 'Game Link Layout'], ['controllers', 'gameLink'], false, 'vendor')('galaxyXr.gameLinkLayout', 'Game Link Layout');
const kalman = group('driver-settings', ['Controllers', 'Controller Fix', 'Kalman Advanced Settings'], ['controllers', 'ctrlFix'], true, 'kalman');
kalman('streamFrame.kalmanCaExactCov', 'Exact Covariance Model (Experimental)', { gate: 'kalman-ca' });
kalman('streamFrame.kalmanDeviceTime', 'Use Tracking Timestamps');
kalman('streamFrame.kalmanPosFreeze3dof', 'Freeze Protection');
group('driver-settings', ['Controllers', 'Controllers Advanced', 'Controller Offsets'], ['controllers', 'ctrlOffsets'], true, 'controllers')('controllers.mirrorOffsetsForRightHand', 'Same Alignment Both Hands');

group('app-settings', ['Picture'], ['heading:app-picture'])('image-enhancements', 'Image Enhancements', {
  keys: ['streamFrame.enable', 'galaxyXr.sdr10Baseline'],
});
group('app-settings', ['Window'], ['heading:app-window'])('minimizeToTray', 'Minimize to tray', { source: 'gui-settings.json' });
group('app-settings', ['Advanced'], ['heading:app-advanced'])('advanceMode', 'Advanced Mode', { source: 'gui-settings.json' });
group('app-settings', ['Updates'], ['heading:app-updates'])('devUpdates', 'Developer Builds', { source: 'gui-settings.json' });
group('app-settings', ['Advanced'], ['heading:app-advanced'])('debugMode', 'Debug Mode');

group('stream-frame', ['Image Processing', 'Color'], ['heading:image-processing', 'color'], false, 'enhancements')('streamFrame.contrastLinear', 'Linear Contrast');
const enhance = group('stream-frame', ['Image Processing', 'Image Enhancements'], ['heading:image-processing', 'enhance'], false, 'enhancements');
enhance('cas-sharpening', 'Sharpening (CAS)', { keys: ['streamFrame.cas.enable', 'streamFrame.postPack.enable', 'streamFrame.postPack.casEnable'] });
enhance('streamFrame.postPack.foveaTop', 'Center Tile at Top', { gate: 'postpack' });
enhance('streamFrame.cas.perEye', 'Per-Eye Values', { gate: 'preencode' });
enhance('streamFrame.dither', 'Dither');
enhance('streamFrame.stationaryDimming.enable', 'Dim Screen When Idle');
// 2026-10-30: the Advanced group lives inside Optical Flow, not under
// Image Processing; the deep link must open the Optical Flow card.
const advanced = group('stream-frame', ['Optical Flow', 'Advanced'], ['heading:optical-flow'], true);
advanced('streamFrame.directRender', 'Fast Render Path');
advanced('streamFrame.deferredEviction', 'Smooth Switching');
advanced('streamFrame.processAtSubmitLayer', 'Alternative Processing Hook');
advanced('streamFrame.calib.blackout', 'Panel Blackout (Testing)', { gate: 'enhancements' });
const debug = group('debug', ['Image Processing', 'Diagnostics'], ['debugImage']);
debug('streamFrame.blackFloor.rampBar', 'Black-Level Test Bar');
debug('streamFrame.hitchDiag', 'Stutter Diagnostics');
debug('streamFrame.eyeGaze.debugRing', 'Gaze Position Ring');
const controllerDebug = group('debug', ['Controllers', 'Diagnostics'], ['debugControllers']);
controllerDebug('streamFrame.poseLogging', 'Motion Logging');
controllerDebug('streamFrame.poseLogBurst', 'Motion Logging: Burst');
group('stream-frame', ['Stream Quality'], ['heading:stream-quality'], false, 'vendor')('streamFrame.nvencTap', 'Override NVIDIA Encoder');
// Async Spacewarp (2026-10-17; 2026-10-26): stream synthesis toggle and the
// separate Force half-rate switch; both rows live in the vendor build's Stream
// Quality branch, so they mirror nvencTap's gate.
group('stream-frame', ['Stream Quality'], ['heading:stream-quality'], false, 'vendor')('streamFrame.spacewarpEnable', 'Async Spacewarp');
group('stream-frame', ['Stream Quality'], ['heading:stream-quality'], false, 'vendor')('streamFrame.spacewarpMode', 'Force half-rate', { kind: 'value' });
// Optical Flow (2026-10-17; 2026-10-23): the managed OFXR Bridge card. The
// remaining rows are gui-settings.json values owned by the Companion; the
// page's Enable switch is additionally gated by the native ofxr_status()
// state. NVIDIA input scale and other build-specific options are set in the
// imported OFXR build's own tray and are not written by the Companion.
const ofxr = group('stream-frame', ['Optical Flow'], ['heading:optical-flow'], false, 'vendor');
ofxr('ofxr.enabled', 'Enable Optical Flow', { source: 'gui-settings.json' });
ofxr('ofxr.mode', 'Backend', { source: 'gui-settings.json', kind: 'value' });
ofxr('ofxr.bidirectional', 'NVIDIA bidirectional consistency', { source: 'gui-settings.json' });
ofxr('ofxr.logging', 'Bridge flight recorder', { source: 'gui-settings.json' });
ofxr('ofxr.maxLogMb', 'Flight log size limit (MB)', { source: 'gui-settings.json', kind: 'value' });
ofxr('ofxr.flushEachEvent', 'Flush every event', { source: 'gui-settings.json' });
ofxr('ofxr.overlay', 'FPS overlay position', { source: 'gui-settings.json', kind: 'value' });
ofxr('ofxr.version', 'OFXR Bridge version', { source: 'gui-settings.json', kind: 'value' });
group('stream-frame', ['Stream Quality'], ['heading:stream-quality'], false, 'encoder', true)('streamFrame.nvencCodec', 'Video Codec', { kind: 'value' });
const encoder = group('stream-frame', ['Encoder Advanced'], ['heading:encoder'], true, 'encoder', true);
encoder('streamFrame.nvencForceCbr', 'Force Constant Bitrate');
encoder('streamFrame.nvencBitrateCurve', 'Bitrate Curve', { kind: 'value' });
encoder('streamFrame.nvencBitrateConstancyPct', 'Bitrate Constancy (%)', { kind: 'value' });
encoder('streamFrame.nvencH264GopFrames', 'H.264 GOP Frames', { gate: 'h264' });
encoder('streamFrame.nvencH264IdrFrames', 'H.264 IDR Frames', { gate: 'h264' });
encoder('streamFrame.nvencH264RefFrames', 'H.264 Reference Frames', { gate: 'h264' });
encoder('streamFrame.nvencH264Entropy', 'H.264 Entropy Mode', { gate: 'h264' });
encoder('streamFrame.nvencH264SliceMode', 'H.264 Slice Mode', { gate: 'h264' });
encoder('streamFrame.nvencH264SliceData', 'H.264 Slice Value', { gate: 'h264' });
encoder('streamFrame.nvencH264VbvInitialDelay', 'H.264 Initial VBV Delay', { gate: 'h264' });
encoder('streamFrame.nvencH264Aud', 'H.264 Access Unit Delimiters', { gate: 'h264' });
encoder('streamFrame.nvencH264RepeatHeaders', 'H.264 Repeat SPS/PPS', { gate: 'h264' });
encoder('streamFrame.nvencH264DisableHeaders', 'H.264 Disable SPS/PPS', { gate: 'h264' });
encoder('streamFrame.nvencH264BitstreamRestriction', 'H.264 Bitstream Restriction', { gate: 'h264' });
encoder('streamFrame.nvencMultiPass', 'Encoder Multipass');
encoder('streamFrame.postPack.limitedRange', 'Lifted-Blacks Fix');
const encoderDebug = group('debug', ['Encoder', 'Diagnostics'], ['debugEncoder'], false, 'encoder', true);
encoderDebug('galaxyXr.vrlinkDebugOverlay', 'Steam Link Debug Overlay');
encoderDebug('streamFrame.nvencFixLevel', 'Encoder Auto-Fixes');
encoderDebug('streamFrame.nvencVerbose', 'Encoder Verbose Log');
const retired = group('stream-frame', ['Graveyard (retired experiments)'], ['graveyard'], true, 'graveyard');
retired('streamFrame.kalmanCaReportAccel', 'Kalman CA: Report Acceleration');
retired('controllers.aligner.enable', 'Controller Aligner (in-headset)');
retired('galaxyXr.simulateTouch', 'Retired: Controller Layout Simulation', { vendorOnly: true });
retired('streamFrame.eyeGaze.probeCapture', 'Probe Capture (scoring run)');
retired('streamFrame.skipColorWhileDashboardOpen', 'Skip Color While Dashboard Open');
retired('streamFrame.eyeGaze.calibDot', 'Fixation Dot (VOR probe)');
retired('streamFrame.eyeGaze.swimProbe', 'Swim Probe Logging');
retired('streamFrame.deriveLatchPoseAssist', 'Velocity Consumer Test / Pose Assist');
retired('streamFrame.kalmanDirLeadAdaptive', 'Adaptive Direction Lead - EXPERIMENT A');
retired('streamFrame.kalmanAdaptiveR', 'Adaptive Measurement Trust - EXPERIMENT B');
retired('streamFrame.kalmanGripEnable', 'Grip-Point Velocity Compensator');
retired('streamFrame.blackFloor.shadowLift', 'Black Floor: Shadow Lift (floor / knee, sRGB codes)');
retired('streamFrame.zeroCopyV3', 'Zero-Copy v3 (experimental)');
retired('streamFrame.nvencPresetMerge', 'NVENC (retired): True Preset Merge');
retired('streamFrame.deriveSmoothAngSeparate', 'Angular Smoothing: Separate (tau slow/fast ms, speed low/high rad/s)');
retired('streamFrame.deriveSplitDirLinear', 'Derive Split Direction: Linear');
retired('streamFrame.deriveSplitDirAngular', 'Derive Split Direction: Angular');
retired('streamFrame.deriveReleaseLatch', 'Release Latch (derive)');

const distortion = group('distortion-profile', ['Distortion Correction'], ['distortion'], false, 'enhancements');
distortion('streamFrame.distortion.perEye', 'Per Eye Curves');
distortion('streamFrame.distortion.perAxis', 'Per Axis Curves');
distortion('streamFrame.distortion.tune.enable', 'Tuner (In-Headset)', { advanced: true });
distortion('streamFrame.distortion.tune.forceGrid', 'Force Calibration Grid', { advanced: true, gate: 'tuner' });
distortion('streamFrame.eyeGaze.debugGrid', 'Calibration Grid', { advanced: true, gate: 'grid' });
distortion('streamFrame.eyeGaze.gridOpaque', 'Camera Pattern: Opaque Background', { advanced: true, gate: 'camera-grid' });
distortion('streamFrame.eyeGaze.overlayWarped', 'Show Corrected Overlays', { advanced: true, gate: 'grid' });
distortion('streamFrame.eyeGaze.gridWorldLocked', 'World-Locked Grid', { advanced: true, gate: 'tuner' });
distortion('streamFrame.distortion.centerTune.enable', 'Center Tuner (in-headset)', { advanced: true });
distortion('streamFrame.distortion.annulus.enable', 'Annulus Tuning Band', { advanced: true });

export const SETTINGS_PRESENTATION: readonly SettingPresentation[] = catalog;
export function settingPresentation(id: string): SettingPresentation | undefined {
  return SETTINGS_PRESENTATION.find(setting => setting.id === id);
}

/** Deliberately no control exists for these compatibility/runtime leaves. New
 * keys must be classified explicitly so they cannot silently disappear. */
export const INTERNAL_BOOLEAN_KEYS = [
  'galaxyXr.profileSupports10bit', 'galaxyXr.force10bit', 'galaxyXr.componentRebaseIncludeTrim', 'galaxyXr.skeletonOffsetMirror',
  // 2026-10-17 (owner directive): the enhancements consent key is retired in
  // place — no control, no behavior — but bundled files still inspect it.
  'galaxyXr.sdr10AllowEnhancements',
  // Camera-calibration and displacement-map booleans are tools/internal; only
  // calib.blackout has a GUI control.
  'streamFrame.calib.captureMode', 'streamFrame.distortion.map.enable',
  'generalHeadset.useViveBluetooth', 'customShader.enable', 'customShader.enableForOther',
  'customShader.contrastLinear', 'customShader.contrastPerEye', 'customShader.contrastPerEyeLinear',
  'customShader.subpixelShift', 'customShader.disableMuraCorrection', 'customShader.disableBlackLevels',
  'customShader.srgbColorCorrection', 'customShader.srgbWhitePointCorrection', 'customShader.dither10Bit',
  'customShader.enableFilterForOverlay', 'customShader.enableFilterForDashboard', 'forceTracking',
  'streamFrame.distortion.enable', 'streamFrame.pupilSwim.enable',
  'streamFrame.reconLogger', 'streamFrame.zeroCopy', 'streamFrame.graveyardEnable',
  'takeCompositorScreenshots', 'onlyHandlePrivateFunctionality', 'watchDistortionProfiles',
] as const;
export function classifyBoolean(check: Pick<SettingCheck, 'source' | 'key'>): 'control' | 'internal' | 'unknown' {
  if (SETTINGS_PRESENTATION.some(setting => setting.source === check.source && setting.keys.includes(check.key))) return 'control';
  if (check.source === 'settings.json' && (INTERNAL_BOOLEAN_KEYS as readonly string[]).includes(check.key)) return 'internal';
  if (check.source === 'gui-settings.json' && check.key === 'driverVerified') return 'internal';
  return 'unknown';
}

export interface PresentationContext {
  settings?: Settings;
  app?: AppSetting;
  driverInstalled: boolean;
  vendor: boolean;
}
export interface PresentedSettingCheck {
  id: string;
  source: SettingSource;
  location: string[];
  state: string;
  defaultState?: string;
  origin: 'stored' | 'default' | 'mixed' | 'unknown';
  changed: boolean;
  hasDefault: boolean;
  kind: 'boolean' | 'value';
  href: string;
  unavailableReason?: string;
  advanced: boolean;
}
function valueAt(value: unknown, path: string): unknown {
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function codecLabel(value: unknown): string {
  return value === 1 ? 'H.264' : value === 2 ? 'AV1' : 'HEVC (default)';
}
function ofxrModeLabel(value: unknown): string {
  switch (value) {
    case 'nvidia-fast': return 'NVIDIA Fast (test)';
    case 'nvidia-medium': return 'NVIDIA Medium (recommended)';
    case 'nvidia-slow': return 'NVIDIA Slow (best quality)';
    default: return 'FidelityFX (any card)';
  }
}
function ofxrOverlayLabel(value: unknown): string {
  switch (value) {
    case 'upper-left': return 'Upper left';
    case 'upper-right': return 'Upper right';
    case 'lower-left': return 'Lower left';
    case 'lower-right': return 'Lower right';
    default: return 'Off';
  }
}
function bitrateCurveLabel(value: unknown): string {
  switch (value) {
    case 1: return 'Power knee';
    case 2: return 'Soft knee';
    case 3: return 'Custom';
    default: return 'Linear';
  }
}

/** Format a raw check value for the technical table. */
export function formatSettingValue(value: unknown): string {
  if (value === undefined) return 'None';
  if (value === null) return 'None';
  if (Array.isArray(value)) return value.length ? `${value.length} entries` : 'None';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'object') return 'Object';
  return String(value);
}

/** Format a presented value row for the human-readable table. */
function formatValue(id: string, value: unknown): string {
  if (value === undefined || value === null) return 'Unknown';
  switch (id) {
    case 'galaxyXr.renderWidth':
    case 'galaxyXr.renderHeight': return `${value} px`;
    case 'ofxr.mode': return ofxrModeLabel(value);
    case 'ofxr.maxLogMb': return `${value} MB`;
    case 'ofxr.overlay': return ofxrOverlayLabel(value);
    case 'ofxr.version': return String(value) || 'Automatic (newest installed)';
    case 'streamFrame.nvencCodec': return codecLabel(value);
    case 'streamFrame.spacewarpMode': return value === 1 ? 'On' : 'Off';
    case 'streamFrame.nvencBitrateCurve': return bitrateCurveLabel(value);
    case 'streamFrame.nvencBitrateConstancyPct': return `${value}%`;
    default: return formatSettingValue(value);
  }
}

export function formatCheckValue(check: SettingCheck): string {
  return check.kind === 'boolean' ? (check.enabled ? 'On' : 'Off') : formatSettingValue(check.value);
}

/** Keys that are migration/runtime/legacy state rather than user-facing
 * controls. The changed-values table hides these by default; Technical
 * details still shows every check. */
const INTERNAL_VALUE_KEYS = new Set([
  'galaxyXr.sdr10SettingsVersion', 'galaxyXr.renderModelVariant', 'galaxyXr.streamQuality',
  'galaxyXr.customEncodeWidth', 'galaxyXr.customStreamFormatWidthOverride', 'galaxyXr.profileMaxStreamFormatWidth',
  'streamFrame.nvencSettingsVersion', 'streamFrame.spacewarpSettingsVersion', 'streamFrame.streamFrameSchema',
  'streamFrame.nvencValidationError', 'streamFrame.distortion.enable', 'streamFrame.pupilSwim.enable',
  'streamFrame.distortion.points', 'streamFrame.distortion.curves',
  'streamFrame.pupilSwim.centerStrengthX', 'streamFrame.pupilSwim.centerStrengthY',
  'forceTracking', 'takeCompositorScreenshots', 'onlyHandlePrivateFunctionality', 'watchDistortionProfiles',
  'generalHeadset.useViveBluetooth',
]);
const INTERNAL_VALUE_PREFIXES = ['customShader.', 'streamFrame.distortion.map.', 'streamFrame.calib.'];
export function isInternalCheck(check: Pick<SettingCheck, 'source' | 'key'>): boolean {
  if (check.source === 'gui-settings.json') return check.key === 'driverVerified';
  if ((INTERNAL_BOOLEAN_KEYS as readonly string[]).includes(check.key)) return true;
  if (INTERNAL_VALUE_KEYS.has(check.key)) return true;
  if (check.key === 'streamFrame.calib.blackout') return false;
  return INTERNAL_VALUE_PREFIXES.some(prefix => check.key.startsWith(prefix));
}

export function settingUnavailable(setting: SettingPresentation, context: PresentationContext): string | undefined {
  if (setting.source === 'settings.json' && !context.settings) return 'Saved driver settings could not be read. Check installation to retry.';
  if (setting.source === 'gui-settings.json' && !context.app) return 'App preferences could not be read. Check installation to retry.';
  if (setting.source === 'settings.json' && !context.driverInstalled) return 'Install the driver to show this control.';
  if (setting.route === 'debug' && context.settings?.debugMode !== true) return 'Enable Debug Mode in App Settings to show diagnostic controls.';
  if ((setting.vendorOnly || setting.gate === 'vendor') && !context.vendor) return 'This control is available in the Galaxy XR build.';
  // 2026-10-24: the master switch hides every other controller control; the
  // checker keeps its saved values inspectable but explains why they are inert.
  if (setting.route === 'driver-settings' && setting.containers.includes('Controllers')
      && setting.id !== 'galaxyXr.controllerBypass' && context.settings?.galaxyXr?.controllerBypass) {
    return 'Disable All Controller Features is on. Its saved adjustments are kept.';
  }
  const sf = context.settings?.streamFrame;
  const enhancements = imageEnhancementsEnabled(context.settings);
  if (setting.gate === 'native-input-profile' && !context.settings?.galaxyXr?.nativeInputProfile) return 'Official Controller Layout is off. Its saved adjustments are kept.';
  if ((setting.gate === 'controllers' || setting.id === 'controllers.aligner.enable') && !context.settings?.controllers) return 'Controller settings are unavailable in this configuration.';
  if (['enhancements', 'postpack', 'preencode', 'camera-grid', 'grid', 'tuner'].includes(setting.gate ?? '') && !enhancements) return 'Image Enhancements is off. Its saved adjustments are kept.';
  if (setting.gate === 'postpack' && !(sf?.postPack?.enable && sf.postPack.casEnable)) return 'This control is available when Sharpening (CAS) uses Post-pack.';
  if (setting.gate === 'preencode' && (sf?.postPack?.enable && sf.postPack.casEnable || !sf?.cas?.enable)) return 'This control is available when Sharpening (CAS) uses Pre-encode.';
  if (['encoder', 'h264'].includes(setting.gate ?? '') && !sf?.nvencTap) return 'NVENC Tap is off. Its saved adjustments are kept.';
  if (setting.gate === 'h264' && sf?.nvencCodec !== 1) return 'Select H.264 to edit this setting. Its saved value is kept.';
  if (setting.gate === 'graveyard' && !sf?.graveyardEnable) return 'Retired experiments are hidden. Showing a setting will not enable them.';
  if ((setting.gate === 'kalman' || setting.gate === 'kalman-ca') && !['kalman', 'kalmanCA', 'kalmanCAM'].includes(sf?.velocityFixMode ?? '')) return 'This control is available with a Kalman controller mode.';
  if (setting.gate === 'kalman-ca' && !['kalmanCA', 'kalmanCAM'].includes(sf?.velocityFixMode ?? '')) return 'This control is available with a Kalman CA controller mode.';
  if (['tuner', 'grid', 'camera-grid'].includes(setting.gate ?? '') && !sf?.distortion.tune.enable) return 'Interactive Tuner is off. Its saved adjustments are kept.';
  if (['grid', 'camera-grid'].includes(setting.gate ?? '') && sf?.distortion.tune.forceGrid) return 'Force Calibration Grid controls these overlays while the tuner is active.';
  if (setting.gate === 'camera-grid' && sf?.eyeGaze.gridMode !== 'sboys') return 'This control is available with the camera calibration pattern.';
  return undefined;
}

export function presentSettings(checks: readonly SettingCheck[], context: PresentationContext): PresentedSettingCheck[] {
  return SETTINGS_PRESENTATION.map(setting => {
    const root = setting.source === 'gui-settings.json' ? context.app : context.settings;
    const values = setting.keys.map(key => valueAt(root, key));
    const found = setting.keys.map(key => checks.find(check => check.source === setting.source && check.key === key));
    const kind = setting.kind ?? 'boolean';
    // Optional legacy controls have false as their UI default, but an unreadable
    // entire source is always Unknown; never turn a failed read into Off.
    let state: string = !root ? 'Unknown' : kind === 'value'
      ? formatValue(setting.id, values[0])
      : values[0] === true ? 'On' : 'Off';
    if (root && setting.id === 'image-enhancements') state = imageEnhancementsEnabled(context.settings) ? 'On' : 'Off';
    if (root && setting.id === 'cas-sharpening') state = values[1] === true && values[2] === true ? 'Post-pack' : values[0] === true ? 'Pre-encode' : 'Off';
    const origins = new Set(found.map(check => check?.origin ?? 'default'));
    const changed = found.some(check => check?.changed === true);
    const hasDefault = found.length > 0 && found.every(check => check?.hasDefault === true);
    const defaultState = found.length === 1
      ? (found[0]?.kind === 'boolean'
        ? (found[0].defaultValue === true ? 'On' : 'Off')
        : formatValue(setting.id, found[0]?.defaultValue))
      : undefined;
    return {
      id: setting.id, source: setting.source,
      location: [ROUTE_LABELS[setting.route], ...setting.containers, setting.label],
      state, defaultState,
      origin: !root ? 'unknown' : origins.size > 1 ? 'mixed' : [...origins][0],
      changed, hasDefault, kind,
      href: settingHref(setting.route, setting.id),
      unavailableReason: settingUnavailable(setting, context),
      advanced: setting.advanced,
    };
  });
}