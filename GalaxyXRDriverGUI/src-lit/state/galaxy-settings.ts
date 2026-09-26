// Shared Galaxy settings state, ported from
// src/app/pages/galaxy-settings/galaxy-settings.base.ts (Angular era).
// This file is the data-semantics core of the GUI: persisted-schema
// migrations, composite CAS action, profile import/export, matrix parsing,
// tuner band generation, calibration lifecycle. The Lit pages are thin
// views over this class; ONE shared instance replaces the old per-page
// Angular directive instances (same root services, no duplicate effects).
//
// All dated-campaign comments and migration predicates are preserved
// verbatim from the source of record.
import { driverDefaults } from '../domain/driver-defaults';
import { getDriverDefaultsForVendor } from '../domain/vendor-driver-defaults';
import type { AppSettingService } from '../services/app-setting';
import { effect, signal } from '../reactive';
import type { DriverSettingService } from '../services/driver-setting';
import type { DriverInfoService } from '../services/driver-info';
import type { Settings, StreamFrameConfig, ControllersConfig, GalaxyXrConfig, HandOffsets } from '../domain/types';
import { vendor } from '../environment';
import { t } from '../locale/i18n';
import { baselineRequested, imageEnhancementsEnabled, changePictureMode } from '../domain/image-mode';

function defaultStreamFrame(): StreamFrameConfig { return structuredClone(driverDefaults.streamFrame!); }

function streamFrameDefaults(infoDefaults: any): StreamFrameConfig {
  const bundled = defaultStreamFrame();
  const defaults = fillDefaults(infoDefaults ? structuredClone(infoDefaults) : undefined, bundled);
  // 2026-09-26: reset arrows must share the encoder defaults used by sparse
  // settings saves; an old info.json must not silently turn overrides back on.
  Object.assign(defaults, Object.fromEntries(Object.entries(bundled)
    .filter(([key]) => key.startsWith('nvenc') || key === 'postPack')));
  return defaults;
}

function zeroHandOffsets(): HandOffsets {
  return {
    rotationOffsetDeg: { x: 0, y: 0, z: 0 },
    positionOffsetCm: { x: 0, y: 0, z: 0 },
  };
}

function defaultControllers(): ControllersConfig { return getDriverDefaultsForVendor(vendor).controllers!; }

function fillDefaults(target: any, defaults: any): any {
  if (target === undefined || target === null) {
    return JSON.parse(JSON.stringify(defaults));
  }
  if (typeof defaults === 'object' && defaults !== null && !Array.isArray(defaults) && typeof target === 'object') {
    for (const key of Object.keys(defaults)) {
      target[key] = fillDefaults(target[key], defaults[key]);
    }
  }
  return target;
}

export class GalaxySettingsBase {
  private appSettings: AppSettingService;
  get advancedMode(): boolean { return !!this.appSettings.values()?.advanceMode; }
  dss: DriverSettingService;
  dis: DriverInfoService;

  rootSetting?: Settings;
  controllerSettings?: ControllersConfig;
  controllerDefaults: ControllersConfig = defaultControllers();
  settings?: StreamFrameConfig;
  defaults: StreamFrameConfig = defaultStreamFrame();
  readonly imageModeChanging = signal(false);
  readonly imageModeError = signal('');
  get baselineRequested(): boolean { return baselineRequested(this.dss.values()); }
  get imageEnhancementsEnabled(): boolean { return imageEnhancementsEnabled(this.dss.values()); }

  async setSdr10Baseline(enabled: boolean): Promise<boolean> {
    return this.setPictureMode('baseline', enabled);
  }

  async setImageEnhancements(enabled: boolean, qualityWarningAccepted = false): Promise<boolean> {
    return this.setPictureMode('enhancements', enabled, qualityWarningAccepted);
  }

  private async setPictureMode(mode: 'baseline' | 'enhancements', enabled: boolean, qualityWarningAccepted = false): Promise<boolean> {
    if (this.imageModeChanging() || this.dss.inspecting) return false;
    this.imageModeChanging.set(true);
    this.imageModeError.set('');
    try {
      // Drain pending edits before taking a snapshot; both mode flags and the
      // reset then travel through the same save/rollback path in one write.
      await this.dss.flush();
      if (this.dss.inspecting || this.dss.readFileError()) return false;
      const next = changePictureMode(this.dss.values(), this.defaults, mode, enabled, qualityWarningAccepted);
      if (!next) {
        this.imageModeError.set(mode === 'baseline'
          ? 'Turn Image Enhancements off before enabling SDR 10-bit baseline.'
          : t('Accept the image-quality warning before enabling Image Enhancements with SDR 10-bit baseline.'));
        return false;
      }
      const saved = await this.dss.save(next);
      if (!saved) this.imageModeError.set(this.dss.writeFileError() ?? 'The picture mode could not be saved.');
      return saved;
    } catch (error) {
      this.imageModeError.set(String(error));
      return false;
    } finally {
      this.imageModeChanging.set(false);
      this.revision.update(x => x + 1);
    }
  }

  // bumped on every edit so the curve component redraws immediately
  revision = signal(0);
  // friendly band layout inputs; the driver consumes the raw bands array,
  // these three regenerate it evenly spaced on change
  tuneBandCount = 7;
  segLayoutText = '';
  tuneBandFirst = 0.15;
  tuneBandLast = 0.65;
  matrixText = signal('');
  matrixError = signal('');

