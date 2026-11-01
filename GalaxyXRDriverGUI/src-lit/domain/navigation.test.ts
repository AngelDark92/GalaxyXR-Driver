import { describe, expect, it } from 'vitest';
import { ROUTES, ROUTE_LABELS, compatibleSectionRoute, compatibleSettingRoute, defaultRoute, driverAvailable, parseRoute, parseSectionTarget, parseSettingTarget, sectionHref, settingHref, permittedRoute, visibleRoutes, type InstallationState } from './navigation';

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
    expect([...ROUTES]).toEqual(['driver-settings', 'stream-frame', 'hybrid-fovea', 'debug', 'distortion-profile', 'app-settings', 'setup', 'about']);
    expect(ROUTE_LABELS['hybrid-fovea']).toBe('Hybrid Fovea (Experimental)');
  });

  it.each([
    [true, true, true], [true, true, false], [true, false, true], [true, false, false],
    [false, true, true], [false, true, false], [false, false, true], [false, false, false],
  ] as const)('gates pages for installed=%s, Debug Mode=%s, Advanced Mode=%s', (available, debugMode, advancedMode) => {
    const routes = visibleRoutes(available, debugMode, advancedMode);
    expect(routes).toEqual(available ? [
      'driver-settings', 'stream-frame',
      ...(advancedMode ? ['hybrid-fovea'] : []), ...(debugMode ? ['debug'] : []),
      'distortion-profile', 'app-settings', 'setup', 'about',
    ] : ['app-settings', 'setup', 'about']);
    expect(parseRoute('#/debug', available)).toBe('debug');
    expect(parseRoute('#/hybrid-fovea', available)).toBe('hybrid-fovea');
    expect(permittedRoute('debug', available, debugMode, advancedMode)).toBe(available
      ? debugMode ? 'debug' : 'app-settings'
      : 'setup');
    expect(permittedRoute('hybrid-fovea', available, debugMode, advancedMode)).toBe(available
      ? advancedMode ? 'hybrid-fovea' : 'app-settings'
      : 'setup');
    for (const route of ROUTES) {
      expect(permittedRoute(route, available, debugMode, advancedMode) === route).toBe(routes.includes(route));
    }
    expect(defaultRoute(available)).toBe(available ? 'driver-settings' : 'setup');
  });

  it('hides Debug by default and gates its setting links through application preferences', () => {
    expect(visibleRoutes(true)).not.toContain('debug');
    const hash = settingHref('debug', 'streamFrame.hitchDiag');
    expect(parseSettingTarget(hash)).toBe('streamFrame.hitchDiag');
    expect(permittedRoute(parseRoute(hash, true), true)).toBe('app-settings');
  });

  it('denies Hybrid by default even when Debug Mode is enabled', () => {
    expect(visibleRoutes(true)).not.toContain('hybrid-fovea');
    expect(visibleRoutes(true, true)).not.toContain('hybrid-fovea');
    expect(permittedRoute('hybrid-fovea', true)).toBe('app-settings');
    expect(permittedRoute('hybrid-fovea', true, true)).toBe('app-settings');
    expect(permittedRoute('hybrid-fovea', false, true)).toBe('setup');
  });

  it('round-trips Hybrid setting and section links without changing target IDs', () => {
    const setting = settingHref('hybrid-fovea', 'hybrid.enabled');
    expect(setting).toBe('#/hybrid-fovea?setting=hybrid.enabled');
    expect(parseRoute(setting, true)).toBe('hybrid-fovea');
    expect(parseSettingTarget(setting)).toBe('hybrid.enabled');
    const section = sectionHref('hybrid-fovea', 'hybrid');
    expect(section).toBe('#/hybrid-fovea?section=hybrid');
    expect(parseRoute(section, true)).toBe('hybrid-fovea');
    expect(parseSectionTarget(section)).toBe('hybrid');
    expect(parseRoute('#///hybrid-fovea?section=hybrid', true)).toBe('hybrid-fovea');
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

  it.each(['driver-settings', 'stream-frame'] as const)('keeps the old %s Hybrid section ID', route => {
    const hash = sectionHref(route, 'hybrid');
    expect(parseSectionTarget(hash)).toBe('hybrid');
    expect(compatibleSectionRoute(parseRoute(hash, true), parseSectionTarget(hash)!)).toBe('hybrid-fovea');
  });

  it.each(['', 'unknown', 'headset', 'controllers', 'graveyard', 'hybrid-other'])('keeps unrelated section links for %s', id => {
    for (const route of ROUTES) expect(compatibleSectionRoute(route, id)).toBe(route);
  });

  it('does not accept the Hybrid section on unrelated routes', () => {
    for (const route of ROUTES.filter(route => route !== 'driver-settings' && route !== 'stream-frame')) {
      expect(compatibleSectionRoute(route, 'hybrid')).toBe(route);
    }
  });

  it('requires installation and mode permission after canonicalization', () => {
    const hybrid = compatibleSectionRoute('driver-settings', 'hybrid');
    expect(permittedRoute(hybrid, true, true, false)).toBe('app-settings');
    expect(permittedRoute(hybrid, false, true, true)).toBe('setup');
    expect(permittedRoute(hybrid, true, false, true)).toBe('hybrid-fovea');
    const diagnostic = compatibleSettingRoute('stream-frame', 'streamFrame.hitchDiag');
    expect(permittedRoute(diagnostic, true, false, true)).toBe('app-settings');
    expect(permittedRoute(diagnostic, false, true, true)).toBe('setup');
    expect(permittedRoute(diagnostic, true, true, false)).toBe('debug');
    const headset = compatibleSettingRoute('driver-settings', 'galaxyXr.nativeResolution');
    expect(permittedRoute(headset, false)).toBe('setup');
    expect(permittedRoute(headset, true)).toBe('stream-frame');
  });
});
