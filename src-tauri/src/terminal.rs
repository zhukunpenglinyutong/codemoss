//! Integrated terminal: one PTY session per frontend terminal tab.
//!
//! Output is pushed through the terminal `EventSink` (32ms / 64KB batching)
//! as `terminal://output` arrays of `{ id, data }` so output floods (e.g.
//! `cat` of a large file) never swamp the IPC channel with one event per
//! 8KB read.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::event_sink::EventSink;
use crate::AppState;

pub const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";

pub struct TerminalSession {
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send>>,
}

/// Sessions keyed by frontend-generated terminal id (globally unique).
pub type TerminalRegistry = Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    id: String,
    data: String,
}

fn default_shell_path() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}
/// Settings "terminalShellPath" wins when set and valid; anything else (unset,
/// blank, hand-edited junk) falls back to the auto-detected shell so a bad
/// value can never wedge every terminal spawn.
fn resolve_shell_path() -> String {
    let configured = crate::settings::read_settings()
        .ok()
        .and_then(|s| s.terminal_shell_path)
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    match configured {
        Some(path) => match crate::settings::validate_bin_override(&path) {
            Ok(canonical) => canonical.to_string_lossy().into_owned(),
            Err(_) => default_shell_path(),
        },
        None => default_shell_path(),
    }
}

/// Force a UTF-8 locale so tools emitting non-ASCII (git, ls, CLIs) don't
/// fall back to garbled C-locale output.
fn resolve_locale() -> String {
    let candidate = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_else(|_| "en_US.UTF-8".to_string());
    let lower = candidate.to_lowercase();
    if lower.contains("utf-8") || lower.contains("utf8") {
        return candidate;
    }
    "en_US.UTF-8".to_string()
}

/// Blocking PTY reads run on their own thread; decoded chunks go to the
/// batching sink. Splits only on UTF-8 boundaries so multibyte characters
/// straddling two reads survive intact.
fn spawn_reader(
    sink: Arc<EventSink>,
    registry: TerminalRegistry,
    id: String,
    session: Arc<TerminalSession>,
    mut reader: Box<dyn Read + Send>,
) {
    std::thread::spawn(move || {
        // sink.push schedules its flush via tokio::spawn; this std thread has
        // no runtime of its own, so enter the app runtime for the thread's
        // lifetime (plain Handle::enter, no block_on: reads must not block
        // the runtime).
        let runtime = tauri::async_runtime::handle();
        let _runtime_guard = match &runtime {
            tauri::async_runtime::RuntimeHandle::Tokio(handle) => Some(handle.enter()),
            // tauri's RuntimeHandle is effectively Tokio-only today; keep a
            // catch-all so a future second variant compiles unchanged.
            #[allow(unreachable_patterns)]
            _ => None,
        };
        let emit = |data: String| {
            if data.is_empty() {
                return;
            }
            let payload = serde_json::to_value(TerminalOutput {
                id: id.clone(),
                data,
            })
            .unwrap_or(serde_json::Value::Null);
            sink.push(payload);
        };
        let mut buffer = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    pending.extend_from_slice(&buffer[..count]);
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(decoded) => {
                                emit(decoded.to_string());
                                pending.clear();
                                break;
                            }
                            Err(error) => {
                                let valid_up_to = error.valid_up_to();
                                if valid_up_to > 0 {
                                    emit(String::from_utf8_lossy(&pending[..valid_up_to])
                                        .into_owned());
                                    pending.drain(..valid_up_to);
                                }
                                // Incomplete trailing sequence: wait for more bytes.
                                if error.error_len().is_none() {
                                    break;
                                }
                                // Invalid bytes: drop them and resync.
                                let invalid_len = error.error_len().unwrap_or(1);
                                pending.drain(..invalid_len.min(pending.len()));
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        // Shell exited (or read failed): drop the session so a later write
        // fails with "not found" and the frontend respawns on demand.
        tauri::async_runtime::block_on(async move {
            let mut sessions = registry.lock().await;
            if sessions
                .get(&id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                sessions.remove(&id);
            }
        });
    });
}

async fn kill_session(session: Arc<TerminalSession>) {
    let mut child = session.child.lock().await;
    let _ = child.kill();
}

/// Kill every session; called when the window is destroyed.
pub async fn kill_all(registry: &TerminalRegistry) {
    let sessions: Vec<Arc<TerminalSession>> = {
        let mut sessions = registry.lock().await;
        sessions.drain().map(|(_, session)| session).collect()
    };
    for session in sessions {
        kill_session(session).await;
    }
}

/// Global cap on live PTY sessions — each one owns a shell process and a
/// reader thread, so unbounded tabs would leak real resources.
const MAX_TERMINAL_SESSIONS: usize = 32;

#[tauri::command]
pub async fn terminal_open(
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if id.is_empty() {
        return Err("terminal id is required".to_string());
    }
    {
        let sessions = state.terminals.lock().await;
        if sessions.contains_key(&id) {
            return Ok(());
        }
        if sessions.len() >= MAX_TERMINAL_SESSIONS {
            return Err(format!(
                "terminal session limit ({MAX_TERMINAL_SESSIONS}) reached; close one first"
            ));
        }
    }
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("terminal cwd does not exist: {cwd}"));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to open pty: {e}"))?;

    let mut cmd = CommandBuilder::new(resolve_shell_path());
    cmd.cwd(cwd_path);
    // `-i` for an interactive shell (aliases, prompt). N/A for cmd.exe.
    #[cfg(not(windows))]
    cmd.arg("-i");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let locale = resolve_locale();
    cmd.env("LANG", &locale);
    cmd.env("LC_ALL", &locale);
    cmd.env("LC_CTYPE", &locale);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn shell: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("failed to open pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("failed to open pty writer: {e}"))?;

    let session = Arc::new(TerminalSession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });

    {
        let mut sessions = state.terminals.lock().await;
        // Lost a concurrent open race: keep the existing session.
        if sessions.contains_key(&id) {
            drop(sessions);
            kill_session(session).await;
            return Ok(());
        }
        sessions.insert(id.clone(), Arc::clone(&session));
    }
    spawn_reader(
        Arc::clone(&state.terminal_sink),
        Arc::clone(&state.terminals),
        id,
        session,
        reader,
    );
    Ok(())
}

#[tauri::command]
pub async fn terminal_write(
    id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = {
        let sessions = state.terminals.lock().await;
        sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| "Terminal session not found".to_string())?
    };
    // A large paste can exceed the PTY buffer and block mid-write; keep that
    // off the async worker threads.
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(async move {
            let mut writer = session.writer.lock().await;
            writer
                .write_all(data.as_bytes())
                .and_then(|()| writer.flush())
                .map_err(|e| format!("failed to write to pty: {e}"))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn terminal_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = {
        let sessions = state.terminals.lock().await;
        sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| "Terminal session not found".to_string())?
    };
    let master = session.master.lock().await;
    master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to resize pty: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_close(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let session = {
        let mut sessions = state.terminals.lock().await;
        sessions.remove(&id)
    };
    // Closing an already-dead session is a no-op, not an error.
    if let Some(session) = session {
        kill_session(session).await;
    }
    Ok(())
}