  // collapsible section state; debug starts closed, everything else open.
  sections = signal({
    headset: true, controllers: true, ctrlFix: true, kalmanAdv: false, ctrlAdv: false, ctrlOffsets: true, tipOffset: false,
    processing: true, color: true, enhance: true, distortion: true, eyeAlign: false, share: false,
    advanced: false, debug: false, graveyard: false,
    encoderAdv: false, encoderDbg: false,
  });

  constructor(appSettings: AppSettingService, dss: DriverSettingService, dis: DriverInfoService) {
    this.appSettings = appSettings;
    this.dss = dss;
    this.dis = dis;
    // driver-published defaults can arrive AFTER the last settings emission
    // (info file poll race), leaving this.defaults stuck on the TS literals;
    // reset arrows then write stale values (field 2026-08-11: a reset wrote
    // pre-campaign A=40/P=2.0/O=0.5 over the ratified tuning and poisoned a
    // capture). values() is a signal, so this effect re-runs on every info
    // update and the literals become a true last-resort fallback only.
    effect(() => {
      const infoDefaults = (this.dis.values()?.defaultSettings as any)?.streamFrame;
      this.defaults = streamFrameDefaults(infoDefaults);
    });
    effect(() => {
      this.rootSetting = this.dss.values();
      // 2026-09-25: a failed migration save rolls back to the disk snapshot.
      // Do not migrate/save that snapshot again until an explicit successful
      // save or reset clears the error; otherwise a read-only file loops forever.
      const canMigrate = !this.dss.inspecting && !this.dss.writeFileError?.();
      if (this.rootSetting) {
        // schema 2 (2026-09-25): mirrors MigrateSdr10Settings in the driver.
        // Only retire the old enabled compatibility default with baseline OFF.
        const rawGalaxy = this.rootSetting.galaxyXr;
        if (rawGalaxy && canMigrate && (rawGalaxy.sdr10SettingsVersion ?? 1) < 2) {
          if (!rawGalaxy.sdr10Baseline && (rawGalaxy.profileSupports10bit ?? true)) {
            rawGalaxy.profileSupports10bit = false;
          }
          rawGalaxy.sdr10SettingsVersion = 2;
          queueMicrotask(() => this.save());
        }
        // schema-2 migration (2026-08-15), on the RAW stored object BEFORE
        // fillDefaults so absent keys are distinguishable from explicit old
        // defaults. mirrors the driver-side migration; this side persists
        // it. only exact-old-default configs are upgraded - custom tuning
        // and deliberate mode choices pass through untouched.
        const rawSf: any = this.rootSetting.streamFrame;
        if (rawSf && canMigrate && (rawSf.streamFrameSchema ?? 1) < 2) {
          const cvDef = (rawSf.kalmanProcessAccel ?? 1) === 1 && (rawSf.kalmanPosNoiseMm ?? 2.7) === 2.7
            && (rawSf.kalmanProcessAngAccel ?? 400) === 400 && (rawSf.kalmanOriNoiseDeg ?? 1.25) === 1.25;
          const caOld = rawSf.kalmanCaJerk === 10 && (rawSf.kalmanCaAngJerk ?? 1500) === 1500
            && rawSf.kalmanCaPosNoiseMm === 4.2 && rawSf.kalmanCaOriNoiseDeg === 1.25;
          if (rawSf.velocityFixMode === 'kalman' && cvDef) {
            rawSf.velocityFixMode = 'kalmanCA';
          } else if ((rawSf.velocityFixMode === 'kalmanCAM' || rawSf.velocityFixMode === 'kalmanCA') && caOld) {
            rawSf.velocityFixMode = 'kalmanCA';
            rawSf.kalmanCaJerk = 17;
            rawSf.kalmanCaPosNoiseMm = 5.7;
            rawSf.kalmanCaOriNoiseDeg = 5.75;
          }
          rawSf.streamFrameSchema = 2;
          queueMicrotask(() => this.save());
        }
        // schema-3 migration (2026-08-16): schema-2 ratified CA tuning ->
        // new ratified defaults. chains after the schema-2 block so a
        // schema-1 config upgraded above matches the pattern here too.
        if (rawSf && canMigrate && (rawSf.streamFrameSchema ?? 1) < 3) {
          const caS2 = rawSf.kalmanCaJerk === 17 && (rawSf.kalmanCaAngJerk ?? 1500) === 1500
            && rawSf.kalmanCaPosNoiseMm === 5.7 && rawSf.kalmanCaOriNoiseDeg === 5.75
            && (rawSf.kalmanCaAccelTauMs ?? 150) === 150 && !(rawSf.kalmanCaExactCov ?? false);
          if (rawSf.velocityFixMode === 'kalmanCA' && caS2) {
            rawSf.kalmanCaJerk = 4;
            rawSf.kalmanCaPosNoiseMm = 1.5;
            rawSf.kalmanCaOriNoiseDeg = 1.5;
            rawSf.kalmanCaAccelTauMs = 20;
            rawSf.kalmanCaExactCov = true;
          }
          rawSf.streamFrameSchema = 3;
          queueMicrotask(() => this.save());
        }
        // schema-4 migration (2026-08-25, 1.0.0): UNCONDITIONAL. the angular
        // velocity frame fix (kalmanAngularOutFrame) invalidated every
        // Direction Lead tuning - under the corrected frame any non-zero Td
        // bends throws off target - and retired Freeze Coast Turn. unlike
        // schema 2/3 this does not check for old defaults: custom values are
        // reset too, on purpose. mirrors the driver-side migration.
        if (rawSf && canMigrate && (rawSf.streamFrameSchema ?? 1) < 4) {
          rawSf.kalmanDirLeadMs = 0;
          rawSf.kalmanFreezeCoastTurn = 0;
          // controller offsets from the previous release were measured
          // against the old grip origin, which moved in 1.0.0 (grip
          // convention + official pose components). they no longer mean
          // anything in the new frame, so they go back to the shipped
          // defaults. per-hand trims did not exist before and are left.
          const dc = defaultControllers();
          const rc = this.rootSetting.controllers;
          if (rc) {
            rc.rotationOffsetDeg = dc.rotationOffsetDeg;
            rc.positionOffsetCm = dc.positionOffsetCm;
            rc.mirrorOffsetsForRightHand = dc.mirrorOffsetsForRightHand;
          }
          rawSf.streamFrameSchema = 4;
          queueMicrotask(() => this.save());
        }
        // NVENC settings v3 (2026-09-05): one measured configuration replaces
        // the per-experiment values. mirrors ConfigLoader's migration: the
        // v3 encoder defaults go over any pre-v3 file, spatial AQ is forced
        // off (it serializes NVENC submission), floors/VUI cleared. Explicit
        // toggle choices are preserved by the 2026-09-25 correction below.
        if (rawSf && canMigrate && (rawSf.nvencSettingsVersion ?? 0) < 3) {
          const d = defaultStreamFrame();
          // 2026-09-25: preserve explicit toggle choices; absent keys still
          // receive normal defaults. Mirror the native legacy-import fix.
          for (const k of ['nvencVbvFrames', 'nvencLowDelayKfScale',
            'nvencMaxBitrateHeadroomPct', 'nvencForceFps', 'nvencSplitMode',
            'nvencPreset', 'nvencAqStrength', 'nvencMinQp', 'nvencMinQpIntra', 'nvencMaxQp', 'nvencVuiFullRange',
            'nvencVuiMatrix', 'nvencVuiPrimaries', 'nvencVuiTransfer', 'nvencBitrateMbit', 'nvencBandwidthOverrideMbit']) {
            (rawSf as any)[k] = (d as any)[k];
          }
          rawSf.nvencSettingsVersion = 3;
          const g = this.rootSetting.galaxyXr as any;
          if (g) {
            if (g.customStreamFormatWidth === undefined || g.customStreamFormatWidth > 2048 || g.customStreamFormatWidth < 512) { g.customStreamFormatWidth = 1536; }
            g.force10bit = false;
          }
          queueMicrotask(() => this.save());
        }
        // v4 (2026-09-05): post-pack CAS replaces the pre-encode CAS when the
        // NVENC tap is on. an enabled pre-encode CAS carries its strength to
        // the fovea and switches off.
        if (rawSf && canMigrate && (rawSf.nvencSettingsVersion ?? 0) < 4) {
          // Inspect the stored object: the service has already filled defaults
          // into rawSf, which otherwise makes absent mode flags look explicit.
          const storedSf = (this.dss.storedValues?.() as Settings | undefined)?.streamFrame ?? rawSf;
          const postPackChosen = typeof storedSf.postPack?.enable === 'boolean'
            || typeof storedSf.postPack?.casEnable === 'boolean';
          const casOff = storedSf.cas?.enable === false;
          if (!rawSf.postPack) { rawSf.postPack = { enable: false, casEnable: true, foveaStrength: 0.6, peripheryStrength: 0.3, foveaTop: true, edgeFalloff: 0.12, limitedRange: false }; }
          if ((rawSf.nvencTap ?? true) && !postPackChosen && casOff) {
            rawSf.postPack.casEnable = false;
            rawSf.postPack.enable = rawSf.postPack.limitedRange;
          } else if (!postPackChosen && rawSf.cas && rawSf.cas.enable && (rawSf.nvencTap ?? true)) {
            rawSf.postPack.enable = true; rawSf.postPack.casEnable = true;
            rawSf.postPack.foveaStrength = Math.max(0.6, Math.min(1, rawSf.cas.strength ?? 0.6));
            rawSf.cas.enable = false;
          } else if (!postPackChosen && (rawSf.nvencTap ?? true)) {
            rawSf.postPack.enable = true; rawSf.postPack.casEnable = true;
          }
          rawSf.nvencSettingsVersion = 4;
          queueMicrotask(() => this.save());
        }
        // kalmanAngularOutFrame is an int in the driver (0 world / 1 body /
        // 2 zero) and a string enum here; older driver builds published the
        // int, and a reset against that wrote the int back into settings.
        // normalise both so the select renders and the reset arrow agrees.
        const frameNames: { [k: number]: string } = { 0: 'world', 1: 'body', 2: 'zero' };
        if (typeof this.defaults.kalmanAngularOutFrame === 'number') {
          this.defaults.kalmanAngularOutFrame = frameNames[this.defaults.kalmanAngularOutFrame as any] ?? 'body';
        }
        if (rawSf && canMigrate && typeof rawSf.kalmanAngularOutFrame === 'number') {
          rawSf.kalmanAngularOutFrame = frameNames[rawSf.kalmanAngularOutFrame] ?? 'body';
          queueMicrotask(() => this.save());
        }
        this.rootSetting.streamFrame = fillDefaults(this.rootSetting.streamFrame, defaultStreamFrame());
        this.rootSetting.controllers = fillDefaults(this.rootSetting.controllers, defaultControllers());
        this.controllerSettings = this.rootSetting.controllers;
        if (this.controllerSettings && this.controllerSettings.mirrorOffsetsForRightHand === undefined) {
          this.controllerSettings.mirrorOffsetsForRightHand = false;
        }
        if (this.controllerSettings) {
          for (const hand of ['left', 'right'] as const) {
            if (!this.controllerSettings[hand]) {
              this.controllerSettings[hand] = zeroHandOffsets();
            }
          }
        }
        this.settings = this.rootSetting.streamFrame;
        this.matrixText.set((this.settings?.srgbMatrix ?? []).join(', '));
        const bands = this.settings?.distortion?.tune?.bands;
        if (bands && bands.length > 0) {
          this.tuneBandCount = bands.length;
          this.tuneBandFirst = bands[0];
          this.tuneBandLast = bands[bands.length - 1];
        }
        const segLayout = this.settings?.distortion?.tune?.segmentLayout;
        this.segLayoutText = Array.isArray(segLayout) ? segLayout.join(', ') : '';
      } else {
        // A failed disk read is unknown, never the last page's stale On state.
        this.settings = undefined;
        this.controllerSettings = undefined;
      }
      const infoDefaults = (this.dis.values()?.defaultSettings as any)?.streamFrame;
      this.defaults = streamFrameDefaults(infoDefaults);
      this.revision.update(x => x + 1);
    });
  }

