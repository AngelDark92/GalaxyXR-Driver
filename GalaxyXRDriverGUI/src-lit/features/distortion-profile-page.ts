// Distortion Profile page, ported from the Angular template (2026-09-20 Lit/Fluent migration).
// Every conditional, field, tip, reset scope and control binding from the original
// template is preserved 1:1; the only interpretation layer is the control
// adapters (app-switch / app-select / app-number / app-slider) whose events
// were verified against the pinned @fluentui/web-components package.
import { html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { ref } from 'lit/directives/ref.js';
import { css } from 'lit';
import { BasePage, settingFieldRow, fieldRow, noteRow, sectionRow, sectionHeading, fieldStyles } from './page-base';
import { t } from '../locale/i18n';
import { pageIntro, statusMessage } from '../ui/presentation';
import '../ui/controls';
import './driver-banner';
import './system-ready';
import './curve-editor';

@customElement('app-distortion-profile-page')
export class DistortionProfilePage extends BasePage {
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem 1rem; }
    .rgb-control { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
    .rgb-control span { opacity: 0.75; font-size: 90%; }
    .matrix-control { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
    .note-inline { opacity: 0.75; font-size: 0.9rem; }
    .curve-field { display: block; padding: 0.5rem 0; }
    .share-field { display: block; }
    .share-control { display: flex; flex-direction: column; gap: 0.5rem; }
    .share-buttons { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    textarea { background: var(--colorNeutralBackground2, #f4f4f4); border: 0.1rem solid var(--colorNeutralStroke1, #888); border-radius: 0.25rem; width: 100%; font-family: monospace; font-size: 0.8rem; padding: 0.5rem; resize: vertical; color: var(--colorNeutralForeground1, #202020); }

  `];

  private _fileInput: HTMLInputElement | null = null;

  private calibrationGuide(): void {
    void this.ctx.dialog.message(t('Calibration guide'), t('Start with small corrections and compare slow head turns. A curve value of 1.0 leaves the image unchanged; higher values pull content inward and lower values push it outward. Corrections are usually within one percent of 1.0.\n\nUse the calibration grid to inspect alignment, then turn calibration off before playing. Force Calibration Grid also enables the angular grid and warped overlays; World-Locked Grid remains independent.'));
  }

  private sharingGuide(): void {
    void this.ctx.dialog.message(t('Import and export'), t('Export current copies the active curves, mode, and center offsets into the text box. Export .json saves them as a file.\n\nTo import, paste a profile and choose Import from text, or choose Import .json. Profiles saved by the in-headset tuner use the same format. Export your current profile first if you want to keep it.'));
  }

  render() {
    const galaxy = this.ctx.galaxy;
    if (!galaxy.settings) return html``;
    const settings = galaxy.settings;
    const defaults = galaxy.defaults;
    const advancedMode = galaxy.advancedMode || this.revealAdvanced;
    const vendor = galaxy.vendor;
    const galaxyXr = galaxy.galaxyXr;
    const sections = galaxy.sections();
    const save = () => { galaxy.save(); this.requestUpdate(); };
    const parts: TemplateResult[] = [pageIntro(t('Distortion Profile'), t('Lens correction and profile sharing.'))];
if (settings) {
      parts.push(html`<app-driver-enable-banner .ctx=${this.ctx}></app-driver-enable-banner>`);
if (galaxy.calibrationActive()) {
          parts.push(statusMessage('warning', t('Calibration is active'), t('Stop calibration before playing.'),
            html`<fluent-button appearance="outline" @click=${() => { galaxy.stopCalibration(); this.requestUpdate(); }}>${t('Stop calibration')}</fluent-button>`));
}
if (galaxy.imageEnhancementsEnabled) {
        parts.push(sectionRow(t('Distortion Correction'), sections['distortion'], 0, () => this.toggleSection('distortion')));
if (sections.distortion) {
          parts.push(noteRow(html`<div class="action-row"><span>${t('Reduce image rippling during head turns with small lens corrections.')}</span>
            <fluent-button appearance="subtle" @click=${() => this.calibrationGuide()}>${t('Calibration guide')}</fluent-button></div>`));
          parts.push(fieldRow(t('Mode'), html`
      <app-select .value=${settings.distortion.mode} .options=${[{ value: 'k1k2', label: 'Two-value curve (k1/k2)' }, { value: 'spline', label: 'Smooth curve (control points)' }]} @change=${(e: CustomEvent) => { settings.distortion.mode = e.detail; save(); }}></app-select>
          `, {
  tip: t("Choose how finely you can adjust the lens correction. Start with the two-number curve; use a spline for more control over different parts of the image.\n\nk1/k2 is a simple two value polynomial curve. Spline gives per radius control points. Convert from k1/k2 keeps the current shape as a starting point.\n\nValue: streamFrame.distortion.mode (settings.json). Driver side — selects the radial curve model evaluated per frame.")
          }));
          parts.push(settingFieldRow('streamFrame.distortion.perEye', html`
      <app-switch .checked=${!!settings.distortion.perEye} @change=${(e: CustomEvent) => { settings.distortion.perEye = e.detail; save(); }}></app-switch>
          `, {
  tip: t("Adjust the left and right eye separately when one shared correction does not suit both eyes. Your current curve is copied before you start.\n\nSeparate correction curves for the left and right eye. Existing curve is copied to both eyes as a starting point.\n\nValue: streamFrame.distortion.perEye (settings.json). Driver side — separate left/right curve evaluation.")
          }));
          parts.push(settingFieldRow('streamFrame.distortion.perAxis', html`
      <app-switch .checked=${!!settings.distortion.perAxis} @change=${(e: CustomEvent) => { settings.distortion.perAxis = e.detail; save(); }}></app-switch>
          `, {
  tip: t("Adjust horizontal and vertical lens correction separately. Start with a shared curve unless you have measured a difference between the two directions.\n\nSeparate horizontal and vertical curves blended around the ring, capturing elliptic error such as lens tilt. Existing curve is copied to both axes as a starting point.\n\nValue: streamFrame.distortion.perAxis (settings.json). Driver side — separate horizontal/vertical curve evaluation.")
          }));
if (advancedMode) {
            parts.push(settingFieldRow('streamFrame.distortion.tune.enable', html`
      <app-switch .checked=${!!settings.distortion.tune.enable} @change=${(e: CustomEvent) => { settings.distortion.tune.enable = e.detail; save(); }}></app-switch>
            `, {
  tip: t("Show the lens-correction controls inside the headset. Use the GxR Tuner and Scoring guide before changing a working profile.\n\nIn-headset configurable distortion profile tuner. For usage refer to the GxR Tuner and Scoring guide.\n\nValue: streamFrame.distortion.tune.enable (settings.json). Driver side — runs the in-headset tuner session.")
            }));
}
if (advancedMode && settings.distortion.tune.enable) {
            parts.push(fieldRow(t('Tuner Adjust Rate'), html`
      <app-number .value=${settings.distortion.tune.rate} step="0.01" min="0.01" max="0.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.distortion.tune.rate = e.detail; } save(); }}></app-number>
            `, {
  tip: t("Set how quickly the correction changes when you move the thumbstick. A lower speed makes small final adjustments easier.\n\nScale change per second at full stick deflection (analog mode, used when Step Size is 0). The response is squared, so partial deflection is much slower for fine nulling. Lower it if the last bit of swim is hard to dial in.\n\nValue: streamFrame.distortion.tune.rate (settings.json). Driver side — tuner stick-response rate.")
            }));
            parts.push(fieldRow(t('Tuner Step Size'), html`
      <app-number .value=${settings.distortion.tune.stepSize} step="0.001" min="0" max="0.05" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.distortion.tune.stepSize = e.detail; } save(); }}></app-number>
            `, {
  tip: t("Choose smooth thumbstick adjustment or fixed-size steps. Set this to 0 for smooth adjustment.\n\n0 = analog mode. For higher values apply this step per 0.1s while the joystick is deflected.\n\nValue: streamFrame.distortion.tune.stepSize (settings.json). Driver side — fixed step per 0.1 s; 0 = analog.")
            }));
            parts.push(fieldRow(t('Band Segments'), html`
      <app-select .value=${settings.distortion.tune.segments} .options=${[{ value: 1, label: 'Off (radial only)' }, { value: 4, label: '4 (quadrants)' }, { value: 8, label: '8 (octants)' }]} @change=${(e: CustomEvent) => { settings.distortion.tune.segments = e.detail; save(); }}></app-select>
            `, {
  tip: t("Split each tuning ring into smaller areas for local corrections. Adjust the lens center first, then the rings, and only then these smaller areas.\n\n1 = classic radial tuning. 4 or 8 splits every band into angular segments with their own adjustment: in the headset, the X button walks ALL -> segment 0..N-1 -> ALL, and a joystick CLICK cycles the eye (linked/L/R) instead of X. ALL edits the whole band as before; a segment nudges only that sector (the band ring dims outside it). Positional correction for top/bottom or nasal/temporal asymmetry that radial bands cannot express. Tune segments LAST: center first, radial bands second - a wrong center masquerades as exactly the asymmetry segments would absorb. Applies when the tuner is next toggled on.\n\nValue: streamFrame.distortion.tune.segments (settings.json). Driver side — angular segment count per tuning band.")
            }));
            parts.push(fieldRow(t('Segment Layout (per band)'), html`
      <input type="text" .value=${galaxy.segLayoutText} placeholder="e.g. 4, 4, 8, 8, 12, 16, 16" @input=${(e: Event) => { galaxy.segLayoutText = (e.target as HTMLInputElement).value; galaxy.updateSegLayout() }}></input>
            `, {
  tip: t("Give different tuning rings different numbers of adjustment areas. Leave the list empty to use the same number everywhere.\n\nOptional: a comma list of segment counts, one per band from INNER to OUTER (e.g. 4, 4, 8, 8, 12, 16, 16). Outer bands cover far more circumference, so they usually deserve more segments than inner ones. Empty = the uniform Band Segments value everywhere. Shorter than the band list = the last entry repeats. Counts 1-32. The X walk covers the current band's own segments; switching bands restarts at ALL. Applies when the tuner is next toggled on.\n\nValue: streamFrame.distortion.tune.segmentLayout (settings.json). Driver side — per-band segment counts, inner to outer.")
            }));
            parts.push(fieldRow(t('Band Ring Opacity'), html`
      <app-number .value=${settings.distortion.tune.ringOpacity} step="0.05" min="0" max="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.distortion.tune.ringOpacity = e.detail; } save(); }}></app-number>
            `, {
  tip: t("Set how visible the orange tuning ring is. Lower it when the marker distracts you from judging image movement; 0 hides it.\n\nOpacity of the orange ring marking the band being edited. 0 hides it entirely (the band position is still logged); lower it if the ring itself distracts from judging the swim.\n\nValue: streamFrame.distortion.tune.ringOpacity (settings.json). Driver side — band ring highlight opacity.")
            }));
            parts.push(fieldRow(t('Band Layout (count / first r / last r)'), html`
      <app-number .value=${galaxy.tuneBandCount} step="1" min="2" max="12" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxy.tuneBandCount = e.detail; } galaxy.updateBands(); }}></app-number>
      <app-number .value=${galaxy.tuneBandFirst} step="0.01" min="0.05" max="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxy.tuneBandFirst = e.detail; } galaxy.updateBands(); }}></app-number>
      <app-number .value=${galaxy.tuneBandLast} step="0.01" min="0.1" max="1.2" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxy.tuneBandLast = e.detail; } galaxy.updateBands(); }}></app-number>
            `, {
  tip: t("Choose how many rings the lens tuner uses and how much of the image they cover. More rings give finer control but take longer to tune.\n\nHow many radius bands the tuner edits and where they start and end, spaced evenly (defaults: 7 bands, 0.15 to 0.65). More bands = finer control but a longer session. Edits regenerate the band list; the active session picks it up next time the tuner is toggled on.\n\nValue: streamFrame.distortion.tune.bands (settings.json). Driver side — band count and radius span.")
            }));
            parts.push(settingFieldRow('streamFrame.distortion.tune.forceGrid', html`
      <app-switch .checked=${!!settings.distortion.tune.forceGrid} @change=${(e: CustomEvent) => { settings.distortion.tune.forceGrid = e.detail; save(); }}></app-switch>
            `, {
  tip: t("Automatically show the reference grid while using the lens tuner. Turn this off only when you want to control the overlays yourself.\n\nOn (default): the tuner forces the angular grid + warped overlays on while active. Off: overlays follow your own toggles below.\n\nValue: streamFrame.distortion.tune.forceGrid (settings.json). Driver side — forces grid overlays during tuner sessions.")
            }));
if (settings.distortion.tune.forceGrid) {
              parts.push(statusMessage('info', t('Calibration grid is forced on'), t('Angular grid and warped overlays are active. World-Locked Grid remains independent.')));
} else {
              parts.push(settingFieldRow('streamFrame.eyeGaze.debugGrid', html`
      <app-switch .checked=${!!settings.eyeGaze.debugGrid} @change=${(e: CustomEvent) => { settings.eyeGaze.debugGrid = e.detail; save(); }}></app-switch>
      <app-select .value=${settings.eyeGaze.gridMode} .options=${[{ value: 'uv', label: 'UV grid (eye tuning)' }, { value: 'angular', label: 'Angular grid (camera photos)' }, { value: 'sboys', label: 'Camera pattern (hue-coded, sboys)' }]} @change=${(e: CustomEvent) => { settings.eyeGaze.gridMode = e.detail; save(); }}></app-select>
      <span>deg</span>
      <app-number .value=${settings.eyeGaze.gridAngularDeg} step="0.5" min="0.5" max="30" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.eyeGaze.gridAngularDeg = e.detail; } save(); }}></app-number>
              `, {
  tip: t("Show reference lines to check whether the image bends or moves as your eyes move. This unwanted movement is often called pupil swim.\n\nOverlays straight reference lines for pupil swim tuning. Fixate a grid intersection, then move only your eyes around it: if the nearby lines bend or shift as your gaze moves, that's pupil swim.\n\nValue: streamFrame.eyeGaze.debugGrid, gridMode, gridAngularDeg (settings.json). Driver side — reference grid overlay, its mode and spacing.")
              }));
if (settings.eyeGaze.gridMode == 'sboys') {
                parts.push(settingFieldRow('streamFrame.eyeGaze.gridOpaque', html`
      <app-switch .checked=${!!settings.eyeGaze.gridOpaque} @change=${(e: CustomEvent) => { settings.eyeGaze.gridOpaque = e.detail; save(); }}></app-switch>
                `, {
  tip: t("Replace the game view with a colored calibration pattern for camera measurements. This is a measurement tool, not a normal-play setting.\n\nThe sboys pattern draws per-axis angle lines whose COLOR encodes their angular index (hue = line number / 6), so the calibrated camera and the fit script can identify every line absolutely - no counting from center, and residual camera pose can be solved jointly with the distortion. This toggle replaces game content with a dim grey background so the camera sees only the pattern. Turn on Warped Overlays for measurement runs: the pattern must pass through the active distortion profile exactly like game content, so the camera reads the residual OF the correction, not the raw lens. Keep 2.5 deg spacing to match the reference tooling.\n\nValue: streamFrame.eyeGaze.gridOpaque (settings.json). Driver side — swaps game content for the camera calibration pattern.")
                }));
}
              parts.push(settingFieldRow('streamFrame.eyeGaze.overlayWarped', html`
      <app-switch .checked=${!!settings.eyeGaze.overlayWarped} @change=${(e: CustomEvent) => { settings.eyeGaze.overlayWarped = e.detail; save(); }}></app-switch>
              `, {
  tip: t("Apply your lens correction to the calibration overlays too. Use this when checking how well the current correction works.\n\nDraws the calibration grid and the fixation dot in content space, so the active distortion profile warps them exactly like scene content. With the ANGULAR grid: a correct profile makes the lines look straight through the lens. With the fixation dot + swim probe: run probe sessions with profile off / A / B and let the fitter score which one flattens the residual. Leave off for plain measurement runs.\n\nValue: streamFrame.eyeGaze.overlayWarped (settings.json). Driver side — draws the overlays through the active distortion profile.")
              }));
}
            parts.push(settingFieldRow('streamFrame.eyeGaze.gridWorldLocked', html`
      <app-switch .checked=${!!settings.eyeGaze.gridWorldLocked} @change=${(e: CustomEvent) => { settings.eyeGaze.gridWorldLocked = e.detail; save(); }}></app-switch>
            `, {
  tip: t("Keep the reference grid fixed in the virtual world instead of moving it with your head. This only affects the angular grid.\n\nDraws the angular grid at fixed WORLD azimuth/elevation instead of head-locked lens angles. Angular grid mode only.\n\nValue: streamFrame.eyeGaze.gridWorldLocked (settings.json). Driver side — world-locked placement of the angular grid.")
            }));
}
if (advancedMode) {
            parts.push(settingFieldRow('streamFrame.distortion.centerTune.enable', html`
      <app-switch .checked=${!!settings.distortion.centerTune.enable} @change=${(e: CustomEvent) => { settings.distortion.centerTune.enable = e.detail; save(); }}></app-switch>
            `, {
  tip: t("Find the center of each lens correction before tuning the surrounding rings. A gently pulsing image and a cross mark the point you are adjusting.\n\nInteractive tuning of the distortion CENTER offsets. While on: the image gently 'breathes' (pulses radially) around the currently configured center, an amber cross marks it, and the fine grid is shown. The lens's true center is the point where color fringing on the grid lines vanishes and sharpness peaks. Drag the breathing's still-point onto it with the stick. X cycles both-shift / both-mirrored(IPD) / left / right. Y resets, holding a grip 1.5s saves a centers profile + paste block. Do this BEFORE band tuning.\n\nValue: streamFrame.distortion.centerTune.enable (settings.json). Driver side — the in-headset center-offset tuner.")
            }));
}
          parts.push(fieldRow(t('Correction Gain'), html`
      <app-number .value=${settings.distortion.gain} step="0.1" min="-1.5" max="1.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.distortion.gain = e.detail; } save(); }}></app-number>
          `, {
  tip: t("Adjust the overall strength and direction of lens correction. 1 uses the saved curve, 0 disables it, and negative values reverse its direction.\n\nMultiplies the whole correction: 1 = curve as authored, 0 = off, -1 = opposite-sign correction, values between scale it. THE perceptual search knob: turn on Warped Overlays + the angular grid, fixate a grid intersection, slowly rotate your head, and sweep the gain until the lines swim least. Settles the correction's sign and strength in one pass, without trusting eye tracking.\n\nValue: streamFrame.distortion.gain (settings.json). Driver side — global multiplier on the correction.")
          }));
if (settings.distortion.mode == 'k1k2' && !settings.distortion.perEye && !settings.distortion.perAxis) {
            parts.push(fieldRow(t('k1'), html`
      <app-number .value=${settings.k1} step="0.001" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.k1 = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.k1} .min=${-0.1} .max=${0.1} .step=${0.001} @change=${(e: CustomEvent) => { settings.k1 = e.detail; save(); }}></app-slider>
            `, {
  tip: t("Adjust the broad lens-correction curve across the image. Make small changes and compare them using the reference grid.\n\nQuadratic radial term. Affects the whole field, growing with distance from the center.\n\nValue: streamFrame.k1 (settings.json). Driver side — quadratic radial term of the curve."),
  reset: { can: settings.k1 != defaults.k1, on: () => { galaxy.reset('k1'); } }
            }));
            parts.push(fieldRow(t('k2'), html`
      <app-number .value=${settings.k2} step="0.001" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.k2 = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.k2} .min=${-0.1} .max=${0.1} .step=${0.001} @change=${(e: CustomEvent) => { settings.k2 = e.detail; save(); }}></app-slider>
            `, {
  tip: t("Adjust lens correction mostly toward the image edges. Tune the broad correction first, then use this for the outer areas.\n\nQuartic radial term. Mostly affects the periphery.\n\nValue: streamFrame.k2 (settings.json). Driver side — quartic radial term of the curve."),
  reset: { can: settings.k2 != defaults.k2, on: () => { galaxy.reset('k2'); } }
            }));
}
          parts.push(html`<div class="field curve-field">
  <app-stream-frame-curve .settings=${settings} .revision=${galaxy.revision()} @changed=${() => save()}></app-stream-frame-curve>
