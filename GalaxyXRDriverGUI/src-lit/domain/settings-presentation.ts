import type { AppSetting, Settings } from './types';
import type { BooleanSettingCheck } from './settings-inspection';
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
  source: BooleanSettingCheck['source'];
  advanced: boolean;
  gate?: 'vendor' | 'enhancements' | 'postpack' | 'preencode' | 'encoder' | 'kalman' | 'kalman-ca' | 'graveyard' | 'grid' | 'camera-grid' | 'tuner' | 'native-input-profile' | 'controllers';
  vendorOnly?: boolean;
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
headset('galaxyXr.nativeIdentity', 'Galaxy XR Native Identity', { advanced: true });
headset('galaxyXr.nativeResolution', 'Native Render Resolution');
headset('galaxyXr.vrlinkHeadsetProfile', 'vrlink Headset Profile', { advanced: true });
headset('galaxyXr.sdr10Baseline', 'SDR 10-bit baseline');
const controllers = group('driver-settings', ['Controllers'], ['controllers'], false, 'vendor');
controllers('galaxyXr.nativeInputProfile', 'Official Controller Input Profile');
controllers('galaxyXr.synthesizeGripTouch', 'Grip Touch From Grip Pressure', { gate: 'native-input-profile', vendorOnly: true });
controllers('galaxyXr.officialComponents', 'Official Pose Components');
group('driver-settings', ['Controllers', 'Controller Fix'], ['controllers', 'ctrlFix'], false, 'vendor')('galaxyXr.gripConvention', 'Grip Convention');
group('driver-settings', ['Controllers', 'Game Link Layout'], ['controllers', 'gameLink'], false, 'vendor')('galaxyXr.gameLinkLayout', 'Game Link Layout');
const kalman = group('driver-settings', ['Controllers', 'Controller Fix', 'Kalman Advanced Settings'], ['controllers', 'ctrlFix'], true, 'kalman');
kalman('streamFrame.kalmanCaExactCov', 'Exact Covariance Transition (A/B)', { gate: 'kalman-ca' });
kalman('streamFrame.kalmanDeviceTime', 'Kalman Device-Time Measurements');
kalman('streamFrame.kalmanPosFreeze3dof', 'Position-Freeze Protection (3dof Fallback)');
group('driver-settings', ['Controllers', 'Controllers Advanced'], ['controllers'], true, 'vendor')('galaxyXr.controllerBypass', 'Controller Bypass');
group('driver-settings', ['Controllers', 'Controllers Advanced', 'Controller Offsets'], ['controllers', 'ctrlOffsets'], true, 'controllers')('controllers.mirrorOffsetsForRightHand', 'Mirror Offsets For Right Hand');

group('app-settings', ['Application preferences'], ['heading:app-preferences'])('image-enhancements', 'Image Enhancements', {
  keys: ['streamFrame.enable', 'galaxyXr.sdr10Baseline', 'galaxyXr.sdr10AllowEnhancements'],
});
group('app-settings', ['Application preferences'], ['heading:app-preferences'])('advanceMode', 'Advanced Mode', { source: 'gui-settings.json' });
group('app-settings', ['Application preferences'], ['heading:app-preferences'])('debugMode', 'Debug Mode');