  handOffsetsDirty(hand: 'left' | 'right'): boolean {
    const h = this.controllerSettings?.[hand];
    if (!h) return false;
    return ['x', 'y', 'z'].some(a => (h.rotationOffsetDeg as any)[a] !== 0 || (h.positionOffsetCm as any)[a] !== 0);
  }

  resetHandOffsets(hand: 'left' | 'right') {
    if (this.controllerSettings) {
      this.controllerSettings[hand] = zeroHandOffsets();
      this.save();
    }
  }

  resetControllers(group: keyof ControllersConfig) {
    if (this.controllerSettings) {
      this.controllerSettings[group] = JSON.parse(JSON.stringify(this.controllerDefaults[group]));
      this.save();
    }
  }

  // regenerate the tuner band array evenly spaced from the three layout inputs
  updateSegLayout() {
    if (!this.settings) return;
    const parts = this.segLayoutText.split(/[\s,;]+/).filter(x => x.length > 0);
    const layout: number[] = [];
    for (const part of parts) {
      let v = Math.round(Number(part));
      if (!(v >= 1)) v = 1;
      if (v > 32) v = 32;
      layout.push(v);
    }
    this.settings.distortion.tune.segmentLayout = layout;
    this.save();
  }

  updateBands() {
    if (!this.settings) return;
    let count = Math.round(this.tuneBandCount);
    if (!(count >= 2)) count = 2;
    if (count > 12) count = 12;
    let first = this.tuneBandFirst;
    let last = this.tuneBandLast;
    if (!(first > 0.02)) first = 0.02;
    if (!(last > first)) last = first + 0.05;
    if (last > 1.2) last = 1.2;
    const bands: number[] = [];
    for (let i = 0; i < count; i++) {
      bands.push(Math.round((first + (last - first) * i / (count - 1)) * 1000) / 1000);
    }
    this.tuneBandCount = count;
    this.tuneBandFirst = first;
    this.tuneBandLast = last;
    this.settings.distortion.tune.bands = bands;
    this.save();
  }

