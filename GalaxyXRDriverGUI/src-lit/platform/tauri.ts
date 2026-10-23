// Typed native bridge, ported from src/app/tauri_wrapper.ts (Angular era).
// Command names, argument keys and result meanings are the IPC contract with
// src-tauri/src/js_api.rs + driver_installation.rs; keep them in lockstep.
import { invoke } from '@tauri-apps/api/core';
import type { OfxrPreferences, OfxrStatus } from '../domain/types';
export type { OfxrPreferences, OfxrStatus };

/** Title-bar Close (X) behavior; the Minimize button is independent. */
export type CompanionCloseAction = 'ask' | 'close' | 'minimise';
export interface CompanionTrayLabels { open: string; quit: string; tooltip: string; }
export function sync_companion_lifecycle(closeAction: CompanionCloseAction, minimizeToTray: boolean, labels: CompanionTrayLabels): Promise<void> {
    return invoke('sync_companion_lifecycle', { closeAction, minimizeToTray, labels });
}
/** Answers a companion-close-requested prompt; the token is the prompt's own. */
export function request_companion_quit(token: number): Promise<void> {
    return invoke('request_companion_quit', { token });
}
/** Cancelling the prompt retires its token so the native timeout cannot quit later. */
export function dismiss_companion_close(token: number): Promise<void> {
    return invoke('dismiss_companion_close', { token });
}
export function complete_companion_quit(token: number, error: string | null): Promise<void> {
    return invoke('complete_companion_quit', { token, error });
}
// SteamVR settings diff is pure logic in the domain layer (unit-tested by
// tools/Test-SteamVRSettingsDiff.cjs); re-exported here so the platform
// module keeps its public API.
import { steamVRSettingsDiff, type SteamVRSettingChange } from '../domain/steamvr-settings-diff';
export { steamVRSettingsDiff };
export type { SteamVRSettingChange };

export type MaintenanceOutcome = 'complete' | 'attention-required' | 'incomplete';
export interface MaintenanceReport {
    outcome: MaintenanceOutcome;
    preservedPaths: string[];
    unresolvedItems: string[];
}
export interface DriverUninstallReport extends MaintenanceReport {
    removedPaths: string[];
    restoredSettings: number;
    legacyReset: boolean;
    warnings: string[];
}
export interface IdentityCleanupReport {
    removedKeys: string[];
    removedSections: string[];
    warnings: string[];
    backupPath: string | null;
}
export async function clean_legacy_galaxyxr_identity(steamvrPath: string): Promise<IdentityCleanupReport> {
    return invoke('clean_legacy_galaxyxr_identity', { steamvrPath });
}
export async function register_galaxyxr_driver(steamvrPath: string, driverPath: string) {
    return invoke('register_galaxyxr_driver', { steamvrPath, driverPath });
}
export async function update_galaxyxr_steamvr_settings(steamvrPath: string, changes: SteamVRSettingChange[]) {
    return invoke('update_galaxyxr_steamvr_settings', { steamvrPath, changes });
}
export async function uninstall_galaxyxr_driver(steamvrPath?: string): Promise<DriverUninstallReport> {
    return invoke('uninstall_galaxyxr_driver', { steamvrPath: steamvrPath ?? null });
}

export async function get_executable_path() {
    return await invoke('get_executable_path') as string;

}
export async function is_vrmonitor_running() {
    return await invoke('is_vrmonitor_running') as boolean;
}
export async function restart_vrcompositor() {
    return await invoke('restart_vrcompositor') as boolean;
}
export async function kill_process(process_name: string): Promise<boolean> {
    return await invoke('kill_process', { processName: process_name }) as boolean;
}
export async function launch_process(path: string, args: string[]): Promise<boolean> {
    return await invoke('launch_process', { path, args }) as boolean;
}

export async function run_process_sync(path: string, args: string[]): Promise<number> {
    return await invoke('run_process_sync', { path, args }) as number;
}

