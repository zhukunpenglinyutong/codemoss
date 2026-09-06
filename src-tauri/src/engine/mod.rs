pub mod claude;
pub mod codex;
pub mod dsh;
pub mod pi_family;
pub mod grok;
pub mod images;
pub mod kimi;
pub mod models;

use crate::event_sink;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::Mutex as TokioMutex;

pub struct SendRequest {
    pub session_id: Option<String>,
    pub workspace: PathBuf,
    pub prompt: String,
    pub images: Vec<String>,
    pub model: Option<String>,
    /// Reasoning effort ("low" | "medium" | "high" | "xhigh" | "max"); engines without an
    /// effort knob ignore it, engines with a narrower knob clamp.
    pub effort: Option<String>,
}

pub struct BuiltCommand {
    pub command: Command,
    /// Written to stdin after spawn; stdin is then closed.
    pub stdin_payload: Option<String>,
    /// Temp files to remove once the process exits.
    pub cleanup_files: Vec<PathBuf>,
    /// Session id assigned before spawn (grok `-s <uuid>`).
    pub preassigned_session_id: Option<String>,
}

pub enum EngineEvent {
    /// Streaming text delta (append).
    Delta(String),
    /// Reasoning/thinking delta (append).
    Thinking(String),
    /// A completed message block (role, text).
    Message { role: String, text: String },
    /// Native session id became known.
    SessionId(String),
    /// Token usage snapshot from the engine.
    Usage(Value),
    /// Engine-reported error.
    Error(String),
    /// Turn finished successfully.
    Done {
        session_id: Option<String>,
        usage: Option<Value>,
    },
}

pub trait Engine: Send + Sync {
    fn id(&self) -> &'static str;
    fn build_command(
        &self,
        req: &SendRequest,
        env: &HashMap<String, String>,
        bin: &str,
    ) -> Result<BuiltCommand, String>;
    /// Parse one NDJSON stdout line into zero or more events.
    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>);
    /// Whether this engine accepts image attachments.
    fn supports_images(&self) -> bool;
}

pub fn engine_by_id(id: &str) -> Option<Box<dyn Engine>> {
    match id {
        "claude" => Some(Box::new(claude::ClaudeEngine)),
        "kimi" => Some(Box::new(kimi::KimiEngine)),
        "grok" => Some(Box::new(grok::GrokEngine)),
        "codex" => Some(Box::new(codex::CodexEngine)),
        "pi" => Some(Box::new(pi_family::pi())),
        "omp" => Some(Box::new(pi_family::omp())),
        "dsh" => Some(Box::new(dsh::DshEngine)),
        _ => None,
    }
}

/// Engine home dir: `$ENV_KEY` (with `~` expansion, as the CLIs resolve it)
/// when set and non-empty, else `~/<default_dir>`.
pub(crate) fn engine_home(env_key: Option<&str>, default_dir: &str) -> PathBuf {
    if let Some(key) = env_key {
        if let Some(value) = std::env::var_os(key).filter(|v| !v.is_empty()) {
            let text = value.to_string_lossy();
            if let Ok(expanded) = crate::open_app::expand_user_path(&text) {
                return expanded;
            }
            return PathBuf::from(value);
        }
    }
    dirs::home_dir().unwrap_or_default().join(default_dir)
}

/// A leading '-' would parse as a flag (pi also treats '@' as a file
/// reference): prefix a space so the prompt stays positional text.
pub(crate) fn safe_prompt_arg(prompt: &str) -> String {
    if prompt.starts_with('-') || prompt.starts_with('@') {
        format!(" {prompt}")
    } else {
        prompt.to_string()
    }
}

// ==================== Process registry ====================

/// Live engine child processes keyed by session key (native session id once
/// known, otherwise the run id). Drop kills everything synchronously.
pub struct ChildEntry {
    pub child: Arc<TokioMutex<Child>>,
    pub pid: u32,
    /// The run id this entry started under; after a rekey the map key is the
    /// native session id, but the frontend may still cancel by run id.
    pub run_id: String,
    /// Set by `kill()`: a user-initiated stop is not an error — at EOF the
    /// runner commits the partial turn as done instead of pushing a bogus
    /// "exited with status …" error.
    pub killed: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Default)]
