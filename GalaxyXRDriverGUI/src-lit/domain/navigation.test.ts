import { describe, expect, it } from 'vitest';
import { ROUTES, driverAvailable, parseRoute, parseSectionTarget, parseSettingTarget, sectionHref, settingHref, permittedRoute, visibleRoutes, type InstallationState } from './navigation';

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
