// About owns project links, credits, and app version/update information.
// Installation and runtime actions live on the always-visible Setup page.
import { html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BasePage, sectionHeading, fieldStyles } from './page-base';
import { t } from '../locale/i18n';
import { signal } from '../reactive';
import { delay } from '../domain/pure';
import { projectUrl } from '../domain/project';
import { openUrl } from '@tauri-apps/plugin-opener';
import { pageIntro, statusMessage } from '../ui/presentation';

const resourcePaths = {
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  release: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  guide: 'M12 5v16M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z',
  tune: 'M4 5h16M4 12h16M4 19h16M8 2v6m8 1v6m-6 1v6',
  issue: 'M8 21H4V4h16v13h-8Zm4-14v4m0 2v1',
};
const externalIcon = () => html`<svg class="external-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
  <path d="M8 4H4v12h12v-4M10 3h7v7M17 3l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

@customElement('app-about-page')
export class AboutPage extends BasePage {
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem; }
    .about-hero { display: flex; align-items: center; gap: 24px; padding: 28px;
      border: 1px solid var(--colorNeutralStroke2); border-radius: 12px;
      background: linear-gradient(115deg, var(--colorBrandBackground2), var(--colorNeutralBackground1) 75%); }
    .brand-mark { display: grid; place-items: center; flex: 0 0 88px; height: 88px;
      background: var(--colorNeutralBackground1); border: 1px solid var(--colorNeutralStroke2); border-radius: 22px; }
    .brand-mark img { width: 64px; height: auto; }
    .brand-copy { min-width: 0; }
    .brand-copy h2 { margin: 0 0 8px; font-size: 1.75rem; line-height: 1.2; font-weight: 600; letter-spacing: -0.025em; }
    .brand-copy p { margin: 8px 0 0; max-width: 62ch; color: var(--colorNeutralForeground2); line-height: 1.5; }
    .section-card { border-inline-start-width: 1px; border-radius: 10px; overflow: hidden; }
    .section-card > .card-heading .section-title { background: var(--colorNeutralBackground1); font-size: 1rem; font-weight: 600; padding: 14px 18px; }
    .section-body { padding: 0 18px 18px; }
    .version-panel { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;
      padding: 16px; border-radius: 8px; background: var(--colorNeutralBackground2); }
    .version-info, .update-status { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
    .version-label { color: var(--colorNeutralForeground2); }
    .version-number { font-weight: 600; font-size: 1.15rem; font-variant-numeric: tabular-nums; }
    .resource-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    a.resource-link { display: flex; align-items: center; gap: 14px; padding: 16px; min-width: 0;
      color: var(--colorNeutralForeground1); background: var(--colorNeutralBackground2);
      border: 1px solid var(--colorNeutralStroke2); border-radius: 8px; text-decoration: none;
      transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease; }
    a.resource-link:hover { background: var(--colorNeutralBackground1Hover); border-color: var(--colorBrandStroke1); box-shadow: var(--shadow2); }
    a.resource-link:active { background: var(--colorNeutralBackground1Pressed); box-shadow: none; }
    .resource-grid > a:last-child { grid-column: 1 / -1; }
    .resource-icon { display: grid; place-items: center; flex: 0 0 40px; height: 40px; border-radius: 10px;
      background: var(--colorBrandBackground2); color: var(--colorBrandForeground1); }
    .resource-icon svg { width: 22px; height: 22px; }
    .resource-copy { flex: 1; min-width: 0; }
    .link-title { display: block; font-weight: 600; line-height: 1.4; }
    .link-description { display: block; margin-top: 4px; color: var(--colorNeutralForeground2); line-height: 1.4; font-size: 0.85rem; }
    .external-icon { flex: 0 0 16px; width: 16px; height: 16px; color: var(--colorNeutralForeground3); }
    fluent-button .external-icon { margin-inline-start: 8px; vertical-align: -3px; color: inherit; }
    .resource-link:hover .external-icon, .compact-link:hover .external-icon { color: var(--colorBrandForegroundLink); }
    .credits-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 24px; }
    .credits-grid h3 { font-size: 0.95rem; font-weight: 600; margin: 0 0 8px; }
    .credits-grid p { color: var(--colorNeutralForeground2); font-size: 0.9rem; line-height: 1.5; margin: 0 0 12px; }
    .credit-links { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
    a.compact-link { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 7px 10px;
      border: 1px solid var(--colorNeutralStroke2); border-radius: 6px; background: var(--colorNeutralBackground2); text-decoration: none; font-weight: 600; }
    a.compact-link:hover { border-color: var(--colorBrandStroke1); background: var(--colorNeutralBackground1Hover); }
    .compact-link span { min-width: 0; overflow-wrap: anywhere; }
    .donation-logo { width: 20px; height: 20px; object-fit: contain; }
    .support { border-inline-start: 1px solid var(--colorNeutralStroke2); padding-inline-start: 24px; }
    @container page (max-width: 700px) {
      .about-hero { padding: 20px; gap: 16px; }
      .brand-mark { flex-basis: 64px; height: 64px; border-radius: 16px; }
      .brand-mark img { width: 48px; }
      .brand-copy h2 { font-size: 1.4rem; }
      .resource-grid, .credits-grid { grid-template-columns: minmax(0, 1fr); }
      .support { border-inline-start: 0; border-top: 1px solid var(--colorNeutralStroke2); padding: 18px 0 0; }
      .section-body { padding: 0 12px 12px; }
    }
  `];

  private checking = signal(false);
  private checkingUnsub?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.checkingUnsub = this.checking.subscribe(() => this.requestUpdate());
  }

  disconnectedCallback(): void {
    this.checkingUnsub?.();
    this.checkingUnsub = undefined;
    super.disconnectedCallback();
  }

  private async openExternal(event: Event, url: string): Promise<void> {
    event.preventDefault();
    try { await openUrl(url); }
    catch {
      await this.ctx.dialog.message(t('Could not open link'), t('Try again, or copy the address into your browser.'), url);
    }
  }

  // Native anchors preserve Enter, context menus and copy-link semantics while
  // Tauri opens external destinations outside the app (2026-09-26).
  private resourceLink(url: string, title: string, description: string, icon: keyof typeof resourcePaths): TemplateResult {
    return html`<a class="resource-link" href=${url} title=${t('Opens in your browser')}
      @click=${(event: Event) => this.openExternal(event, url)}>
      <span class="resource-icon"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path d=${resourcePaths[icon]} stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg></span>
      <span class="resource-copy"><span class="link-title">${title}</span><span class="link-description">${description}</span></span>
      ${externalIcon()}
    </a>`;
  }

  private compactLink(url: string, title: string, logo?: string): TemplateResult {
    return html`<a class="compact-link" href=${url} title=${t('Opens in your browser')}
      @click=${(event: Event) => this.openExternal(event, url)}>
      ${logo ? html`<img src=${logo} alt="" class="donation-logo">` : html``}<span>${title}</span>${externalIcon()}
    </a>`;
  }

  private async checkUpdate(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    try {
      const start = performance.now();
      await this.ctx.aus.checkUpdate();
      const wait = 2000 - (performance.now() - start);
      if (wait > 0) await delay(wait);
    } finally {
      this.checking.set(false);
    }
  }

  render() {
    const updateInfo = this.ctx.aus.updateInfo();
    const checking = this.checking() || !updateInfo;
    const parts: TemplateResult[] = [
      pageIntro(t('About'), t('Updates, guides, and the people behind the project.')),
      html`<section class="about-hero" aria-label=${t('Galaxy XR Companion')}>
        <div class="brand-mark"><img src="icons/headset_galaxy_xr_ready_2x.png" alt=""></div>
        <div class="brand-copy"><h2>${t('Galaxy XR Companion')}</h2>
          <fluent-badge appearance="tint" color="brand">${t('Open source')}</fluent-badge>
          <p>${t('Set up Galaxy XR for SteamVR, tune tracking, and adjust the streamed image.')}</p>
        </div>
      </section>`,
      sectionHeading(t('Version and updates'), 0, 'about-version'),
      html`<div class="version-panel">
        <div class="version-info"><span class="version-label">${t('App Version')}</span>
          <span class="version-number">${updateInfo?.currentVersion ?? t('Loading…')}</span></div>
        <div class="update-status" aria-live="polite" aria-busy=${checking}>
          ${checking ? html`<fluent-spinner size="tiny" aria-label=${t('Checking for updates')}></fluent-spinner>`
            : updateInfo?.updateAvailable ? html`<fluent-badge appearance="tint" color="brand">${t('Update available')}</fluent-badge>`
            : updateInfo?.fetchSuccess ? html`<fluent-badge appearance="tint" color="success">${t('Up to date')}</fluent-badge>` : html``}
          ${!checking && updateInfo?.updateAvailable
            ? html`<fluent-button appearance="primary" @click=${(event: Event) => this.openExternal(event, updateInfo.url)}>${t('View release')}${externalIcon()}</fluent-button>`
            : html`<fluent-button appearance="outline" ?disabled=${checking} @click=${() => this.checkUpdate()}>
                ${checking ? t('Checking…') : t('Check for updates')}
              </fluent-button>`}
        </div>
      </div>`,
    ];
    if (!checking && !updateInfo?.fetchSuccess) parts.push(statusMessage('warning', t('Update check unavailable'), t('Try again when your connection is available.')));

    parts.push(
      sectionHeading(t('Links'), 0, 'about-links'),
      html`<div class="resource-grid">
        ${this.resourceLink(projectUrl, t('GitHub project'), t('Explore the code and follow development.'), 'code')}
        ${this.resourceLink(projectUrl + '/releases', t('Releases and changelog'), t('Get the latest release and see what changed.'), 'release')}
        ${this.resourceLink(projectUrl + '/blob/main/Docs/StreamFrame.md', t('Setup and image processing guide'), t('Connect your headset and tune the picture.'), 'guide')}
        ${this.resourceLink(projectUrl + '/blob/main/Docs/TunerUsage.md', t('Distortion tuner guide'), t('Calibrate your view with the in-headset tuner.'), 'tune')}
        ${this.resourceLink(projectUrl + '/issues', t('Report a problem'), t('Open an issue and attach your SteamVR server log.'), 'issue')}
      </div>`,
      sectionHeading(t('Credits'), 0, 'about-credits'),
      html`<div class="credits-grid">
        <div><h3>${t('Built together')}</h3>
          <p>${t('Built on CustomHeadsetOpenVR by sboys3, with Galaxy XR driver work by timkhronos and compdoge.')}</p>
          <div class="credit-links">
            ${this.compactLink('https://github.com/sboys3/CustomHeadsetOpenVR', t('sboys3 / CustomHeadsetOpenVR'))}
            ${this.compactLink('https://github.com/timkhronos/CustomHeadsetOpenVrGxR', t('timkhronos / CustomHeadsetOpenVrGxR'))}
          </div>
          <h3>${t('Galaxy XR icons')}</h3>
          <p>${t('Galaxy XR icons by Vilkka. Based on Quest Pro icons by Lux / Hekky.')}</p>
        </div>
        <div class="support"><h3>${t('Support the original project')}</h3>
          <p>${t('Support sboys3, creator of the original project.')}</p>
          <div class="credit-links">
            ${this.compactLink('https://patreon.com/SBoys3', t('Patreon'), 'patreon-logo.svg')}
            ${this.compactLink('https://ko-fi.com/sboys3', t('Ko-fi'), 'ko-fi-logo.svg')}
          </div>
        </div>
      </div>`,
    );
    return this.sectionCardsFor(parts);
  }
}
