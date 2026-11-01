import { describe, expect, it } from 'vitest';
import { ROUTES, compatibleSettingRoute, driverAvailable, parseRoute, parseSectionTarget, parseSettingTarget, sectionHref, settingHref, permittedRoute, visibleRoutes, type InstallationState } from './navigation';

describe('stable tab order and the always-visible Setup page', () => {
  it('round-trips a stable setting target and still enforces installation routes', () => {
    const hash = settingHref('stream-frame', 'streamFrame.nvencForceCbr');
    expect(parseRoute(hash, true)).toBe('stream-frame');
    expect(parseSettingTarget(hash)).toBe('streamFrame.nvencForceCbr');
    expect(permittedRoute(parseRoute(hash, false), false)).toBe('setup');
    expect(parseSettingTarget('#/stream-frame')).toBeUndefined();
    expect(parseSettingTarget('#/stream-frame?setting=%22%3E')).toBeUndefined();
  });

  it('round-trips a stable section target for the Contents card', () => {
    const hash = sectionHref('stream-frame', 'optical-flow');
    expect(hash).toBe('#/stream-frame?section=optical-flow');
    expect(parseRoute(hash, true)).toBe('stream-frame');
    expect(parseSectionTarget(hash)).toBe('optical-flow');
    expect(parseSettingTarget(hash)).toBeUndefined();
    expect(parseSectionTarget('#/stream-frame')).toBeUndefined();
    expect(parseSectionTarget('#/stream-frame?section=%22%3E')).toBeUndefined();
    expect(parseSectionTarget('#/driver-settings?section=controller-fix')).toBe('controller-fix');
  });
  it('keeps the canonical tab order', () => {
    expect([...ROUTES]).toEqual(['driver-settings', 'stream-frame', 'debug', 'distortion-profile', 'app-settings', 'setup', 'about']);
  });

  it.each([
    [true, true], [true, false], [false, true], [false, false],
  ] as const)('gates Debug for installed=%s and Debug Mode=%s', (available, debugMode) => {
    const routes = visibleRoutes(available, debugMode);
    expect(routes).toEqual(available
      ? debugMode
        ? ['driver-settings', 'stream-frame', 'debug', 'distortion-profile', 'app-settings', 'setup', 'about']
        : ['driver-settings', 'stream-frame', 'distortion-profile', 'app-settings', 'setup', 'about']
      : ['app-settings', 'setup', 'about']);
    expect(parseRoute('#/debug', available)).toBe('debug');
    expect(permittedRoute('debug', available, debugMode)).toBe(available
      ? debugMode ? 'debug' : 'app-settings'
      : 'setup');
    for (const route of ROUTES) {
      expect(permittedRoute(route, available, debugMode) === route).toBe(routes.includes(route));
    }
  });

  it('hides Debug by default and gates its setting links through application preferences', () => {
    expect(visibleRoutes(true)).not.toContain('debug');
    const hash = settingHref('debug', 'streamFrame.hitchDiag');
    expect(parseSettingTarget(hash)).toBe('streamFrame.hitchDiag');
    expect(permittedRoute(parseRoute(hash, true), true)).toBe('app-settings');
  });

  it.each([
    ['checking', undefined, false],
    ['not-installed', undefined, false],
    ['unknown', '1.2.3', false],
    ['installed', undefined, false],
    ['installed', '1.2.3', true],
    ['checking', '1.2.3', true],
  ] as Array<[InstallationState, string | undefined, boolean]>)('%s / %s keeps a stable order', (state, version, available) => {
    expect(driverAvailable(version, state)).toBe(available);
    const routes = visibleRoutes(available);
    expect(routes[0]).toBe(available ? 'driver-settings' : 'app-settings');
    expect(routes).toContain('setup');
    expect(routes).toEqual(available
      ? ['driver-settings', 'stream-frame', 'distortion-profile', 'app-settings', 'setup', 'about']
      : ['app-settings', 'setup', 'about']);
    expect(routes.filter(route => ['app-settings', 'setup', 'about'].includes(route)))
      .toEqual(['app-settings', 'setup', 'about']);
  });

  it.each(['', '#/', '#/missing'] as const)('lands on Setup uninstalled and Driver Settings installed for %s', hash => {
    expect(parseRoute(hash, false)).toBe('setup');
    expect(parseRoute(hash, true)).toBe('driver-settings');
  });

  it.each(['app-settings', 'setup', 'about'] as const)('allows %s before and after installation', route => {
    expect(parseRoute(`#/${route}`, false)).toBe(route);
    expect(parseRoute(`#/${route}`, true)).toBe(route);
    expect(permittedRoute(route, false)).toBe(route);
    expect(permittedRoute(route, true)).toBe(route);
  });

  it.each(['driver-settings', 'distortion-profile', 'stream-frame'] as const)('gates %s through Setup without changing valid deep links', route => {
    expect(parseRoute(`#/${route}`, false)).toBe(route);
    expect(parseRoute(`#/${route}`, true)).toBe(route);
    expect(permittedRoute(route, false)).toBe('setup');
    expect(permittedRoute(route, true)).toBe(route);
  });
});

