use super::{same_or_child, scan_summary_file, stat_signature, ScanSummary, SessionFile};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;

/// Bump when title derivation changes so unchanged files still re-title.
const TITLE_VERSION: &str = "4";

/// Titles matching these prefixes were derived before envelope stripping
/// existed; one migration pass re-derives them even when files are unchanged.
const NOISE_TITLE_WHERE: &str = "title LIKE '<file %' ESCAPE '\\'
     OR title LIKE '[Image #%' ESCAPE '\\'
     OR title LIKE '<user\\_info%' ESCAPE '\\'
     OR title LIKE '<user\\_query%' ESCAPE '\\'
     OR title LIKE '# AGENTS.md instructions%'
     OR title LIKE '<environment\\_context%' ESCAPE '\\'
     OR title LIKE '<agents-instructions%'
     OR title LIKE '<skill>%'
     OR title LIKE '<INSTRUCTIONS>%'";

/// Bounded head peek: parse up to `max_lines` JSON lines from the head of a
/// file (plain or zstd). Reads in 16 KiB chunks and stops as soon as
/// `max_lines` complete lines have arrived, so a file costs ~tens of KB,
/// never the full cap. Codex embeds its full base_instructions system
/// prompt in the `session_meta` line, so line 1 alone runs to tens of KB —
/// a fixed 16 KiB read truncated it mid-JSON and every newer rollout failed
/// identification, while a fixed 1 MiB read would pull ~1 GB per 1000 files
/// on a cold scan for lines it never uses. Total reads stay bounded by
/// MAX_HEAD_BYTES. Newer pi-family files prepend a `title` line before the
/// `session` line, so line 1 alone is not enough either.
fn peek_head_json_lines(
    path: &Path,
    zstd_compressed: bool,
    max_lines: usize,
) -> Vec<serde_json::Value> {
    use std::io::{BufReader, Read};
    const CHUNK_BYTES: usize = 16 * 1024;
    const MAX_HEAD_BYTES: usize = 1024 * 1024;
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut reader: Box<dyn Read> = if zstd_compressed {
        match zstd::stream::read::Decoder::new(BufReader::new(file)) {
            Ok(decoder) => Box::new(decoder),
            Err(_) => return Vec::new(),
        }
    } else {
        Box::new(file)
    };
    let mut buf = Vec::new();
    // Incremental newline count: re-scanning the whole buffer per chunk is
    // O(n²) on a long head.
    let mut newline_count = 0usize;
    let mut eof = false;
    while newline_count < max_lines && buf.len() < MAX_HEAD_BYTES {
        let mut chunk = [0u8; CHUNK_BYTES];
        match reader.read(&mut chunk) {
            Ok(0) => {
                eof = true;
                break;
            }
            Ok(n) => {
                newline_count += chunk[..n].iter().filter(|&&b| b == b'\n').count();
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(_) => return Vec::new(),
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = head.split('\n').collect();
    if !eof {
        // The cap (or an unlucky chunk boundary) can leave the tail segment
        // mid-line; a partial line never parses, so drop it. At EOF the tail
        // is a complete final line.
        lines.pop();
    }
    lines
        .into_iter()
        .take(max_lines)
        .filter_map(|line| serde_json::from_str(line.trim()).ok())
        .collect()
}

fn discover_claude(workspace: &Path) -> Vec<SessionFile> {
    let encoded = super::claude_encode_project_path(&workspace.to_string_lossy());
    let dir = crate::engine::engine_home(None, ".claude")
        .join("projects")
        .join(encoded);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem == "history" {
            continue;
        }
        out.push(SessionFile {
            engine: "claude",
            session_id: stem.to_string(),
            workspace_path: workspace.to_string_lossy().to_string(),
            file_path: path,
        });
    }
    out
}

fn discover_kimi(workspace: &Path) -> Vec<SessionFile> {
    let base = crate::engine::engine_home(None, ".kimi-code");
    let Ok(raw) = std::fs::read_to_string(base.join("session_index.jsonl")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in raw.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let work_dir = value
            .get("workDir")
            .or_else(|| value.get("work_dir"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if work_dir.is_empty() || !same_or_child(Path::new(work_dir), workspace) {
            continue;
        }
        let session_id = value
            .get("sessionId")
            .or_else(|| value.get("session_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let session_dir = value
            .get("sessionDir")
            .or_else(|| value.get("session_dir"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if session_id.is_empty() || session_dir.is_empty() {
            continue;
        }
        let wire = PathBuf::from(&session_dir)
            .join("agents")
            .join("main")
            .join("wire.jsonl");
        if wire.is_file() {
            out.push(SessionFile {
                engine: "kimi",
                session_id,
                workspace_path: workspace.to_string_lossy().to_string(),
                file_path: wire,
            });
        }
    }
    out
}

fn grok_url_decode(encoded: &str) -> String {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &encoded[i + 1..i + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn discover_grok(workspace: &Path) -> Vec<SessionFile> {
    let sessions_root = crate::engine::engine_home(None, ".grok").join("sessions");
    let Ok(cwd_dirs) = std::fs::read_dir(&sessions_root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for cwd_entry in cwd_dirs.flatten() {
        let cwd_dir = cwd_entry.path();
        if !cwd_dir.is_dir() {
            continue;
        }
        let decoded = grok_url_decode(&cwd_entry.file_name().to_string_lossy());
        if !same_or_child(Path::new(&decoded), workspace) {
            continue;
        }
        let Ok(session_dirs) = std::fs::read_dir(&cwd_dir) else {
            continue;
        };
        for session_entry in session_dirs.flatten() {
            let session_dir = session_entry.path();
            if !session_dir.is_dir() {
                continue;
            }
            let chat = session_dir.join("chat_history.jsonl");
            if !chat.is_file() {
                continue;
            }
            let session_id = session_entry.file_name().to_string_lossy().to_string();
            if session_id.is_empty() {
                continue;
            }
            out.push(SessionFile {
                engine: "grok",
                session_id,
                workspace_path: workspace.to_string_lossy().to_string(),
                file_path: chat,
            });
        }
    }
    out
}

// ==================== Scan ====================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub scanned: usize,
    pub reparsed: usize,
    pub reused: usize,
}

/// One candidate session file on disk, identified lazily.
struct Candidate {
    engine: &'static str,
    path: PathBuf,
    /// Session id known from the filename/index without reading the file.
    known_id: Option<String>,
    /// Workspace attribution without reading the file (filename-keyed engines).
    known_workspace: Option<String>,
}

/// Engine file identity from the first JSON line (codex session_meta /
/// pi-family & dsh session line). Returns (session_id, cwd).
fn identify_head(engine: &str, path: &Path) -> Option<(String, String)> {
    let expected = match engine {
        "codex" => "session_meta",
        "pi" | "omp" | "dsh" => "session",
        _ => return None,
    };
    // Scan the first few head lines: newer pi-family files prepend a
    // `title` line before the `session` line.
    for head in peek_head_json_lines(path, engine == "dsh", 8) {
        if head.get("type").and_then(|v| v.as_str()) != Some(expected) {
            continue;
        }
        let source = if engine == "codex" {
            head.get("payload")?
        } else {
            &head
        };
        let id = source.get("id").and_then(|v| v.as_str())?.trim();
        let cwd = source.get("cwd").and_then(|v| v.as_str())?.trim();
        if id.is_empty() || cwd.is_empty() {
            return None;
        }
        return Some((id.to_string(), cwd.to_string()));
    }
    None
}

/// Codex rollout files (readdir only, no content reads).
fn codex_candidates() -> Vec<PathBuf> {
    let home = crate::engine::engine_home(Some("CODEX_HOME"), ".codex");
    let mut out = Vec::new();
    for root in [home.join("sessions"), home.join("archived_sessions")] {
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
                    .unwrap_or(false)
                {
                    out.push(path);
                }
            }
        }
    }
    out
}

fn pi_family_candidates(home_dir_name: &str) -> Vec<PathBuf> {
    let root = crate::engine::engine_home(None, home_dir_name)
        .join("agent")
        .join("sessions");
    let mut out = Vec::new();
    let Ok(cwd_dirs) = std::fs::read_dir(&root) else {
        return out;
    };
    for cwd_entry in cwd_dirs.flatten() {
        let Ok(files) = std::fs::read_dir(cwd_entry.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push(path);
            }
        }
    }
    out
}

fn dsh_candidates() -> Vec<PathBuf> {
    let root = crate::engine::engine_home(Some("DSH_HOME"), ".dsh").join("sessions");
    let mut out = Vec::new();
    let Ok(cwd_dirs) = std::fs::read_dir(&root) else {
        return out;
    };
    for cwd_entry in cwd_dirs.flatten() {
        let Ok(session_dirs) = std::fs::read_dir(cwd_entry.path()) else {
            continue;
        };
        for session_entry in session_dirs.flatten() {
            let file = session_entry.path().join("session.jsonl.zstd");
            if file.is_file() {
                out.push(file);
            }
        }
    }
    out
}

/// Scan all registered workspaces; reparse only files whose stat signature
/// changed; upsert the sessions table; emit sessions://changed once.
pub fn scan_all_workspaces(state: &crate::AppState) -> Result<ScanReport, String> {
    let sink = Arc::clone(&state.sink);
    let progress_sink = Arc::clone(&state.sink);
    scan_inner(
        &state.db,
        move || sink.emit_sessions_changed(),
        move |p| progress_sink.emit_scan_progress(p),
    )
}

/// The scan itself, decoupled from the event sink for testing.
pub fn scan_with(db: &crate::db::Db, on_changed: impl Fn()) -> Result<ScanReport, String> {
    scan_inner(db, on_changed, |_| {})
}

// ---------- phase helpers (each stage is lock-free except where noted) ----------

/// Enumerate every candidate session file (readdir/index only, no content).
fn gather_candidates(workspaces: &[String]) -> Vec<Candidate> {
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut seen_paths: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for workspace_path in workspaces {
        let workspace = PathBuf::from(workspace_path);
        // Filename/index-keyed engines identify cheaply per workspace.
        for file in discover_claude(&workspace)
            .into_iter()
            .chain(discover_kimi(&workspace))
            .chain(discover_grok(&workspace))
        {
            if seen_paths.insert(file.file_path.clone()) {
                candidates.push(Candidate {
                    engine: file.engine,
                    path: file.file_path,
                    known_id: Some(file.session_id),
                    known_workspace: Some(file.workspace_path),
                });
            }
        }
    }
    // Head-keyed engines: enumerate once, attribute by content on change.
    for (engine, paths) in [
        ("codex", codex_candidates()),
        ("pi", pi_family_candidates(".pi")),
        ("omp", pi_family_candidates(".omp")),
        ("dsh", dsh_candidates()),
    ] {
        for path in paths {
            if seen_paths.insert(path.clone()) {
                candidates.push(Candidate {
                    engine,
                    path,
                    known_id: None,
                    known_workspace: None,
                });
            }
        }
    }
    candidates
}

/// Stat every candidate and fold (path, size, mtime) into one signature.
fn stat_all(workspaces: &[String], candidates: &[Candidate]) -> (Vec<Option<(i64, i64)>>, String) {
    let mut signature_hasher = Sha256::new();
    signature_hasher.update(format!("v{}|", crate::db::CACHE_VERSION).as_bytes());
    for w in workspaces {
        signature_hasher.update(w.as_bytes());
        signature_hasher.update(b"|");
    }
    let mut stats: Vec<Option<(i64, i64)>> = Vec::with_capacity(candidates.len());
    for cand in candidates {
        let sig = stat_signature(&cand.path);
        if let Some((size, mtime_ms)) = sig {
            signature_hasher.update(cand.path.to_string_lossy().as_bytes());
            signature_hasher.update(size.to_le_bytes());
            signature_hasher.update(mtime_ms.to_le_bytes());
        }
        stats.push(sig);
    }
    (stats, format!("{:x}", signature_hasher.finalize()))
}

/// Tier-1 gate (brief lock): a matching global signature means nothing
/// changed and the scan short-circuits. Also decides whether the one-time
/// title re-derivation migration is still pending.
struct Tier1 {
    signature: String,
    retitle_pending: bool,
}

fn tier1_gate(db: &crate::db::Db, signature: String) -> Result<Option<Tier1>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let previous: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key='stat_signature'",
            [],
            |r| r.get(0),
        )
        .ok();
    let row_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap_or(0);
    let title_version: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key='title_version'", [], |r| {
            r.get(0)
        })
        .ok();
    // One-time migration: titles derived before envelope stripping
    // (`<file …` / `[Image #…` / `<user_info>`) or rows with no timestamps
    // force a single re-derivation even when files are unchanged.
    let retitle_pending = title_version.as_deref() != Some(TITLE_VERSION)
        && conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM sessions WHERE {NOISE_TITLE_WHERE} OR updated_at IS NULL"
                ),
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;
    if previous.as_deref() == Some(signature.as_str()) && row_count > 0 && !retitle_pending {
        return Ok(None);
    }
    Ok(Some(Tier1 {
        signature,
        retitle_pending,
    }))
}

/// Prefetch (brief lock) the stored per-file stat keys and, while the
/// re-title migration runs, the paths whose titles are still noise. Lets the
/// parse phase decide "unchanged" without holding the db lock.
fn prefetch_stat_keys(
    db: &crate::db::Db,
    retitle_pending: bool,
) -> Result<
    (
        std::collections::HashMap<String, (i64, i64)>,
        std::collections::HashSet<String>,
    ),
    String,
> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT file_path, file_size, file_mtime_ms FROM sessions")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut stats = std::collections::HashMap::new();
    for row in rows {
        match row {
            Ok((path, size, mtime)) => {
                stats.insert(path, (size, mtime));
            }
            Err(e) => eprintln!("[scanner] skipping undecodable session stat row: {e}"),
        }
    }
    let mut stale = std::collections::HashSet::new();
    if retitle_pending {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT file_path FROM sessions WHERE {NOISE_TITLE_WHERE} OR updated_at IS NULL"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            match row {
                Ok(path) => {
                    stale.insert(path);
                }
                Err(e) => eprintln!("[scanner] skipping undecodable stale-title row: {e}"),
            }
        }
    }
    Ok((stats, stale))
}