  // Galaxy XR native identity (vendor builds only; page hides it otherwise)
  vendor = vendor;
  get galaxyXr(): GalaxyXrConfig {
    if (this.rootSetting) {
      if (!this.rootSetting.galaxyXr) {
        this.rootSetting.galaxyXr = { nativeIdentity: true, nativeInputProfile: false, nativeResolution: true, streamQuality: 'balanced', renderModelScale: 1.15 };
      }
      if (this.rootSetting.galaxyXr.nativeResolution === undefined) {
        this.rootSetting.galaxyXr.nativeResolution = true;
      }
      if (this.rootSetting.galaxyXr.streamQuality === undefined) {
        this.rootSetting.galaxyXr.streamQuality = 'balanced';
      }
      if (this.rootSetting.galaxyXr.synthesizeGripTouch === undefined) {
        this.rootSetting.galaxyXr.synthesizeGripTouch = true;
      }
      if (this.rootSetting.galaxyXr.gripTouchThreshold === undefined) {
        this.rootSetting.galaxyXr.gripTouchThreshold = 0.03;
      }
      // v3 tier names: legacy v1/v2 names map onto the closest tier
      {
        const q = this.rootSetting.galaxyXr.streamQuality;
        const legacy: Record<string, string> = { stable: 'efficient', quality: 'balanced', default: 'balanced', high: 'sharp', highest: 'sharp', ultra: 'max' };
        if (legacy[q]) { this.rootSetting.galaxyXr.streamQuality = legacy[q]; }
      }
      if (this.rootSetting.galaxyXr.renderModelScale === undefined) {
        this.rootSetting.galaxyXr.renderModelScale = 1.15;
      }
      if (this.rootSetting.galaxyXr.skeletonOffsetXCm === undefined) {
        this.rootSetting.galaxyXr.skeletonOffsetXCm = 0.0;
      }
      if (this.rootSetting.galaxyXr.skeletonOffsetYCm === undefined) {
        this.rootSetting.galaxyXr.skeletonOffsetYCm = 0.0;
      }
      if (this.rootSetting.galaxyXr.skeletonOffsetZCm === undefined) {
        this.rootSetting.galaxyXr.skeletonOffsetZCm = 0.0;
      }
      if (this.rootSetting.galaxyXr.handAnchorXCm === undefined) {
        this.rootSetting.galaxyXr.handAnchorXCm = 0.0;
      }
      if (this.rootSetting.galaxyXr.handAnchorYCm === undefined) {
        this.rootSetting.galaxyXr.handAnchorYCm = 0.0;
      }
      if (this.rootSetting.galaxyXr.handAnchorZCm === undefined) {
        this.rootSetting.galaxyXr.handAnchorZCm = 0.0;
      }
      if (this.rootSetting.galaxyXr.handAnchorPitchDeg === undefined) {
        this.rootSetting.galaxyXr.handAnchorPitchDeg = 0.0;
      }
      if (this.rootSetting.galaxyXr.handAnchorYawDeg === undefined) {
        this.rootSetting.galaxyXr.handAnchorYawDeg = 0.0;
      }
      if (this.rootSetting.galaxyXr.handAnchorRollDeg === undefined) {
        this.rootSetting.galaxyXr.handAnchorRollDeg = 0.0;
      }
      if (this.rootSetting.galaxyXr.meshOffsetXCm === undefined) {
        this.rootSetting.galaxyXr.meshOffsetXCm = 0.0;
      }
      if (this.rootSetting.galaxyXr.meshOffsetYCm === undefined) {
        this.rootSetting.galaxyXr.meshOffsetYCm = 0.0;
      }
      if (this.rootSetting.galaxyXr.meshOffsetZCm === undefined) {
        this.rootSetting.galaxyXr.meshOffsetZCm = 0.0;
      }
      if (this.rootSetting.galaxyXr.officialComponents === undefined) {
        this.rootSetting.galaxyXr.officialComponents = true;
      }
      if (this.rootSetting.galaxyXr.gripConvention === undefined) {
        this.rootSetting.galaxyXr.gripConvention = true;
      }
      if (this.rootSetting.galaxyXr.controllerBypass === undefined) {
        this.rootSetting.galaxyXr.controllerBypass = false;
      }
      if (this.rootSetting.galaxyXr.customEncodeWidth === undefined) {
        this.rootSetting.galaxyXr.customEncodeWidth = 3072;
      }
      // streamFormatWidth now tracks customEncodeWidth (2026-08-26); the old
      // separate field is kept in the file only so the driver can clean the
      // legacy value out of steamvr.vrsettings
      if (this.rootSetting.galaxyXr.customStreamFormatWidth === undefined) {
        this.rootSetting.galaxyXr.customStreamFormatWidth = 1536; // v3: the tile, not the (inert) encode width
      }
      // v1 tier names migrate to the v2 tuples (driver accepts both;
      // migrating keeps the dropdown selection visible)
      const tierMigration: Record<string, string> = { stable: 'efficient', quality: 'balanced', high: 'sharp', highest: 'sharp', ultra: 'max' };
      if (this.rootSetting.galaxyXr.streamQuality && tierMigration[this.rootSetting.galaxyXr.streamQuality]) {
        this.rootSetting.galaxyXr.streamQuality = tierMigration[this.rootSetting.galaxyXr.streamQuality];
      }
      if (this.rootSetting.galaxyXr.customBandwidthMbit === undefined) {
        this.rootSetting.galaxyXr.customBandwidthMbit = 350;
      }
      if (this.rootSetting.galaxyXr.customStreamFormatWidthOverride === undefined) {
        this.rootSetting.galaxyXr.customStreamFormatWidthOverride = 0;
      }
      if (this.rootSetting.galaxyXr.nativeIdentity === undefined) {
        this.rootSetting.galaxyXr.nativeIdentity = true;
      }
      if (this.rootSetting.galaxyXr.vrlinkHeadsetProfile === undefined) {
        this.rootSetting.galaxyXr.vrlinkHeadsetProfile = true;
      }
      if (this.rootSetting.galaxyXr.profileMaxStreamFormatWidth === undefined) {
        this.rootSetting.galaxyXr.profileMaxStreamFormatWidth = 3200;
      }
      if (this.rootSetting.galaxyXr.profileSupports10bit === undefined) {
        this.rootSetting.galaxyXr.profileSupports10bit = true;
      }
      if (this.rootSetting.galaxyXr.force10bit === undefined) {
        this.rootSetting.galaxyXr.force10bit = false;
      }
      if (this.rootSetting.galaxyXr.vrlinkDebugOverlay === undefined) {
        this.rootSetting.galaxyXr.vrlinkDebugOverlay = false;
      }
      if (this.rootSetting.galaxyXr.vrlinkMaxVideoQueueLatencyUs === undefined) {
        this.rootSetting.galaxyXr.vrlinkMaxVideoQueueLatencyUs = 0;
      }
      if (this.rootSetting.galaxyXr.vrlinkBackoffRecoveryCoefficient === undefined) {
        this.rootSetting.galaxyXr.vrlinkBackoffRecoveryCoefficient = 0;
      }
      if (this.rootSetting.galaxyXr.simulateTouch === undefined) {
        this.rootSetting.galaxyXr.simulateTouch = false;
      }
      if (this.rootSetting.galaxyXr.aimTrimXCm === undefined) {
        this.rootSetting.galaxyXr.aimTrimXCm = 0.0;
      }
      if (this.rootSetting.galaxyXr.aimTrimYCm === undefined) {
        this.rootSetting.galaxyXr.aimTrimYCm = -1.0;
      }
      if (this.rootSetting.galaxyXr.aimTrimZCm === undefined) {
        this.rootSetting.galaxyXr.aimTrimZCm = 1.0;
      }
      if (this.rootSetting.galaxyXr.componentRebaseIncludeTrim === undefined) {
        this.rootSetting.galaxyXr.componentRebaseIncludeTrim = true;
      }
      if (this.rootSetting.galaxyXr.sdr10Baseline === undefined) {
        this.rootSetting.galaxyXr.sdr10Baseline = false;
      }
      return this.rootSetting.galaxyXr;
    }
    return { nativeIdentity: true };
  }