export interface CleanSettingsReport extends MaintenanceReport {
    backupPath: string;
    resetFiles: string[];
    restoredSettings: number;
    removedIdentityKeys: string[];
    removedIdentitySections: string[];
    steamvrCleaned: boolean;
    warnings: string[];
}
export interface EncoderRestoreReport extends MaintenanceReport {
    backupPath: string;
    resetFiles: string[];
    tapEnabled: boolean;
    warnings: string[];
}
export function restore_steamlink_encoder_behaviour(steamvrPath?: string): Promise<EncoderRestoreReport> {
    return invoke('restore_steamlink_encoder_behaviour', { steamvrPath: steamvrPath ?? null });
}
export interface DriverRuntimeStatus {
    state: 'not-running' | 'waiting' | 'locked-out' | 'version-mismatch' | 'initialized' | 'headset-connected';
    detail: string;
    steamvrRunning: boolean;
    driverInitialized: boolean;
    headsetConnected: boolean;
    driverVersion: string | null;
    serverPid: number | null;
    checkedAt: number;
    encoderTap?: {
        state: 'enabled' | 'restart-required' | 'disabled';
        configPath: string;
        modulePath: string;
    } | null;
}
export function clean_galaxyxr_settings(steamvrPath?: string): Promise<CleanSettingsReport> {
    return invoke('clean_galaxyxr_settings', { steamvrPath: steamvrPath ?? null });
}
export function get_galaxyxr_runtime_status(steamvrPath: string | undefined, expectedVersion: string): Promise<DriverRuntimeStatus> {
    return invoke('get_galaxyxr_runtime_status', { steamvrPath: steamvrPath ?? null, expectedVersion });
}

// OFXR Bridge managed component (2026-10-17; 2026-10-23). Pinned IPC contract:
// ofxr_status() -> OfxrStatus, ofxr_arm(prefs) -> OfxrStatus,
// ofxr_disarm() -> OfxrStatus, ofxr_apply(prefs) -> void,
// ofxr_import(folder) -> version. The Rust side owns the layer registration
// and the INI write-through; imported builds are copied without a version gate.
export function ofxr_status(selected: string): Promise<OfxrStatus> {
    return invoke('ofxr_status', { selected: selected || null });
}
export function ofxr_arm(prefs: OfxrPreferences): Promise<OfxrStatus> {
    return invoke('ofxr_arm', { prefs });
}
export function ofxr_disarm(): Promise<OfxrStatus> {
    return invoke('ofxr_disarm');
}
export function ofxr_apply(prefs: OfxrPreferences): Promise<void> {
    return invoke('ofxr_apply', { prefs });
}

export function ofxr_import(source: string): Promise<string> {
    return invoke('ofxr_import', { source });
}

export function ofxr_reinstall(prefs: OfxrPreferences): Promise<OfxrStatus> {
    return invoke('ofxr_reinstall', { prefs });
}

export function ofxr_remove(): Promise<OfxrStatus> {
    return invoke('ofxr_remove');
}

// Interface scale (2026-10-19): the Companion window uses the native webview
// zoom factor, not CSS zoom. CSS zoom separates getBoundingClientRect() from
// style pixels and misplaces Fluent's fixed-position dropdowns and tooltips;
// the platform zoom factor keeps one coordinate space for layout and popups.
export function set_webview_zoom(scale: number): Promise<void> {
    return invoke('set_webview_zoom', { scale });
}

