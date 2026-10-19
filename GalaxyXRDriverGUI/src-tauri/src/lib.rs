mod i18n;
mod js_api;
mod driver_installation;
mod ofxr;
mod curve_preview;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
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
            curve_preview::open_curve_preview,
            curve_preview::curve_preview_state,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => ofxr::shutdown_on_exit(),
            // Closing the Companion takes the preview with it; a lone preview
            // window must never keep the process alive.
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } if label == "main" => app.exit(0),
            _ => {}
        });
}
