use serde::Serialize;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::WebviewWindowBuilder;
#[cfg(not(target_os = "macos"))]
use tauri::RunEvent;
use tauri::{DragDropEvent, Emitter, Manager, Webview, WebviewEvent};
#[cfg(target_os = "macos")]
use tauri::{RunEvent, WindowEvent};

const MAIN_WINDOW_DRAG_DROP_FORWARD_EVENT: &str = "main-window://drag-drop";

/// Stores paths that were passed to the app on launch (via drag-drop or CLI)
/// Frontend can retrieve these paths after it's ready
static PENDING_OPEN_PATHS: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[derive(Clone, Serialize)]
struct ForwardedDragDropPosition {
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize)]
struct ForwardedDragDropPayload {
    #[serde(rename = "type")]
    event_type: &'static str,
    position: ForwardedDragDropPosition,
    paths: Option<Vec<String>>,
}

/// Get and clear any pending paths that were passed to the app on launch
#[tauri::command]
fn get_pending_open_paths() -> Vec<String> {
    let mut paths = PENDING_OPEN_PATHS.lock().unwrap();
    std::mem::take(&mut *paths)
}

fn forwarded_drag_drop_position<R: tauri::Runtime>(
    webview: &Webview<R>,
    position: &tauri::PhysicalPosition<f64>,
) -> ForwardedDragDropPosition {
    let offset = if webview.label() == "main" {
        None
    } else {
        webview.position().ok()
    };
    ForwardedDragDropPosition {
        x: position.x + offset.map(|point| point.x as f64).unwrap_or(0.0),
        y: position.y + offset.map(|point| point.y as f64).unwrap_or(0.0),
    }
}