// 2026-10-19 bitrate curve editor window (src-tauri/src/curve_preview.rs).
// The window receives a snapshot of the Companion's current values and relays
// committed point edits back to the main window, which owns the settings write.
export interface CurvePreviewPoint {
    x: number;
    y: number;
}
export interface CurvePreviewState {
    curve: number;
    constancyPct: number;
    ceilingMbit: number;
    /** 'No fallback' on: the streamer request is fixed at Max Bitrate. */
    fallbackDisabled: boolean;
    /** Seven displayed handles: derived for presets, saved shape for Custom. */
    points: CurvePreviewPoint[];
    /** SteamVR is running; curve changes are disabled. */
    locked: boolean;
}
export async function open_curve_preview(locale: string, snapshot: CurvePreviewState): Promise<void> {
    return invoke('open_curve_preview', { locale, snapshot });
}
export async function publish_curve_preview(snapshot: CurvePreviewState): Promise<void> {
    return invoke('publish_curve_preview', { snapshot });
}
export async function curve_preview_state(): Promise<CurvePreviewState> {
    return invoke('curve_preview_state');
}
export async function submit_curve_preview_edit(points: CurvePreviewPoint[]): Promise<void> {
    return invoke('submit_curve_preview_edit', { points });
}
export async function submit_curve_preview_reset(): Promise<void> {
    return invoke('submit_curve_preview_reset');
}
export async function close_curve_preview(): Promise<void> {
    return invoke('close_curve_preview');
}

// 2026-10-23 on-demand bitrate monitor window
// (src-tauri/src/bitrate_monitor). Sampling starts only after the window asks;
// every worker stops on close or hide.
export type BitrateSampleKind = 'nvenc' | 'decoderInput' | 'networkRxAllTraffic';
export interface BitrateCodecDetection {
    codec: string | null;
    label: string;
    evidence: string;
    ageSeconds: number;
    frameSha256?: string | null;
    frameIndex?: number | null;
    captureId?: number | null;
    generation?: number | null;
    capturedTickMs?: number | null;
    frameBytes?: number | null;
    sampledAt?: number | null;
}
export interface BitrateSample {
    sourceId: string;
    monotonicTime: number;
    totalBytes: number;
    frames?: number | null;
    kind: BitrateSampleKind;
    pid?: number | null;
    moduleSha256?: string | null;
    serial?: string | null;
    interface?: string | null;
    codec?: BitrateCodecDetection | null;
}
export interface BitrateSampleError { code: string; detail: string; }
export interface BitrateSampleEvent {
    generation: number;
    source: 'nvenc' | 'headset';
    sample?: BitrateSample | null;
    error?: BitrateSampleError | null;
}
export interface BitrateMonitorConfig {
    infoPath?: string | null;
    adbPath: string;
    serial: string;
    codecInterval: number;
}
export interface BitrateMonitorPreferences {
    adbPath: string;
    serial: string;
    codecInterval: number;
    defaultAdb: string;
    invalidInterval: boolean;
}
export async function open_bitrate_monitor(
    locale: string, title: string, colorScheme: string, debugMode: boolean, infoPath: string,
): Promise<void> {
    return invoke('open_bitrate_monitor', { locale, title, colorScheme, debugMode, infoPath });
}
export async function close_bitrate_monitor(): Promise<void> {
    return invoke('close_bitrate_monitor');
}
export async function publish_bitrate_monitor_theme(colorScheme: string): Promise<void> {
    return invoke('publish_bitrate_monitor_theme', { colorScheme });
}
export interface BitrateMonitorEnvironment { theme: string; infoPath?: string | null; }
export async function bitrate_monitor_environment(): Promise<BitrateMonitorEnvironment> {
    return invoke('bitrate_monitor_environment') as Promise<BitrateMonitorEnvironment>;
}
export async function start_bitrate_monitor(config: BitrateMonitorConfig): Promise<number> {
    return invoke('start_bitrate_monitor', { config }) as Promise<number>;
}
export async function stop_bitrate_monitor(): Promise<void> {
    return invoke('stop_bitrate_monitor');
}
export async function bitrate_monitor_preferences(): Promise<BitrateMonitorPreferences> {
    return invoke('bitrate_monitor_preferences') as Promise<BitrateMonitorPreferences>;
}
export async function save_bitrate_monitor_preferences(preferences: BitrateMonitorPreferences): Promise<void> {
    return invoke('save_bitrate_monitor_preferences', { preferences });
}
export async function write_bitrate_csv(path: string, content: string): Promise<void> {
    return invoke('write_bitrate_csv', { path, content });
}
