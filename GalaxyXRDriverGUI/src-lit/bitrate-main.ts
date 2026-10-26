// Dedicated packaged entry for the on-demand bitrate monitor. It has no
// Companion context, settings service or driver action. Sampling starts only
// after the window mounts and stops on close or when the window is hidden.
import { setLocale, t } from './locale/i18n';
import { applyTheme } from './ui/theme';

async function boot(): Promise<void> {
  // Avoid a light flash before the native environment reports the saved theme.
  applyTheme('system');
  await import('./features/bitrate-monitor-window');
  const monitor = document.createElement('app-bitrate-monitor');
  document.body.appendChild(monitor);
  document.getElementById('loading')?.remove();
  // Localization I/O never delays the monitor's own start; the component
  // subscribes to locale changes and re-renders its labels.
  void fetch('./locale.json').then(async response => {
    if (!response.ok) return;
    const code = location.pathname.split('/').filter(Boolean).at(-2) ?? 'en-US';
    setLocale(code, await response.json());
    document.documentElement.lang = code;
    document.getElementById('title')!.textContent = t('Bitrate Monitor');
    document.getElementById('close')!.textContent = t('Close');
    (monitor as unknown as { requestUpdate(): void }).requestUpdate();
  }).catch(error => console.warn('Could not load bitrate monitor locale', error));
}
void boot().catch(error => {
  document.getElementById('loading')?.remove();
  const message = document.getElementById('error')!;
  message.hidden = false;
  message.textContent = t('The bitrate monitor window could not be opened: {reason}', { reason: String(error) });
});
