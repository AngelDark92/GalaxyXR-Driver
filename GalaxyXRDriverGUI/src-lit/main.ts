// Application bootstrap (Lit frontend, 2026-09-20 migration).
// Replaces src/main.ts (Angular bootstrapApplication + appInitializer). Order:
//   1. register every custom element (see ./register.ts — keeps the element
//      modules in the bundle and defines the Fluent elements)
//   2. resolve config paths without recreating an uninstalled driver's data
//   3. build the shared service composition root
//   4. detect the locale from the page path and load ./locale.json
//   5. mount the shell
// The page is always served at /<locale>/index.html (en-US | zh-Hant | ja),
// both in the dev server and the release bundle, so the locale is the page's
// directory and its catalog is the sibling ./locale.json.
import { createAppContext } from './app-context';
import { PathsService } from './services/paths';
import { setLocale } from './locale/i18n';
import { appCustomElements } from './register';
import { applyTheme } from './ui/theme';
import { applyUiScale } from './ui/ui-scale';
// 2026-10-19: side-effect import so the preview element is actually defined.
// A type-only import is erased by the bundler, which left the window blank.
import './features/curve-preview-window';
import { is_curve_preview_window } from './platform/tauri';

function localeFromPath(): string {
  const segments = window.location.pathname.split('/').filter(Boolean);
  // /<locale>/index.html -> the segment before the last is the locale.
  const locale = segments.length >= 2 ? segments[segments.length - 2] : segments[0];
  return locale || 'en-US';
}

async function loadLocale(): Promise<void> {
  const code = localeFromPath();
  try {
    const res = await fetch('./locale.json', { cache: 'no-cache' });
    if (res.ok) {
      const map = (await res.json()) as Record<string, string>;
      setLocale(code, map);
      return;
    }
    console.warn('locale.json not served; falling back to English source strings');
  } catch (e) {
    console.warn('Could not load locale.json; falling back to English source strings', e);
  }
  setLocale(code, {});
}

async function boot(): Promise<void> {
  // Register all custom elements (Fluent + app) before mounting. Referencing
  // the registry here also guarantees its defining modules are retained in the
  // production bundle.
  void appCustomElements;

  // 2026-10-19: the bitrate curve graph runs in its own window (#view=curve).
  // It must not build the service composition root: no settings writer, no
  // directory creation and no migrations. Locale and theme are all it needs.
  const view = window.location.hash.replace(/^#/, '') || new URLSearchParams(window.location.search).get('view')
    || document.documentElement.dataset.view;
  // 2026-10-19: the window label is authoritative. Query/fragment markers in a
  // Tauri App URL are treated as part of the asset path, so the page never
  // loaded and the window stayed white.
  const previewWindow = view === 'curve'
    || (window as unknown as { __GXR_CURVE_PREVIEW__?: boolean }).__GXR_CURVE_PREVIEW__ === true
    || await is_curve_preview_window().catch(() => false);
  if (previewWindow) {
    applyTheme('system');
    document.title = 'Bitrate Curve';
    if (!customElements.get('app-curve-preview')) {
      // Never leave a silent white window: say what failed.
      const message = document.createElement('p');
      message.style.cssText = 'font: 14px system-ui; padding: 1rem; margin: 0;';
      message.textContent = 'The bitrate curve preview failed to load.';
      document.body.appendChild(message);
      return;
    }
    const preview = document.createElement('app-curve-preview');
    document.body.appendChild(preview);
    // Mount first, then localize: a stalled locale fetch must not leave the
    // window empty.
    void loadLocale().then(() => (preview as unknown as { requestUpdate?: () => void }).requestUpdate?.());
    return;
  }

  // 2026-09-26: opening Companion must not recreate data removed by Uninstall.
  // Installation and deliberate preference saves create directories on demand.
  const paths = new PathsService();
  await paths.initialize();
  const ctx = createAppContext(paths);
  // Read preferences before mounting; avoid a flash of the wrong theme.
  await ctx.appSetting.initTask;
  applyTheme(ctx.appSetting.values().colorScheme);
  // The saved window scale must be in effect for the first paint too.
  const scaleError = await applyUiScale(ctx.appSetting.values().uiScale);
  if (scaleError) console.warn('Could not apply the saved interface scale', scaleError);
  await loadLocale();

  const host = document.createElement('app-shell');
  (host as unknown as { ctx: unknown }).ctx = ctx;
  document.body.appendChild(host);
  // Exposed for debugging / future integration tests.
  (window as unknown as Record<string, unknown>).appContext = ctx;
  (window as unknown as Record<string, unknown>).appCustomElements = appCustomElements;
}

document.title = 'Galaxy XR Companion';
applyTheme('system');

boot().catch((err) => {
  console.error(err);
  const el = document.createElement('pre');
  el.style.cssText = 'font-family: monospace; padding: 1rem; white-space: pre-wrap; margin: 0;';
  el.textContent = `Failed to start the GUI:\n${err}`;
  document.body.appendChild(el);
});
