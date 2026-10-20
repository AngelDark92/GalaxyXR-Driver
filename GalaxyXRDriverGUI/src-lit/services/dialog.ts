// 2026-09-26: Fluent surfaces, with the existing Promise-based call contract.
// Dialogs are serialized so a background error cannot strand a confirmation.
import { t } from '../locale/i18n';

interface FluentDialog extends HTMLElement {
  show(): void;
  hide(): void;
  dialog?: HTMLDialogElement;
}
interface Action { label: string; value: unknown; primary?: boolean; danger?: boolean; }

function activeControl(): HTMLElement | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
}

export class DialogService {
  private host: HTMLElement | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private ensureHost(): HTMLElement {
    if (this.host && document.body.contains(this.host)) return this.host;
    const host = document.createElement('div');
    host.id = 'app-dialog-host';
    document.body.appendChild(host);
    this.host = host;
    return host;
  }

  private openDialog(title: string, message: string, actions: Action[], details?: string): Promise<unknown> {
    const open = () => new Promise<unknown>(resolve => {
      const previousFocus = activeControl();
      const dialog = document.createElement('fluent-dialog') as FluentDialog;
      dialog.className = 'app-dialog';
      dialog.setAttribute('aria-label', title);
      dialog.setAttribute('type', actions.length > 1 ? 'alert' : 'modal');
      const body = document.createElement('fluent-dialog-body');
      const heading = document.createElement('h2');
      heading.slot = 'title';
      heading.textContent = title;
      body.appendChild(heading);
      const content = document.createElement('p');
      content.textContent = message;
      content.className = 'app-dialog-message';
      if (actions.some(action => action.danger)) {
        const warning = document.createElement('fluent-message-bar');
        warning.setAttribute('intent', 'warning');
        const icon = document.createElement('span');
        icon.slot = 'icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '⚠';
        warning.append(icon, content);
        body.appendChild(warning);
      } else body.appendChild(content);
      if (details) {
        const disclosure = document.createElement('details');
        disclosure.className = 'app-dialog-details';
        const summary = document.createElement('summary');
        summary.textContent = t('Details');
        const text = document.createElement('pre');
        text.textContent = details;
        disclosure.append(summary, text);
        body.appendChild(disclosure);
      }
      let finished = false;
      const finish = (value?: unknown) => {
        if (finished) return;
        finished = true;
        if (dialog.dialog?.open) dialog.hide();
        dialog.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
        resolve(value);
      };
      actions.forEach((action, index) => {
        const button = document.createElement('fluent-button');
        button.slot = 'action';
        button.textContent = action.label;
        button.setAttribute('type', 'button');
        button.setAttribute('appearance', action.primary || action.danger ? 'primary' : 'secondary');
        if (action.danger) button.className = 'danger';
        // Fluent show() focuses this after its internal native dialog opens.
        // First action is Cancel for confirmations and OK for messages.
        if (index === 0) button.setAttribute('autofocus', '');
        button.addEventListener('click', () => finish(action.value));
        body.appendChild(button);
      });
      dialog.appendChild(body);
      dialog.addEventListener('toggle', event => {
        if ((event as CustomEvent<{ newState: string }>).detail?.newState === 'closed') finish();
      });
      this.ensureHost().appendChild(dialog);
      dialog.show();
    });
    const result = this.queue.then(open, open);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async confirm(title: string, message: string, yesText?: string, yesClass?: string): Promise<true | undefined> {
    const result = await this.openDialog(title, message, [
      { label: t('Cancel'), value: undefined },
      { label: yesText ?? t('Yes'), value: true, primary: yesClass === 'primary', danger: yesClass === 'danger' },
    ]);
    return result === true ? true : undefined;
  }

  async message(title: string, message: string, details?: string): Promise<void> {
    await this.openDialog(title, message, [{ label: t('Ok'), value: undefined, primary: true }], details);
  }

  /** Prompt whose first action is the default one: Fluent autofocuses it, so
   * Enter accepts it. Resolves with the chosen action's value, or undefined
   * when the dialog is dismissed. */
  async choose<T>(title: string, message: string, actions: Array<{ label: string; value: T; primary?: boolean }>): Promise<T | undefined> {
    return (await this.openDialog(title, message, actions)) as T | undefined;
  }
}
