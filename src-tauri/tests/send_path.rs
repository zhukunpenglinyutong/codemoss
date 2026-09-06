//! End-to-end send-path test: fake `claude` CLI on PATH emitting stream-json
//! NDJSON, real send_message command, real EventSink, events captured via
//! listen_global. Verifies the whole chain the UI depends on.

use ccgui_next_lib::config::ConfigStore;
use ccgui_next_lib::db::Db;
use ccgui_next_lib::engine::{self, ProcessRegistry};
use ccgui_next_lib::event_sink::{EventSink, ENGINE_EVENT_NAME};
use ccgui_next_lib::AppState;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{Listener, Manager};
/// Tests mutate process-global HOME/PATH; serialize them. Holding the std
/// guard across awaits is intentional here (test serialization, no deadlock:
/// each test awaits only its own child processes).
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn temp_home(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ccgui-send-test-{}-{}", tag, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_fake_claude(dir: &std::path::Path) {
    let script = r#"#!/bin/sh
read -r line
echo '{"type":"system","subtype":"init","session_id":"fake-session-123"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"from fake"}}}'
echo '{"type":"result","subtype":"success","session_id":"fake-session-123","usage":{"input_tokens":10,"output_tokens":5}}'
"#;
    let path = dir.join("claude");
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn build_app(
    home: &std::path::Path,
) -> (tauri::App<tauri::test::MockRuntime>, Arc<Mutex<Vec<Value>>>) {
    std::env::set_var("HOME", home);
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = AppState {
        db: Arc::new(Db::open_at(&home.join("app.db")).unwrap()),
        sink: EventSink::new(Arc::new(app.handle().clone())),
        terminal_sink: EventSink::with_name(
            Arc::new(app.handle().clone()),
            ccgui_next_lib::terminal::TERMINAL_OUTPUT_EVENT,
        ),
        terminals: ccgui_next_lib::terminal::TerminalRegistry::default(),
        processes: Arc::new(ProcessRegistry::default()),
        config_store: ConfigStore::default(),
    };
    app.manage(state);

    let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&events);
    let handle = app.handle().clone();
    handle.listen_any(ENGINE_EVENT_NAME, move |event: tauri::Event| {
        if let Ok(batch) = serde_json::from_str::<Vec<Value>>(event.payload()) {
            captured.lock().unwrap().extend(batch);
        }
    });
    (app, events)
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn send_message_streams_events_end_to_end() {
    let _env_guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("stream");
    let bin_dir = home.join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    write_fake_claude(&bin_dir);
    std::env::set_var("PATH", format!("{}:/usr/bin:/bin", bin_dir.display()));

    let workspace = home.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();

    let (app, events) = build_app(&home);
    let state = app.state::<AppState>();

    let result = engine::send_message(
        state,
        "claude".to_string(),
        workspace.to_string_lossy().to_string(),
        None,
        "hi".to_string(),
        None,
        None,
        None,
    )
    .await
    .expect("send_message must succeed");
    assert!(!result.run_id.is_empty());

    // Wait for the done event (events are batched at 32ms).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let kinds: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| e.get("kind").and_then(Value::as_str).map(str::to_string))
            .collect();
        if kinds.iter().any(|k| k == "done") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no done event within 5s"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let collected = events.lock().unwrap();
    let kinds: Vec<&str> = collected
        .iter()
        .filter_map(|e| e.get("kind").and_then(Value::as_str))
        .collect();
    assert!(
        kinds.contains(&"session"),
        "session event missing: {kinds:?}"
    );
    assert!(kinds.contains(&"delta"), "delta events missing: {kinds:?}");

    let session_event = collected
        .iter()
        .find(|e| e.get("kind").and_then(Value::as_str) == Some("session"))
        .unwrap();
    assert_eq!(
        session_event.get("data").and_then(Value::as_str),
        Some("fake-session-123")
    );
    let delta_text: String = collected
        .iter()
        .filter(|e| e.get("kind").and_then(Value::as_str) == Some("delta"))
        .filter_map(|e| e.get("data").and_then(Value::as_str).map(str::to_string))
        .collect();
    assert_eq!(delta_text, "Hello from fake");

    let done = collected
        .iter()
        .find(|e| e.get("kind").and_then(Value::as_str) == Some("done"))
        .unwrap();
    assert_eq!(
        done.get("sessionId").and_then(Value::as_str),
        Some("fake-session-123")
    );

    // Process registry drained after exit.
    assert!(app
        .state::<AppState>()
        .processes
        .0
        .lock()
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn interrupt_kills_running_child() {
    let _env_guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("interrupt");
    let bin_dir = home.join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    // Fake engine that emits a session id then hangs forever.
    let script = r#"#!/bin/sh
read -r line
echo '{"type":"system","subtype":"init","session_id":"fake-hang-1"}'
sleep 60
"#;
    let path = bin_dir.join("claude");
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::env::set_var("PATH", format!("{}:/usr/bin:/bin", bin_dir.display()));

    let workspace = home.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();

    let (app, events) = build_app(&home);
    let state = app.state::<AppState>();
    engine::send_message(
        state,
        "claude".to_string(),
        workspace.to_string_lossy().to_string(),
        None,
        "hi".to_string(),
        None,
        None,
        None,
    )
    .await
    .unwrap();

    // Wait for the session event (child registered under native id).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let seen = events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.get("kind").and_then(Value::as_str) == Some("session"));
        if seen {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no session event within 5s"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let killed = engine::interrupt_session(app.state::<AppState>(), "fake-hang-1".to_string());
    assert!(killed, "interrupt must find and kill the child");

    // Child exits shortly after start_kill.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if app
            .state::<AppState>()
            .processes
            .0
            .lock()
            .unwrap()
            .is_empty()
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "child still registered after kill"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// The JS side invokes with camelCase args (`workspacePath`, `sessionId`,
/// `imagePaths`) against snake_case Rust params; this drives the real IPC
/// router to prove that contract plus the command's presence in the handler.
#[test]
fn ipc_send_message_accepts_camel_case_args() {
    let _env_guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("ipc");
    let bin_dir = home.join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    write_fake_claude(&bin_dir);
    std::env::set_var("HOME", &home);
    std::env::set_var("PATH", format!("{}:/usr/bin:/bin", bin_dir.display()));
    let workspace = home.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();

    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![engine::send_message])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AppState {
        db: Arc::new(Db::open_at(&home.join("app.db")).unwrap()),
        sink: EventSink::new(Arc::new(app.handle().clone())),
        terminal_sink: EventSink::with_name(
            Arc::new(app.handle().clone()),
            ccgui_next_lib::terminal::TERMINAL_OUTPUT_EVENT,
        ),
        terminals: ccgui_next_lib::terminal::TerminalRegistry::default(),
        processes: Arc::new(ProcessRegistry::default()),
        config_store: ConfigStore::default(),
    });
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let res = tauri::test::get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
            cmd: "send_message".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "engine": "claude",
                "workspacePath": workspace.to_string_lossy(),
                "sessionId": null,
                "prompt": "hi",
                "imagePaths": null,
                "model": null,
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    );
    let body = res.unwrap_or_else(|e| panic!("IPC send_message failed: {e}"));
    let value = body.deserialize::<Value>().unwrap();
    let run_id = value.get("runId").and_then(Value::as_str).unwrap_or("");
    assert!(!run_id.is_empty(), "expected runId in response: {value}");
}
