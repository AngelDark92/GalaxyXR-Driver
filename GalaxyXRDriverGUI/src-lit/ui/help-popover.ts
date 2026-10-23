/** Application help uses the browser top layer, not a scrolling page's stacking
 * context. The body portal is a fallback for older embedded webviews. Content
 * is text-only and is always fitted to the native window's visible viewport. */
export interface HelpContent { title: string; summary: string; details?: string }
export interface HelpRect { left: number; top: number; right: number; bottom: number }
export interface HelpViewport { left: number; top: number; width: number; height: number }

export function placeHelp(anchor: HelpRect, width: number, height: number, viewport: HelpViewport) {
  const margin = 12, gap = 8;
  const minX = viewport.left + margin, minY = viewport.top + margin;
  const maxX = Math.max(minX, viewport.left + viewport.width - width - margin);
  const maxY = Math.max(minY, viewport.top + viewport.height - height - margin);
  const below = anchor.bottom + gap;
  const above = anchor.top - height - gap;
  const preferredY = below + height <= viewport.top + viewport.height - margin ? below : above;
  return { left: Math.max(minX, Math.min(anchor.left, maxX)), top: Math.max(minY, Math.min(preferredY, maxY)) };
}

const POPUP_CSS = `
  [data-gxr-help] { box-sizing:border-box; position:fixed; inset:auto; margin:0;
    width:min(30rem, calc(100vw - 24px)); max-height:calc(100vh - 24px);
    overflow:auto; overscroll-behavior:contain; z-index:2147483647;
    padding:16px 18px; border:1px solid var(--colorNeutralStroke1, #888);
    border-radius:10px; background:var(--colorNeutralBackground1, #fff);
    color:var(--colorNeutralForeground1, #202020); color-scheme:inherit;
    font:400 14px/1.55 'Segoe UI', system-ui, sans-serif;
    box-shadow:0 8px 32px #0004; text-align:left; white-space:normal;
    overflow-wrap:anywhere; user-select:none; }
  [data-gxr-help]::backdrop { background:transparent; }
  [data-gxr-help] header { display:flex; align-items:flex-start; gap:16px; }
  [data-gxr-help] h2 { margin:0; flex:1; font:600 16px/1.4 'Segoe UI',system-ui,sans-serif; }
  [data-gxr-help] button { flex-shrink:0; cursor:pointer; padding:2px 8px;
    border:1px solid var(--colorNeutralStroke1,#888); border-radius:4px;
    background:var(--colorNeutralBackground1,#fff); color:inherit; font:inherit; }
  [data-gxr-help] :focus-visible { outline:2px solid var(--colorBrandStroke1,#0067c0); outline-offset:2px; }
  [data-gxr-help] p { margin:10px 0 0; white-space:pre-line; }
  [data-gxr-help] details { margin-top:12px; border-top:1px solid var(--colorNeutralStroke2,#aaa); padding-top:10px; }
  [data-gxr-help] summary { cursor:pointer; font-weight:600; color:var(--colorBrandForegroundLink,#0067c0); }
`;

export class HelpPopover {
  private panel?: HTMLElement;
  private trigger?: HTMLButtonElement;
  private observer?: ResizeObserver;
  private frame = 0;
  private scrollRoots: Array<Document | ShadowRoot> = [];
  private native = false;
  private static nextId = 0;

