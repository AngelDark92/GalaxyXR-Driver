// Typed native bridge, ported from src/app/tauri_wrapper.ts (Angular era).
// Command names, argument keys and result meanings are the IPC contract with
// src-tauri/src/js_api.rs + driver_installation.rs; keep them in lockstep.
import { invoke } from '@tauri-apps/api/core';
import type { OfxrPreferences, OfxrStatus } from '../domain/types';
export type { OfxrPreferences, OfxrStatus };
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

// OFXR Bridge managed component (2026-10-17). Pinned IPC contract (brief W4A):
// ofxr_status() -> OfxrStatus, ofxr_arm(prefs) -> OfxrStatus,
// ofxr_disarm() -> OfxrStatus, ofxr_apply(prefs) -> void. The Rust side owns
// the layer registration, the version gate and the INI write-through.
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

// 2026-10-19 bitrate curve preview window (src-tauri/src/curve_preview.rs).
// The window is read-only: it resolves the values the driver would use and the
// page never writes through it.
export interface CurvePreviewState {
    curve: number;
    constancyPct: number;
    ceilingMbit: number;
    clampMbit: number;
}
export async function open_curve_preview(locale: string): Promise<void> {
    return invoke('open_curve_preview', { locale });
}
export async function curve_preview_state(): Promise<CurvePreviewState> {
    return invoke('curve_preview_state');
}