  // 2026-09-19 SDR10 baseline (see SdrColorPolicy.h): the baseline yields to
  // a per-device custom shader enabled for "other" headsets (Galaxy XR lands
  // in that bucket), which owns the compositor color path. mirrors
  // gxr::ResolveSdr10Policy so GUI status and driver behavior agree
  sdr10BaselineConflict(): boolean {
    return !!(this.rootSetting?.customShader?.enable && this.rootSetting?.customShader?.enableForOther);
  }
  sdr10BaselineActive(): boolean {
    return !!this.rootSetting?.galaxyXr?.sdr10Baseline && !this.sdr10BaselineConflict();
  }

  save() {
    if (this.dss.inspecting) return;
    if (this.rootSetting) {
      this.dss.save(this.rootSetting);
    }
    this.revision.update(x => x + 1);
  }

  alignmentDirty(): boolean {
    if (!this.settings) return false;
    const a = this.settings.alignment, d = this.defaults.alignment;
    return a.leftH != d.leftH || a.leftV != d.leftV || a.rightH != d.rightH || a.rightV != d.rightV;
  }

  velocityFixTip = "Choose a controller-motion correction mode. Start with the normal filter; the other options are intended for comparisons and specific compatibility problems.\n\nOff: pass the native runtime velocities through untouched. Kalman: a single estimator produces position, rotation, velocity and spin as one coherent state, the same architecture native tracked controllers use. Kalman CA (recommended): A constant-acceleration variant that tracks the throw ramp itself instead of rescaling it away. Replaces the whole estimator.";
  velocityFixTipFull = "Choose a controller-motion correction mode, including older experiments. Some legacy modes are kept only for compatibility and are not recommended for normal play.\n\nOff: pass the native runtime velocities through untouched. Kalman: a single estimator produces position, rotation, velocity and spin as one coherent state, the same architecture native tracked controllers use. Kalman CA (recommended): A constant-acceleration variant that tracks the throw ramp itself instead of rescaling it away. Replaces the whole estimator. Graveyard modes - Classic/Full: first-generation fixes, superseded. Derive: the legacy pose-derivation pipeline; retired after field testing, kept intact for reproducibility. Kalman CA Magnitude: transitional CA variant that swapped only the throw-strength channel; superseded by CA Full (retired 2026-08-15).";