pub struct ProcessRegistry(pub Mutex<HashMap<String, ChildEntry>>);

/// Two concurrent runs of one session must never evict each other's entries:
/// an evicted child leaks (no key routes an interrupt to it).
impl ProcessRegistry {
    fn insert(&self, key: String, entry: ChildEntry) {
        if let Ok(mut map) = self.0.lock() {
            map.insert(key, entry);
        }
    }

    fn len(&self) -> usize {
        self.0.lock().map(|map| map.len()).unwrap_or(0)
    }

    /// Move an entry to the native-session key once known. A colliding target
    /// key belongs to another live run — keep both instead of overwriting.
    fn rekey(&self, from: &str, to: String) {
        if from == to {
            return;
        }
        if let Ok(mut map) = self.0.lock() {
            if map.contains_key(&to) {
                return;
            }
            if let Some(entry) = map.remove(from) {
                map.insert(to, entry);
            }
        }
    }

    /// Remove only if the entry is still the same child (pid match): a run
    /// that lost its session key to nothing must not evict another run's
    /// entry that now lives under that key.
    fn remove_if_pid(&self, key: &str, pid: u32) {
        if let Ok(mut map) = self.0.lock() {
            if map.get(key).map(|entry| entry.pid) == Some(pid) {
                map.remove(key);
            }
        }
    }

    pub fn kill(&self, key: &str) -> bool {
        let entry = match self.0.lock() {
            Ok(map) => map.get(key).map(|e| (e.pid, Arc::clone(&e.child), Arc::clone(&e.killed))),
            Err(_) => None,
        };
        // Fallback: the frontend may cancel by run id after the entry was
        // rekeyed to the native session id.
        let entry = entry.or_else(|| {
            self.0.lock().ok().and_then(|map| {
                map.values()
                    .find(|e| e.run_id == key)
                    .map(|e| (e.pid, Arc::clone(&e.child), Arc::clone(&e.killed)))
            })
        });
        let Some((pid, child, killed)) = entry else {
            return false;
        };
        killed.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut guard) = child.try_lock() {
            // Pid-reuse guard: a reaped child's pid may already belong to
            // someone else — never signal a group we no longer own.
            match guard.try_wait() {
                Ok(Some(_)) => {}
                _ => {
                    kill_process_group(pid);
                    let _ = guard.start_kill();
                }
            }
        } else {
            // The runner holds the lock only while reaping post-EOF; that
            // window is tiny and the kill flag already settles the turn.
            kill_process_group(pid);
        }
        true
    }

    pub fn kill_all(&self) {
        // Blocking lock on the teardown path: skipping children because the
        // lock was briefly contended would leak engine processes.
        let entries: Vec<ChildEntry> = match self.0.lock() {
            Ok(mut map) => map.drain().map(|(_, e)| e).collect(),
            Err(poisoned) => poisoned.into_inner().drain().map(|(_, e)| e).collect(),
        };
        for entry in entries {
            kill_process_group(entry.pid);
            if let Ok(mut guard) = entry.child.try_lock() {
                let _ = guard.start_kill();
            }
        }
    }
}

impl Drop for ProcessRegistry {
    fn drop(&mut self) {
        // &mut self makes locking unnecessary; poisoning must not skip the
        // kill sweep either (a panicked run leaves live children).
        let map = self.0.get_mut().unwrap_or_else(|e| e.into_inner());
        for (_, entry) in map.drain() {
            kill_process_group(entry.pid);
            if let Ok(mut guard) = entry.child.try_lock() {
                let _ = guard.start_kill();
            }
        }
    }
}
/// SIGKILL the child's whole process group (spawn used `process_group(0)`,
/// so pgid == pid). Grandchildren holding the stdout pipe die too, which is
/// what lets the reader task observe EOF and drain the registry.
#[cfg(unix)]
fn kill_process_group(pid: u32) {
    // SAFETY: kill with a negated pgid signals the group; no memory touched.
    unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
}

#[cfg(not(unix))]
fn kill_process_group(_pid: u32) {}

// ==================== stderr redaction ====================