/// One changed file fully processed outside the db lock: identity peek (for
/// head-keyed engines) + the lightweight summary parse.
struct PreparedUpsert {
    engine: &'static str,
    session_id: String,
    workspace_path: String,
    path_str: String,
    size: i64,
    mtime_ms: i64,
    summary: ScanSummary,
}

fn prepare_candidate(
    cand: &Candidate,
    sig: (i64, i64),
    stat_keys: &std::collections::HashMap<String, (i64, i64)>,
    stale_paths: &std::collections::HashSet<String>,
    workspaces: &[String],
) -> Option<PreparedUpsert> {
    let (size, mtime_ms) = sig;
    let path_str = cand.path.to_string_lossy().to_string();
    // Unchanged on disk (stat key match) and not pending re-title: reuse.
    if stat_keys.get(&path_str) == Some(&sig) && !stale_paths.contains(&path_str) {
        return None;
    }
    // Identify the session (peek only for head-keyed engines).
    let (session_id, workspace_path) = match (&cand.known_id, &cand.known_workspace) {
        (Some(id), Some(ws)) => (id.clone(), ws.clone()),
        _ => {
            let Some((id, cwd)) = identify_head(cand.engine, &cand.path) else {
                return None;
            };
            // Attribute only files belonging to a registered workspace.
            if !workspaces
                .iter()
                .any(|w| same_or_child(Path::new(&cwd), Path::new(w)))
            {
                return None;
            }
            (id, cwd)
        }
    };
    let summary = scan_summary_file(cand.engine, &cand.path).ok()?;
    Some(PreparedUpsert {
        engine: cand.engine,
        session_id,
        workspace_path,
        path_str,
        size,
        mtime_ms,
        summary,
    })
}

