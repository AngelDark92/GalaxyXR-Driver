import { css } from 'lit';

// Adopt this in every Shadow DOM boundary containing native controls. Document
// CSS does not reach a page's buttons, inputs, links or dialogs through a shadow root.
export const interactiveStyles = css`
  *, *::before, *::after { box-sizing: border-box; }
  :host {
    color: var(--colorNeutralForeground1, #242424);
    font-family: var(--fontFamilyBase, "Segoe UI", system-ui, sans-serif);
    /* 2026-10-23 (owner directive): desktop-application text is not
       selectable. Document CSS cannot reach a shadow root, so every component
       adopting this stylesheet repeats the policy and its copy exceptions. */
    -webkit-user-select: none;
    user-select: none;
  }
  [hidden] { display: none !important; }
  button, input, select, textarea { font: inherit; }
  input, textarea, select, [contenteditable=""], [contenteditable="true"],
  pre, code, .technical, .error, .window-error {
    -webkit-user-select: text;
    user-select: text;
  }
  img { -webkit-user-drag: none; }
  button, .btn {
    color: var(--colorNeutralForeground1, #242424);
    background: var(--colorNeutralBackground1, #fff);
    border: 1px solid var(--colorNeutralStroke1, #d1d1d1);
    border-bottom-color: var(--colorNeutralStrokeAccessible, #616161);
    border-radius: var(--borderRadiusMedium, 4px);
    min-height: 32px;
    padding: 5px 12px;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: var(--colorNeutralBackground1Hover, #f5f5f5); }
  button:active:not(:disabled) { background: var(--colorNeutralBackground1Pressed, #e0e0e0); }
  button.primary, button.btn-primary {
    background: var(--colorBrandBackground, #0f6cbd);
    color: var(--colorNeutralForegroundOnBrand, #fff);
    border-color: transparent;
  }
  button.primary:hover:not(:disabled), button.btn-primary:hover:not(:disabled) { background: var(--colorBrandBackgroundHover, #115ea3); }
  button:disabled { cursor: not-allowed; color: var(--colorNeutralForegroundDisabled, #bdbdbd); background: var(--colorNeutralBackgroundDisabled, #f0f0f0); }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, [role="button"]:focus-visible {
    outline: 2px solid var(--colorStrokeFocus2, #000); outline-offset: 2px;
  }
  input, select, textarea { color: var(--colorNeutralForeground1, #242424); background: var(--colorNeutralBackground1, #fff); border: 1px solid var(--colorNeutralStroke1, #d1d1d1); border-radius: 4px; }
  input:disabled, select:disabled, textarea:disabled { color: var(--colorNeutralForegroundDisabled, #bdbdbd); }
  a { color: var(--colorBrandForegroundLink, #115ea3); text-decoration: underline; text-decoration-color: transparent;
    text-underline-offset: 3px; text-decoration-thickness: 1px; border-radius: 3px;
    transition: color 120ms ease, background 120ms ease, border-color 120ms ease; }
  a:hover { text-decoration-color: currentColor; }
  a:visited { color: var(--colorBrandForegroundLink, #115ea3); }
  a[href^="#/"] { display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 32px; padding: 5px 10px; font-weight: 600; line-height: 1.4;
    border: 1px solid var(--colorNeutralStroke2); border-radius: 6px;
    background: var(--colorNeutralBackground1); text-decoration: none; }
  a[href^="#/"]::after { content: ''; width: 6px; height: 6px; flex: 0 0 6px;
    border-top: 1.5px solid currentColor; border-right: 1.5px solid currentColor; transform: rotate(45deg); }
  a[href^="#/"]:hover { color: var(--colorBrandForegroundLinkHover); background: var(--colorNeutralBackground1Hover); border-color: var(--colorBrandStroke1); }
  a[href^="#/"]:active { background: var(--colorNeutralBackground1Pressed); }
  hr { border: 0; border-top: 1px solid var(--colorNeutralStroke2, #e0e0e0); }
  .page-intro { padding: 24px 4px 12px; }
  .page-intro h1 { margin: 0; font-size: 1.5rem; font-weight: 600; line-height: 1.3; }
  .page-intro p { margin: 6px 0 0; color: var(--colorNeutralForeground2); line-height: 1.5; }
  .status-message { margin: 12px 0; width: 100%; overflow-wrap: anywhere; }
  .status-message .status-title { display: block; font-weight: 600; }
  .status-body { margin-top: 3px; line-height: 1.5; }
  .status-icon { width: 20px; height: 20px; flex-shrink: 0; }
  .status-actions, .action-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .surface-card { padding: 20px; border: 1px solid var(--colorNeutralStroke2); border-radius: 8px; background: var(--colorNeutralBackground1); }
  .surface-card h2 { margin: 0 0 8px; font-size: 1.1rem; font-weight: 600; }
  .surface-card p { margin: 8px 0; line-height: 1.5; }
  .status-badge-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px; }
  fluent-button { flex-shrink: 0; }
  fluent-button.danger {
    --colorBrandBackground: var(--colorPaletteRedBackground3, #c50f1f);
    --colorBrandBackgroundHover: var(--colorPaletteRedBackground3Hover, #b10e1b);
    --colorBrandBackgroundPressed: var(--colorPaletteRedBackground3Pressed, #960b17);
    --colorNeutralForegroundOnBrand: #fff;
  }
  @media (max-width: 700px) {
    .page-intro { padding-top: 18px; }
    .surface-card { padding: 16px; }
    .status-actions { justify-content: flex-start; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