/// Engine stderr can echo the provider env we injected; redact credential
/// shapes before the tail is shown to the user in an error banner.
fn redact_secrets(text: &str) -> String {
    use std::sync::LazyLock;
    static PATTERNS: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| {
        [
            r"(?i)sk-[A-Za-z0-9_-]+",
            r"(?i)bearer\s+\S+",
            r"(?i)api[_-]?key\s*[=:]\s*\S+",
            r"(?i)token\s*[=:]\s*\S+",
        ]
        .iter()
        .filter_map(|p| regex::Regex::new(p).ok())
        .collect()
    });
    let mut out = text.to_string();
    for pattern in PATTERNS.iter() {
        out = pattern.replace_all(&out, "***").into_owned();
    }
    out
}

// ==================== Commands ====================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub run_id: String,
    pub session_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: String,
    pub available: bool,
    pub supports_images: bool,
}

fn engine_bin(settings: &crate::settings::AppSettings, engine_id: &str) -> String {
    if let Some(custom) = settings.bin_override(engine_id) {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            // Defense in depth: settings write validates too, but the file
            // may have been hand-edited since.
            match crate::settings::validate_bin_override(trimmed) {
                Ok(path) => return path.to_string_lossy().to_string(),
                Err(reason) => {
                    eprintln!("[engine] ignoring invalid {engine_id} bin override: {reason}");
                }
            }
        }
    }
    which::which(engine_id)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| engine_id.to_string())
}

#[tauri::command]
pub fn list_engines() -> Vec<EngineInfo> {
    let settings = crate::settings::read_settings().unwrap_or_default();
    crate::config::ENGINES
        .iter()
        .map(|id| {
            let engine = engine_by_id(id).expect("known engine");
            let available = match settings.bin_override(id) {
                Some(custom) if !custom.trim().is_empty() => {
                    crate::settings::validate_bin_override(custom).is_ok()
                }
                _ => which::which(id).is_ok(),
            };
            EngineInfo {
                id: id.to_string(),
                available,
                supports_images: engine.supports_images(),
            }
        })
        .collect()
}

/// Concurrent engine runs; past this the machine thrashes and the registry
/// fan-out makes interrupts unreliable anyway.
const MAX_CONCURRENT_RUNS: usize = 16;

/// Resolved launch parameters for one send: request, binary, built command.
struct Launch {
    req: SendRequest,
    bin: String,
    built: BuiltCommand,
    engine_impl: Box<dyn Engine>,
    env: HashMap<String, String>,
}

fn prepare_launch(
    engine: &str,
    workspace_path: &str,
    session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<Launch, String> {
    let engine_impl = engine_by_id(engine).ok_or_else(|| format!("unknown engine: {engine}"))?;
    let env = crate::config::resolve_provider_env(engine)?;
    let settings = crate::settings::read_settings().unwrap_or_default();
    let model = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| settings.default_models.get(engine).cloned())
        .filter(|m| !m.trim().is_empty());
    let effort = effort
        .filter(|e| !e.trim().is_empty())
        .or_else(|| settings.default_efforts.get(engine).cloned())
        .filter(|e| !e.trim().is_empty());
    let req = SendRequest {
        session_id: session_id.filter(|s| !s.trim().is_empty()),
        workspace: PathBuf::from(workspace_path),
        prompt,
        images: image_paths.unwrap_or_default(),
        model,
        effort,
    };
    let bin = engine_bin(&settings, engine);
    let built = engine_impl.build_command(&req, &env, &bin)?;
    Ok(Launch {
        req,
        bin,
        built,
        engine_impl,
        env,
    })
}

/// Stdin payload writer: engines consuming stream-json stdin get the payload
/// then EOF (drop closes the pipe).
fn spawn_stdin_writer(child: &mut Child, payload: Option<String>) {
    let Some(payload) = payload else {
        return;
    };
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(payload.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
            // drop closes stdin -> EOF
        });
    }
}

/// Stderr capture ring: keeps the last 4KB for the error banner.
fn spawn_stderr_capture(stderr: ChildStderr) -> Arc<Mutex<String>> {
    let buf = Arc::new(Mutex::new(String::new()));
    let target = Arc::clone(&buf);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let mut guard = match target.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    guard.push_str(&line);
                    if guard.len() > 4096 {
                        let keep = guard.len() - 4096;
                        guard.drain(..keep);
                    }
                }
            }
        }
    });
    buf
}