group('stream-frame', ['Image Processing', 'Color'], ['heading:image-processing', 'color'], false, 'enhancements')('streamFrame.contrastLinear', 'Linear Contrast');
const enhance = group('stream-frame', ['Image Processing', 'Image Enhancements'], ['heading:image-processing', 'enhance'], false, 'enhancements');
enhance('cas-sharpening', 'CAS Sharpening', { keys: ['streamFrame.cas.enable', 'streamFrame.postPack.enable', 'streamFrame.postPack.casEnable'] });
enhance('streamFrame.postPack.foveaTop', 'Fovea Tile On Top', { gate: 'postpack' });
enhance('streamFrame.cas.perEye', 'Per Eye Strength', { gate: 'preencode' });
enhance('streamFrame.dither', 'Dither');
enhance('streamFrame.stationaryDimming.enable', 'Stationary Dimming');
const advanced = group('stream-frame', ['Image Processing', 'Advanced'], ['heading:image-processing'], true);
advanced('streamFrame.directRender', 'Direct Render Path');
advanced('streamFrame.deferredEviction', 'Deferred Scratch Eviction');
advanced('streamFrame.processAtSubmitLayer', 'Process At Submit Layer');
advanced('streamFrame.calib.blackout', 'Blackout Headset Screens', { gate: 'enhancements' });
const debug = group('debug', ['Image Processing', 'Diagnostics'], ['debugImage']);
debug('streamFrame.blackFloor.rampBar', 'Black Floor: Diagnostic Ramp Bar');
debug('streamFrame.hitchDiag', 'Hitch Diagnostics (HITCHDIAG)');
debug('streamFrame.eyeGaze.debugRing', 'Gaze Debug Ring');
const controllerDebug = group('debug', ['Controllers', 'Diagnostics'], ['debugControllers']);
controllerDebug('streamFrame.poseLogging', 'Pose Logging (diagnostic)');
controllerDebug('streamFrame.poseLogBurst', 'Pose Logging: Burst Channel');
group('stream-frame', ['Encoder'], ['heading:encoder'], true, 'vendor')('streamFrame.nvencTap', 'NVENC Tap');
const encoder = group('stream-frame', ['Encoder', 'Advanced'], ['heading:encoder'], true, 'encoder', true);
encoder('streamFrame.nvencForceCbr', 'Force CBR');
encoder('streamFrame.postPack.limitedRange', 'Limited Range Video (fixes the black floor)');
const encoderDebug = group('debug', ['Encoder', 'Diagnostics'], ['debugEncoder'], false, 'encoder', true);
encoderDebug('galaxyXr.vrlinkDebugOverlay', 'vrlink Debug Overlay');
encoderDebug('streamFrame.nvencFixLevel', 'NVENC: Fix Level');
encoderDebug('streamFrame.nvencVerbose', 'NVENC: Verbose Log');
const retired = group('stream-frame', ['Graveyard (retired experiments)'], ['graveyard'], true, 'graveyard');
retired('streamFrame.kalmanCaReportAccel', 'Kalman CA: Report Acceleration');
retired('controllers.aligner.enable', 'Controller Aligner (in-headset)');
retired('galaxyXr.simulateTouch', 'Experimental: Simulate Oculus Touch', { vendorOnly: true });
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
retired('streamFrame.nvencBitrateScale', 'NVENC (retired): Bitrate Follows Streamer Backoff');
retired('streamFrame.nvencPresetMerge', 'NVENC (retired): True Preset Merge');
retired('streamFrame.deriveSmoothAngSeparate', 'Angular Smoothing: Separate (tau slow/fast ms, speed low/high rad/s)');
retired('streamFrame.deriveSplitDirLinear', 'Derive Split Direction: Linear');
retired('streamFrame.deriveSplitDirAngular', 'Derive Split Direction: Angular');
retired('streamFrame.deriveReleaseLatch', 'Release Latch (derive)');