  open(trigger: HTMLButtonElement, content: HelpContent, labels = { close: 'Close help', details: 'Technical details' }): void {
    if (this.trigger === trigger && this.panel) { this.close(true); return; }
    this.close(false);
    this.trigger = trigger;
    const panel = document.createElement('div');
    this.panel = panel;
    panel.dataset.gxrHelp = '';
    panel.id = `gxr-help-${++HelpPopover.nextId}`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    const style = document.createElement('style'); style.textContent = POPUP_CSS;
    const header = document.createElement('header');
    const title = document.createElement('h2'); title.id = `${panel.id}-title`; title.textContent = content.title;
    panel.setAttribute('aria-labelledby', title.id);
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×';
    close.setAttribute('aria-label', labels.close); close.addEventListener('click', () => this.close(true));
    header.append(title, close);
    const summary = document.createElement('p'); summary.textContent = content.summary;
    panel.append(style, header, summary);
    if (content.details) {
      const details = document.createElement('details'), caption = document.createElement('summary'), body = document.createElement('p');
      caption.textContent = labels.details; body.textContent = content.details;
      details.append(caption, body); details.addEventListener('toggle', this.schedulePosition);
      panel.append(details);
    }
    this.native = typeof panel.showPopover === 'function';
    if (this.native) panel.setAttribute('popover', 'auto');
    // In the top layer, a shadow-root child is not clipped by its ancestors.
    // Keeping it beside the trigger also makes aria-controls a same-root IDREF.
    const root = trigger.getRootNode();
    (this.native && root instanceof ShadowRoot ? root : document.body).appendChild(panel);
    trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', panel.id);
    panel.addEventListener('toggle', this.onToggle);
    if (this.native) panel.showPopover();
    this.position();
    close.focus({ preventScroll: true });
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('resize', this.schedulePosition);
    // Scroll is not a composed event: a document listener alone cannot see
    // the app shell's scrolling panes inside a Lit shadow root.
    let node: Node = trigger;
    while (true) {
      const scrollRoot = node.getRootNode();
      if (scrollRoot instanceof ShadowRoot || scrollRoot instanceof Document) {
        this.scrollRoots.push(scrollRoot);
        scrollRoot.addEventListener('scroll', this.schedulePosition, true);
      }
      if (!(scrollRoot instanceof ShadowRoot)) break;
      node = scrollRoot.host;
    }
    window.addEventListener('scroll', this.schedulePosition, true);
    window.visualViewport?.addEventListener('resize', this.schedulePosition);
    window.visualViewport?.addEventListener('scroll', this.schedulePosition);
    this.observer = new ResizeObserver(this.schedulePosition); this.observer.observe(panel); this.observer.observe(trigger);
  }

  close(restoreFocus = false, owner?: HTMLButtonElement): void {
    if (owner && owner !== this.trigger) return;
    const panel = this.panel, trigger = this.trigger;
    this.panel = undefined; this.trigger = undefined;
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.observer?.disconnect(); this.observer = undefined;
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('resize', this.schedulePosition);
    window.removeEventListener('scroll', this.schedulePosition, true);
    for (const root of this.scrollRoots) root.removeEventListener('scroll', this.schedulePosition, true);
    this.scrollRoots = [];
    window.visualViewport?.removeEventListener('resize', this.schedulePosition);
    window.visualViewport?.removeEventListener('scroll', this.schedulePosition);
    if (panel) {
      panel.removeEventListener('toggle', this.onToggle);
      if (this.native && panel.matches(':popover-open')) panel.hidePopover();
      panel.remove();
    }
    trigger?.setAttribute('aria-expanded', 'false'); trigger?.removeAttribute('aria-controls');
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  private onToggle = (event: Event): void => {
    if ((event as Event & { newState: string }).newState === 'closed') this.close(false);
  };
  private onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.panel) {
      event.preventDefault(); event.stopPropagation(); this.close(true);
    }
  };
  private onOutside = (event: PointerEvent): void => {
    const path = event.composedPath();
    if (this.panel && !path.includes(this.panel) && this.trigger && !path.includes(this.trigger)) this.close(false);
  };
  private schedulePosition = (): void => {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.position(); });
  };
  private position(): void {
    const panel = this.panel, trigger = this.trigger;
    if (!panel || !trigger) return;
    if (!trigger.isConnected) { this.close(false); return; }
    const vv = window.visualViewport;
    const viewport = { left: vv?.offsetLeft ?? 0, top: vv?.offsetTop ?? 0, width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight };
    panel.style.width = `${Math.min(480, Math.max(1, viewport.width - 24))}px`;
    panel.style.maxHeight = `${Math.max(1, viewport.height - 24)}px`;
    const anchor = trigger.getBoundingClientRect();
    if (anchor.bottom < viewport.top || anchor.top > viewport.top + viewport.height) { this.close(false); return; }
    // Dismiss when the trigger scrolls out of its own pane, even if that pane
    // is wholly inside the native window. The help itself stays in the top layer.
    let ancestor: Element | null = trigger;
    while (ancestor) {
      const root = ancestor.getRootNode();
      ancestor = ancestor.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
      if (!ancestor) break;
      const style = getComputedStyle(ancestor), clip = ancestor.getBoundingClientRect();
      const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
      if ((clipsY && (anchor.bottom <= clip.top || anchor.top >= clip.bottom))
        || (clipsX && (anchor.right <= clip.left || anchor.left >= clip.right))) {
        this.close(false); return;
      }
    }
    const box = panel.getBoundingClientRect();
    const point = placeHelp(anchor, box.width, box.height, viewport);
    panel.style.left = `${point.left}px`; panel.style.top = `${point.top}px`;
  }
}

export const helpPopover = new HelpPopover();
