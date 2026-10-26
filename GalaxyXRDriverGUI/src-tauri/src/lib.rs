mod i18n;
mod js_api;
mod driver_installation;
mod ofxr;
mod webview_zoom;
mod curve_preview;
mod bitrate_monitor;
mod tray;
mod webview_resources;
mod windows_startup;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let start_in_tray = tray::start_in_tray_argument(std::env::args_os());
    let mut context = tauri::generate_context!();
    if start_in_tray {
        // Set this before Tauri creates the window: hiding in setup flashes
        // the Companion during Windows sign-in.
        for window in &mut context.config_mut().app.windows {
            if window.label == "main" { window.visible = false; }
        }
    }
    tauri::Builder::default()
        // Registered FIRST on purpose: this plugin must observe the launch
        // before any other plugin initialises. The callback runs in the
        // ALREADY-RUNNING instance. A background launch leaves its visibility
        // alone; a manual launch restores the full lifecycle, including graphs.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !tray::start_in_tray_argument(argv) { tray::open_companion(app); }
        }))
        .manage(curve_preview::Preview::default())
        .manage(bitrate_monitor::Monitor::default())
        .manage(tray::Lifecycle::new(start_in_tray))
        .manage(webview_resources::Resources::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            tray::restore_deferred_open(app.handle());
            tray::start_startup_watchdog(app.handle());
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if cfg!(not(debug_assertions)) {
                i18n::load_i18n_page(app);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            js_api::get_executable_path,
            js_api::is_vrmonitor_running,
            js_api::restart_vrcompositor,
            js_api::kill_process,
            js_api::launch_process,
            js_api::run_process_sync,
            driver_installation::register_galaxyxr_driver,
            driver_installation::update_galaxyxr_steamvr_settings,
            driver_installation::uninstall_galaxyxr_driver,
            driver_installation::clean_legacy_galaxyxr_identity,
            driver_installation::settings_cleanup::clean_galaxyxr_settings,
            driver_installation::settings_cleanup::restore_steamlink_encoder_behaviour,
            driver_installation::runtime_status::get_galaxyxr_runtime_status,
            ofxr::ofxr_status,
            ofxr::ofxr_arm,
            ofxr::ofxr_disarm,
            ofxr::ofxr_apply,
            ofxr::ofxr_reinstall,
            ofxr::ofxr_import,
            ofxr::ofxr_remove,
            webview_zoom::set_webview_zoom,
            curve_preview::open_curve_preview,
            curve_preview::curve_preview_state,
            curve_preview::submit_curve_preview_edit,
            curve_preview::submit_curve_preview_reset,
            curve_preview::close_curve_preview,
            curve_preview::publish_curve_preview,
            bitrate_monitor::open_bitrate_monitor,
            bitrate_monitor::close_bitrate_monitor,
            bitrate_monitor::close_bitrate_monitor_window,
            bitrate_monitor::publish_bitrate_monitor_theme,
            bitrate_monitor::bitrate_monitor_environment,
            bitrate_monitor::start_bitrate_monitor,
            bitrate_monitor::stop_bitrate_monitor,
            bitrate_monitor::bitrate_monitor_preferences,
            bitrate_monitor::save_bitrate_monitor_preferences,
            bitrate_monitor::write_bitrate_csv,
            tray::sync_companion_lifecycle,
            tray::complete_companion_startup,
            tray::complete_companion_quit,
            tray::request_companion_quit,
            tray::dismiss_companion_close,
            windows_startup::get_windows_startup,
            windows_startup::set_windows_startup,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => {
                bitrate_monitor::shutdown_on_exit(app);
                ofxr::shutdown_on_exit();
            }
            // A genuine main-window destruction is still an exit fallback;
            // CloseRequested is routed through tray/settings-flush policy below.
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } if label == "main" => {
                bitrate_monitor::shutdown_on_exit(app);
                app.exit(0);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } if label == curve_preview::PREVIEW_LABEL => {
                tray::window_event(app, &label, &tauri::WindowEvent::Destroyed);
                curve_preview::destroyed(app);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } if label == bitrate_monitor::WINDOW_LABEL => {
                tray::window_event(app, &label, &tauri::WindowEvent::Destroyed);
                bitrate_monitor::destroyed(app);
            }
            tauri::RunEvent::WindowEvent { label, event, .. } => tray::window_event(app, &label, &event),
            _ => {}
        });
}
