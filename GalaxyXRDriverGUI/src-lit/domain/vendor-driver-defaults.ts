import { driverDefaults } from './driver-defaults';
import type { Settings } from './types';

/** Return native defaults for this build without changing generated data. */
export function getDriverDefaultsForVendor(vendor: string): Settings {
  const defaults = structuredClone(driverDefaults);
  // 2026-09-25: the generator compiles with VENDOR_GALAXYXR. These are all
  // Config.h defaults conditional on that define; neutral builds use no
  // Galaxy identity or shared controller correction. Saved values overlay
  // this baseline later and remain authoritative.
  if (vendor !== 'galaxyxr') {
    if (defaults.galaxyXr) defaults.galaxyXr.nativeIdentity = false;
    if (defaults.controllers) {
      defaults.controllers.mirrorOffsetsForRightHand = false;
      defaults.controllers.rotationOffsetDeg = { x: 0, y: 0, z: 0 };
      defaults.controllers.positionOffsetCm = { x: 0, y: 0, z: 0 };
    }
  }
  return defaults;
}