/// Mutable per-run streaming state shared by the reader loop's dispatch.
struct TurnState {
    seq: u64,
    native_session_id: Option<String>,
    saw_done: bool,
    saw_error: bool,
    saw_any_output: bool,
}

impl TurnState {
    fn new(preassigned: Option<String>) -> Self {
        Self {
            seq: 0,
            native_session_id: preassigned,
            saw_done: false,
            saw_error: false,
            saw_any_output: false,
        }
    }

    fn push(&mut self, sink: &Arc<event_sink::EventSink>, run_id: &str, engine_id: &str, kind: &str, data: Value) {
        self.seq += 1;
        sink.push(serde_json::json!({
            "runId": run_id,
            "sessionId": self.native_session_id,
            "engine": engine_id,
            "seq": self.seq,
            "kind": kind,
            "data": data,
        }));
    }
}

/// Everything the stdout reader task needs (moved in at spawn).
struct RunContext {
    sink: Arc<event_sink::EventSink>,
    registry: Arc<ProcessRegistry>,
    engine_impl: Box<dyn Engine>,
    engine_id: String,
    run_id: String,
    pid: u32,
    /// Session id fixed before spawn (grok `-s`); seeds TurnState.
    preassigned_session_id: Option<String>,
    child: Arc<TokioMutex<Child>>,
    killed: Arc<std::sync::atomic::AtomicBool>,
    cleanup_files: Vec<PathBuf>,
    stderr_buf: Arc<Mutex<String>>,
}

impl RunContext {
    /// Adopt a native session id: rekey the registry entry (no overwrite) and
    /// remember it for subsequent event payloads.
    fn adopt_session_id(&self, state: &mut TurnState, id: &str, announce: bool) {
        if state.native_session_id.as_deref() == Some(id) {
            return;
        }
        state.native_session_id = Some(id.to_string());
        self.registry.rekey(&self.run_id, id.to_string());
        if announce {
            state.push(&self.sink, &self.run_id, &self.engine_id, "session", Value::String(id.to_string()));
        }
    }

    fn dispatch_event(&self, state: &mut TurnState, event: EngineEvent) {
        match event {
            EngineEvent::Delta(text) => {
                state.push(&self.sink, &self.run_id, &self.engine_id, "delta", Value::String(text))
            }
            EngineEvent::Thinking(text) => {
                state.push(&self.sink, &self.run_id, &self.engine_id, "thinking", Value::String(text))
            }
            EngineEvent::Message { role, text } => state.push(
                &self.sink,
                &self.run_id,
                &self.engine_id,
                "message",
                serde_json::json!({ "role": role, "text": text }),
            ),
            EngineEvent::SessionId(id) => self.adopt_session_id(state, &id, true),
            EngineEvent::Usage(usage) => {
                state.push(&self.sink, &self.run_id, &self.engine_id, "usage", usage)
            }
            EngineEvent::Error(error) => {
                state.saw_error = true;
                state.push(&self.sink, &self.run_id, &self.engine_id, "error", Value::String(error));
            }
            EngineEvent::Done { session_id, usage } => {
                state.saw_done = true;
                if let Some(id) = session_id {
                    self.adopt_session_id(state, &id, false);
                }
                state.push(&self.sink, &self.run_id, &self.engine_id, "done", serde_json::json!({ "usage": usage }));
            }
        }
    }
}