describe('explicit compatibility aliases', () => {
  it.each([
    'galaxyXr.nativeResolution', 'galaxyXr.renderWidth', 'galaxyXr.renderHeight',
    'renderResolutionLinked', 'galaxyXr.sdr10Baseline',
  ])('moves only the old Driver Settings link for %s', id => {
    for (const route of ROUTES) {
      expect(compatibleSettingRoute(route, id)).toBe(route === 'driver-settings' ? 'stream-frame' : route);
    }
  });

  it.each([
    'streamFrame.kalmanCaReportAccel', 'controllers.aligner.enable', 'galaxyXr.simulateTouch',
    'streamFrame.deriveLatchPoseAssist', 'streamFrame.kalmanDirLeadAdaptive', 'streamFrame.kalmanAdaptiveR',
    'streamFrame.kalmanGripEnable', 'streamFrame.deriveSmoothAngSeparate', 'streamFrame.deriveSplitDirLinear',
    'streamFrame.deriveSplitDirAngular', 'streamFrame.deriveReleaseLatch',
  ])('moves only the old Image Settings controller link for %s', id => {
    for (const route of ROUTES) {
      expect(compatibleSettingRoute(route, id)).toBe(route === 'stream-frame' ? 'driver-settings' : route);
    }
  });

  it.each([
    'streamFrame.blackFloor.rampBar', 'streamFrame.hitchDiag', 'streamFrame.eyeGaze.debugRing',
    'streamFrame.poseLogging', 'streamFrame.poseLogBurst', 'galaxyXr.vrlinkDebugOverlay',
    'streamFrame.nvencFixLevel', 'streamFrame.nvencVerbose',
  ])('preserves only the old Image Settings diagnostic link for %s', id => {
    for (const route of ROUTES) {
      expect(compatibleSettingRoute(route, id)).toBe(route === 'stream-frame' ? 'debug' : route);
    }
  });

  it.each([
    '', 'unknown.setting', 'hybrid.enabled', 'debugMode', 'galaxyXr.profileSupports10bit',
    'galaxyXr.controllerBypass', 'streamFrame.eyeGaze.debugGrid', 'streamFrame.eyeGaze.probeCapture',
  ])('does not infer an alias for %s', id => {
    for (const route of ROUTES) expect(compatibleSettingRoute(route, id)).toBe(route);
  });

  it('requires installation and mode permission after canonicalization', () => {
    const diagnostic = compatibleSettingRoute('stream-frame', 'streamFrame.hitchDiag');
    expect(permittedRoute(diagnostic, true, false)).toBe('app-settings');
    expect(permittedRoute(diagnostic, false, true)).toBe('setup');
    expect(permittedRoute(diagnostic, true, true)).toBe('debug');
    const headset = compatibleSettingRoute('driver-settings', 'galaxyXr.nativeResolution');
    expect(permittedRoute(headset, false)).toBe('setup');
    expect(permittedRoute(headset, true)).toBe('stream-frame');
  });
});
