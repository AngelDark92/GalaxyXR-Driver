// Dedicated packaged entry: no Companion context, settings services or driver actions.
import { setLocale, t } from './locale/i18n';

async function boot(): Promise<void> {
  await import('./features/curve-preview-window');
  const preview = document.createElement('app-curve-preview');
  document.body.appendChild(preview);
  document.getElementById('loading')?.remove();
  // The graph/close controls do not wait for localization I/O.
  void fetch('./locale.json').then(async response => {
    if (!response.ok) return;
    const code = location.pathname.split('/').filter(Boolean).at(-2) ?? 'en-US';
    setLocale(code, await response.json());
    document.documentElement.lang = code;
    document.getElementById('title')!.textContent = t('Bitrate curve');
    document.getElementById('close')!.textContent = t('Close');
    (preview as unknown as { requestUpdate(): void }).requestUpdate();
  }).catch(error => console.warn('Could not load graph locale', error));
}
void boot().catch(error => {
  document.getElementById('loading')?.remove();
  const message = document.getElementById('error')!;
  message.hidden = false;
  message.textContent = t('The graph window could not be opened: {reason}', { reason: String(error) });
});