/// Read NDJSON stdout until EOF, dispatch events, then settle the turn:
/// registry cleanup, temp-file cleanup, and the terminal done/error event.
async fn run_reader(stdout: ChildStdout, ctx: RunContext) {
    let mut state = TurnState::new(ctx.preassigned_session_id.clone());
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        state.saw_any_output = true;
        let mut events = Vec::new();
        ctx.engine_impl.parse_line(trimmed, &mut events);
        for event in events {
            ctx.dispatch_event(&mut state, event);
        }
    }

    // Wait for exit
    let status = {
        let mut guard = ctx.child.lock().await;
        guard.wait().await.ok()
    };
    for path in &ctx.cleanup_files {
        let _ = std::fs::remove_file(path);
    }
    if let Some(key) = state.native_session_id.clone() {
        ctx.registry.remove_if_pid(&key, ctx.pid);
    }
    ctx.registry.remove_if_pid(&ctx.run_id, ctx.pid);

    if !state.saw_done && !state.saw_error {
        let stderr_tail = ctx
            .stderr_buf
            .lock()
            .map(|g| g.trim().to_string())
            .unwrap_or_default();
        let failed = status.map(|s| !s.success()).unwrap_or(true);
        let killed = ctx.killed.load(std::sync::atomic::Ordering::SeqCst);
        if killed {
            // User-initiated stop: commit whatever streamed so far as a
            // normal turn end — a SIGKILL'd child is not a failure.
            state.push(&ctx.sink, &ctx.run_id, &ctx.engine_id, "done", serde_json::json!({ "usage": null }));
        } else if failed || !state.saw_any_output {
            let mut message = format!(
                "{} exited with status {}",
                ctx.engine_id,
                status
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            );
            if !stderr_tail.is_empty() {
                message.push_str(&format!(": {}", redact_secrets(&stderr_tail)));
            }
            state.push(&ctx.sink, &ctx.run_id, &ctx.engine_id, "error", Value::String(message));
        } else {
            // Clean EOF without an explicit done line (kimi).
            state.push(&ctx.sink, &ctx.run_id, &ctx.engine_id, "done", serde_json::json!({ "usage": null }));
        }
    }
    ctx.sink.flush();
}

#[tauri::command]
pub async fn send_message(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<SendResult, String> {
    if state.processes.len() >= MAX_CONCURRENT_RUNS {
        return Err(format!(
            "too many concurrent runs ({MAX_CONCURRENT_RUNS}); wait for one to finish"
        ));
    }
    let launch = prepare_launch(
        &engine,
        &workspace_path,
        session_id,
        prompt,
        image_paths,
        model,
        effort,
    )?;

    let mut command = launch.built.command;
    command
        .stdin(if launch.built.stdin_payload.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(&launch.req.workspace);
    for (key, value) in &launch.env {
        command.env(key, value);
    }
    // Own process group so interrupt can kill the whole tree (grandchildren
    // inherit the stdout pipe and would otherwise block EOF forever).
    #[cfg(unix)]
    command.process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            // Never strand the staging files build_command wrote (grok).
            for path in &launch.built.cleanup_files {
                let _ = std::fs::remove_file(path);
            }
            return Err(format!("failed to spawn {}: {error}", launch.bin));
        }
    };

    spawn_stdin_writer(&mut child, launch.built.stdin_payload);

    let run_id = uuid::Uuid::new_v4().to_string();
    let pid = child.id().unwrap_or(0);
    // Detach both pipes while we still own the child outright. A missing pipe
    // after spawn is fatal: kill the child so it cannot run unobserved and
    // unregistered.
    let (stdout, stderr) = {
        let pipes = child.stdout.take().zip(child.stderr.take());
        match pipes {
            Some(pair) => pair,
            None => {
                let _ = child.start_kill();
                for path in &launch.built.cleanup_files {
                    let _ = std::fs::remove_file(path);
                }
                return Err("missing stdout/stderr pipe after spawn".to_string());
            }
        }
    };
    let child = Arc::new(TokioMutex::new(child));
    let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.processes.insert(
        run_id.clone(),
        ChildEntry {
            child: Arc::clone(&child),
            pid,
            run_id: run_id.clone(),
            killed: Arc::clone(&killed),
        },
    );

    let stderr_buf = spawn_stderr_capture(stderr);
    let ctx = RunContext {
        sink: Arc::clone(&state.sink),
        registry: Arc::clone(&state.processes),
        engine_impl: launch.engine_impl,
        engine_id: engine.clone(),
        run_id: run_id.clone(),
        pid,
        preassigned_session_id: launch.built.preassigned_session_id.clone(),
        child,
        killed,
        cleanup_files: launch.built.cleanup_files,
        stderr_buf,
    };
    tokio::spawn(run_reader(stdout, ctx));

    Ok(SendResult {
        run_id,
        session_id: launch.built.preassigned_session_id,
    })
}

#[tauri::command]
pub fn interrupt_session(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
) -> bool {
    state.processes.kill(&session_id)
}