</div>`);
if (advancedMode) {
            parts.push(settingFieldRow('streamFrame.distortion.annulus.enable', html`
      <app-switch .checked=${!!settings.distortion.annulus.enable} @change=${(e: CustomEvent) => { settings.distortion.annulus.enable = e.detail; save(); }}></app-switch>
            `, {
  tip: t("Show the area of the image affected by a tuning ring. Turn this diagnostic display off for normal play.\n\nDiagnostic: limit the correction to a radius band so one region of the curve can be tuned against untouched surroundings. Disable for normal use, the band edges are intentionally not geometric.\n\nValue: streamFrame.distortion.annulus.enable (settings.json). Driver side — limits the correction to a radius band.")
            }));
}
if (advancedMode && settings.distortion.annulus.enable) {
            parts.push(fieldRow(t('Band Range and Feather'), html`
      <span>min</span>
      <app-number .value=${settings.distortion.annulus.rMin} step="0.05" min="0" max="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.distortion.annulus.rMin = e.detail; } save(); }}></app-number>
      <span>max</span>
      <app-number .value=${settings.distortion.annulus.rMax} step="0.05" min="0" max="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.distortion.annulus.rMax = e.detail; } save(); }}></app-number>
      <span>feather</span>
      <app-number .value=${settings.distortion.annulus.feather} step="0.01" min="0" max="0.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.distortion.annulus.feather = e.detail; } save(); }}></app-number>
            `, {  tip: t("Set how far the ring band reaches into the image and how soft its edge is. Match the band you are tuning.\n\nValue: streamFrame.distortion.annulus.rMin, rMax, feather (settings.json). Driver side — radius span and soft edge of the tuning band.") }
          ));
}
          parts.push(fieldRow(t('Optical Center Offset'), html`
      <span>x left</span>
      <app-number .value=${settings.centerOffsetXLeft} step="0.001" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.centerOffsetXLeft = e.detail; } save(); }}></app-number>
      <span>x right</span>
      <app-number .value=${settings.centerOffsetXRight} step="0.001" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.centerOffsetXRight = e.detail; } save(); }}></app-number>
      <span>y</span>
      <app-number .value=${settings.centerOffsetY} step="0.001" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.centerOffsetY = e.detail; } save(); }}></app-number>
          `, {
  tip: t("Move the center around which the lens correction is applied. Small changes can affect both image sharpness and apparent movement.\n\nMoves the center the correction rings are anchored to, in uv units per eye. Use if the residual wobble is asymmetric.\n\nValue: streamFrame.centerOffsetXLeft, centerOffsetXRight, centerOffsetY (settings.json). Driver side — per-eye uv-space center of the correction.")
          }));
if (advancedMode) {
            parts.push(sectionRow(t('Eye Alignment'), sections['eyeAlign'], 1, () => this.toggleSection('eyeAlign')));
if (sections.eyeAlign) {
              parts.push(fieldRow(t('Eye Alignment Left H'), html`
      <app-number .value=${settings.alignment.leftH} step="0.0005" min="-0.01" max="0.01" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.alignment.leftH = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.alignment.leftH} .min=${-0.01} .max=${0.01} .step=${0.0005} @change=${(e: CustomEvent) => { settings.alignment.leftH = e.detail; save(); }}></app-slider>
              `, {
  tip: t("Move the left-eye image sideways for alignment. Change this carefully: a poor setting can affect comfort and depth perception.\n\nPrism correction: shifts the LEFT eye's whole image horizontally, in fractions of the image (positive = right). Corrects binocular misalignment when an eye sits off its lens axis. Use sparingly: horizontal shift also changes apparent depth. Typical useful values are within a few thousandths.\n\nValue: streamFrame.alignment.leftH (settings.json). Driver side — horizontal prism shift for the left eye (fractions of image width)."),
  reset: { can: galaxy.alignmentDirty(), on: () => { galaxy.reset('alignment'); } }
              }));
              parts.push(fieldRow(t('Eye Alignment Left V'), html`
      <app-number .value=${settings.alignment.leftV} step="0.0005" min="-0.01" max="0.01" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.alignment.leftV = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.alignment.leftV} .min=${-0.01} .max=${0.01} .step=${0.0005} @change=${(e: CustomEvent) => { settings.alignment.leftV = e.detail; save(); }}></app-slider>
              `, {
  tip: t("Move the left-eye image up or down for alignment. A mismatch between the eyes can be uncomfortable; keep a known-good profile to restore.\n\nPrism correction: shifts the LEFT eye's whole image vertically, in fractions of the image (positive = up). Vertical misalignment between the eyes is can contribute to one-eye 'something is off' strain: fusional range is tiny vertically. Tune while alternately closing each eye against a horizontal line until the line does not jump.\n\nValue: streamFrame.alignment.leftV (settings.json). Driver side — vertical prism shift for the left eye.")
              }));
              parts.push(fieldRow(t('Eye Alignment Right H'), html`
      <app-number .value=${settings.alignment.rightH} step="0.0005" min="-0.01" max="0.01" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.alignment.rightH = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.alignment.rightH} .min=${-0.01} .max=${0.01} .step=${0.0005} @change=${(e: CustomEvent) => { settings.alignment.rightH = e.detail; save(); }}></app-slider>
              `, {
  tip: t("Move the right-eye image sideways for alignment. Change this carefully and compare both eyes together.\n\nPrism correction: shifts the RIGHT eye's whole image horizontally, in fractions of the image (positive = right).\n\nValue: streamFrame.alignment.rightH (settings.json). Driver side — horizontal prism shift for the right eye.")
              }));
              parts.push(fieldRow(t('Eye Alignment Right V'), html`
      <app-number .value=${settings.alignment.rightV} step="0.0005" min="-0.01" max="0.01" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.alignment.rightV = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.alignment.rightV} .min=${-0.01} .max=${0.01} .step=${0.0005} @change=${(e: CustomEvent) => { settings.alignment.rightV = e.detail; save(); }}></app-slider>
              `, {
  tip: t("Move the right-eye image up or down for alignment. Use small changes and stop if the result is uncomfortable.\n\nPrism correction: shifts the RIGHT eye's whole image vertically, in fractions of the image (positive = up). Usually only ONE eye needs a vertical correction; pick the eye that feels off.\n\nValue: streamFrame.alignment.rightV (settings.json). Driver side — vertical prism shift for the right eye.")
              }));
}
}
}
        parts.push(sectionRow(t('Share Distortion Profile'), sections['share'], 0, () => this.toggleSection('share')));
if (sections.share) {
          parts.push(noteRow(html`<div class="action-row"><span>${t('Save your current profile or import a shared one.')}</span>
            <fluent-button appearance="subtle" @click=${() => this.sharingGuide()}>${t('Import and export')}</fluent-button></div>`));
          parts.push(html`<div class="field share-field">
  <div class="control share-control">
    <div class="share-buttons">
      <fluent-button appearance="outline" @click=${() => galaxy.exportProfile()}>${t('Export current')}</fluent-button>
      <fluent-button appearance="outline" @click=${() => galaxy.importProfile()}>${t('Import from text')}</fluent-button>
      <fluent-button appearance="outline" @click=${() => galaxy.exportJsonFile()}>${t('Export .json')}</fluent-button>
      <fluent-button appearance="outline" @click=${() => this._fileInput && this._fileInput.click()}>${t('Import .json')}</fluent-button>
      <input ${ref(el => { this._fileInput = el as HTMLInputElement | undefined ?? null; })} type="file" accept=".json,application/json" style="display: none" @change=${(e: Event) => { const el = e.target as HTMLInputElement; const f = el.files && el.files[0]; if (f) galaxy.importJsonFile(f); }}>
    </div>
    ${galaxy.shareStatus() ? statusMessage('info', t('Profile transfer'), galaxy.shareStatus()!) : html``}
    <textarea .value=${galaxy.shareText()} rows="6" aria-label=${t('Profile text')} placeholder=${t('Paste a profile or choose Export current')} @input=${(e: Event) => galaxy.shareText.set((e.target as HTMLTextAreaElement).value)}></textarea>
  </div>
</div>`);
}
} else {
        parts.push(sectionHeading(t('Distortion Correction')));
        parts.push(statusMessage('info', t('Image Enhancements is off'),
          t('Enable it in App Settings to use lens correction and profile sharing.'),
          html`<a href="#/app-settings">${t('Open App Settings')}</a>`));
}
}
    return html`<app-system-ready .ctx=${this.ctx}>${this.sectionCardsFor(parts)}</app-system-ready>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-distortion-profile-page': DistortionProfilePage;
  }
}
