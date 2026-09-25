// Stream Frame (Image Settings) page, ported from the Angular template (2026-09-20 Lit/Fluent migration).
// Every conditional, field, tip, reset scope and control binding from the original
// template is preserved 1:1; the only interpretation layer is the control
// adapters (app-switch / app-select / app-number / app-slider) whose events
// were verified against the pinned @fluentui/web-components package.
import { html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { css } from 'lit';
import { BasePage, fieldRow, noteRow, sectionRow, sectionHeading, fieldStyles } from './page-base';
import { t } from '../locale/i18n';
import '../ui/controls';
import './driver-banner';
import './system-ready';

@customElement('app-stream-frame-page')
export class StreamFramePage extends BasePage {
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem 1rem; }
    .calibration-banner { background: #4a3b00; border: 1px solid #a08500; color: #ffe97a; border-radius: 6px; padding: 8px 14px; margin: 8px 0; }
    .rgb-control { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
    .rgb-control span { opacity: 0.75; font-size: 90%; }
    .matrix-control { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
    .matrix-error { color: var(--colorPaletteRedForeground1, #b00020); font-size: 0.85rem; }
    .note-inline { opacity: 0.75; font-size: 0.9rem; }

  `];


  render() {
    const galaxy = this.ctx.galaxy;
    if (!galaxy.settings) return html``;
    const settings = galaxy.settings;
    const defaults = galaxy.defaults;
    const advancedMode = galaxy.advancedMode;
    const vendor = galaxy.vendor;
    const galaxyXr = galaxy.galaxyXr;
    const sections = galaxy.sections();
    const save = () => { galaxy.save(); this.requestUpdate(); };
    const parts: TemplateResult[] = [];
if (settings) {
      parts.push(html`<app-driver-enable-banner .ctx=${this.ctx}></app-driver-enable-banner>`);
if (galaxy.calibrationActive()) {
if (galaxy.calibrationActive()) {
          parts.push(html`<div class="calibration-banner">
    Calibration modes are active. Turn them off before normal play, or use Advanced Mode to adjust them.
    <button type="button" @click=${() => { galaxy.stopCalibration(); this.requestUpdate(); }}>Stop calibration</button>
  </div>`);
}
}
if (vendor) {
        parts.push(sectionHeading(t('Stream Quality')));
        parts.push(fieldRow(t('Stream Quality Preset'), html`
      <app-select .width=${300} .value=${galaxyXr.streamQuality} .options=${[{ value: 'efficient', label: 'Efficient — 1536 tile, 300 Mbit/s (any link)' }, { value: 'balanced', label: 'Balanced — 1536 tile, 350 Mbit/s (recommended)' }, { value: 'vivid', label: 'Vivid — 1536 tile, 400 Mbit/s' }, { value: 'sharp', label: 'Sharp — 1536 tile, 450 Mbit/s (good 6 GHz link, headset permitting)' }, { value: 'max', label: 'Max — 2048 tile, 450 Mbit/s (encode-limited on current GPUs)' }, { value: 'custom', label: 'Custom — set tile and bandwidth yourself' }]} @change=${(e: CustomEvent) => { galaxyXr.streamQuality = e.detail; save(); }}></app-select>
        `, {
  tip: "Choose the video-stream detail and bandwidth preset. Higher settings need more GPU, network, and headset decoding capacity; they do not guarantee a clearer or smoother result.\n\nTile width and bandwidth. The stream is four stacked square tiles of this width per frame (per eye: the whole view downscaled, plus a 1:1 gaze-tracked cut-out of the render target). 1536 keeps the encoder ahead of the streamer on a 3-engine GPU and gets the full bitrate; 2048 is the hard ceiling (4 x 2048 = the codec's 8192-row limit) and is encode-limited today. Bandwidth drives the network pacer and the encoder together; 350 is the streamer's own ceiling, 450 the headset's. Everything else about the encoder is in the Encoder group below and is the same for every tier. Box size and sharpness inside the fovea come from SteamVR supersampling (~200% recommended). Takes effect at the next SteamVR start or headset connect."
        }));
if (galaxyXr.streamQuality === 'custom') {
          parts.push(fieldRow(t('Custom: Tile Width (streamFormatWidth)'), html`
      <app-number .value=${galaxyXr.customStreamFormatWidth} step="512" min="512" max="2048" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.customStreamFormatWidth = e.detail; } save(); }}></app-number>
          `, {
  tip: "Set the custom video tile width. Larger tiles can increase detail and processing load; the driver clamps this value to its supported range.\n\nThe transport tile in pixels: 1536 or 2048. Anything above 2048 is silently clamped by the streamer (four stacked tiles must fit the codec's 8192-row limit). Also sets the profile's maxStreamFormatWidth.",
  reset: { can: galaxyXr.customStreamFormatWidth != 1536, on: () => { galaxyXr.customStreamFormatWidth = 1536; save(); } }
          }));
          parts.push(fieldRow(t('Custom: Bandwidth (Mbit/s)'), html`
      <app-number .value=${galaxyXr.customBandwidthMbit} step="25" min="100" max="600" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.customBandwidthMbit = e.detail; } save(); }}></app-number>
          `, {
  tip: "Set the custom streaming bandwidth budget. Higher bandwidth can improve compression quality only when the connection can sustain it.\n\nWritten to targetBandwidth and recommendedBandwidthMbit (the pacer) and used as the encoder bitrate. The streamer's own request never exceeds 350; above that the encoder is scaled up proportionally. 450 is the headset's practical limit.",
  reset: { can: galaxyXr.customBandwidthMbit != 350, on: () => { galaxyXr.customBandwidthMbit = 350; save(); } }
          }));
}
        parts.push(noteRow(t('Native identity changes take effect after restarting SteamVR.')));
}
parts.push(sectionHeading(t('Image Processing')));
if (galaxy.imageEnhancementsEnabled) {
        parts.push(sectionRow(t('Color'), sections['color'], 1, () => this.toggleSection('color')));
if (sections.color) {
if (galaxy.sdr10BaselineActive()) {
            parts.push(noteRow(t('SDR 10-bit and Image Enhancements are both on. Image quality may be reduced.')));
}
          parts.push(fieldRow(t('Brightness'), html`
      <app-number .value=${settings.brightness} step="0.05" min="0.05" max="1.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.brightness = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.brightness} .min=${0.05} .max=${1.5} .step=${0.05} @change=${(e: CustomEvent) => { settings.brightness = e.detail; save(); }}></app-slider>
          `, {
  tip: "Adjust the overall picture brightness. Lower values darken the image; this is a display preference, not a guarantee about panel lifespan.\n\nScales output brightness in the host image-processing path. Compare against a known neutral setting and avoid compensating for a video-range mismatch with brightness alone. Panel wear depends on many factors; this control does not provide a measured or guaranteed lifespan improvement.",
  reset: { can: settings.brightness != defaults.brightness, on: () => { galaxy.reset('brightness'); } }
          }));
          parts.push(fieldRow(t('Saturation'), html`
      <app-number .value=${settings.saturation} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.saturation = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.saturation} .min=${0} .max=${100} .step=${1} @change=${(e: CustomEvent) => { settings.saturation = e.detail; save(); }}></app-slider>
          `, {
  tip: "Adjust the strength of colors. The neutral value keeps the original color saturation.\n\nIncrease or decrease the variation of the colors. 50 is neutral, 0 is grayscale.",
  reset: { can: settings.saturation != defaults.saturation, on: () => { galaxy.reset('saturation'); } }
          }));
          parts.push(fieldRow(t('Vibrance'), html`
      <app-number .value=${settings.vibrance} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.vibrance = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.vibrance} .min=${-100} .max=${100} .step=${1} @change=${(e: CustomEvent) => { settings.vibrance = e.detail; save(); }}></app-slider>
          `, {
  tip: "Boost quieter colors without changing all colors equally. Use small adjustments to avoid an unnatural-looking picture.\n\nSmart saturation: changes muted colors the most and already vivid colors the least. Positive enriches dull colors with far less clipping and skin tone blowout than raw saturation; negative fades muted colors toward gray while vivid accents remain. 0 is off, stacks with Saturation.",
  reset: { can: settings.vibrance != defaults.vibrance, on: () => { galaxy.reset('vibrance'); } }
          }));
          parts.push(fieldRow(t('Contrast'), html`
      <app-number .value=${settings.contrast} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.contrast = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.contrast} .min=${0} .max=${100} .step=${1} @change=${(e: CustomEvent) => { settings.contrast = e.detail; save(); }}></app-slider>
          `, {
  tip: "Adjust the difference between light and dark areas. Stronger contrast can hide details in shadows or highlights.\n\nContrast around the midpoint. 50 is neutral.",
  reset: { can: settings.contrast != defaults.contrast, on: () => { galaxy.reset('contrast'); } }
          }));
          parts.push(fieldRow(t('Contrast Midpoint'), html`
      <app-number .value=${settings.contrastMidpoint} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.contrastMidpoint = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.contrastMidpoint} .min=${0} .max=${100} .step=${1} @change=${(e: CustomEvent) => { settings.contrastMidpoint = e.detail; save(); }}></app-slider>
          `, {
  tip: "Choose the brightness level around which contrast is adjusted. Change this only when the normal contrast control does not give the desired balance.\n\nThe brightness level from 0 to 100 percent of white that the contrast pivots around.",
  reset: { can: settings.contrastMidpoint != defaults.contrastMidpoint, on: () => { galaxy.reset('contrastMidpoint'); } }
          }));
          parts.push(fieldRow(t('Linear Contrast'), html`
      <app-switch .checked=${!!settings.contrastLinear} @change=${(e: CustomEvent) => { settings.contrastLinear = e.detail; save(); }}></app-switch>
          `, {
  tip: "Apply contrast in linear light rather than the usual display-encoded space. This changes the effect of the contrast control.\n\nApply the contrast in linear space instead of gamma space.",
  reset: { can: settings.contrastLinear != defaults.contrastLinear, on: () => { galaxy.reset('contrastLinear'); } }
          }));
          parts.push(fieldRow(t('Gamma'), html`
      <app-number .value=${settings.gamma} step="0.01" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.gamma = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.gamma} .min=${1.2} .max=${3.2} .step=${0.01} @change=${(e: CustomEvent) => { settings.gamma = e.detail; save(); }}></app-slider>
          `, {
  tip: "Adjust midtone brightness without using the overall brightness control. The neutral pipeline value is 2.2.\n\nGamma of the output. 2.2 is neutral, lower brightens midtones.",
  reset: { can: settings.gamma != defaults.gamma, on: () => { galaxy.reset('gamma'); } }
          }));
          parts.push(fieldRow(t('Color Multiplier'), html`
      <span>R</span>
      <app-number .value=${settings.colorMultiplier.r} step="0.01" min="0" max="2" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.colorMultiplier.r = e.detail; } save(); }}></app-number>
      <span>G</span>
      <app-number .value=${settings.colorMultiplier.g} step="0.01" min="0" max="2" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.colorMultiplier.g = e.detail; } save(); }}></app-number>
      <span>B</span>
      <app-number .value=${settings.colorMultiplier.b} step="0.01" min="0" max="2" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.colorMultiplier.b = e.detail; } save(); }}></app-number>
          `, {
  tip: "Adjust the red, green, and blue channels separately to correct a color tint. 1 on every channel leaves the balance unchanged.\n\nPer channel tint multiplier applied to the image. 1 for each channel is neutral.",
  reset: { can: settings.colorMultiplier.r != defaults.colorMultiplier.r || settings.colorMultiplier.g != defaults.colorMultiplier.g || settings.colorMultiplier.b != defaults.colorMultiplier.b, on: () => { galaxy.reset('colorMultiplier'); } }
          }));
          parts.push(fieldRow(t('Color Matrix'), html`
      <input type="text" .value=${galaxy.matrixText()} placeholder="empty = disabled" @input=${(e: Event) => { galaxy.onMatrixTextChanged((e.target as HTMLInputElement).value) }}></input>
      ${galaxy.matrixError() ? html`<span class="matrix-error">${galaxy.matrixError()}</span>` : html``}
          `, {
  tip: "Apply a nine-value color correction matrix. This is an advanced calibration tool; an incorrect matrix can strongly distort colors.\n\nOptional 3x3 linear rgb matrix, row major, 9 comma separated numbers. Used for gamut or white point correction. Leave empty to disable.",
  reset: { can: settings.srgbMatrix.length != 0, on: () => { galaxy.reset('srgbMatrix'); } }
          }));
}
        parts.push(sectionRow(t('Image Enhancements'), sections['enhance'], 1, () => this.toggleSection('enhance')));
if (sections.enhance) {
          parts.push(fieldRow(t('FXAA Anti-Aliasing'), html`
      <app-select .value=${settings.fxaa} .options=${[{ value: 'off', label: 'Off' }, { value: 'fast', label: 'Fast - in-pass (single pass, lightest)' }, { value: 'quality', label: 'Quality - separate pre-pass (best edges)' }]} @change=${(e: CustomEvent) => { settings.fxaa = e.detail; save(); }}></app-select>
          `, {
  tip: "Reduce jagged edges with a post-processing filter. The quality mode does more work than the fast mode and may cost performance.\n\nFXAA applied BEFORE CAS so sharpening enhances resolved edges instead of amplifying jagged staircases. Best for titles with heavy edge shimmer (specular geometry, foliage, thin railings); slightly softens fine text - leave off for text-heavy apps. Fast: integrated into the main pass; CAS sharpens raw neighbors around the AA-resolved center (can faintly re-jag very strong edges at high CAS strength). Quality: a separate FXAA pre-pass, so CAS sees fully resolved edges - costs one extra full-frame pass and VRAM for an intermediate texture; falls back to Fast automatically (with a log line) if the pass shader or intermediate is unavailable. Check 'pixel shader ready (... fxaa: yes, fxaaPass: yes)' in the log after updating.",
  reset: { can: settings.fxaa != defaults.fxaa, on: () => { galaxy.reset('fxaa'); } }
          }));
          parts.push(fieldRow(t('CAS Sharpening'), html`
      <app-select .width=${300} .value=${galaxy.casMode} .options=${[{ value: 'off', label: 'Off' }, { value: 'postpack', label: 'Post-pack — on the encoded frame (recommended)' }, { value: 'preencode', label: 'Pre-encode — full-resolution pass (AMD / tap off)' }]} @change=${(e: CustomEvent) => { galaxy.casMode = e.detail; save(); }}></app-select>
          `, {
  tip: "Choose where contrast-adaptive sharpening is applied. The modes use different processing paths; avoid adding the same sharpening twice.\n\nContrast adaptive sharpening. POST-PACK (recommended, NVIDIA + NVENC Tap): runs on the frame the encoder actually sends - the foveated transport image - with separate strengths for the gaze region and the periphery; the periphery is sharpened after Steam Link downscales it, so it survives to the panel, at ~0.04 ms per frame. PRE-ENCODE: the older full-resolution pass on the eye textures; only for AMD GPUs or with the NVENC Tap off. Never run both."
          }));
if (galaxy.casMode === 'postpack' && !settings.nvencTap) {
            parts.push(noteRow(html`Post-pack sharpening needs the NVENC Tap (Headset &rarr; Encoder). With the tap off nothing is sharpened; choose Pre-encode instead.`));
}
if (galaxy.casMode === 'postpack') {
            parts.push(fieldRow(t('Fovea Strength'), html`
      <app-number .value=${settings.postPack.foveaStrength} step="0.05" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.postPack.foveaStrength = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.postPack.foveaStrength} .min=${0} .max=${1} .step=${0.05} @change=${(e: CustomEvent) => { settings.postPack.foveaStrength = e.detail; save(); }}></app-slider>
            `, {
  tip: "Adjust sharpening in the high-detail center of the streamed image. Too much sharpening can create bright outlines or noise.\n\nSharpening for the gaze cut-out tile (1:1 render-target pixels), 0 to 1. Under CBR sharpening costs bits: spend them here.",
  reset: { can: settings.postPack.foveaStrength != 0.6, on: () => { settings.postPack.foveaStrength = 0.6; save(); } }
            }));
            parts.push(fieldRow(t('Periphery Strength'), html`
      <app-number .value=${settings.postPack.peripheryStrength} step="0.05" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.postPack.peripheryStrength = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.postPack.peripheryStrength} .min=${0} .max=${1} .step=${0.05} @change=${(e: CustomEvent) => { settings.postPack.peripheryStrength = e.detail; save(); }}></app-slider>
            `, {
  tip: "Adjust sharpening outside the high-detail center. This affects the lower-detail edges of the streamed image.\n\nSharpening for the downscaled whole-view tile, 0 to 1. Applied after the downscale, so it is visible on the panel; keep it lower than the fovea to avoid haloing on the stretched periphery.",
  reset: { can: settings.postPack.peripheryStrength != 0.3, on: () => { settings.postPack.peripheryStrength = 0.3; save(); } }
            }));
            parts.push(fieldRow(t('Fovea Edge Falloff'), html`
      <app-number .value=${settings.postPack.edgeFalloff} step="0.02" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.postPack.edgeFalloff = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.postPack.edgeFalloff} .min=${0} .max=${0.5} .step=${0.02} @change=${(e: CustomEvent) => { settings.postPack.edgeFalloff = e.detail; save(); }}></app-slider>
            `, {
  tip: "Smooth the transition between center and edge sharpening. Use this when a visible boundary appears around the sharp region.\n\nFraction of the fovea tile (0 to 0.5) over which its sharpening ramps down to the periphery strength at the tile border, so the seam where the headset composites the cut-out over the stretched periphery is not a sharpness step. 0 = hard edge. Raise if a halo is visible around the fovea region.",
  reset: { can: settings.postPack.edgeFalloff != 0.12, on: () => { settings.postPack.edgeFalloff = 0.12; save(); } }
            }));
            parts.push(fieldRow(t('Fovea Tile On Top'), html`
      <app-switch .checked=${!!settings.postPack.foveaTop} @change=${(e: CustomEvent) => { settings.postPack.foveaTop = e.detail; save(); }}></app-switch>
            `, {
  tip: "Adjust sharpening for the upper and lower center tiles. These values fine-tune the streamed image layout.\n\nWhich tile of each eye's pair is the gaze cut-out. On = upper tile (what the streamer's shader indicates). If the wrong region looks sharpened - e.g. periphery crisp, fovea soft - flip this."
            }));
}
if (galaxy.casMode === 'preencode') {
            parts.push(fieldRow(t('Per Eye Strength'), html`
      <app-switch .checked=${!!settings.cas.perEye} @change=${(e: CustomEvent) => { settings.cas.perEye = e.detail; save(); }}></app-switch>
            `, {
  tip: "Use different sharpening values for the left and right eye. Leave linked unless you need an eye-specific correction.\n\nSharpen each eye independently. Useful when one eye sits slightly off its lens axis (facial asymmetry) and only that eye needs extra sharpening to mask the mild off-axis blur; the other eye is spared the over-sharpening."
            }));
if (!settings.cas.perEye) {
              parts.push(fieldRow(t('CAS Strength'), html`
      <app-number .value=${settings.cas.strength} step="0.05" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.cas.strength = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.cas.strength} .min=${0} .max=${1} .step=${0.05} @change=${(e: CustomEvent) => { settings.cas.strength = e.detail; save(); }}></app-slider>
              `, {
  tip: "Set the overall sharpening strength. Higher values can improve apparent detail but may also amplify noise or create halos.\n\nStrength of the sharpening from 0 to 1."
              }));
}
if (settings.cas.perEye) {
              parts.push(fieldRow(t('Strength Left'), html`
      <app-number .value=${settings.cas.strengthLeft} step="0.05" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.cas.strengthLeft = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.cas.strengthLeft} .min=${0} .max=${1} .step=${0.05} @change=${(e: CustomEvent) => { settings.cas.strengthLeft = e.detail; save(); }}></app-slider>
              `, {
  tip: "Set sharpening strength for the left eye. Compare both eyes to avoid an uneven-looking image.\n\nSharpening strength for the left eye only, 0 to 1."
              }));
              parts.push(fieldRow(t('Strength Right'), html`
      <app-number .value=${settings.cas.strengthRight} step="0.05" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.cas.strengthRight = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.cas.strengthRight} .min=${0} .max=${1} .step=${0.05} @change=${(e: CustomEvent) => { settings.cas.strengthRight = e.detail; save(); }}></app-slider>
              `, {
  tip: "Set sharpening strength for the right eye. Compare both eyes to avoid an uneven-looking image.\n\nSharpening strength for the right eye only, 0 to 1."
              }));
}
}
          parts.push(fieldRow(t('Dither'), html`
      <app-switch .checked=${!!settings.dither} @change=${(e: CustomEvent) => { settings.dither = e.detail; save(); }}></app-switch>
          `, {
  tip: "Add a small amount of noise to make color banding less obvious. It can improve smooth gradients but does not add real color detail.\n\nAdds a small amount of noise before the encode to reduce banding in dark gradients.",
  reset: { can: settings.dither != defaults.dither, on: () => { galaxy.reset('dither'); } }
          }));
          parts.push(fieldRow(t('Stationary Dimming'), html`
      <app-switch .checked=${!!settings.stationaryDimming.enable} @change=${(e: CustomEvent) => { settings.stationaryDimming.enable = e.detail; save(); }}></app-switch>
          `, {
  tip: "Dim the picture when the headset is not moving. This reduces visible brightness during still periods rather than pausing the game.\n\nFades the streamed image uniformly toward black when the headset has not moved for the configured time, then restores brightness on movement. This reduces time spent showing a bright stationary image; it does not guarantee protection from panel wear. Tracking and the game can continue while the picture is dimmed."
          }));
if (settings.stationaryDimming.enable) {
            parts.push(fieldRow(t('Dimming Timing'), html`
      <span>after</span>
      <app-number .value=${settings.stationaryDimming.movementTime} step="1" min="2" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.stationaryDimming.movementTime = e.detail; } save(); }}></app-number>
      <span>fade</span>
      <app-number .value=${settings.stationaryDimming.dimSeconds} step="1" min="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.stationaryDimming.dimSeconds = e.detail; } save(); }}></app-number>
            `, {
  tip: "Set how long the headset must stay still before dimming starts and how quickly the picture fades.\n\nSeconds of stillness before dimming starts, and seconds to fade fully to black."
            }));
}
}
} else {
        parts.push(noteRow(galaxy.baselineRequested
          ? html`<strong>${t('SDR 10-bit baseline is on. Image Enhancements is off.')}</strong>
              ${t('Enable Image Enhancements in App Settings and accept the image-quality warning to adjust the picture while keeping the 10-bit request.')}
              <a href="#/app-settings">${t('Open App Settings')}</a>`
          : html`${t('Enable Image Enhancements in App Settings to adjust color and sharpening. Turn enhancements off before enabling SDR 10-bit baseline.')}
              <a href="#/app-settings">${t('Open App Settings')}</a>`));
}
if (advancedMode) {
        parts.push(sectionRow(t('Advanced'), sections['advanced'], 0, () => this.toggleSection('advanced')));
if (sections.advanced) {
          parts.push(fieldRow(t('Sync Timeout (ms)'), html`
      <app-number .value=${settings.syncTimeoutMs} step="1" min="1" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.syncTimeoutMs = e.detail; } save(); }}></app-number>
          `, {
  tip: "Skip a synchronization wait in the image-processing path. This is a latency experiment and can cause flashes or other display artifacts.\n\nHow long to wait for the frame sync before letting a frame through unprocessed (a brief 'flash' of ungraded color). Higher values trade flashes under heavy load for slightly later frames. After a skipped frame the wait automatically escalates to break flash streaks. Default 10, sensible range 3-15.",
  reset: { can: settings.syncTimeoutMs != defaults.syncTimeoutMs, on: () => { galaxy.reset('syncTimeoutMs'); } }
          }));
          parts.push(fieldRow(t('Gaze Prediction (ms)'), html`
      <app-number .value=${settings.eyeGaze.predictionMs} step="5" min="0" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.eyeGaze.predictionMs = e.detail; } save(); }}></app-number>
          `, {
  tip: "Adjust how far ahead eye movement is predicted for processing. Too much prediction can place the correction ahead of your actual gaze.\n\nLeads the gaze point by extrapolating recent eye motion, compensating the capture-to-display latency that makes the ring trail your eyes. Raise if the ring lags behind saccades, lower if it overshoots. 0 disables."
          }));
          parts.push(fieldRow(t('Direct Render Path'), html`
      <app-switch .checked=${!!settings.directRender} @change=${(e: CustomEvent) => { settings.directRender = e.detail; save(); }}></app-switch>
          `, {
  tip: "Request a more direct rendering path. Performance and compatibility depend on the runtime; compare carefully before leaving it enabled.\n\nPerformance: draws the processed frame directly into the layer texture instead of a scratch target plus copy-back (about a third less GPU memory traffic). Falls back automatically per texture if a layer refuses a render target view. Only turn off to A/B against the old path; the log line 'direct render path' / 'copy-back path' shows which is active per app.",
  reset: { can: settings.directRender != defaults.directRender, on: () => { galaxy.reset('directRender'); } }
          }));
          parts.push(fieldRow(t('Deferred Scratch Eviction'), html`
      <app-switch .checked=${!!settings.deferredEviction} @change=${(e: CustomEvent) => { settings.deferredEviction = e.detail; save(); }}></app-switch>
          `, {
  tip: "Keep cached resources longer to try to reduce short stutters. This changes resource handling and may use more memory.\n\nPerformance: when the scratch texture cache is full and a new resolution arrives, the old set's release is postponed a few frames and performed after the frame sync mutex is released, instead of inside the same frame that already pays the unavoidable creation stall. Spreads transition cost so resolution/app switches hitch less. Off restores the old synchronous eviction for A/B; score the difference with Hitch Diagnostics on ('creates'/'evicts' counters and HITCH tags mark the transitions).",
  reset: { can: settings.deferredEviction != defaults.deferredEviction, on: () => { galaxy.reset('deferredEviction'); } }
          }));
          parts.push(fieldRow(t('Process At Submit Layer'), html`
      <app-switch .checked=${!!settings.processAtSubmitLayer} @change=${(e: CustomEvent) => { settings.processAtSubmitLayer = e.detail; save(); }}></app-switch>
          `, {
  tip: "Choose an alternate point in the rendering pipeline for image processing. This is a compatibility and performance experiment.\n\nProcesses frames during SubmitLayer instead of Present. Only needed if processing at Present has no visible effect on your driver.",
  reset: { can: settings.processAtSubmitLayer != defaults.processAtSubmitLayer, on: () => { galaxy.reset('processAtSubmitLayer'); } }
          }));
          parts.push(fieldRow(t('Blackout Headset Screens'), html`
      <app-switch .checked=${!!settings.calib?.blackout} ?disabled=${!settings.enable} @change=${(e: CustomEvent) => { galaxy.setBlackout(e.detail); }}></app-switch>
      ${!settings.enable ? html`<span class="note">enable Image Processing first</span>` : html``}
          `, {
  tip: "Make the headset image black while keeping tracking and the game running. Use this for testing, not as a way to stop or pause the application.\n\nBlack out the headset's screens to protect from burn in. Tracking, streaming and the game keep running; only the panels go black. Useful while developing or leaving the headset connected. Needs Enable Image Processing on.",
  reset: { can: !!settings.calib?.blackout, on: () => { galaxy.setBlackout(false); } }
          }));
}
        parts.push(sectionRow(t('Debug'), sections['debug'], 0, () => this.toggleSection('debug')));
if (sections.debug) {
          parts.push(fieldRow(t('Black Floor: Diagnostic Ramp Bar'), html`
      <app-switch .checked=${!!settings.blackFloor.rampBar} @change=${(e: CustomEvent) => { settings.blackFloor.rampBar = e.detail; save(); }}></app-switch>
          `, {
  tip: "Show grayscale ramps and near-black patches to help judge shadow detail and video levels. Turn the test pattern off for normal play.\n\nDraws two near-black test strips per eye (17 patches, sRGB codes 0 to 32 in steps of 2, white ticks over codes 0/8/16/24/32): one across screen center and one near the bottom."
          }));
          parts.push(fieldRow(t('Black Floor: Black Point (sRGB code)'), html`
      <app-number .value=${settings.blackFloor.blackPointCode} step="0.5" min="0" max="24" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.blackFloor.blackPointCode = e.detail; } save(); }}></app-number>
          `, {
  tip: "Remap the darkest part of the picture. Too much correction can erase shadow detail; compare against the near-black test patches.\n\nAdjustable black level: remaps [BP, 255] onto [0, 255], darkening blacks. Calibration recipe: turn the Ramp Bar on, raise BP until the two darkest patches just merge into one black, then back off one notch, that is maximum contrast with zero crushed detail."
          }));
          parts.push(fieldRow(t('Hitch Diagnostics (HITCHDIAG)'), html`
      <app-switch .checked=${!!settings.hitchDiag} @change=${(e: CustomEvent) => { settings.hitchDiag = e.detail; save(); }}></app-switch>
          `, {
  tip: "Record information about frame-time spikes. Enable it while reproducing stutters, then turn it off to limit log size and overhead.\n\nRender-side cadence instrumentation, the frame-path analog of KALDIAG. Every 2 seconds a HITCHDIAG log line summarizes the frame callback rhythm: mean/max gap between frames, counts over 16.7ms and 33ms, sync-mutex wait, this driver's own work time, and skip/scratch-create/evict counters. Any single gap over 25ms also logs a one-shot HITCH line tagged with what the previous frame did (scratch creation, distortion LUT bake, shader compile, sync skip) so stutters name their own cause.",
  reset: { can: settings.hitchDiag != defaults.hitchDiag, on: () => { galaxy.reset('hitchDiag'); } }
          }));
          parts.push(fieldRow(t('Gaze Debug Ring'), html`
      <app-switch .checked=${!!settings.eyeGaze.debugRing} @change=${(e: CustomEvent) => { settings.eyeGaze.debugRing = e.detail; save(); }}></app-switch>
          `, {
  tip: "Show where eye tracking reports you are looking. Eye tracking and the appropriate Steam Link sharing setting must be available.\n\nDraws a small red ring where the eye tracker says you are looking (requires SteamVR's Steam Link tab's 'Share ET data with other apps' to be on).",
  reset: { can: settings.eyeGaze.debugRing != defaults.eyeGaze.debugRing, on: () => { galaxy.reset('eyeGaze'); } }
          }));
          parts.push(fieldRow(t('Pose Logging (diagnostic)'), html`
      <app-switch .checked=${!!settings.poseLogging} @change=${(e: CustomEvent) => { settings.poseLogging = e.detail; save(); }}></app-switch>
          `, {
  tip: "Record tracking samples for troubleshooting or calibration. Logs can contain movement data and may become large.\n\nWrites throttled controller pose lines to vrserver.txt (positions, reported vs position-derived velocity, tracking state), with burst capture during fast motion. Only needed when collecting data for a report; leave off otherwise.",
  reset: { can: settings.poseLogging != defaults.poseLogging, on: () => { galaxy.reset('poseLogging'); } }
          }));
          parts.push(fieldRow(t('Pose Logging: Burst Channel'), html`
      <app-switch .checked=${!!settings.poseLogBurst} @change=${(e: CustomEvent) => { settings.poseLogBurst = e.detail; save(); }}></app-switch>
          `, {
  tip: "Record a short, high-detail burst of tracking samples. The extra work can itself cause stutters, so use it only for a focused test.\n\nHigh-rate diagnostic lines (up to 100/s per device) during fast motion, on top of Pose Logging. Log storms during hard throws can hitch the game/stream, so leave this off unless a session is specifically collecting throw diagnostics.",
  reset: { can: settings.poseLogBurst != defaults.poseLogBurst, on: () => { galaxy.reset('poseLogBurst'); } }
          }));
}
if (vendor) {
        parts.push(sectionHeading(t('Encoder')));
        parts.push(fieldRow(t('NVENC Tap'), html`
      <app-switch .checked=${!!settings.nvencTap} @change=${(e: CustomEvent) => { settings.nvencTap = e.detail; save(); }}></app-switch>
            `, {
  tip: "Allow this driver to adjust NVIDIA's video encoder. These controls require a supported NVIDIA encoder path and may need a new stream connection.\n\nHooks the streamer's video encoder setup and applies the settings below on every encoder init and reconfigure. Every change is tried once and, if the encoder rejects it, retried with the streamer's own values, so the worst case is stock behaviour plus a log line. Off = stock streamer (the tier then only sets tile width and bandwidth). Requires an NVIDIA GPU; turn on BEFORE launching SteamVR.",
  reset: { can: settings.nvencTap != defaults.nvencTap, on: () => { galaxy.reset('nvencTap'); } }
            }));
if (settings.nvencTap) {
              parts.push(sectionRow(t('Advanced'), sections['encoderAdv'], 1, () => this.toggleSection('encoderAdv')));
if (sections.encoderAdv) {
                parts.push(fieldRow(t('Bandwidth Override (Mbit/s)'), html`
      <app-number .value=${settings.nvencBandwidthOverrideMbit} step="25" min="0" max="600" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencBandwidthOverrideMbit = e.detail; } save(); }}></app-number>
                `, {
  tip: "Override the normal stream bandwidth budget. 0 uses the selected stream preset instead of forcing a separate value.\n\n0 follows the tier (or custom) bandwidth. Nonzero writes both the network pacer and the encoder bitrate at once, replacing the tier value.",
  reset: { can: settings.nvencBandwidthOverrideMbit != defaults.nvencBandwidthOverrideMbit, on: () => { galaxy.reset('nvencBandwidthOverrideMbit'); } }
                }));
                parts.push(fieldRow(t('VBV Frames'), html`
      <app-number .value=${settings.nvencVbvFrames} step="1" min="0" max="30" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencVbvFrames = e.detail; } save(); }}></app-number>
                `, {
  tip: "Set how much video the encoder may buffer. A smaller buffer can reduce delay but makes sudden complex scenes harder to encode cleanly.\n\nVBV = average bitrate per frame times this, which bounds how large any single frame can be. 2 caps vegetation peaks and reset key frames at about two frame budgets, far below the streamer's 2 MB send limit. 0 leaves the streamer's value.",
  reset: { can: settings.nvencVbvFrames != defaults.nvencVbvFrames, on: () => { galaxy.reset('nvencVbvFrames'); } }
                }));
                parts.push(fieldRow(t('Preset Override (P1-P7)'), html`
      <app-number .value=${settings.nvencPreset} step="1" min="0" max="7" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencPreset = e.detail; } save(); }}></app-number>
                `, {
  tip: "Choose the NVIDIA encoding preset. Keep automatic selection unless you are testing a specific quality or latency trade-off.\n\n0 = automatic by NVENC engine count (3 engines: P7, 2: P5, 1: P4; logged as 'preset AUTO'). Higher presets spend more encoder time for better quality at the same bitrate; P7 needs the split across three engines to hold 90 fps.",
  reset: { can: settings.nvencPreset != defaults.nvencPreset, on: () => { galaxy.reset('nvencPreset'); } }
                }));
                parts.push(fieldRow(t('Force CBR'), html`
      <app-switch .checked=${!!settings.nvencForceCbr} @change=${(e: CustomEvent) => { settings.nvencForceCbr = e.detail; save(); }}></app-switch>
                `, {
  tip: "Force constant-bitrate encoding. This changes how the encoder spends its bandwidth budget and can alter image quality and latency.\n\nSwitches rate control to constant bitrate with low-delay key-frame scaling. Every frame gets the same budget, so complex scenes get slightly coarser instead of larger and later. Recommended on.",
  reset: { can: settings.nvencForceCbr != defaults.nvencForceCbr, on: () => { galaxy.reset('nvencForceCbr'); } }
                }));
                parts.push(fieldRow(t('CBR Key Frame Budget (x frames)'), html`
      <app-number .value=${settings.nvencLowDelayKfScale} step="1" min="1" max="4" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencLowDelayKfScale = e.detail; } save(); }}></app-number>
                `, {
  tip: "Limit the size of keyframes, which refresh the whole video picture. Large keyframes can create brief network or decoding spikes.\n\nWith Force CBR: how many P-frame budgets the key frame after an encoder reset may spend (1-4). 2 fits inside VBV Frames 2 and gives a sharper key frame than 1.",
  reset: { can: settings.nvencLowDelayKfScale != defaults.nvencLowDelayKfScale, on: () => { galaxy.reset('nvencLowDelayKfScale'); } }
                }));
                parts.push(fieldRow(t('Split-Frame Encoding'), html`
      <app-number .value=${settings.nvencSplitMode} step="1" min="0" max="15" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencSplitMode = e.detail; } save(); }}></app-number>
                `, {
  tip: "Allow multiple NVIDIA encoder engines to share the work, where supported. Availability depends on the GPU and encoding mode.\n\nSpreads each frame across the GPU's NVENC engines. The driver only does this by itself for presets P1-P4; higher presets need it forced or they drop to ~50 fps. 1 = forced, driver picks the strip count (measured best); 2-4 force that many strips; 15 disables; 0 leaves the driver's choice. Nonzero opens the encoder session as API 12.1 (look for 'SESSION UPGRADE' in the log).",
  reset: { can: settings.nvencSplitMode != defaults.nvencSplitMode, on: () => { galaxy.reset('nvencSplitMode'); } }
                }));
                parts.push(fieldRow(t('Foveated QP: Fovea / Periphery Delta'), html`
      <app-number .value=${settings.nvencQpFovea} step="1" min="-10" max="0" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencQpFovea = e.detail; } save(); }}></app-number>
      <app-number .value=${settings.nvencQpPeriphery} step="1" min="0" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencQpPeriphery = e.detail; } save(); }}></app-number>
                `, {
  tip: "Spend more encoding quality on the center of the image than on the edges. This advanced option can change artifacts in different areas.\n\nMoves bits within the same bitrate: a QP offset per block, negative for the gaze cut-out tile (finer, more bits) and positive for the periphery tile (coarser, fewer bits), blended over the same edge falloff as the sharpening. 0 / 0 = off. Small values (-2 / 2, -3 / 3) work; large ones starve the whole frame.",
  reset: { can: settings.nvencQpFovea != 0 || settings.nvencQpPeriphery != 0, on: () => { settings.nvencQpFovea = 0; settings.nvencQpPeriphery = 0; save(); } }
                }));
                parts.push(fieldRow(t('Limited Range Video (fixes the black floor)'), html`
      <app-switch .checked=${!!settings.postPack.limitedRange} @change=${(e: CustomEvent) => { settings.postPack.limitedRange = e.detail; settings.postPack.enable = settings.postPack.enable || settings.postPack.limitedRange; save(); }}></app-switch>
                `, {
  tip: "Correct a mismatch between full-range and limited-range video levels. Use this only to diagnose washed-out blacks or crushed shadows; it requires the NVIDIA encoder adjustment path.\n\nSteam Link produces full-range video; the Galaxy XR client handles full-range imperfectly and lifts the 'black floor'. This remaps luma to 16-235 and chroma to 16-240 on the packed frame and tags the stream as limited range, so the headset expands it on its standard path. Measured to fix the black floor with the xrvst2ue-identity APK (no effect on the older Quest-Pro-identity build). Needs the NVENC Tap.",
  reset: { can: settings.postPack.limitedRange != true, on: () => { settings.postPack.limitedRange = true; settings.postPack.enable = settings.postPack.enable || true; save(); } }
                }));
                parts.push(sectionRow(t('Debug'), sections['encoderDbg'], 2, () => this.toggleSection('encoderDbg')));
if (sections.encoderDbg) {
                  parts.push(fieldRow(t('vrlink Debug Overlay'), html`
      <app-switch .checked=${!!galaxyXr.vrlinkDebugOverlay} @change=${(e: CustomEvent) => { galaxyXr.vrlinkDebugOverlay = e.detail; save(); }}></app-switch>
                  `, {
  tip: "Show the encoder's diagnostic overlay. Turn it off for normal play after collecting the information you need.\n\nDisplays a coloured overlay on the foveated area and the streamer's advanced graphs (encode time, RFOV %). Diagnostic only; takes effect at the next connect."
                  }));
                  parts.push(fieldRow(t('NVENC: Fix Level'), html`
      <app-switch .checked=${!!settings.nvencFixLevel} @change=${(e: CustomEvent) => { settings.nvencFixLevel = e.detail; save(); }}></app-switch>
                  `, {
  tip: "Let the encoder choose an HEVC level and tier suitable for the stream. Incorrect manual choices can prevent a stream from starting.\n\nSets HEVC level to auto-select and tier to High on every encoder init and reconfigure. The streamer hardcodes level 6.1, which the 8192-row canvas exceeds at 90 Hz, so its reconfigures were being rejected. Keep on.",
  reset: { can: settings.nvencFixLevel != defaults.nvencFixLevel, on: () => { galaxy.reset('nvencFixLevel'); } }
                  }));
                  parts.push(fieldRow(t('Peak Headroom (%)'), html`
      <app-number .value=${settings.nvencMaxBitrateHeadroomPct} step="5" min="0" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencMaxBitrateHeadroomPct = e.detail; } save(); }}></app-number>
                  `, {
  tip: "Allow temporary bitrate peaks above the target budget. This mainly affects modes that are not strict constant bitrate.\n\nPeak bitrate over the average, in percent. Only meaningful without Force CBR (under CBR peak = average). 0 measured safe.",
  reset: { can: settings.nvencMaxBitrateHeadroomPct != defaults.nvencMaxBitrateHeadroomPct, on: () => { galaxy.reset('nvencMaxBitrateHeadroomPct'); } }
                  }));
                  parts.push(fieldRow(t('Force Frame Rate'), html`
      <app-number .value=${settings.nvencForceFps} step="1" min="0" max="120" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencForceFps = e.detail; } save(); }}></app-number>
                  `, {
  tip: "Set the frame-rate value used for encoder budgeting. Match the intended stream rate; changing this alone does not change the headset refresh rate.\n\nPins the encoder's frame rate so the per-frame budget is constant. Without it the streamer passes its momentary estimate (down to 12 fps while hitching) and under CBR the next key frame balloons. Recommended 90. 0 leaves the streamer's value.",
  reset: { can: settings.nvencForceFps != defaults.nvencForceFps, on: () => { galaxy.reset('nvencForceFps'); } }
                  }));
                  parts.push(fieldRow(t('Encoder Bitrate (separate, Mbit/s)'), html`
      <app-number .value=${settings.nvencBitrateMbit} step="25" min="0" max="600" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencBitrateMbit = e.detail; } save(); }}></app-number>
                  `, {
  tip: "Override only the encoder's bitrate budget. This does not automatically change network pacing, so mismatched values can cause problems.\n\n0 = the encoder bitrate equals the pacer bandwidth (normal). Nonzero sets only the encoder, for experiments where the pacer and the encoder should differ.",
  reset: { can: settings.nvencBitrateMbit != defaults.nvencBitrateMbit, on: () => { galaxy.reset('nvencBitrateMbit'); } }
                  }));
                  parts.push(fieldRow(t('NVENC: Verbose Log'), html`
      <app-switch .checked=${!!settings.nvencVerbose} @change=${(e: CustomEvent) => { settings.nvencVerbose = e.detail; save(); }}></app-switch>
                  `, {
  tip: "Write detailed NVIDIA encoder diagnostics to the log. Use this for troubleshooting; extra logging can add overhead and large files.\n\nLogs every reconfigure and hex-dumps the encoder structs. For offline decoding of driver_vrlink's encoder setup; leave off.",
  reset: { can: settings.nvencVerbose != defaults.nvencVerbose, on: () => { galaxy.reset('nvencVerbose'); } }
                  }));
}
}
}
}
if (settings.graveyardEnable) {
          parts.push(sectionRow(t('Graveyard (retired experiments)'), sections['graveyard'], 0, () => this.toggleSection('graveyard')));
if (sections.graveyard) {
            parts.push(fieldRow(t('Kalman Freeze Coast Turn'), html`
      <app-number .value=${settings.kalmanFreezeCoastTurn} step="0.25" min="0" max="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanFreezeCoastTurn = e.detail; } save(); }}></app-number>
            `, {
  tip: "Try a custom curve for how motion continues during a tracking interruption. This is experimental and may make brief tracking losses feel worse.\n\nExperimental. While the tracker sends frozen positions with a live rotation (fast swings), bend the coasted hand path by the current angular velocity instead of coasting in a straight line. 0 = off (default), 1 = full coupling.",
  reset: { can: settings.kalmanFreezeCoastTurn != defaults.kalmanFreezeCoastTurn, on: () => { galaxy.reset('kalmanFreezeCoastTurn'); } }
            }));
            parts.push(fieldRow(t('Kalman Direction Lead (ms)'), html`
      <span>Td</span>
      <app-number .value=${settings.kalmanDirLeadMs} ?disabled=${true}></app-number>
      <span class="note">locked at 0 since 1.0.0 (angular frame fix)</span>
            `, {
  tip: "Retired experiment: this direction-lead setting is forced to 0. It is kept only so older settings files remain compatible.\n\nRETIRED 1.0.0: this lead was tuned while the angular velocity was reported in the wrong frame. With the frame fixed any non-zero value bends throws off target, so the driver and GUI force it to 0 on load. Original description: Fixes throws that combine arm movement WITH a wrist flick bending off target. Rotates the reported throw direction forward along your current wrist rotation by this many ms.",
  reset: { can: settings.kalmanDirLeadMs != defaults.kalmanDirLeadMs, on: () => { galaxy.reset('kalmanDirLeadMs'); } }
            }));
            parts.push(fieldRow(t('Position-Freeze Velocity Decay (ms)'), html`
      <app-number .value=${settings.kalmanPosFreezeVelDecayMs} step="20" min="0" max="2000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanPosFreezeVelDecayMs = e.detail; } save(); }}></app-number>
            `, {
  tip: "Control how quickly speed fades when controller position stops updating. 0 keeps coasting; larger decay reduces continued movement during a freeze.\n\nWhile the position is frozen (3dof fallback), the hand's velocity decays toward zero with this time constant. Short mid-throw freezes coast almost untouched; long out-of-view occlusions (windups behind the head) glide to a stop near where tracking was lost instead of sailing away on the entry velocity and reacquiring with a wrong-direction state. 0 = pure coast. Driver clamps 20-2000 when nonzero.",
  reset: { can: settings.kalmanPosFreezeVelDecayMs != defaults.kalmanPosFreezeVelDecayMs, on: () => { galaxy.reset('kalmanPosFreezeVelDecayMs'); } }
            }));
            parts.push(fieldRow(t('Kalman CA: Report Acceleration'), html`
      <app-switch .checked=${!!settings.kalmanCaReportAccel} @change=${(e: CustomEvent) => { settings.kalmanCaReportAccel = e.detail; save(); }}></app-switch>
            `, {
  tip: "Retired acceleration-reporting experiment. Leave this at its default; it is not a general improvement for normal play.\n\nRetired 2026-08-25. Reports the CA filter's acceleration state to SteamVR as vecAcceleration. No title was found that consumes it and it adds noise to the pose log.",
  reset: { can: settings.kalmanCaReportAccel != defaults.kalmanCaReportAccel, on: () => { galaxy.reset('kalmanCaReportAccel'); } }
            }));
if (galaxy.controllerSettings) {
const controllerSettings = galaxy.controllerSettings;
              parts.push(fieldRow(t('Controller Aligner (in-headset)'), html`
      <app-switch .checked=${!!controllerSettings.aligner.enable} @change=${(e: CustomEvent) => { controllerSettings.aligner.enable = e.detail; save(); }}></app-switch>
              `, {
  tip: "Open the controller alignment workflow to compare tracked poses and adjust held-object alignment. Follow the capture instructions and save a known-good profile first.\n\nInteractive tuning of the controller offsets below, with the controllers themselves. A magenta marker draws where the driver believes the selected controller's TIP is. MANUAL: X switches hand, Y switches position/rotation, A/B cycle the axis, stick adjusts it live. AUTOMATIC (position): plant the tip on any solid surface at chest height away from your body (armrest, desk edge), HOLD THE TRIGGER, slowly swirl a wide cone around the planted tip for a few seconds, release. Swirl again without the trigger to verify: a frozen marker means the offset is right. Rotation is finished manually by aiming. Hold a grip 1.5s to save (paste block + file). Offsets are shared by both hands for now."
              }));
}
if (vendor) {
              parts.push(fieldRow(t('Debug: Skeleton Hand Offset X (cm)'), html`
      <app-number .value=${galaxyXr.skeletonOffsetXCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.skeletonOffsetXCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the animated hand skeleton sideways relative to the controller. This affects compatible hand visuals rather than headset tracking.\n\nMoves the skeletal hand relative to its grip anchor without touching the tracked pose, controller model, or the pivot games rotate held items around. Mirrored to the right hand. Applies LIVE - no restart, watch the hand move as you adjust."
              }));
              parts.push(fieldRow(t('Debug: Skeleton Hand Offset Y (cm)'), html`
      <app-number .value=${galaxyXr.skeletonOffsetYCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.skeletonOffsetYCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the animated hand skeleton vertically relative to the controller. This affects compatible hand visuals.\n\nSecond axis of the live skeletal hand offset. Axes are in the skeleton root frame - identify directions empirically by nudging; changes apply immediately."
              }));
              parts.push(fieldRow(t('Debug: Skeleton Hand Offset Z (cm)'), html`
      <app-number .value=${galaxyXr.skeletonOffsetZCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.skeletonOffsetZCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the animated hand skeleton forward or backward relative to the controller. This affects compatible hand visuals.\n\nThird axis of the live skeletal hand offset. Set skeletonOffsetMirror to false in settings.json if the left hand needs the X direction unmirrored."
              }));
              parts.push(fieldRow(t('Experimental: Simulate Oculus Touch'), html`
      <app-switch .checked=${!!galaxyXr.simulateTouch} @change=${(e: CustomEvent) => { galaxyXr.simulateTouch = e.detail; save(); }}></app-switch>
              `, {
  tip: "Try presenting a compatible Oculus Touch controller identity to games. This is experimental, can change bindings, and requires a SteamVR restart.\n\nIdentity experiment. Adds an Oculus Touch layout above Valve Index in the controller remapping, so games that ship Touch bindings auto-remap with Touch simulation (the game applies its Touch hand offsets) instead of Index. Meant to be tested with gripConvention off in settings.json, since Samsung's raw pose is Touch-convention. Off = Index remains the fallback. Requires a SteamVR restart."
              }));
              parts.push(fieldRow(t('Controller Mesh Offset X (cm)'), html`
      <app-number .value=${galaxyXr.meshOffsetXCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.meshOffsetXCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move only the visible controller model sideways to compensate for a pose adjustment. This does not move the underlying tracked pose.\n\nCosmetic counter-translation of the visible controller model (SteamVR Home, dashboard) after a pose trim moved it off the physical controller. Moves ONLY the mesh - no pose, anchor or held-object pivot changes. Left-hand authored, X mirrored for the right. Applies live (model regenerates and reloads within a second)."
              }));
              parts.push(fieldRow(t('Controller Mesh Offset Y (cm)'), html`
      <app-number .value=${galaxyXr.meshOffsetYCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.meshOffsetYCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move only the visible controller model vertically. This does not move the underlying tracked pose.\n\nSecond axis of the mesh counter-translation (up/down in the controller frame)."
              }));
              parts.push(fieldRow(t('Controller Mesh Offset Z (cm)'), html`
      <app-number .value=${galaxyXr.meshOffsetZCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.meshOffsetZCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move only the visible controller model forward or backward. This does not move the underlying tracked pose.\n\nThird axis of the mesh counter-translation. Positive moves the mesh back toward the wrist. If Position Offset Z is -2 for the hands, +2 here puts the Home mesh back on the real controller."
              }));
              parts.push(fieldRow(t('Hand Anchor X (cm)'), html`
      <app-number .value=${galaxyXr.handAnchorXCm} step="0.25" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorXCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the optional hand-anchor pose sideways. A game must explicitly use the hand-anchor binding for this adjustment to have an effect.\n\nTransform of the /pose/hand_anchor component, used ONLY by per-app bindings that select it (identity = same as raw). Note: a per-app binding disables SteamVR controller-type simulation, so games lose their own per-controller hand offsets - prefer the knuckles fallback and the pose trims below unless a game has no usable offsets. Left-hand authored; X, yaw and roll mirror for the right. Live."
              }));
              parts.push(fieldRow(t('Hand Anchor Y (cm)'), html`
      <app-number .value=${galaxyXr.handAnchorYCm} step="0.25" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorYCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the optional hand-anchor pose vertically. It only affects games bound to that pose.\n\nSecond axis of the hand anchor translation."
              }));
              parts.push(fieldRow(t('Hand Anchor Z (cm)'), html`
      <app-number .value=${galaxyXr.handAnchorZCm} step="0.25" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorZCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the optional hand-anchor pose forward or backward. It only affects games bound to that pose.\n\nThird axis of the hand anchor translation (negative = toward the fingertips)."
              }));
              parts.push(fieldRow(t('Hand Anchor Pitch (deg)'), html`
      <app-number .value=${galaxyXr.handAnchorPitchDeg} step="1" min="-90" max="90" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorPitchDeg = e.detail; } save(); }}></app-number>
              `, {
  tip: "Rotate the optional hand-anchor pose around its first axis. It only affects games bound to that pose.\n\nHand anchor rotation about X, in the render model rotate_xyz convention."
              }));
              parts.push(fieldRow(t('Hand Anchor Yaw (deg)'), html`
      <app-number .value=${galaxyXr.handAnchorYawDeg} step="1" min="-90" max="90" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorYawDeg = e.detail; } save(); }}></app-number>
              `, {
  tip: "Rotate the optional hand-anchor pose around its second axis. It only affects games bound to that pose.\n\nHand anchor rotation about Y (mirrored for the right hand)."
              }));
              parts.push(fieldRow(t('Hand Anchor Roll (deg)'), html`
      <app-number .value=${galaxyXr.handAnchorRollDeg} step="1" min="-90" max="90" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorRollDeg = e.detail; } save(); }}></app-number>
              `, {
  tip: "Rotate the optional hand-anchor pose around its third axis. It only affects games bound to that pose.\n\nHand anchor rotation about Z (mirrored for the right hand)."
              }));
}
            parts.push(fieldRow(t('Probe Capture (scoring run)'), html`
      <app-switch .checked=${!!settings.eyeGaze.probeCapture} @change=${(e: CustomEvent) => { settings.eyeGaze.probeCapture = e.detail; save(); }}></app-switch>
            `, {
  tip: "Use a controlled comparison preset for measuring image movement. This changes a group of calibration settings; it is not intended for normal play.\n\nOne switch for an A/B scoring run: acts as Fixation Dot + Swim Probe logging + Warped Overlays together, in the right combination, so nothing can be toggled in the wrong order. Procedure: face forward, flip this on (the dot latches ahead), fixate the dot, rotate your head slowly for 60-90s sweeping it around, flip off, save vrserver.txt. Do one run with the profile off (gain 0) and one with it on, then compare with swimprobe_score.py."
            }));
            parts.push(fieldRow(t('Skip Color While Dashboard Open'), html`
      <app-switch .checked=${!!settings.skipColorWhileDashboardOpen} @change=${(e: CustomEvent) => { settings.skipColorWhileDashboardOpen = e.detail; save(); }}></app-switch>
            `, {
  tip: "Avoid applying color correction twice when the dashboard's custom shader is active. Choose one processing path for a fair comparison.\n\nOnly needed if the custom shader is also enabled with color adjustments: avoids applying them twice while the dashboard is open. Recommended setup for streamed headsets is custom shader off and this off.",
  reset: { can: settings.skipColorWhileDashboardOpen != defaults.skipColorWhileDashboardOpen, on: () => { galaxy.reset('skipColorWhileDashboardOpen'); } }
            }));
            parts.push(fieldRow(t('Fixation Dot (VOR probe)'), html`
      <app-switch .checked=${!!settings.eyeGaze.calibDot} @change=${(e: CustomEvent) => { settings.eyeGaze.calibDot = e.detail; save(); }}></app-switch>
            `, {
  tip: "Show a target fixed in the virtual world for gaze and lens-correction tests. Follow the target as directed by the measurement workflow.\n\nDraws a world-locked cyan dot, latched to your view direction the moment it's enabled (toggle off and on to re-center it). Stare at the dot and slowly ROTATE your head in place - don't translate, the dot is at infinity. With the gaze ring on, the red ring should stay centered on the dot. This is the fixation target for swim probe data collection."
            }));
            parts.push(fieldRow(t('Swim Probe Logging'), html`
      <app-switch .checked=${!!settings.eyeGaze.swimProbe} @change=${(e: CustomEvent) => { settings.eyeGaze.swimProbe = e.detail; save(); }}></app-switch>
            `, {
  tip: "Record data for measuring image movement as your eyes or head move. Use the probe with the matching calibration tools.\n\nWhile the fixation dot is on, writes throttled SwimProbe lines to vrserver.txt: gaze-vs-dot angular residual (raw and smoothed), head angular velocity, gaze sample age, and per-eye lens UVs of both. This is the raw data for empirical distortion / pupil swim calibration. Leave off when not collecting."
            }));
            parts.push(fieldRow(t('Velocity Consumer Test / Pose Assist'), html`
      <app-select .value=${settings.deriveDiagVelocity} .options=${[{ value: 'off', label: 'Normal velocity' }, { value: 'zero', label: 'Report zero (test)' }]} @change=${(e: CustomEvent) => { settings.deriveDiagVelocity = e.detail; save(); }}></app-select>
      <app-switch .checked=${!!settings.deriveLatchPoseAssist} @change=${(e: CustomEvent) => { settings.deriveLatchPoseAssist = e.detail; save(); }}></app-switch>
            `, {
  tip: "Send zero controller velocity to isolate problems caused by reported motion. This diagnostic mode can break throwing and should be off for normal play.\n\nHelps decide if a game uses vecVelocity or computes the velocity itself. Report zero for ~2 minutes: if throws still fly, the game ignores reported velocity. Turn off after testing.",
  reset: { can: settings.deriveDiagVelocity != defaults.deriveDiagVelocity || settings.deriveLatchPoseAssist != defaults.deriveLatchPoseAssist, on: () => { galaxy.reset('deriveDiagVelocity'); galaxy.reset('deriveLatchPoseAssist'); } }
            }));
            parts.push(fieldRow(t('Adaptive Direction Lead - EXPERIMENT A'), html`
      <app-switch .checked=${!!settings.kalmanDirLeadAdaptive} @change=${(e: CustomEvent) => { settings.kalmanDirLeadAdaptive = e.detail; save(); }}></app-switch>
      <span>Base</span>
      <app-number .value=${settings.kalmanDirLeadBaseMs} step="1" min="0" max="30" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanDirLeadBaseMs = e.detail; } save(); }}></app-number>
      <span>Slope</span>
      <app-number .value=${settings.kalmanDirLeadWMs} step="0.05" min="0" max="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanDirLeadWMs = e.detail; } save(); }}></app-number>
            `, {
  tip: "Try an experimental correction that anticipates changes in motion direction. Leave it off unless you are measuring the result.\n\nThe fixed Direction Lead above is tuned for the average throw, but the hardest wrist whips (25+ rad/s) lag the filter more, so a single value under-corrects exactly your most violent throws - the last remaining direction tail. When enabled, the lead grows smoothly with your wrist speed: base + slope x rotation speed, OVERRIDING the manual Td while on. Defaults (5 + 0.3/rads): an ordinary throw gets ~8ms, a hard whip ~14ms. No thresholds, nothing switches - gentle throws are essentially unchanged. Success looks like the rare 12-24 degree hard-whip releases dropping to the ~5 degree baseline with everything else identical.",
  reset: { can: settings.kalmanDirLeadAdaptive != defaults.kalmanDirLeadAdaptive || settings.kalmanDirLeadBaseMs != defaults.kalmanDirLeadBaseMs || settings.kalmanDirLeadWMs != defaults.kalmanDirLeadWMs, on: () => { galaxy.reset('kalmanDirLeadAdaptive'); galaxy.reset('kalmanDirLeadBaseMs'); galaxy.reset('kalmanDirLeadWMs'); } }
            }));
            parts.push(fieldRow(t('Adaptive Measurement Trust - EXPERIMENT B'), html`
      <app-switch .checked=${!!settings.kalmanAdaptiveR} @change=${(e: CustomEvent) => { settings.kalmanAdaptiveR = e.detail; save(); }}></app-switch>
      <span>Max</span>
      <app-number .value=${settings.kalmanAdaptiveRMaxDiv} step="2" min="1" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanAdaptiveRMaxDiv = e.detail; } save(); }}></app-number>
            `, {
  tip: "Try an experimental correction for smoothing delay. Too much correction can create overshoot or unstable motion.\n\nAttacks the hard-whip lag itself instead of compensating its direction error - so unlike Experiment A this also reaches games that compute throws from hand position history. The filter continuously measures how far the incoming tracking is outrunning its own smooth model and, exactly in proportion, trusts the raw measurements more (bounded by Max). During calm and ordinary motion it is mathematically identical to off; during violent whips it lets the filter keep up, at the honest cost of passing some tracking noise through while your hand is moving fast (where it is hard to perceive). Purely opt-in - this deliberately bends the smoothness tuning the whole campaign ratified, so judge it on its own session. Watch rDiv/rADiv in KALDIAG: 1.0 all session = it never engaged; peaks of 5-16 during whips only = working as designed.",
  reset: { can: settings.kalmanAdaptiveR != defaults.kalmanAdaptiveR || settings.kalmanAdaptiveRMaxDiv != defaults.kalmanAdaptiveRMaxDiv, on: () => { galaxy.reset('kalmanAdaptiveR'); galaxy.reset('kalmanAdaptiveRMaxDiv'); } }
            }));
            parts.push(fieldRow(t('Grip-Point Velocity Compensator'), html`
      <app-switch .checked=${!!settings.kalmanGripEnable} @change=${(e: CustomEvent) => { settings.kalmanGripEnable = e.detail; save(); }}></app-switch>
      <span>Blend</span>
      <app-number .value=${settings.kalmanGripBlend} step="0.1" min="0" max="2" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripBlend = e.detail; } save(); }}></app-number>
            `, {
  tip: "Account for rotation around a wrist or grip point when estimating controller motion. This is an advanced alignment-dependent adjustment.\n\nThe estimator honestly reports the tracked origin's velocity; during a wrist snap that includes the origin's tangential speed around your hand (w x r) - physics, not filter error, and the measured cause of combined linear+wrist throws bending off while pure linear and pure flick throws feel right. When enabled, reported velocity is transported to the grip point: v + blend x (w x r). Set r via the in-headset Aligner's GRIP capture (hold the palm still, swirl a pure wrist cone with the trigger held) or type it below. With r set but Enable OFF the driver runs shadow-only: PEAKDIAG logs gOut/gDirOff/wr showing what compensation WOULD have reported - verify a session like that first. Leave OFF for games/engines that already transport velocity to their own attach point (they would double-apply). Blend 1 = full physics; below 1 under-corrects deliberately.",
  reset: { can: settings.kalmanGripEnable != defaults.kalmanGripEnable || settings.kalmanGripBlend != defaults.kalmanGripBlend, on: () => { galaxy.reset('kalmanGripEnable'); galaxy.reset('kalmanGripBlend'); } }
            }));
            parts.push(fieldRow(t('Grip Point r - Left / Right (cm, controller local frame)'), html`
      <span>Lx</span>
      <app-number .value=${settings.kalmanGripLeftCm.x} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripLeftCm.x = e.detail; } save(); }}></app-number>
      <span>Ly</span>
      <app-number .value=${settings.kalmanGripLeftCm.y} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripLeftCm.y = e.detail; } save(); }}></app-number>
      <span>Lz</span>
      <app-number .value=${settings.kalmanGripLeftCm.z} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripLeftCm.z = e.detail; } save(); }}></app-number>
      <span>Rx</span>
      <app-number .value=${settings.kalmanGripRightCm.x} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripRightCm.x = e.detail; } save(); }}></app-number>
      <span>Ry</span>
      <app-number .value=${settings.kalmanGripRightCm.y} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripRightCm.y = e.detail; } save(); }}></app-number>
      <span>Rz</span>
      <app-number .value=${settings.kalmanGripRightCm.z} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripRightCm.z = e.detail; } save(); }}></app-number>
            `, {
  tip: "Set the point around which each controller rotates. Use measurements from the alignment workflow rather than guessing large offsets.\n\nPer-hand vector from the tracked origin to the hand's rotation center, in the controller's local frame. The Aligner's GRIP capture solves this automatically (it is the same least-squares pivot solve as the tip capture, aimed at your wrist instead of a desk) and saving from the Aligner writes these fields. Typical magnitude a few cm; values are ignored (compensator inert) below 0.1cm or above 30cm. Field data 2026-08-14: per-throw inversion of the direction error clusters at |r| ~ 5cm.",
  reset: { can: settings.kalmanGripLeftCm.x != defaults.kalmanGripLeftCm.x || settings.kalmanGripLeftCm.y != defaults.kalmanGripLeftCm.y || settings.kalmanGripLeftCm.z != defaults.kalmanGripLeftCm.z || settings.kalmanGripRightCm.x != defaults.kalmanGripRightCm.x || settings.kalmanGripRightCm.y != defaults.kalmanGripRightCm.y || settings.kalmanGripRightCm.z != defaults.kalmanGripRightCm.z, on: () => { galaxy.reset('kalmanGripLeftCm'); galaxy.reset('kalmanGripRightCm'); } }
            }));
            parts.push(fieldRow(t('Black Floor: Range Remap'), html`
      <app-select .value=${settings.blackFloor.rangeMode} .options=${[{ value: 'off', label: 'Off' }, { value: 'compress', label: 'Compress (fix crushed blacks below code 16)' }, { value: 'expand', label: 'Expand (fix grey blacks / clipped whites)' }]} @change=${(e: CustomEvent) => { settings.blackFloor.rangeMode = e.detail; save(); }}></app-select>
            `, {
  tip: "Adjust video black levels to diagnose a range mismatch. Incorrect compression or expansion can wash out blacks or erase shadow detail.\n\nFix for a full-vs-limited video range mismatch in the stream chain. Compress: pre-maps into limited range (16-235) before encode - the fix when the first ~8 ramp patches are indistinguishable black (display decoding full as limited). Expand: the inverse - the fix when black looks grey and highlights clip. Leave off unless the ramp bar diagnosed one of the two."
            }));
            parts.push(fieldRow(t('Black Floor: Shadow Lift (floor / knee, sRGB codes)'), html`
      <app-switch .checked=${!!settings.blackFloor.shadowLift} @change=${(e: CustomEvent) => { settings.blackFloor.shadowLift = e.detail; save(); }}></app-switch>
      <span>F</span>
      <app-number .value=${settings.blackFloor.floorCode} step="0.5" min="0" max="16" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.blackFloor.floorCode = e.detail; } save(); }}></app-number>
      <span>K</span>
      <app-number .value=${settings.blackFloor.kneeCode} step="1" min="2" max="48" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.blackFloor.kneeCode = e.detail; } save(); }}></app-number>
            `, {
  tip: "Brighten the darkest visible shades. Use small values to reveal shadow detail without making black areas look gray.\n\nLifts the deepest shadows before encoding: values below the knee are remapped so black reaches the selected floor, while values above the knee are unchanged. This may make dark detail more visible, but cannot recreate detail already lost elsewhere in the pipeline. Floor 2 / knee 8 is a small starting adjustment. Check near-black test patches; excessive lifting can make blacks look gray."
            }));
            parts.push(fieldRow(t('Throw Strength Trim (scale / spin scale)'), html`
      <span>S</span>
      <app-number .value=${settings.kalmanMagScale} step="0.05" min="0.25" max="4" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanMagScale = e.detail; } save(); }}></app-number>
      <span>Sa</span>
      <app-number .value=${settings.kalmanAngMagScale} step="0.05" min="0.25" max="4" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanAngMagScale = e.detail; } save(); }}></app-number>
            `, {
  tip: "Scale the speed estimate in the acceleration-based filter. 1 leaves it unchanged; this can affect throwing strength.\n\nGlobal multipliers on reported speed and spin, kept as safety trims for the CA experiment modes. If the CA model is doing its job these converge to 1.0 - the PEAKDIAG log line (out/sec ratio) is the instrument that says whether they can.",
  reset: { can: settings.kalmanMagScale != defaults.kalmanMagScale || settings.kalmanAngMagScale != defaults.kalmanAngMagScale, on: () => { galaxy.reset('kalmanMagScale'); galaxy.reset('kalmanAngMagScale'); } }
            }));
            parts.push(fieldRow(t('Field-retired experiments - kept for reproducibility. Each lost a live test. Values here stay ACTIVE while hidden; re-test only if the transport fresh-rate materially improves.'), html`
      
            `, {
  reset: { can: true, on: () => { galaxy.resetGraveyard(); } }
            }));
            parts.push(fieldRow(t('Zero-Copy v3 (experimental)'), html`
      <app-switch .checked=${!!settings.zeroCopyV3} @change=${(e: CustomEvent) => { settings.zeroCopyV3 = e.detail; save(); }}></app-switch>
            `, {
  tip: "Use an alternate texture-staging path for image processing. This is a performance and compatibility experiment, not a picture-quality control.\n\nPerformance: instead of writing the processed frame back into the layer, it is drawn into a shared shadow texture and the streamer's own per-frame staging copy is redirected to read it - roughly halving this driver's GPU memory traffic on top of Direct Render. Failure mode is benign: any miss ships one unprocessed frame (a brief ungraded flash), the same as a sync timeout skip. Test in a disposable session first: grep the log for 'zero-copy v3: redirect active' to confirm engagement, and 'passthrough' lines to see misses. Turn off if you see persistent unprocessed frames or flicker.",
  reset: { can: settings.zeroCopyV3 != defaults.zeroCopyV3, on: () => { galaxy.reset('zeroCopyV3'); } }
            }));
            parts.push(fieldRow(t('NVENC (retired): AQ Strength'), html`
      <app-number .value=${settings.nvencAqStrength} step="1" min="0" max="15" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencAqStrength = e.detail; } save(); }}></app-number>
            `, {
  tip: "Do not use spatial adaptive quantization for normal play in this build. It has caused encoder stalls in testing, and the driver's safety checks may reset it.\n\nDO NOT USE. Any spatial AQ, at any strength, makes nvEncEncodePicture block 4-6 ms per frame on these tall frames and trips the streamer's 10 ms watchdog (encoder resets, soft key frames, storms). Migration forces it to 0.",
  reset: { can: settings.nvencAqStrength != defaults.nvencAqStrength, on: () => { galaxy.reset('nvencAqStrength'); } }
            }));
            parts.push(fieldRow(t('NVENC (retired): Max QP'), html`
      <app-number .value=${settings.nvencMaxQp} step="1" min="0" max="51" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencMaxQp = e.detail; } save(); }}></app-number>
            `, {
  tip: "Set a lower limit on the encoder's quantization value. This is an advanced quality/bandwidth constraint, not a simple quality slider.\n\nQuality floor per block (0 = off). Fights CBR; can overshoot the 2 MB frame limit in complex scenes.",
  reset: { can: settings.nvencMaxQp != defaults.nvencMaxQp, on: () => { galaxy.reset('nvencMaxQp'); } }
            }));
            parts.push(fieldRow(t('NVENC (retired): Min QP / Min QP intra'), html`
      <app-number .value=${settings.nvencMinQp} step="1" min="0" max="51" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencMinQp = e.detail; } save(); }}></app-number>
      <app-number .value=${settings.nvencMinQpIntra} step="1" min="0" max="51" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencMinQpIntra = e.detail; } save(); }}></app-number>
            `, {
  tip: "Set an upper limit on quantization where the selected rate-control mode uses it. It has no effect in the documented constant-bitrate path.\n\nInert under CBR (the key-frame budget does the containment). Only meaningful with Force CBR off."
            }));
            parts.push(fieldRow(t('NVENC (retired): Bitrate Follows Streamer Backoff'), html`
      <app-switch .checked=${!!settings.nvencBitrateScale} @change=${(e: CustomEvent) => { settings.nvencBitrateScale = e.detail; save(); }}></app-switch>
            `, {
  tip: "Preserve the streamer's rate-control configuration. This compatibility behavior stays enabled; it is not a separate quality improvement to tune.\n\nAlways on. The streamer's per-frame request is its real rate control; replacing it outright (off) starves the pacer (R3).",
  reset: { can: settings.nvencBitrateScale != defaults.nvencBitrateScale, on: () => { galaxy.reset('nvencBitrateScale'); } }
            }));
            parts.push(fieldRow(t('NVENC (retired): True Preset Merge'), html`
      <app-switch .checked=${!!settings.nvencPresetMerge} @change=${(e: CustomEvent) => { settings.nvencPresetMerge = e.detail; save(); }}></app-switch>
            `, {
  tip: "Choose which encoder preset configuration is used as the starting point. This affects several low-level settings together.\n\nAdopts the canonical preset's multipass / AQ / ref settings besides the preset GUID. Left on; one A/B (P7 with it off) was never run.",
  reset: { can: settings.nvencPresetMerge != defaults.nvencPresetMerge, on: () => { galaxy.reset('nvencPresetMerge'); } }
            }));
            parts.push(fieldRow(t('NVENC (retired): VUI Full Range / Matrix / Primaries / Transfer'), html`
      <app-number .value=${settings.nvencVuiFullRange} step="1" min="-1" max="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencVuiFullRange = e.detail; } save(); }}></app-number>
      <app-number .value=${settings.nvencVuiMatrix} step="1" min="-1" max="14" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencVuiMatrix = e.detail; } save(); }}></app-number>
      <app-number .value=${settings.nvencVuiPrimaries} step="1" min="-1" max="22" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencVuiPrimaries = e.detail; } save(); }}></app-number>
      <app-number .value=${settings.nvencVuiTransfer} step="1" min="-1" max="18" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencVuiTransfer = e.detail; } save(); }}></app-number>
            `, {
  tip: "Override video color-range metadata. Leave automatic unless diagnosing a known mismatch; incompatible client handling can darken the image.\n\n-1 leaves the streamer's tags. The correct BT.709 tags (1/1/1) make the client render dim and saturated - the client mishandles explicit tags, so these stay inert until the APK changes."
            }));
            parts.push(fieldRow(t('vrlink (retired): Encode Width'), html`
      <app-number .value=${galaxyXr.customEncodeWidth} step="256" min="512" max="8192" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.customEncodeWidth = e.detail; } save(); }}></app-number>
            `, {
  tip: "Compatibility value for encoder width. It does not control the actual tile width in the current foveated streaming path.\n\nNo observable effect in foveated mode (the streamer's sampling shader never reads it); written as 3072 for compatibility.",
  reset: { can: galaxyXr.customEncodeWidth != 3072, on: () => { galaxyXr.customEncodeWidth = 3072; save(); } }
            }));
            parts.push(fieldRow(t('vrlink (retired): Max Video Queue Latency (us) / Backoff Recovery Coefficient'), html`
      <app-number .value=${galaxyXr.vrlinkMaxVideoQueueLatencyUs} step="1000" min="0" max="200000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.vrlinkMaxVideoQueueLatencyUs = e.detail; } save(); }}></app-number>
      <app-number .value=${galaxyXr.vrlinkBackoffRecoveryCoefficient} step="0.1" min="0" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.vrlinkBackoffRecoveryCoefficient = e.detail; } save(); }}></app-number>
            `, {
  tip: "Test undocumented Steam Link settings. 0 or the default value leaves the override unused; there is no guarantee that a particular client reads these keys.\n\nUndocumented streamer keys found in driver_vrlink.dll. No measurable effect in A/B (V1/V2). 0 leaves the streamer's defaults."
            }));
            parts.push(fieldRow(t('Gaze FOV Tangents'), html`
      <span>X</span>
      <app-number .value=${settings.eyeGaze.tanHalfFovX} step="0.02" min="0.3" max="3" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.eyeGaze.tanHalfFovX = e.detail; } save(); }}></app-number>
      <span>Y</span>
      <app-number .value=${settings.eyeGaze.tanHalfFovY} step="0.02" min="0.3" max="3" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.eyeGaze.tanHalfFovY = e.detail; } save(); }}></app-number>
            `, {
  tip: "Set the field-of-view values used to map eye gaze into the image. Incorrect values can misplace gaze-based correction.\n\nHalf-FOV tangents used to map gaze direction to screen position. 1.19 corresponds to ~100 degrees. If the ring moves too far for your gaze, increase; too little, decrease. Tune X with horizontal gaze, Y with vertical."
            }));
            parts.push(fieldRow(t('Kalman Smoothed Reporting Lag (ms)'), html`
      <app-number .value=${settings.kalmanSmoothLagMs} step="5" min="0" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanSmoothLagMs = e.detail; } save(); }}></app-number>
            `, {
  tip: "Try a filter that smooths motion using a short history. This is experimental and trades some delay for steadier estimates.\n\nThe one remaining pure-estimator upgrade, aimed at what this game actually reads (your hand's position history): instead of estimating the present from the past only, the reported hand state is estimated a few ms in the past using tracking samples from BOTH sides of that moment - as calm as your A=1 tuning AND amplitude-accurate like a fast filter, a combination plain filtering cannot achieve. The whole reported state (position, rotation, velocity, spin) shifts together, staying coherent. The single honest cost: this many ms of added hand latency (partly hidden by the runtime's forward prediction, which now gets an accurate velocity). In Kalman CA this is a true fixed-lag RTS smoother; set it to roughly your measured release skew (~35 ms) and pair it with a faster Jerk (8-25) than you would run causally. 0 = off.",
  reset: { can: settings.kalmanSmoothLagMs != defaults.kalmanSmoothLagMs, on: () => { galaxy.reset('kalmanSmoothLagMs'); } }
            }));
            parts.push(fieldRow(t('Kalman Smoothed Lag Epoch'), html`
      <app-select .value=${settings.kalmanSmoothLagEpoch} .options=${[{ value: 0, label: 'Latent - stamped as current (+L hand latency)' }, { value: 1, label: 'Honest - true epoch (runtime extrapolates L)' }]} @change=${(e: CustomEvent) => { settings.kalmanSmoothLagEpoch = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose how the experimental history-based filter timestamps its result. This can change how games interpret prediction and delay.\n\nHow the smoothed (L ms old) state is stamped for SteamVR. Latent (default): stamped as current, so the runtime predicts its usual short horizon and the whole hand simply carries L ms of extra latency; the submitted position history is the smoothed trajectory delayed by L, which is what pose-history throw estimators read. Honest: the true epoch (-L) is reported; the runtime then extrapolates the position by L plus its photon horizon from the reported velocity, which turned throws weak/backward in the field for this game (pose-history games); only for games that read vecVelocity directly.",
  reset: { can: settings.kalmanSmoothLagEpoch != defaults.kalmanSmoothLagEpoch, on: () => { galaxy.reset('kalmanSmoothLagEpoch'); } }
            }));
            parts.push(fieldRow(t('Gaze Aim Assist (strength 0-1 / max bend deg / min speed m/s)'), html`
      <span>G</span>
      <app-number .value=${settings.kalmanGazeAssist} step="0.1" min="0" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGazeAssist = e.detail; } save(); }}></app-number>
      <span>°</span>
      <app-number .value=${settings.kalmanGazeMaxDeg} step="5" min="5" max="180" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGazeMaxDeg = e.detail; } save(); }}></app-number>
      <span>S</span>
      <app-number .value=${settings.kalmanGazeMinSpeed} step="0.1" min="0.3" max="4" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGazeMinSpeed = e.detail; } save(); }}></app-number>
            `, {
  tip: "Try using gaze information to help estimate throwing direction. This is experimental, needs reliable eye tracking, and can change normal throws.\n\nUses your eye tracking to fix the last class of bad throws: you look at the target before your hand lets go, so your gaze knows the intended direction even when the release samples the hand's snap-back. Above the minimum speed, the reported throw direction is bent toward where you're looking - by strength fraction of the angle, never more than the max bend cap. Direction only: throw power and spin are untouched, the rendered hand is untouched, and if eye data is missing or stale for even 100ms it silently does nothing. Start at 0.4-0.6; the 'gaze aim assist ENGAGED' log line confirms it's live. 0 = off. TEST MODE: values above 1 shrink the disagreement needed for full gaze takeover - G=10 with max bend 180 locks every throw straight onto your gaze, for verifying the whole pipeline.",
  reset: { can: settings.kalmanGazeAssist != defaults.kalmanGazeAssist || settings.kalmanGazeMaxDeg != defaults.kalmanGazeMaxDeg || settings.kalmanGazeMinSpeed != defaults.kalmanGazeMinSpeed, on: () => { galaxy.reset('kalmanGazeAssist'); galaxy.reset('kalmanGazeMaxDeg'); galaxy.reset('kalmanGazeMinSpeed'); } }
            }));
            parts.push(fieldRow(t('Kalman Duplicate-Coast Cap (ms)'), html`
      <app-number .value=${settings.kalmanDupCoastMaxMs} step="10" min="10" max="500" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanDupCoastMaxMs = e.detail; } save(); }}></app-number>
            `, {
  tip: "Limit how long repeated samples are treated as duplicates while the controller is still. This balances freeze detection against genuine stillness.\n\nActive even while archived. Repeats sustained past this cap are accepted as genuine stillness at full weight - no human hand holds a position bit-identically for tens of ms, so a long repeat means the tracker stopped producing, and believing it beats extrapolating or distrusting blind. Also closes a coast runaway. Default 90, range 10-500. Applies to Coast, Drop, and Soft.",
  reset: { can: settings.kalmanDupCoastMaxMs != defaults.kalmanDupCoastMaxMs, on: () => { galaxy.reset('kalmanDupCoastMaxMs'); } }
            }));
            parts.push(fieldRow(t('Kalman Direction Smoothing (linear ms / angular ms)'), html`
      <span>Dir</span>
      <app-number .value=${settings.kalmanDirSmoothMs} step="10" min="0" max="300" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanDirSmoothMs = e.detail; } save(); }}></app-number>
      <span>DirA</span>
      <app-number .value=${settings.kalmanAngDirSmoothMs} step="10" min="0" max="300" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanAngDirSmoothMs = e.detail; } save(); }}></app-number>
            `, {
  tip: "Smooth motion speed and motion direction separately in the legacy filter. This only affects the supported legacy branch.\n\nWhat your A=1 tuning discovered, made into its own knob: throw DIRECTION gets heavy smoothing (the calm you liked) while throw STRENGTH stays live (no weak throws, nothing slipping out of your hand). Set Accel back to 40-60 and put 60-90 here; direction takes on the A=1 steadiness while magnitude keeps full snap. Angular ditto for spin. 0 = off. Only the reported velocity is shaped; the rendered hand is untouched.",
  reset: { can: settings.kalmanDirSmoothMs != defaults.kalmanDirSmoothMs || settings.kalmanAngDirSmoothMs != defaults.kalmanAngDirSmoothMs, on: () => { galaxy.reset('kalmanDirSmoothMs'); galaxy.reset('kalmanAngDirSmoothMs'); } }
            }));
            parts.push(fieldRow(t('Kalman Release Rewind (ms) / Hold (ms) - EXPERIMENT'), html`
      <span>R</span>
      <app-number .value=${settings.kalmanReleaseRewindMs} step="5" min="0" max="150" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanReleaseRewindMs = e.detail; } save(); }}></app-number>
      <span>H</span>
      <app-number .value=${settings.kalmanRewindHoldMs} step="10" min="20" max="300" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanRewindHoldMs = e.detail; } save(); }}></app-number>
            `, {
  tip: "Try an experimental release-time correction for throwing. 0 disables it; the approach is a hypothesis to test, not a guaranteed fix.\n\nSingle-session experiment, off at 0. Hypothesis: your trigger release reaches the PC 40-60ms later than your hand motion does, so games read the hand AFTER it already snapped back - that is where reverse throws come from. When set, the moment your release arrives, the reported velocity is taken from Rewind ms earlier in the motion history (then blends back to live over Hold ms). This is pure time re-alignment by one constant - if a value around 45 makes reverse throws vanish, the hypothesis is proven and the value IS your network's input lag; if no value in 30-60 helps, the hypothesis is dead and this stays off forever. The rendered hand is never touched.",
  reset: { can: settings.kalmanReleaseRewindMs != defaults.kalmanReleaseRewindMs || settings.kalmanRewindHoldMs != defaults.kalmanRewindHoldMs, on: () => { galaxy.reset('kalmanReleaseRewindMs'); galaxy.reset('kalmanRewindHoldMs'); } }
            }));
            parts.push(fieldRow(t('Derive Smoothing (tau slow/fast ms, speed low/high)'), html`
      <span>τS</span>
      <app-number .value=${settings.deriveSmoothTauSlowMs} step="5" min="1" max="300" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothTauSlowMs = e.detail; } save(); }}></app-number>
      <span>τF</span>
      <app-number .value=${settings.deriveSmoothTauFastMs} step="1" min="1" max="60" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothTauFastMs = e.detail; } save(); }}></app-number>
      <span>sL</span>
      <app-number .value=${settings.deriveSmoothSpeedLow} step="0.05" min="0" max="3" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothSpeedLow = e.detail; } save(); }}></app-number>
      <span>sH</span>
      <app-number .value=${settings.deriveSmoothSpeedHigh} step="0.05" min="0.1" max="5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothSpeedHigh = e.detail; } save(); }}></app-number>
            `, {
  tip: "Adjust the motion filter's smoothing automatically with speed. This changes the trade-off between steady slow motion and responsive fast motion.\n\nSpeed-adaptive smoothing for the Derive velocity mode, live reloaded. The filter time constant slides from tau slow (held still: kills trembling) to tau fast (throw speeds: near raw so the peak survives) as effective speed crosses low..high. Lower tau fast raises the reported peak but passes more raw noise at release; if throw directions misbehave, prefer the Split Direction toggles below over pushing tau fast toward zero.",
  reset: { can: settings.deriveSmoothTauSlowMs != defaults.deriveSmoothTauSlowMs || settings.deriveSmoothTauFastMs != defaults.deriveSmoothTauFastMs || settings.deriveSmoothSpeedLow != defaults.deriveSmoothSpeedLow || settings.deriveSmoothSpeedHigh != defaults.deriveSmoothSpeedHigh, on: () => { galaxy.reset('deriveSmoothTauSlowMs'); galaxy.reset('deriveSmoothTauFastMs'); galaxy.reset('deriveSmoothSpeedLow'); galaxy.reset('deriveSmoothSpeedHigh'); } }
            }));
            parts.push(fieldRow(t('Angular Smoothing: Separate (tau slow/fast ms, speed low/high rad/s)'), html`
      <app-switch .checked=${!!settings.deriveSmoothAngSeparate} @change=${(e: CustomEvent) => { settings.deriveSmoothAngSeparate = e.detail; save(); }}></app-switch>
      <span>τS</span>
      <app-number .value=${settings.deriveSmoothAngTauSlowMs} step="5" min="1" max="300" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothAngTauSlowMs = e.detail; } save(); }}></app-number>
      <span>τF</span>
      <app-number .value=${settings.deriveSmoothAngTauFastMs} step="1" min="1" max="60" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothAngTauFastMs = e.detail; } save(); }}></app-number>
      <span>sL</span>
      <app-number .value=${settings.deriveSmoothAngSpeedLow} step="0.1" min="0" max="30" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothAngSpeedLow = e.detail; } save(); }}></app-number>
      <span>sH</span>
      <app-number .value=${settings.deriveSmoothAngSpeedHigh} step="0.5" min="0.5" max="60" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothAngSpeedHigh = e.detail; } save(); }}></app-number>
            `, {
  tip: "Use a separate smoothing strength for rotational motion. This lets rotation and straight-line movement be tuned independently.\n\nGives the angular (spin) channel its own speed-adaptive smoothing instead of sharing the linear channel's filter. Field data shows the shared filter under-serves spin: reported angular speed swings about +-40% around raw. Defaults are chosen to be nearly behavior neutral on enable, so tune from there: raise tau fast to calm spin jitter, lower speed high if wrist-flick throws lose their snap. Angular speeds are in rad/s (a firm wrist flick peaks around 10-20).",
  reset: { can: settings.deriveSmoothAngSeparate != defaults.deriveSmoothAngSeparate || settings.deriveSmoothAngTauSlowMs != defaults.deriveSmoothAngTauSlowMs || settings.deriveSmoothAngTauFastMs != defaults.deriveSmoothAngTauFastMs || settings.deriveSmoothAngSpeedLow != defaults.deriveSmoothAngSpeedLow || settings.deriveSmoothAngSpeedHigh != defaults.deriveSmoothAngSpeedHigh, on: () => { galaxy.reset('deriveSmoothAngSeparate'); galaxy.reset('deriveSmoothAngTauSlowMs'); galaxy.reset('deriveSmoothAngTauFastMs'); galaxy.reset('deriveSmoothAngSpeedLow'); galaxy.reset('deriveSmoothAngSpeedHigh'); } }
            }));
            parts.push(fieldRow(t('Derive Split Direction: Linear'), html`
      <app-switch .checked=${!!settings.deriveSplitDirLinear} @change=${(e: CustomEvent) => { settings.deriveSplitDirLinear = e.detail; save(); }}></app-switch>
            `, {
  tip: "Use a separate smoothing strength for straight-line motion direction. It only affects filter modes that split speed from direction.\n\nExperimental fix for throws flying in random directions with Derive mode. Keeps the smoothed velocity MAGNITUDE but takes the DIRECTION from a speed-weighted average of the raw estimates over a short window, so the fastest (most reliable) samples pin the release direction. Toggle one channel at a time for a clean A/B; the log line 'VelocityFix: split-dir active' confirms it engaged.",
  reset: { can: settings.deriveSplitDirLinear != defaults.deriveSplitDirLinear, on: () => { galaxy.reset('deriveSplitDirLinear'); } }
            }));
            parts.push(fieldRow(t('Derive Split Direction: Angular'), html`
      <app-switch .checked=${!!settings.deriveSplitDirAngular} @change=${(e: CustomEvent) => { settings.deriveSplitDirAngular = e.detail; save(); }}></app-switch>
            `, {
  tip: "Use a separate smoothing strength for rotation direction. It only affects filter modes that split rotation speed from direction.\n\nSame split treatment for angular velocity (spin direction at release). Independent from the linear toggle so A/B tests stay single-variable.",
  reset: { can: settings.deriveSplitDirAngular != defaults.deriveSplitDirAngular, on: () => { galaxy.reset('deriveSplitDirAngular'); } }
            }));
            parts.push(fieldRow(t('Latch Angular Min Speed (rad/s) / Input Prefilter'), html`
      <app-number .value=${settings.deriveLatchAngMinSpeed} step="0.5" min="0" max="30" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveLatchAngMinSpeed = e.detail; } save(); }}></app-number>
      <app-select .value=${settings.derivePreFilter} .options=${[{ value: 'off', label: 'Off (raw input)' }, { value: 'median3', label: 'Median of 3 (recommended)' }]} @change=${(e: CustomEvent) => { settings.derivePreFilter = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose the minimum spin speed needed before the experimental spin latch takes effect. Keep the default unless testing that mode.\n\nAngular min speed: the spin channel's own latch gate - wrist snaps above this replay their peak spin at release, gentler rotation stays live (6 is a deliberate flick; casual regrabs sit far below). Input prefilter median3: cleans single-frame network position spikes BEFORE velocity is derived, at one sample of lag - the recommended fix for jitter tails and twitchy held objects. Off restores raw input for A/B.",
  reset: { can: settings.deriveLatchAngMinSpeed != defaults.deriveLatchAngMinSpeed || settings.derivePreFilter != defaults.derivePreFilter, on: () => { galaxy.reset('deriveLatchAngMinSpeed'); galaxy.reset('derivePreFilter'); } }
            }));
            parts.push(fieldRow(t('Input Pre-Smoothing (ms) / Scope'), html`
      <app-number .value=${settings.derivePreSmoothMs} step="5" min="0" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.derivePreSmoothMs = e.detail; } save(); }}></app-number>
      <app-select .value=${settings.derivePreSmoothScope} .options=${[{ value: 'direction', label: 'Direction only (recommended)' }, { value: 'both', label: 'Both direction and speed' }]} @change=${(e: CustomEvent) => { settings.derivePreSmoothScope = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose which parts of motion data receive the optional pre-filter. Different scopes can change both responsiveness and noise.\n\nSmooths the raw tracking stream BEFORE anything is derived from it, with adjustable strength (0 = off; try 10-25; capped at 100). Scope 'Direction only' cleans what the throw direction and rendered-hand prediction see while speed is still derived from the exact positions - the recommended way to calm jittery hands without losing throw power. 'Both' also feeds the smoothed stream to the speed derivation: maximum calm, slight peak lag. Works alongside the median-of-3 spike filter.",
  reset: { can: settings.derivePreSmoothMs != defaults.derivePreSmoothMs || settings.derivePreSmoothScope != defaults.derivePreSmoothScope, on: () => { galaxy.reset('derivePreSmoothMs'); galaxy.reset('derivePreSmoothScope'); } }
            }));
            parts.push(fieldRow(t('Split Direction Source'), html`
      <app-select .value=${settings.deriveDirSource} .options=${[{ value: 'secant', label: 'Position secant (recommended)' }, { value: 'runtime', label: 'Runtime report direction' }, { value: 'window', label: 'Window average (original)' }]} @change=${(e: CustomEvent) => { settings.deriveDirSource = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose where the motion-direction estimate comes from. The choices use different sample histories and can behave differently around release.\n\nWhere the throw DIRECTION comes from when a Split Direction toggle is on (magnitude always comes from the smoothed estimate). Position secant: direction of the raw hand displacement over the last ~25-70ms - very noise resistant, small fixed lag; the recommended default. Runtime report: direction of the driver's own (heavily smoothed) velocity - device-side sensor fusion, smooth but more lagged. Window average: the original weighted average of recent estimates - kept for A/B, weakest against correlated noise. After changing this, flip a Split toggle off and on to get a fresh confirmation log line.",
  reset: { can: settings.deriveDirSource != defaults.deriveDirSource, on: () => { galaxy.reset('deriveDirSource'); } }
            }));
            parts.push(fieldRow(t('Split Magnitude Source'), html`
      <app-select .value=${settings.deriveMagSource} .options=${[{ value: 'vector', label: 'Vector length (original)' }, { value: 'scalar', label: 'Scalar speed (recommended test)' }]} @change=${(e: CustomEvent) => { settings.deriveMagSource = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose where the motion-speed estimate comes from. Compare with measured throws rather than assuming a different source is more accurate.\n\nWhere the throw SPEED comes from when a Split Direction toggle is on. Vector: length of the smoothed velocity vector (original; components pointing in changing directions partially cancel inside the average, which both jitters and under-reads mid-swing). Scalar: the speed itself is smoothed with the same adaptive time constant - no cancellation, less jitter for the same responsiveness. Recommended test: Scalar, combined with Tau Fast raised to ~15-20 (direction no longer pays for a slower magnitude filter since it comes from the secant).",
  reset: { can: settings.deriveMagSource != defaults.deriveMagSource, on: () => { galaxy.reset('deriveMagSource'); } }
            }));
            parts.push(fieldRow(t('Release Latch (derive)'), html`
      <app-switch .checked=${!!settings.deriveReleaseLatch} @change=${(e: CustomEvent) => { settings.deriveReleaseLatch = e.detail; save(); }}></app-switch>
      <span>W</span>
      <app-number .value=${settings.deriveLatchWindowMs} step="10" min="40" max="400" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveLatchWindowMs = e.detail; } save(); }}></app-number>
      <span>H</span>
      <app-number .value=${settings.deriveLatchHoldMs} step="10" min="40" max="400" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveLatchHoldMs = e.detail; } save(); }}></app-number>
      <span>S</span>
      <app-number .value=${settings.deriveLatchMinSpeed} step="0.1" min="0" max="3" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveLatchMinSpeed = e.detail; } save(); }}></app-number>
            `, {
  tip: "Retain a recent speed peak briefly around release in the legacy filter. This can change throw strength and may exaggerate a noisy peak.\n\nFixes throws that come out weak or die mid-air: field data shows the input release event often trails the hand motion, so about a quarter of throws sample the velocity AFTER the hand already slowed. When on, the moment your trigger/grip release arrives, the output replays the strongest recent motion (window below) for the hold duration - full strength for the first half, fading after. Normal throws that release at the peak are unaffected. The three numbers: peak window ms / hold ms / minimum speed to engage (m/s).",
  reset: { can: settings.deriveReleaseLatch != defaults.deriveReleaseLatch, on: () => { galaxy.reset('deriveReleaseLatch'); } }
            }));
            parts.push(fieldRow(t('Split Direction Window (ms) / Weight Power'), html`
      <span>W</span>
      <app-number .value=${settings.deriveDirWindowMs} step="5" min="5" max="200" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveDirWindowMs = e.detail; } save(); }}></app-number>
      <span>P</span>
      <app-number .value=${settings.deriveDirWeightPow} step="0.5" min="0" max="6" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveDirWeightPow = e.detail; } save(); }}></app-number>
            `, {
  tip: "Choose how older samples are weighted when averaging motion direction. Recent-sample weighting reacts faster but may be less steady.\n\nWindow: how far back the direction average looks (clamped 5-200 in the driver). Shorter follows wrist snaps tighter but averages less noise. Weight power: how strongly fast samples dominate (speed^power weighting); 2 is a good default, higher approaches 'direction of the single fastest sample', 0 is an unweighted average.",
  reset: { can: settings.deriveDirWindowMs != defaults.deriveDirWindowMs || settings.deriveDirWeightPow != defaults.deriveDirWeightPow, on: () => { galaxy.reset('deriveDirWindowMs'); galaxy.reset('deriveDirWeightPow'); } }
            }));
}
}
}
}
    return html`<app-system-ready .ctx=${this.ctx}>${this.sectionCardsFor(parts)}</app-system-ready>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-stream-frame-page': StreamFramePage;
  }
}