fn forwarded_drag_drop_paths(paths: &[std::path::PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn forward_webview_drag_drop_to_main<R: tauri::Runtime>(
    webview: &Webview<R>,
    event: &WebviewEvent,
) {
    let event = match event {
        WebviewEvent::DragDrop(event) => event,
        _ => return,
    };
    let payload = match event {
        DragDropEvent::Enter { paths, position } => Some(ForwardedDragDropPayload {
            event_type: "enter",
            position: forwarded_drag_drop_position(webview, position),
            paths: Some(forwarded_drag_drop_paths(paths)),
        }),
        DragDropEvent::Over { position } => Some(ForwardedDragDropPayload {
            event_type: "over",
            position: forwarded_drag_drop_position(webview, position),
            paths: None,
        }),
        DragDropEvent::Drop { paths, position } => Some(ForwardedDragDropPayload {
            event_type: "drop",
            position: forwarded_drag_drop_position(webview, position),
            paths: Some(forwarded_drag_drop_paths(paths)),
        }),
        DragDropEvent::Leave => None,
        _ => None,
    };
    if let (Some(payload), Some(main_window)) =
        (payload, webview.window().get_webview_window("main"))
    {
        let _ = main_window.emit(MAIN_WINDOW_DRAG_DROP_FORWARD_EVENT, payload);
    }
}

mod agents;
mod app_paths;
mod backend;
mod backend_budget;
mod browser_agent;
mod claude_commands;
mod claude_home;
mod client_error_log;
mod client_storage;
mod code_intel;
mod codex;
mod command_registry;
mod computer_use;
mod curated_skills;
mod diagnostics_bundle;
mod dictation;
mod email;
mod engine;
mod event_sink;
mod files;
mod git;
mod git_utils;
mod input_history;
mod linux_startup_guard;
mod local_usage;
mod menu;
mod note_cards;
mod project_canvas;
mod project_identity;
mod project_map;
mod project_map_api_contracts;
mod project_map_relations;
mod project_memory;
mod prompts;
mod remote_backend;
mod renderer_stability;
mod rules;
mod runtime;
mod runtime_log;
mod session_management;
mod settings;
mod shared;
mod shared_sessions;
mod skills;
mod snapshot_throttle;
mod startup_guard;
mod state;
mod storage;
mod terminal;
mod text_encoding;
mod types;
mod utils;
mod vendors;
mod web_service;
mod window;
mod workspaces;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        // Avoid WebKit compositing issues on NVIDIA Linux setups (GBM buffer errors).
        if std::env::var_os("__NV_PRIME_RENDER_OFFLOAD").is_none() {
            std::env::set_var("__NV_PRIME_RENDER_OFFLOAD", "1");
        }
        match linux_startup_guard::prepare_launch() {
            Ok(decision) => {
                linux_startup_guard::apply_launch_env(&decision);
                linux_startup_guard::log_launch_decision(&decision);
            }
            Err(error) => {
                log::warn!("Failed to prepare Linux startup guard: {error}");
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        match startup_guard::prepare_launch() {
            Ok(decision) => {
                if decision.enable_webview2_compat_mode {
                    startup_guard::apply_webview2_compat_env();
                    log::warn!(
                        "WebView2 compatibility mode enabled after {} consecutive unready launches",
                        decision.consecutive_unready_launches
                    );
                }
                if decision.enable_webview2_gpu_fallback {
                    startup_guard::apply_webview2_gpu_fallback_env();
                    log::warn!(
                        "WebView2 GPU fallback enabled after {} consecutive unready launches",
                        decision.consecutive_unready_launches
                    );
                }
            }
            Err(error) => {
                log::warn!("Failed to prepare startup guard: {error}");
            }
        }
    }

    let builder = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .manage(menu::MenuItemRegistry::<tauri::Wry>::default())
        .menu(menu::build_menu)
        .on_menu_event(menu::handle_menu_event)
        .on_webview_event(forward_webview_drag_drop_to_main)
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            #[cfg(target_os = "macos")]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            if let Err(error) = app_paths::app_home_dir() {
                log::warn!("Failed to prepare CodePort home directory: {error}");
            }
            let state = state::AppState::load(&app.handle());
            app.manage(state);
            renderer_stability::spawn_renderer_heartbeat_watchdog(app.handle().clone());
            {
                // Start the in-process AskUserQuestion MCP server so mid-turn
                // structured asks work in default/acceptEdits (not just plan mode).
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<state::AppState>();
                    let claude_manager = state.engine_manager.claude_manager.clone();
                    if let Err(error) =
                        crate::engine::claude::init_askuser_mcp_global(claude_manager).await
                    {
                        log::warn!("Failed to start AskUserQuestion MCP server: {error}");
                    }
                });
            }
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<state::AppState>();
                    state.sync_engine_configs_from_settings().await;
                });
            }
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                        let state = app_handle.state::<state::AppState>();
                        if state.runtime_manager.is_shutting_down() {
                            break;
                        }
                        let settings = state.app_settings.lock().await.clone();
                        crate::runtime::commands::run_reconcile_cycle(&state, &settings).await;
                    }
                });
            }
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_notification::init())?;
            }

            // Create the main window programmatically so we can register on_navigation
            // to intercept external URLs (e.g. links inside iframes) and open them
            // in the system browser instead of navigating the webview.
            let mut win_builder =
                WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                    .title("CodePort")
                    .inner_size(1300.0, 800.0)
                    .min_inner_size(800.0, 600.0)
                    .devtools(true);

            #[cfg(target_os = "windows")]
            {
                win_builder = win_builder.drag_and_drop(true).decorations(false);
            }

            #[cfg(target_os = "macos")]
            {
                win_builder = win_builder
                    .background_throttling(BackgroundThrottlingPolicy::Disabled)
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .transparent(false);
            }

            win_builder = win_builder.on_navigation(|url: &tauri::Url| {
                let scheme = url.scheme();
                let host = url.host_str().unwrap_or("");

                // Allow tauri internal protocol
                if scheme == "tauri" || scheme == "asset" {
                    return true;
                }

                // Allow localhost (dev server + memory iframe)
                // Windows uses http://tauri.localhost/ as the internal webview origin
                if host == "localhost" || host == "127.0.0.1" || host == "tauri.localhost" {
                    return true;
                }

                // External URL → open in system browser, block webview navigation
                if scheme == "http" || scheme == "https" {
                    let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    return false;
                }

                true
            });

            let window = win_builder.build()?;

            // Hide the menu bar on Windows while keeping accelerator shortcuts active.
            #[cfg(target_os = "windows")]
            {
                let _ = window.hide_menu();
            }

            // Suppress unused variable warning on non-Windows
            let _ = &window;

            Ok(())
        });

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    let app = builder
        // .plugin(tauri_plugin_liquid_glass::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(command_registry::invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        match &event {
            RunEvent::Reopen { .. } => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            RunEvent::Opened { urls } => {
                // Handle files/folders dropped on the app icon (macOS)
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| {
                        if url.scheme() == "file" {
                            url.to_file_path()
                                .ok()
                                .map(|p| p.to_string_lossy().into_owned())
                        } else {
                            None
                        }
                    })
                    .collect();
                if !paths.is_empty() {
                    // Store paths for frontend to retrieve later (in case event is missed)
                    if let Ok(mut pending) = PENDING_OPEN_PATHS.lock() {
                        pending.extend(paths.clone());
                    }
                    // Also try to emit event immediately (for when app is already running)
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.emit("open-paths", paths);
                    }
                }
            }
            _ => {}
        }

        #[cfg(not(target_os = "macos"))]
        if let RunEvent::Ready = event {
            #[cfg(target_os = "windows")]
            if let Some(window) = app_handle.get_webview_window("main") {
                // Re-apply frameless mode after startup to avoid any state-restore override.
                let _ = window.set_decorations(false);
            }

            // Handle command line arguments (Windows/Linux)
            let args: Vec<String> = std::env::args().skip(1).collect();
            let paths: Vec<String> = args
                .into_iter()
                .filter(|arg| !arg.starts_with('-') && std::path::Path::new(arg).exists())
                .collect();
            if !paths.is_empty() {
                // Store paths for frontend to retrieve later
                if let Ok(mut pending) = PENDING_OPEN_PATHS.lock() {
                    pending.extend(paths.clone());
                }
                // Also try to emit event
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit("open-paths", paths);
                }
            }
        }

        // Clean up active AI processes on app exit to prevent orphaned CLI processes
        if let RunEvent::ExitRequested { .. } = &event {
            let state = app_handle.state::<state::AppState>();
            let manager = &state.engine_manager;
            tauri::async_runtime::block_on(async {
                manager.claude_manager.interrupt_all().await;
                if state
                    .app_settings
                    .lock()
                    .await
                    .runtime_force_cleanup_on_exit
                {
                    crate::runtime::shutdown_managed_runtimes(&state).await;
                }
                crate::terminal::cleanup_all_terminal_sessions(&state).await;
            });
        }
    });
}