const distortion = group('distortion-profile', ['Distortion Correction'], ['distortion'], false, 'enhancements');
distortion('streamFrame.distortion.perEye', 'Per Eye Curves');
distortion('streamFrame.distortion.perAxis', 'Per Axis Curves');
distortion('streamFrame.distortion.tune.enable', 'Interactive Tuner (in-headset)', { advanced: true });
distortion('streamFrame.distortion.tune.forceGrid', 'Force Calibration Grid', { advanced: true, gate: 'tuner' });
distortion('streamFrame.eyeGaze.debugGrid', 'Calibration Grid', { advanced: true, gate: 'grid' });
distortion('streamFrame.eyeGaze.gridOpaque', 'Camera Pattern: Opaque Background', { advanced: true, gate: 'camera-grid' });
distortion('streamFrame.eyeGaze.overlayWarped', 'Warped Overlays (profile validation)', { advanced: true, gate: 'grid' });
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
  'generalHeadset.useViveBluetooth', 'customShader.enable', 'customShader.enableForOther',
  'customShader.contrastLinear', 'customShader.contrastPerEye', 'customShader.contrastPerEyeLinear',
  'customShader.subpixelShift', 'customShader.disableMuraCorrection', 'customShader.disableBlackLevels',
  'customShader.srgbColorCorrection', 'customShader.srgbWhitePointCorrection', 'customShader.dither10Bit',
  'customShader.enableFilterForOverlay', 'customShader.enableFilterForDashboard', 'forceTracking',
  'streamFrame.distortion.enable', 'streamFrame.distortion.map.enable', 'streamFrame.pupilSwim.enable',
  'streamFrame.reconLogger', 'streamFrame.zeroCopy', 'streamFrame.graveyardEnable',
  'streamFrame.calib.captureMode', 'takeCompositorScreenshots', 'onlyHandlePrivateFunctionality', 'watchDistortionProfiles',
] as const;
export function classifyBoolean(check: Pick<BooleanSettingCheck, 'source' | 'key'>): 'control' | 'internal' | 'unknown' {
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
  location: string[];
  state: 'On' | 'Off' | 'Unknown' | 'Post-pack' | 'Pre-encode';
  origin: 'stored' | 'default' | 'mixed' | 'unknown';
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
export function settingUnavailable(setting: SettingPresentation, context: PresentationContext): string | undefined {
  if (setting.source === 'settings.json' && !context.settings) return 'Saved driver settings could not be read. Check installation to retry.';
  if (setting.source === 'gui-settings.json' && !context.app) return 'App preferences could not be read. Check installation to retry.';
  if (setting.source === 'settings.json' && !context.driverInstalled) return 'Install the driver to show this control.';
  if (setting.route === 'debug' && context.settings?.debugMode !== true) return 'Enable Debug Mode in App Settings to show diagnostic controls.';
  if ((setting.vendorOnly || setting.gate === 'vendor') && !context.vendor) return 'This control is available in the Galaxy XR build.';
  const sf = context.settings?.streamFrame;
  const enhancements = imageEnhancementsEnabled(context.settings);
  if (setting.gate === 'native-input-profile' && !context.settings?.galaxyXr?.nativeInputProfile) return 'Official Controller Input Profile is off. Its saved adjustments are kept.';
  if ((setting.gate === 'controllers' || setting.id === 'controllers.aligner.enable') && !context.settings?.controllers) return 'Controller settings are unavailable in this configuration.';
  if (['enhancements', 'postpack', 'preencode', 'camera-grid', 'grid', 'tuner'].includes(setting.gate ?? '') && !enhancements) return 'Image Enhancements is off. Its saved adjustments are kept.';
  if (setting.gate === 'postpack' && !(sf?.postPack?.enable && sf.postPack.casEnable)) return 'This control is available when CAS Sharpening uses Post-pack.';
  if (setting.gate === 'preencode' && (sf?.postPack?.enable && sf.postPack.casEnable || !sf?.cas?.enable)) return 'This control is available when CAS Sharpening uses Pre-encode.';
  if (setting.gate === 'encoder' && !sf?.nvencTap) return 'NVENC Tap is off. Its saved adjustments are kept.';
  if (setting.gate === 'graveyard' && !sf?.graveyardEnable) return 'Retired experiments are hidden. Showing a setting will not enable them.';
  if ((setting.gate === 'kalman' || setting.gate === 'kalman-ca') && !['kalman', 'kalmanCA', 'kalmanCAM'].includes(sf?.velocityFixMode ?? '')) return 'This control is available with a Kalman controller mode.';
  if (setting.gate === 'kalman-ca' && !['kalmanCA', 'kalmanCAM'].includes(sf?.velocityFixMode ?? '')) return 'This control is available with a Kalman CA controller mode.';
  if (['tuner', 'grid', 'camera-grid'].includes(setting.gate ?? '') && !sf?.distortion.tune.enable) return 'Interactive Tuner is off. Its saved adjustments are kept.';
  if (['grid', 'camera-grid'].includes(setting.gate ?? '') && sf?.distortion.tune.forceGrid) return 'Force Calibration Grid controls these overlays while the tuner is active.';
  if (setting.gate === 'camera-grid' && sf?.eyeGaze.gridMode !== 'sboys') return 'This control is available with the camera calibration pattern.';
  return undefined;
}

export function presentSettings(checks: readonly BooleanSettingCheck[], context: PresentationContext): PresentedSettingCheck[] {
  return SETTINGS_PRESENTATION.map(setting => {
    const root = setting.source === 'gui-settings.json' ? context.app : context.settings;
    const values = setting.keys.map(key => valueAt(root, key));
    // Optional legacy controls have false as their UI default, but an unreadable
    // entire source is always Unknown; never turn a failed read into Off.
    let state: PresentedSettingCheck['state'] = !root ? 'Unknown' : values[0] === true ? 'On' : 'Off';
    if (root && setting.id === 'image-enhancements') state = imageEnhancementsEnabled(context.settings) ? 'On' : 'Off';
    if (root && setting.id === 'cas-sharpening') state = values[1] === true && values[2] === true ? 'Post-pack' : values[0] === true ? 'Pre-encode' : 'Off';
    const origins = new Set(setting.keys.map(key => checks.find(check => check.source === setting.source && check.key === key)?.origin ?? 'default'));
    return { id: setting.id, location: [ROUTE_LABELS[setting.route], ...setting.containers, setting.label], state,
      origin: !root ? 'unknown' : origins.size > 1 ? 'mixed' : [...origins][0],
      href: settingHref(setting.route, setting.id), unavailableReason: settingUnavailable(setting, context), advanced: setting.advanced };
  });
}