  resetGraveyard() {
    if (!this.settings) return;
    const archived: (keyof StreamFrameConfig)[] = ['deriveDirSource', 'deriveDirWeightPow', 'deriveDirWindowMs', 'deriveLatchAngMinSpeed', 'deriveLatchHoldMs', 'deriveLatchMinSpeed', 'deriveLatchWindowMs', 'deriveMagSource', 'derivePreFilter', 'derivePreSmoothMs', 'derivePreSmoothScope', 'deriveReleaseLatch', 'deriveSmoothAngSeparate', 'deriveSmoothAngSpeedHigh', 'deriveSmoothAngSpeedLow', 'deriveSmoothAngTauFastMs', 'deriveSmoothAngTauSlowMs', 'deriveSmoothSpeedHigh', 'deriveSmoothSpeedLow', 'deriveSmoothTauFastMs', 'deriveSmoothTauSlowMs', 'deriveSplitDirAngular', 'deriveSplitDirLinear', 'kalmanAngDirSmoothMs', 'kalmanDirSmoothMs', 'kalmanDupCoastMaxMs', 'kalmanGazeAssist', 'kalmanGazeMaxDeg', 'kalmanGazeMinSpeed', 'kalmanReleaseRewindMs', 'kalmanRewindHoldMs', 'kalmanSmoothLagMs', 'zeroCopyV3'];
    for (const k of archived) { (this.settings as any)[k] = JSON.parse(JSON.stringify((this.defaults as any)[k])); }
    // FOV tangents live inside eyeGaze; reset only those subkeys so
    // gaze prediction is untouched
    this.settings.eyeGaze.tanHalfFovX = this.defaults.eyeGaze.tanHalfFovX;
    this.settings.eyeGaze.tanHalfFovY = this.defaults.eyeGaze.tanHalfFovY;
    this.save();
  }

