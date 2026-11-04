// Wrong-GPU detection for the NVENC Tap (2026-11-04).
//
// The preferred encoder GPU is a capability CANDIDATE (see
// `preferredEncoderAdapter`), never a verified stream adapter. A mismatch is
// reported only against fresh, process-bound runtime evidence:
//   - the adapter the NVENC session actually opened (encoderEvidence), and
//   - the adapter SteamVR reported for the HMD (info.json graphicsAdapter).
// Both are informational: nothing is rewritten and no GPU is switched.
import type { DriverRuntimeStatus } from '../platform/tauri';
import type { DriverInfo, GpuCapabilities } from './types';
import { preferredEncoderAdapter } from './encoder-capabilities';
import { t } from '../locale/i18n';

const FRESH_MS = 5000;
const FUTURE_SKEW_MS = 2000;

const luidKey = (luid: string | undefined) => luid?.trim().toLowerCase() || undefined;
const pathKey = (p: string | undefined) => p?.replace(/\\/g, '/').toLowerCase();

/** The HMD rendering adapter, only while it belongs to the freshly verified
 *  current driver process. Anything stopped, replaced or old yields undefined. */
export function graphicsAdapterEvidence(
  info: DriverInfo | undefined,
  runtime: DriverRuntimeStatus | undefined,
  now = Date.now(),
): NonNullable<DriverInfo['graphicsAdapter']> | undefined {
  const g = info?.graphicsAdapter;
  if (!g || !luidKey(g.adapterLuid) || !Number.isFinite(g.observedAt) || !Number.isFinite(g.pid) || !Number.isFinite(now)) return undefined;
  if (!runtime?.driverInitialized || !runtime.steamvrRunning || !runtime.serverPid || runtime.serverPid !== g.pid) return undefined;
  if (!Number.isFinite(runtime.checkedAt)) return undefined;
  if (now - runtime.checkedAt > FRESH_MS || runtime.checkedAt > now + FUTURE_SKEW_MS) return undefined;
  if (now - g.observedAt > FRESH_MS || g.observedAt > now + FUTURE_SKEW_MS) return undefined;
  // When both sides report the loaded module/config, they must be the same
  // files (a replaced driver copy must not vouch for old info.json data).
  const tap = info?.encoderTap;
  const live = runtime.encoderTap;
  if (tap?.modulePath && tap.configPath && live?.modulePath && live.configPath
      && (pathKey(tap.modulePath) !== pathKey(live.modulePath) || pathKey(tap.configPath) !== pathKey(live.configPath))) {
    return undefined;
  }
  return g;
}

export type GpuMismatch = {
  /** The NVENC session opened on a different GPU than the preferred one. */
  encoder?: { expected: string; actual: string };
  /** SteamVR renders on a different GPU than the preferred encoder GPU. */
  renderer?: { expected: string; actual: string };
};

function describeAdapter(gpu: GpuCapabilities | undefined, luid: string | undefined, fallbackName?: string): string {
  const key = luidKey(luid);
  const known = gpu?.adapters.find(a => luidKey(a.adapterLuid) === key);
  const name = known?.gpuName || fallbackName;
  return name ? `${name} (${luid})` : String(luid);
}

/** Pure comparison. `encoder` must be the already process-bound evidence and
 *  `graphics` the result of `graphicsAdapterEvidence`. No preferred candidate,
 *  or no fresh identity on a side, means no error for that side. */
export function gpuMismatch(
  gpu: GpuCapabilities | undefined,
  encoder: DriverInfo['encoderTap'] | undefined,
  graphics: DriverInfo['graphicsAdapter'] | undefined,
): GpuMismatch {
  const preferred = preferredEncoderAdapter(gpu);
  const result: GpuMismatch = {};
  if (!preferred) return result;
  const want = luidKey(preferred.adapterLuid);
  const expected = describeAdapter(gpu, preferred.adapterLuid, preferred.gpuName);
  const actualEncoder = encoder?.capabilities;
  if (luidKey(actualEncoder?.adapterLuid) && luidKey(actualEncoder?.adapterLuid) !== want) {
    result.encoder = { expected, actual: describeAdapter(gpu, actualEncoder!.adapterLuid, actualEncoder!.gpuName) };
  }
  if (graphics && luidKey(graphics.adapterLuid) && luidKey(graphics.adapterLuid) !== want) {
    result.renderer = { expected, actual: describeAdapter(gpu, graphics.adapterLuid) };
  }
  return result;
}

export function encoderMismatchText(m: NonNullable<GpuMismatch['encoder']>): string {
  return t('Expected GPU {expected}, but the NVENC session opened on {actual}. Saved settings were not changed; the actual GPU decides which options are available.', m);
}

export function rendererMismatchText(m: NonNullable<GpuMismatch['renderer']>): string {
  return t('Preferred NVIDIA encoder GPU: {expected}. SteamVR is rendering on {actual}. This alone does not prove streaming will fail.', m);
}

/** Compact Tap-row notice: driver-verified encoder GPU when a live session
 *  reported one, else the preferred (unverified) candidate. Never both. */
export function encoderGpuNotice(
  gpu: GpuCapabilities | undefined,
  encoder: DriverInfo['encoderTap'] | undefined,
): { intent: 'info'; title: string; compact: true } | undefined {
  const live = encoder?.capabilities;
  if (luidKey(live?.adapterLuid)) {
    return { intent: 'info', compact: true,
      title: t('Driver-verified encoder GPU: {gpu}', { gpu: describeAdapter(gpu, live!.adapterLuid, live!.gpuName) }) };
  }
  const preferred = preferredEncoderAdapter(gpu);
  if (!preferred) return undefined;
  return { intent: 'info', compact: true,
    title: t('Preferred encoder GPU: {gpu}. Awaiting encoder session verification.', { gpu: describeAdapter(gpu, preferred.adapterLuid, preferred.gpuName) }) };
}

export const ENCODER_MISMATCH_TITLE = () => t('NVENC session opened on a different GPU');
export const RENDERER_MISMATCH_TITLE = () => t('SteamVR rendering GPU differs from preferred NVIDIA encoder GPU');
