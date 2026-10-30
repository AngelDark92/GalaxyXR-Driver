// Canonical tab order (2026-10-01): Debug follows Image Settings when enabled.
// Installation/mode gates hide pages without reordering the remaining tabs.
export const ROUTES = ['driver-settings', 'stream-frame', 'debug', 'distortion-profile', 'app-settings', 'setup', 'about'] as const;
export type Route = (typeof ROUTES)[number];
export const ROUTE_LABELS: Record<Route, string> = {
  'driver-settings': 'Driver Settings', 'distortion-profile': 'Distortion Profile',
  'stream-frame': 'Image Settings', debug: 'Debug', 'app-settings': 'App Settings', setup: 'Setup', about: 'About',
};
export type InstallationState = 'checking' | 'installed' | 'not-installed' | 'unknown';
const ALWAYS_VISIBLE: readonly Route[] = ['app-settings', 'setup', 'about'];

/** Keep an already verified installation visible during a repeat check. */
export function driverAvailable(version: string | undefined, state: InstallationState): boolean {
  return !!version && (state === 'installed' || state === 'checking');
}

export function visibleRoutes(available: boolean, debugMode = false): readonly Route[] {
  return ROUTES.filter(route => (available || ALWAYS_VISIBLE.includes(route)) && (route !== 'debug' || debugMode));
}

/** Landing page (2026-09-22): Setup before the driver is installed,
 * Driver Settings once it is installed. */
export function defaultRoute(available: boolean): Route {
  return available ? 'driver-settings' : 'setup';
}

export function parseRoute(hash: string, available: boolean): Route {
  const value = hash.replace(/^#\/?/, '').replace(/^\/+/, '').split('?')[0];
  return (ROUTES as readonly string[]).includes(value) ? value as Route : defaultRoute(available);
}

/** Stable control links, independent of localized labels and DOM order. */
export function settingHref(route: Route, settingId: string): string {
  return `#/${route}?setting=${encodeURIComponent(settingId)}`;
}

export function parseSettingTarget(hash: string): string | undefined {
  const query = hash.indexOf('?');
  if (query < 0) return undefined;
  const id = new URLSearchParams(hash.slice(query + 1)).get('setting');
  return id && /^[a-zA-Z0-9._-]+$/.test(id) ? id : undefined;
}

/** Stable section link for the chapter Contents card and clipboard/back-forward. */
export function sectionHref(route: Route, anchorId: string): string {
  return `#/${route}?section=${encodeURIComponent(anchorId)}`;
}

export function parseSectionTarget(hash: string): string | undefined {
  const query = hash.indexOf('?');
  if (query < 0) return undefined;
  const id = new URLSearchParams(hash.slice(query + 1)).get('section');
  return id && /^[a-zA-Z0-9._-]+$/.test(id) ? id : undefined;
}

export function permittedRoute(requested: Route, available: boolean, debugMode = false): Route {
  if (available && requested === 'debug' && !debugMode) return 'app-settings';
  return available || ALWAYS_VISIBLE.includes(requested) ? requested : 'setup';
}