/// Phase B (one lock, one transaction): upsert every prepared row, then
/// record the signature that makes the next scan a short-circuit.
fn upsert_rows(
    db: &crate::db::Db,
    rows: &[PreparedUpsert],
    tier1: &Tier1,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for row in rows {
        // Engines whose jsonl has no per-line timestamps would otherwise land
        // at updated_at=0 and fall off the sidebar's recent list. File mtime
        // is the fallback for every engine, not a grok-only special case.
        let created_at = row.summary.first_ts.or(Some(row.mtime_ms));
        let updated_at = row.summary.last_ts.or(Some(row.mtime_ms));
        tx.execute(
            "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms, title, preview, created_at, updated_at, message_count)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(engine, session_id) DO UPDATE SET
                workspace_path=excluded.workspace_path,
                file_path=excluded.file_path,
                file_size=excluded.file_size,
                file_mtime_ms=excluded.file_mtime_ms,
                title=excluded.title,
                preview=excluded.preview,
                created_at=COALESCE(sessions.created_at, excluded.created_at),
                updated_at=excluded.updated_at,
                message_count=excluded.message_count",
            rusqlite::params![
                row.engine,
                row.session_id,
                row.workspace_path,
                row.path_str,
                row.size,
                row.mtime_ms,
                row.summary.title,
                row.summary.preview,
                created_at,
                updated_at,
                row.summary.message_count,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT INTO meta(key, value) VALUES('stat_signature', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![tier1.signature],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO meta(key, value) VALUES('title_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [TITLE_VERSION],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// `on_progress` fires throttled during the parse loop and once with
/// `finished: true` when a scan that emitted any progress completes.
fn scan_inner(
    db: &crate::db::Db,
    on_changed: impl Fn(),
    on_progress: impl Fn(crate::event_sink::ScanProgress),
) -> Result<ScanReport, String> {
    let workspaces = db.workspace_paths()?;
    let candidates = gather_candidates(&workspaces);
    let (stats, signature) = stat_all(&workspaces, &candidates);
    let Some(tier1) = tier1_gate(db, signature)? else {
        return Ok(ScanReport {
            scanned: candidates.len(),
            reparsed: 0,
            reused: candidates.len(),
        });
    };
    let (stat_keys, stale_paths) = prefetch_stat_keys(db, tier1.retitle_pending)?;

    // Phase A (lock-free): parse changed files, collect rows to upsert.
    let total = candidates.len();
    let step = (total / 50).max(1);
    if total > 0 {
        on_progress(crate::event_sink::ScanProgress {
            done: 0,
            total,
            finished: false,
        });
    }
    let mut rows = Vec::new();
    let mut reused = 0usize;
    for (index, (cand, sig)) in candidates.iter().zip(stats.iter()).enumerate() {
        let processed = index + 1;
        if processed % step == 0 {
            on_progress(crate::event_sink::ScanProgress {
                done: processed,
                total,
                finished: false,
            });
        }
        let Some(sig) = sig else {
            continue;
        };
        match prepare_candidate(cand, *sig, &stat_keys, &stale_paths, &workspaces) {
            Some(row) => rows.push(row),
            None => {
                if stat_keys.get(&cand.path.to_string_lossy().to_string()) == Some(sig) {
                    reused += 1;
                }
            }
        }
    }

    // Phase B: the db lock is held only for the upsert transaction.
    let reparsed = rows.len();
    upsert_rows(db, &rows, &tier1)?;
    on_changed();
    if total > 0 {
        on_progress(crate::event_sink::ScanProgress {
            done: total,
            total,
            finished: true,
        });
    }
    Ok(ScanReport {
        scanned: total,
        reparsed,
        reused,
    })
}

/// Spawn a background scan off the Tauri runtime. Concurrent invocations
/// collapse: a scan already in flight makes the new call a no-op.
pub fn spawn_scan(app: tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static SCAN_RUNNING: AtomicBool = AtomicBool::new(false);
    if SCAN_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        // RAII so a panicking scan still frees the slot for the next one.
        struct ResetOnDrop;
        impl Drop for ResetOnDrop {
            fn drop(&mut self) {
                SCAN_RUNNING.store(false, Ordering::SeqCst);
            }
        }
        let _guard = ResetOnDrop;
        let state = app.state::<crate::AppState>();
        if let Err(error) = scan_all_workspaces(state.inner()) {
            eprintln!("[scanner] scan failed: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Point HOME at a scratch dir for the duration of a test.
    /// Serialized: two tests mutating HOME in parallel would clobber each other.
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    struct HomeGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        prev: Option<std::ffi::OsString>,
    }
    impl HomeGuard {
        fn set(home: &Path) -> Self {
            let lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let prev = std::env::var_os("HOME");
            std::env::set_var("HOME", home);
            Self { _lock: lock, prev }
        }
    }
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccgui-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn identify_head_reads_session_line_after_title_line() {
        let dir = scratch_dir("identify");
        let path = dir.join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"title\",\"v\":1,\"title\":\"t\"}\n",
                "{\"type\":\"session\",\"version\":3,\"id\":\"abc\",\"cwd\":\"/tmp/ws\"}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            identify_head("omp", &path),
            Some(("abc".to_string(), "/tmp/ws".to_string()))
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn identify_head_first_line_session_still_works() {
        let dir = scratch_dir("identify-old");
        let path = dir.join("s.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"session\",\"version\":3,\"id\":\"old\",\"cwd\":\"/tmp/ws\"}\n",
        )
        .unwrap();
        assert_eq!(
            identify_head("pi", &path),
            Some(("old".to_string(), "/tmp/ws".to_string()))
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// End-to-end: an omp file with a prepended title line is attributed to
    /// a registered workspace and parsed into the sessions table.
    #[test]
    fn scan_attributes_omp_session_with_title_head() -> Result<(), String> {
        let home = scratch_dir("scan-home");
        let workspace = home.join("ws");
        let sessions_dir = home.join(".omp").join("agent").join("sessions").join("-ws");
        std::fs::create_dir_all(&sessions_dir).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
        std::fs::write(
            sessions_dir.join("s.jsonl"),
            format!(
                "{}\n{}\n{}\n",
                "{\"type\":\"title\",\"v\":1,\"title\":\"t\"}",
                format!(
                    "{{\"type\":\"session\",\"version\":3,\"id\":\"sid-1\",\"timestamp\":\"2026-09-05T07:13:57.946Z\",\"cwd\":\"{}\"}}",
                    workspace.display()
                ),
                "{\"type\":\"message\",\"timestamp\":\"2026-09-05T07:14:06.682Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}",
            ),
        )
        .map_err(|e| e.to_string())?;

        let _guard = HomeGuard::set(&home);
        let db = crate::db::Db::open_at(&home.join("app.db")).map_err(|e| e.to_string())?;
        {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO workspaces(id, path, name) VALUES('w1', ?1, 'ws')",
                [workspace.to_string_lossy().to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        let report = scan_with(&db, || {})?;
        assert_eq!(report.reparsed, 1);
        let title: String = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT title FROM sessions WHERE engine='omp' AND session_id='sid-1'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?
        };
        assert_eq!(title, "hello");
        drop(db);
        std::fs::remove_dir_all(&home).ok();
        Ok(())
    }

    /// Grok injects `<user_info>` as the first user turn and omits per-line
    /// timestamps. Scan must still title from `<user_query>` and sort by mtime.
    #[test]
    fn scan_grok_titles_from_user_query_and_uses_mtime() -> Result<(), String> {
        let home = scratch_dir("scan-grok-home");
        let workspace = home.join("ws");
        std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
        let encoded: String = workspace
            .to_string_lossy()
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        let session_dir = home
            .join(".grok")
            .join("sessions")
            .join(&encoded)
            .join("sid-grok");
        std::fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;
        std::fs::write(
            session_dir.join("chat_history.jsonl"),
            concat!(
                "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<user_info>\\nOS Version: macos\\n</user_info>\"}]}\n",
                "{\"type\":\"user\",\"synthetic_reason\":\"system_reminder\",\"content\":[{\"type\":\"text\",\"text\":\"<system-reminder>x</system-reminder>\"}]}\n",
                "{\"type\":\"user\",\"prompt_index\":0,\"content\":[{\"type\":\"text\",\"text\":\"<user_query>这个鼠标移动上去</user_query>\"}]}\n",
                "{\"type\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}\n",
            ),
        )
        .map_err(|e| e.to_string())?;

        let _guard = HomeGuard::set(&home);
        let db = crate::db::Db::open_at(&home.join("app.db")).map_err(|e| e.to_string())?;
        {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO workspaces(id, path, name) VALUES('w1', ?1, 'ws')",
                [workspace.to_string_lossy().to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        let report = scan_with(&db, || {})?;
        assert_eq!(report.reparsed, 1);
        let (title, updated_at): (String, Option<i64>) = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT title, updated_at FROM sessions WHERE engine='grok' AND session_id='sid-grok'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?
        };
        assert_eq!(title, "这个鼠标移动上去");
        assert!(updated_at.is_some() && updated_at.unwrap() > 0, "expected mtime fallback, got {updated_at:?}");
        drop(db);
        std::fs::remove_dir_all(&home).ok();
        Ok(())
    }

    /// Codex embeds its full base_instructions system prompt in the
    /// session_meta line, pushing line 1 past the old 16 KiB head-peek cap;
    /// the truncated line failed to parse and the rollout was never
    /// attributed. A >16 KiB session_meta must still scan.
    #[test]
    fn scan_identifies_codex_rollout_with_huge_session_meta() -> Result<(), String> {
        let home = scratch_dir("scan-codex-home");
        let workspace = home.join("ws");
        std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
        let rollout_dir = home.join(".codex").join("sessions").join("2026").join("09").join("06");
        std::fs::create_dir_all(&rollout_dir).map_err(|e| e.to_string())?;
        let big_instructions = "x".repeat(40 * 1024);
        std::fs::write(
            rollout_dir.join("rollout-2026-09-06T21-52-11-sid-codex.jsonl"),
            format!(
                "{}\n{}\n",
                format!(
                    "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"sid-codex\",\"cwd\":\"{}\",\"base_instructions\":{{\"text\":\"{big_instructions}\"}}}}}}",
                    workspace.display()
                ),
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"你好啊\"}]}}",
            ),
        )
        .map_err(|e| e.to_string())?;

        let _guard = HomeGuard::set(&home);
        let db = crate::db::Db::open_at(&home.join("app.db")).map_err(|e| e.to_string())?;
        {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO workspaces(id, path, name) VALUES('w1', ?1, 'ws')",
                [workspace.to_string_lossy().to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        let report = scan_with(&db, || {})?;
        assert_eq!(report.reparsed, 1);
        let title: String = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT title FROM sessions WHERE engine='codex' AND session_id='sid-codex'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?
        };
        assert_eq!(title, "你好啊");
        drop(db);
        std::fs::remove_dir_all(&home).ok();
        Ok(())
    }

    /// A first line past MAX_HEAD_BYTES must terminate the chunked read at
    /// the cap — no full-file read, no hang; identification just comes back
    /// empty and the file is skipped.
    #[test]
    fn peek_head_stays_bounded_when_line_exceeds_cap() {
        let dir = scratch_dir("peek-cap");
        let path = dir.join("big.jsonl");
        let huge = "x".repeat(2 * 1024 * 1024);
        std::fs::write(
            &path,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"a\",\"cwd\":\"{huge}\"}}}}}}\n"
            ),
        )
        .unwrap();
        assert!(peek_head_json_lines(&path, false, 8).is_empty());
        assert_eq!(identify_head("codex", &path), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