  // CAS mode: one control over the two sharpening paths. post-pack = the
  // encoder-side pass (needs the NVENC tap); pre-encode = the legacy
  // full-resolution pass. never both.
  get casMode(): 'off' | 'postpack' | 'preencode' {
    const s = this.settings;
    if (!s) return 'off';
    if (s.postPack && s.postPack.enable && s.postPack.casEnable) return 'postpack';
    if (s.cas && s.cas.enable) return 'preencode';
    return 'off';
  }
  set casMode(m: 'off' | 'postpack' | 'preencode') {
    const s = this.settings;
    if (!s) return;
    if (!s.postPack) { s.postPack = { enable: false, casEnable: true, foveaStrength: 0.6, peripheryStrength: 0.3, foveaTop: true, edgeFalloff: 0.12, limitedRange: false }; }
    if (m === 'postpack') { s.postPack.enable = true; s.postPack.casEnable = true; s.cas.enable = false; }
    else if (m === 'preencode') { s.postPack.casEnable = false; s.postPack.enable = s.postPack.limitedRange; s.cas.enable = true; }
    else { s.postPack.casEnable = false; s.postPack.enable = s.postPack.limitedRange; s.cas.enable = false; }
  }

  reset(key: keyof StreamFrameConfig) {
    if (!this.settings) return;
    (this.settings as any)[key] = JSON.parse(JSON.stringify((this.defaults as any)[key]));
    if (key === 'srgbMatrix') {
      this.matrixText.set(this.settings.srgbMatrix.join(', '));
      this.matrixError.set('');
    }
    this.save();
  }

  // ---- distortion profile sharing ----
  shareText = signal('');
  shareStatus = signal('');
  // any calibration overlay/mode that would be visible or disruptive in a
  // normal play session — drives the warning banner at the top of the page
  // the CA experiment modes share the mode-4 machinery (dup handling,
  // device time), so those rows show for any kalman-family mode
  retiredVelocityModes: string[] = ['classic', 'full', 'derive', 'kalmanCAM'];
  retiredVelocityModeLabels: { [k: string]: string } = {
    classic: 'Classic (legacy)',
    full: 'Full (legacy)',
    derive: 'Derive (legacy, retired)',
    kalmanCAM: 'Kalman CA \u2014 Magnitude (retired)',
  };
  // a stored graveyarded mode still renders (as the sole extra option)
  // when the graveyard is hidden, so old configs never break
  isRetiredVelocityMode(m: string | undefined): boolean {
    return !!m && this.retiredVelocityModes.includes(m);
  }

  isKalmanMode(): boolean {
    const m = this.settings?.velocityFixMode;
    return m == 'kalman' || m == 'kalmanCAM' || m == 'kalmanCA';
  }
  calibrationActive(): boolean {
    const s = this.settings;
    const c = this.controllerSettings;
    if (!s) return false;
    return !!(s.distortion?.tune?.enable || s.distortion?.centerTune?.enable
      || c?.aligner?.enable || s.eyeGaze?.probeCapture || s.eyeGaze?.debugGrid
      || s.eyeGaze?.calibDot || s.eyeGaze?.debugRing || s.eyeGaze?.overlayWarped
      || s.eyeGaze?.swimProbe || s.calib?.blackout);
  }

