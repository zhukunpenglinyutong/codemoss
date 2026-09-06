//! End-to-end terminal test: real PTY session via the terminal commands,
//! output captured from the batching terminal sink. Verifies the chain the
//! dock depends on: open spawns a shell in the given cwd, write reaches it,
//! output arrives as `terminal://output` batches, close kills the session.

use ccgui_next_lib::config::ConfigStore;
use ccgui_next_lib::db::Db;
use ccgui_next_lib::engine::ProcessRegistry;
use ccgui_next_lib::event_sink::EventSink;
use ccgui_next_lib::terminal::{self, TERMINAL_OUTPUT_EVENT};
use ccgui_next_lib::AppState;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Listener, Manager};

fn temp_home(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ccgui-terminal-test-{}-{}", tag, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn build_app(home: &std::path::Path) -> tauri::App<tauri::test::MockRuntime> {
    std::env::set_var("HOME", home);
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AppState {
        db: Arc::new(Db::open_at(&home.join("app.db")).unwrap()),
        sink: EventSink::new(Arc::new(app.handle().clone())),
        terminal_sink: EventSink::with_name(
            Arc::new(app.handle().clone()),
            TERMINAL_OUTPUT_EVENT,
        ),
        terminals: terminal::TerminalRegistry::default(),
        processes: Arc::new(ProcessRegistry::default()),
        config_store: ConfigStore::default(),
    });
    app
}

fn invoke(app: &tauri::App<tauri::test::MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let label = format!("w-{}-{}", cmd, COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let webview = tauri::WebviewWindowBuilder::new(app, label, Default::default())
        .build()
        .unwrap();
    tauri::test::get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map(|r| r.deserialize::<Value>().unwrap())
}

#[cfg(unix)]
#[test]
fn terminal_session_roundtrip() {
    let home = temp_home("roundtrip");
    let app = build_app(&home);

    let batches: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&batches);
    app.handle().listen_any(TERMINAL_OUTPUT_EVENT, move |event| {
        if let Ok(batch) = serde_json::from_str::<Vec<Value>>(event.payload()) {
            captured.lock().unwrap().extend(batch);
        }
    });

    // Open a shell in the temp workspace.
    invoke(
        &app,
        "terminal_open",
        serde_json::json!({ "id": "t1", "cwd": home, "cols": 80, "rows": 24 }),
    )
    .unwrap();
    // Run a command whose output is a unique marker.
    invoke(
        &app,
        "terminal_write",
        serde_json::json!({ "id": "t1", "data": "echo marker-$((6*7))\n" }),
    )
    .unwrap();

    // Wait for the marker to arrive (sink batches at 32ms; allow startup).
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut received = String::new();
    while Instant::now() < deadline {
        {
            let batches = batches.lock().unwrap();
            received = batches
                .iter()
                .filter(|p| p["id"] == "t1")
                .map(|p| p["data"].as_str().unwrap_or("").to_string())
                .collect();
        }
        if received.contains("marker-42") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        received.contains("marker-42"),
        "expected shell output to contain marker-42, got: {received:?}"
    );

    // Resize must succeed against the live session.
    invoke(
        &app,
        "terminal_resize",
        serde_json::json!({ "id": "t1", "cols": 120, "rows": 40 }),
    )
    .unwrap();

    // Close kills the session; a write afterwards reports it missing.
    invoke(&app, "terminal_close", serde_json::json!({ "id": "t1" })).unwrap();
    let err = invoke(
        &app,
        "terminal_write",
        serde_json::json!({ "id": "t1", "data": "echo again\n" }),
    )
    .unwrap_err();
    assert!(
        err.as_str().unwrap_or("").contains("Terminal session not found"),
        "expected not-found error after close, got: {err}"
    );
}

#[cfg(unix)]
#[test]
fn terminal_open_rejects_missing_cwd() {
    let home = temp_home("bad-cwd");
    let app = build_app(&home);
    let err = invoke(
        &app,
        "terminal_open",
        serde_json::json!({
            "id": "t-x",
            "cwd": home.join("does-not-exist"),
            "cols": 80,
            "rows": 24,
        }),
    )
    .unwrap_err();
    assert!(
        err.as_str().unwrap_or("").contains("does not exist"),
        "expected cwd validation error, got: {err}"
    );
}