  stopCalibration() {
    const s = this.settings;
    if (!s) return;
    s.distortion.tune.enable = false;
    s.distortion.centerTune.enable = false;
    if (this.controllerSettings) this.controllerSettings.aligner.enable = false;
    for (const key of ['probeCapture', 'debugGrid', 'calibDot', 'debugRing', 'overlayWarped', 'swimProbe'] as const) {
      s.eyeGaze[key] = false;
    }
    if (s.calib) s.calib.blackout = false;
    this.save();
  }
  // calib is normally written by the camera tools; the GUI only exposes
  // blackout, so create the object lazily with the driver's defaults
  setBlackout(on: boolean) {
    if (!this.settings) return;
    if (!this.settings.calib) {
      this.settings.calib = { blackout: false, eye: -1, patternBrightness: 1, captureMode: false, pattern: -1, patternBits: 10 };
    }
    this.settings.calib.blackout = on;
    this.save();
  }
  private buildProfile(): any {
    const s = this.settings!;
    const profile: any = {
      type: 'streamFrameDistortionProfile',
      version: 1,
      name: 'My Galaxy XR profile',
      distortion: JSON.parse(JSON.stringify(s.distortion)),
      k1: s.k1,
      k2: s.k2,
      centerOffsetXLeft: s.centerOffsetXLeft,
      centerOffsetXRight: s.centerOffsetXRight,
      centerOffsetY: s.centerOffsetY
    };
    // the annulus and tuners are tuning diagnostics, not part of a shareable profile
    delete profile.distortion.annulus;
    delete profile.distortion.tune;
    delete profile.distortion.centerTune;
    return profile;
  }
  exportJsonFile() {
    if (!this.settings) return;
    const text = JSON.stringify(this.buildProfile(), null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    anchor.download = 'gxr-distortion-profile-' + stamp + '.json';
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    this.shareStatus.set('Profile downloaded as ' + anchor.download);
  }
  importJsonFile(file: File) {
    if (!file) return;
    file.text().then(text => {
      this.shareText.set(text);
      this.importProfile();
    });
  }
  exportProfile() {
    if (!this.settings) return;
    const s = this.settings;
    const profile = {
      type: 'streamFrameDistortionProfile',
      version: 1,
      name: 'My Galaxy XR profile',
      distortion: JSON.parse(JSON.stringify(s.distortion)),
      k1: s.k1,
      k2: s.k2,
      centerOffsetXLeft: s.centerOffsetXLeft,
      centerOffsetXRight: s.centerOffsetXRight,
      centerOffsetY: s.centerOffsetY
    };
    // the annulus and tuner are tuning diagnostics, not part of a shareable profile
    delete profile.distortion.annulus;
    delete profile.distortion.tune;
    delete profile.distortion.centerTune;
    const text = JSON.stringify(profile, null, 2);
    this.shareText.set(text);
    this.shareStatus.set('Profile exported below. Copy it anywhere.');
    navigator.clipboard?.writeText(text).then(
      () => this.shareStatus.set('Profile copied to clipboard.'),
      () => {}
    );
  }
  importProfile() {
    if (!this.settings) return;
    let parsed: any;
    try {
      parsed = JSON.parse(this.shareText());
    } catch (e: any) {
      this.shareStatus.set('Not valid JSON: ' + e.message);
      return;
    }
    // controller-aligner save files ({"controllers": {...}}) import here too,
    // applying straight into the offset fields below
    const controllers = parsed?.controllers;
    if (controllers && (controllers.rotationOffsetDeg || controllers.positionOffsetCm) && this.controllerSettings) {
      const applyAxes = (target: { x: number, y: number, z: number }, source: any) => {
        for (const axis of ['x', 'y', 'z'] as const) {
          if (Number.isFinite(source?.[axis])) target[axis] = source[axis];
        }
      };
      applyAxes(this.controllerSettings.rotationOffsetDeg, controllers.rotationOffsetDeg);
      applyAxes(this.controllerSettings.positionOffsetCm, controllers.positionOffsetCm);
      this.save();
      this.shareStatus.set('Controller offsets imported and applied.');
      return;
    }
    if (parsed?.type !== 'streamFrameDistortionProfile' || typeof parsed.distortion !== 'object') {
      this.shareStatus.set('Not a stream frame distortion profile.');
      return;
    }
    const num = (v: any, fallback: number) => (Number.isFinite(v) ? v : fallback);
    const s = this.settings;
    // center-tuner saves apply ONLY the center offsets: importing a stale
    // centers file must never roll the curves back to its embedded snapshot
    if (parsed.centersOnly) {
      s.centerOffsetXLeft = num(parsed.centerOffsetXLeft, s.centerOffsetXLeft);
      s.centerOffsetXRight = num(parsed.centerOffsetXRight, s.centerOffsetXRight);
      s.centerOffsetY = num(parsed.centerOffsetY, s.centerOffsetY);
      this.save();
      this.revision.update(v => v + 1);
      this.shareStatus.set('Center offsets imported and applied (curves untouched).');
      return;
    }
    const d = parsed.distortion;
    s.distortion.mode = d.mode === 'spline' ? 'spline' : 'k1k2';
    s.distortion.perEye = !!d.perEye;
    s.distortion.perAxis = !!d.perAxis;
    s.distortion.segments = (Number.isInteger(d.segments) && d.segments >= 2 && d.segments <= 32) ? d.segments : 1;
    if (Array.isArray(parsed.tuneSegmentLayout)) {
      s.distortion.tune.segmentLayout = parsed.tuneSegmentLayout
        .map((v: any) => Math.round(Number(v)))
        .filter((v: number) => v >= 1 && v <= 32);
    }
    const parsePoints = (arr: any) => Array.isArray(arr)
      ? arr.filter((p: any) => Number.isFinite(p?.r) && Number.isFinite(p?.scale)).map((p: any) => ({ r: p.r, scale: p.scale }))
      : [];
    s.distortion.points = parsePoints(d.points);
    s.distortion.curves = {};
    if (d.curves && typeof d.curves === 'object') {
      for (const key of Object.keys(d.curves)) {
        const c = d.curves[key];
        s.distortion.curves[key] = { k1: num(c?.k1, 0), k2: num(c?.k2, 0), points: parsePoints(c?.points) };
      }
    }
    // dense displacement map (version 2 profiles, camera calibrated).
    // absent = the profile is radial only, so any previous map is dropped
    // (a profile is a complete correction, not a patch)
    const m = d.map;
    const eyeArray = (arr: any, len: number) => Array.isArray(arr) && arr.length === len && arr.every((v: any) => Number.isFinite(v))
      ? arr.map((v: any) => Number(v)) : [];
    if (m && Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols >= 2 && m.rows >= 2) {
      const len = m.cols * m.rows * 2;
      s.distortion.map = {
        enable: m.enable !== false,
        cols: m.cols,
        rows: m.rows,
        left: eyeArray(m.left, len),
        right: eyeArray(m.right, len),
        source: typeof m.source === 'string' ? m.source : '',
      };
    } else {
      delete s.distortion.map;
    }
    s.k1 = num(parsed.k1, 0);
    s.k2 = num(parsed.k2, 0);
    s.centerOffsetXLeft = num(parsed.centerOffsetXLeft, 0);
    s.centerOffsetXRight = num(parsed.centerOffsetXRight, 0);
    s.centerOffsetY = num(parsed.centerOffsetY, 0);
    this.save();
    this.shareStatus.set('Profile applied' + (parsed.name ? ': ' + parsed.name : '.'));
  }

  onMatrixTextChanged(text: string) {
    this.matrixText.set(text);
    if (!this.settings) return;
    const trimmed = text.trim();
    if (trimmed === '') {
      this.settings.srgbMatrix = [];
      this.matrixError.set('');
      this.save();
      return;
    }
    const values = trimmed.split(/[\s,;]+/).map(Number);
    if (values.length === 9 && values.every(x => Number.isFinite(x))) {
      this.settings.srgbMatrix = values;
      this.matrixError.set('');
      this.save();
    } else {
      this.matrixError.set('Needs exactly 9 numbers (row major 3x3), or empty to disable');
    }
  }
}
