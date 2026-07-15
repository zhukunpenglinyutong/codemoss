use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::app_paths;
use crate::runtime::{RuntimePoolRow, RuntimePoolSnapshot};
use crate::state::AppState;
use crate::types::AppSettings;

const CLIENT_STORE_FILES: &[(&str, &str)] = &[
    ("layout", "layout.json"),
    ("composer", "composer.json"),
    ("threads", "threads.json"),
    ("app", "app.json"),
    ("leida", "leida.json"),
    ("diagnostics", "diagnostics.json"),
];
const MAX_RENDERER_DIAGNOSTICS: usize = 200;
const MAX_CLIENT_STORE_KEYS: usize = 80;
const MAX_DIAGNOSTIC_PAYLOAD_KEYS: usize = 40;
const MAX_DIAGNOSTIC_ARRAY_ITEMS: usize = 40;
const MAX_RUNTIME_POOL_ROWS: usize = 80;
const MAX_RUNTIME_LEASE_SOURCES: usize = 24;
const STRING_FINGERPRINT_BYTES: usize = 12;
const MAX_DIAGNOSTIC_LABEL_CHARS: usize = 120;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsBundleExportResult {
    file_path: String,
    generated_at: String,
}

#[tauri::command]
pub(crate) async fn export_diagnostics_bundle(
    state: State<'_, AppState>,
) -> Result<DiagnosticsBundleExportResult, String> {
    export_diagnostics_bundle_core(&state).await
}

pub(crate) async fn export_diagnostics_bundle_core(
    state: &AppState,
) -> Result<DiagnosticsBundleExportResult, String> {
    let generated_at_ms = now_millis();
    let generated_at = generated_at_ms.to_string();
    let settings = state.app_settings.lock().await.clone();
    let runtime_snapshot = state.runtime_manager.snapshot(&settings).await;
    let client_store_summary = collect_client_store_summary()?;
    let renderer_diagnostics = collect_renderer_diagnostics(&client_store_summary);
    let payload = json!({
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "generatedAtMs": generated_at_ms,
        "app": {
            "name": "CodePort",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "environment": collect_environment_summary(),
        "settings": sanitize_app_settings(&settings),
        "runtimePool": sanitize_runtime_pool_snapshot(&runtime_snapshot),
        "clientStores": client_store_summary,
        "rendererDiagnostics": renderer_diagnostics,
    });

    let output_path = diagnostics_output_path(generated_at_ms)?;
    write_json_atomically(&output_path, &payload)?;
    Ok(DiagnosticsBundleExportResult {
        file_path: output_path.to_string_lossy().to_string(),
        generated_at,
    })
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn diagnostics_output_path(generated_at_ms: u128) -> Result<PathBuf, String> {
    let file_id = uuid::Uuid::new_v4();
    Ok(app_paths::app_home_dir()?
        .join("diagnostics")
        .join(format!("diagnostics-{generated_at_ms}-{file_id}.json")))
}

fn write_json_atomically(path: &Path, value: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("failed to serialize diagnostics bundle: {error}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create diagnostics directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let temp_path = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    let mut temp_file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .map_err(|error| {
            format!(
                "failed to open diagnostics temp file {}: {error}",
                temp_path.display()
            )
        })?;
    if let Err(error) = temp_file.write_all(content.as_bytes()) {
        drop(temp_file);
        cleanup_temp_file(&temp_path);
        return Err(format!(
            "failed to write diagnostics temp file {}: {error}",
            temp_path.display()
        ));
    }
    if let Err(error) = temp_file.sync_all() {
        drop(temp_file);
        cleanup_temp_file(&temp_path);
        return Err(format!(
            "failed to sync diagnostics temp file {}: {error}",
            temp_path.display()
        ));
    }
    drop(temp_file);

    #[cfg(target_os = "windows")]
    if path.exists() {
        if let Err(error) = fs::remove_file(path) {
            cleanup_temp_file(&temp_path);
            return Err(format!(
                "failed to replace diagnostics file {}: {error}",
                path.display()
            ));
        }
    }

    if let Err(error) = fs::rename(&temp_path, path) {
        cleanup_temp_file(&temp_path);
        return Err(format!(
            "failed to finalize diagnostics file {}: {error}",
            path.display()
        ));
    }
    Ok(())
}

fn cleanup_temp_file(path: &Path) {
    let _ = fs::remove_file(path);
}

fn collect_environment_summary() -> Value {
    let current_exe = std::env::current_exe()
        .ok()
        .map(|path| summarize_path_value(&path.to_string_lossy()));
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "family": std::env::consts::FAMILY,
        "currentExe": current_exe,
        "processId": std::process::id(),
        "homeResolved": dirs::home_dir().is_some(),
    })
}

fn sanitize_app_settings(settings: &AppSettings) -> Value {
    let mut root = serde_json::Map::new();
    root.insert("backendMode".to_string(), json!(settings.backend_mode));
    root.insert(
        "webServicePort".to_string(),
        json!(settings.web_service_port),
    );
    root.insert(
        "systemProxyEnabled".to_string(),
        json!(settings.system_proxy_enabled),
    );
    root.insert(
        "defaultAccessMode".to_string(),
        json!(settings.default_access_mode),
    );
    root.insert("theme".to_string(), json!(settings.theme));
    root.insert(
        "canvasWidthMode".to_string(),
        json!(settings.canvas_width_mode),
    );
    root.insert("layoutMode".to_string(), json!(settings.layout_mode));
    root.insert("uiScale".to_string(), json!(settings.ui_scale));
    root.insert("codeFontSize".to_string(), json!(settings.code_font_size));
    root.insert(
        "notificationSoundsEnabled".to_string(),
        json!(settings.notification_sounds_enabled),
    );
    root.insert(
        "systemNotificationEnabled".to_string(),
        json!(settings.system_notification_enabled),
    );
    root.insert(
        "preloadGitDiffs".to_string(),
        json!(settings.preload_git_diffs),
    );
    root.insert(
        "detachedExternalChangeAwarenessEnabled".to_string(),
        json!(settings.detached_external_change_awareness_enabled),
    );
    root.insert(
        "detachedExternalChangeWatcherEnabled".to_string(),
        json!(settings.detached_external_change_watcher_enabled),
    );
    root.insert(
        "codexModeEnforcementEnabled".to_string(),
        json!(settings.codex_mode_enforcement_enabled),
    );
    root.insert(
        "chatCanvasUseNormalizedRealtime".to_string(),
        json!(settings.chat_canvas_use_normalized_realtime),
    );
    root.insert(
        "chatCanvasUseUnifiedHistoryLoader".to_string(),
        json!(settings.chat_canvas_use_unified_history_loader),
    );
    root.insert(
        "chatCanvasUsePresentationProfile".to_string(),
        json!(settings.chat_canvas_use_presentation_profile),
    );
    root.insert(
        "dictationEnabled".to_string(),
        json!(settings.dictation_enabled),
    );
    root.insert(
        "composerEditorPreset".to_string(),
        json!(settings.composer_editor_preset),
    );
    root.insert(
        "composerSendShortcut".to_string(),
        json!(settings.composer_send_shortcut),
    );
    root.insert(
        "runtimeRestoreThreadsOnlyOnLaunch".to_string(),
        json!(settings.runtime_restore_threads_only_on_launch),
    );
    root.insert(
        "runtimeForceCleanupOnExit".to_string(),
        json!(settings.runtime_force_cleanup_on_exit),
    );
    root.insert(
        "runtimeOrphanSweepOnLaunch".to_string(),
        json!(settings.runtime_orphan_sweep_on_launch),
    );
    root.insert(
        "codexMaxHotRuntimes".to_string(),
        json!(settings.codex_max_hot_runtimes),
    );
    root.insert(
        "codexMaxWarmRuntimes".to_string(),
        json!(settings.codex_max_warm_runtimes),
    );
    root.insert(
        "codexWarmTtlSeconds".to_string(),
        json!(settings.codex_warm_ttl_seconds),
    );
    root.insert(
        "codexAutoCompactionEnabled".to_string(),
        json!(settings.codex_auto_compaction_enabled),
    );
    root.insert(
        "codexAutoCompactionThresholdPercent".to_string(),
        json!(settings.codex_auto_compaction_threshold_percent),
    );
    root.insert(
        "performanceCompatibilityModeEnabled".to_string(),
        json!(settings.performance_compatibility_mode_enabled),
    );
    root.insert(
        "hasClaudeBin".to_string(),
        json!(settings
            .claude_bin
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())),
    );
    root.insert(
        "hasCodexBin".to_string(),
        json!(settings
            .codex_bin
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())),
    );
    root.insert(
        "hasCodexArgs".to_string(),
        json!(settings
            .codex_args
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())),
    );
    root.insert(
        "hasTerminalShellPath".to_string(),
        json!(settings
            .terminal_shell_path
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())),
    );
    root.insert(
        "hasRemoteBackendToken".to_string(),
        json!(settings
            .remote_backend_token
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())),
    );
    root.insert(
        "hasWebServiceToken".to_string(),
        json!(settings
            .web_service_token
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())),
    );
    root.insert(
        "emailSender".to_string(),
        json!({
            "enabled": settings.email_sender.enabled,
            "provider": settings.email_sender.provider,
            "security": settings.email_sender.security,
            "hasSenderEmail": !settings.email_sender.sender_email.trim().is_empty(),
            "hasSmtpHost": !settings.email_sender.smtp_host.trim().is_empty(),
            "smtpPort": settings.email_sender.smtp_port,
            "hasUsername": !settings.email_sender.username.trim().is_empty(),
            "hasRecipientEmail": !settings.email_sender.recipient_email.trim().is_empty(),
        }),
    );
    Value::Object(root)
}

fn collect_client_store_summary() -> Result<Value, String> {
    let client_dir = app_paths::client_storage_dir()?;
    let mut stores = serde_json::Map::new();
    for (store_name, filename) in CLIENT_STORE_FILES {
        let path = client_dir.join(filename);
        let store_value = read_json_file_best_effort(&path);
        stores.insert(
            (*store_name).to_string(),
            summarize_store_value(store_value),
        );
    }
    Ok(Value::Object(stores))
}

fn read_json_file_best_effort(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|error| {
            json!({
                "diagnosticReadError": format!("failed to parse json: {error}"),
            })
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(error) => json!({
            "diagnosticReadError": format!("failed to read: {error}"),
        }),
    }
}

fn summarize_store_value(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut key_summaries = BTreeMap::new();
            for (key, value) in map.iter().take(MAX_CLIENT_STORE_KEYS) {
                key_summaries.insert(key.clone(), summarize_json_value(value));
            }
            json!({
                "kind": "object",
                "keyCount": map.len(),
                "keysTruncated": map.len() > MAX_CLIENT_STORE_KEYS,
                "keys": key_summaries,
            })
        }
        Value::Array(items) => json!({
            "kind": "array",
            "length": items.len(),
        }),
        Value::Null => json!({
            "kind": "missing",
        }),
        other => json!({
            "kind": json_value_kind(&other),
            "summary": summarize_json_value(&other),
        }),
    }
}

fn summarize_json_value(value: &Value) -> Value {
    match value {
        Value::Null => json!({ "kind": "null" }),
        Value::Bool(value) => json!({ "kind": "boolean", "value": value }),
        Value::Number(value) => json!({ "kind": "number", "value": value }),
        Value::String(value) => json!({
            "kind": "string",
            "length": value.chars().count(),
            "fingerprint": fingerprint_string(value),
        }),
        Value::Array(items) => json!({
            "kind": "array",
            "length": items.len(),
        }),
        Value::Object(map) => json!({
            "kind": "object",
            "keyCount": map.len(),
        }),
    }
}

fn json_value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn fingerprint_string(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .iter()
        .take(STRING_FINGERPRINT_BYTES)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn truncate_string(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn path_basename(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .or_else(|| {
            path.rsplit(['/', '\\'])
                .find(|part| !part.trim().is_empty())
                .map(ToString::to_string)
        })
}

fn summarize_path_value(path: &str) -> Value {
    json!({
        "kind": "path",
        "length": path.chars().count(),
        "basename": path_basename(path),
        "fingerprint": fingerprint_string(path),
    })
}

fn summarize_optional_string(value: Option<&str>) -> Value {
    match value {
        Some(value) if !value.trim().is_empty() => {
            summarize_json_value(&Value::String(value.to_string()))
        }
        _ => json!({ "kind": "missing" }),
    }
}

fn summarize_optional_path(value: Option<&str>) -> Value {
    match value {
        Some(value) if !value.trim().is_empty() => summarize_path_value(value),
        _ => json!({ "kind": "missing" }),
    }
}

fn insert_field(root: &mut Map<String, Value>, key: &str, value: Value) {
    root.insert(key.to_string(), value);
}

fn sanitize_runtime_pool_snapshot(snapshot: &RuntimePoolSnapshot) -> Value {
    let rows = snapshot
        .rows
        .iter()
        .take(MAX_RUNTIME_POOL_ROWS)
        .map(sanitize_runtime_pool_row)
        .collect::<Vec<_>>();

    json!({
        "rows": rows,
        "rowCount": snapshot.rows.len(),
        "rowsTruncated": snapshot.rows.len() > MAX_RUNTIME_POOL_ROWS,
        "summary": &snapshot.summary,
        "budgets": &snapshot.budgets,
        "diagnostics": {
            "orphanEntriesFound": snapshot.diagnostics.orphan_entries_found,
            "orphanEntriesCleaned": snapshot.diagnostics.orphan_entries_cleaned,
            "orphanEntriesFailed": snapshot.diagnostics.orphan_entries_failed,
            "forceKillCount": snapshot.diagnostics.force_kill_count,
            "leaseBlockedEvictionCount": snapshot.diagnostics.lease_blocked_eviction_count,
            "coordinatorAbortCount": snapshot.diagnostics.coordinator_abort_count,
            "startupManagedNodeProcesses": snapshot.diagnostics.startup_managed_node_processes,
            "startupResumeHelperNodeProcesses": snapshot.diagnostics.startup_resume_helper_node_processes,
            "startupOrphanResidueProcesses": snapshot.diagnostics.startup_orphan_residue_processes,
            "lastOrphanSweepAtMs": snapshot.diagnostics.last_orphan_sweep_at_ms,
            "lastShutdownAtMs": snapshot.diagnostics.last_shutdown_at_ms,
            "runtimeEndDiagnosticsRecorded": snapshot.diagnostics.runtime_end_diagnostics_recorded,
            "lastRuntimeEndReasonCode": &snapshot.diagnostics.last_runtime_end_reason_code,
            "lastRuntimeEndMessage": summarize_optional_string(snapshot.diagnostics.last_runtime_end_message.as_deref()),
            "lastRuntimeEndAtMs": snapshot.diagnostics.last_runtime_end_at_ms,
            "lastRuntimeEndWorkspaceId": summarize_optional_string(snapshot.diagnostics.last_runtime_end_workspace_id.as_deref()),
            "lastRuntimeEndEngine": &snapshot.diagnostics.last_runtime_end_engine,
        },
        "engineObservability": &snapshot.engine_observability,
    })
}

fn sanitize_runtime_pool_row(row: &RuntimePoolRow) -> Value {
    let lease_sources = row
        .lease_sources
        .iter()
        .take(MAX_RUNTIME_LEASE_SOURCES)
        .map(|value| summarize_json_value(&Value::String(value.to_string())))
        .collect::<Vec<_>>();

    let mut root = Map::new();
    insert_field(
        &mut root,
        "workspaceId",
        summarize_json_value(&Value::String(row.workspace_id.clone())),
    );
    insert_field(
        &mut root,
        "workspaceName",
        summarize_json_value(&Value::String(row.workspace_name.clone())),
    );
    insert_field(
        &mut root,
        "workspacePath",
        summarize_path_value(&row.workspace_path),
    );
    insert_field(&mut root, "engine", json!(&row.engine));
    insert_field(&mut root, "state", json!(&row.state));
    insert_field(&mut root, "lifecycleState", json!(&row.lifecycle_state));
    insert_field(&mut root, "pid", json!(row.pid));
    insert_field(
        &mut root,
        "runtimeGeneration",
        summarize_optional_string(row.runtime_generation.as_deref()),
    );
    insert_field(&mut root, "wrapperKind", json!(&row.wrapper_kind));
    insert_field(
        &mut root,
        "resolvedBin",
        summarize_optional_path(row.resolved_bin.as_deref()),
    );
    insert_field(&mut root, "startedAtMs", json!(row.started_at_ms));
    insert_field(&mut root, "lastUsedAtMs", json!(row.last_used_at_ms));
    insert_field(&mut root, "pinned", json!(row.pinned));
    insert_field(&mut root, "turnLeaseCount", json!(row.turn_lease_count));
    insert_field(&mut root, "streamLeaseCount", json!(row.stream_lease_count));
    insert_field(
        &mut root,
        "leaseSourceCount",
        json!(row.lease_sources.len()),
    );
    insert_field(
        &mut root,
        "leaseSourcesTruncated",
        json!(row.lease_sources.len() > MAX_RUNTIME_LEASE_SOURCES),
    );
    insert_field(&mut root, "leaseSources", json!(lease_sources));
    insert_field(
        &mut root,
        "activeWorkProtected",
        json!(row.active_work_protected),
    );
    insert_field(
        &mut root,
        "activeWorkReason",
        json!(&row.active_work_reason),
    );
    insert_field(
        &mut root,
        "activeWorkSinceMs",
        json!(row.active_work_since_ms),
    );
    insert_field(
        &mut root,
        "activeWorkLastRenewedAtMs",
        json!(row.active_work_last_renewed_at_ms),
    );
    insert_field(
        &mut root,
        "foregroundWorkState",
        json!(&row.foreground_work_state),
    );
    insert_field(
        &mut root,
        "foregroundWorkSource",
        json!(&row.foreground_work_source),
    );
    insert_field(
        &mut root,
        "foregroundWorkThreadId",
        summarize_optional_string(row.foreground_work_thread_id.as_deref()),
    );
    insert_field(
        &mut root,
        "foregroundWorkTurnId",
        summarize_optional_string(row.foreground_work_turn_id.as_deref()),
    );
    insert_field(
        &mut root,
        "foregroundWorkSinceMs",
        json!(row.foreground_work_since_ms),
    );
    insert_field(
        &mut root,
        "foregroundWorkTimeoutAtMs",
        json!(row.foreground_work_timeout_at_ms),
    );
    insert_field(
        &mut root,
        "foregroundWorkLastEventAtMs",
        json!(row.foreground_work_last_event_at_ms),
    );
    insert_field(
        &mut root,
        "foregroundWorkTimedOut",
        json!(row.foreground_work_timed_out),
    );
    insert_field(&mut root, "evictCandidate", json!(row.evict_candidate));
    insert_field(&mut root, "evictionReason", json!(&row.eviction_reason));
    insert_field(
        &mut root,
        "error",
        summarize_optional_string(row.error.as_deref()),
    );
    insert_field(
        &mut root,
        "lastExitReasonCode",
        json!(&row.last_exit_reason_code),
    );
    insert_field(
        &mut root,
        "lastExitMessage",
        summarize_optional_string(row.last_exit_message.as_deref()),
    );
    insert_field(&mut root, "lastExitAtMs", json!(row.last_exit_at_ms));
    insert_field(&mut root, "lastExitCode", json!(row.last_exit_code));
    insert_field(&mut root, "lastExitSignal", json!(&row.last_exit_signal));
    insert_field(
        &mut root,
        "lastExitPendingRequestCount",
        json!(row.last_exit_pending_request_count),
    );
    insert_field(
        &mut root,
        "processDiagnostics",
        sanitize_runtime_process_diagnostics(row.process_diagnostics.as_ref()),
    );
    insert_field(&mut root, "startupState", json!(&row.startup_state));
    insert_field(
        &mut root,
        "lastRecoverySource",
        json!(&row.last_recovery_source),
    );
    insert_field(&mut root, "lastGuardState", json!(&row.last_guard_state));
    insert_field(
        &mut root,
        "lastReplaceReason",
        json!(&row.last_replace_reason),
    );
    insert_field(
        &mut root,
        "lastProbeFailure",
        summarize_optional_string(row.last_probe_failure.as_deref()),
    );
    insert_field(
        &mut root,
        "lastProbeFailureSource",
        json!(&row.last_probe_failure_source),
    );
    insert_field(&mut root, "reasonCode", json!(&row.reason_code));
    insert_field(&mut root, "recoverySource", json!(&row.recovery_source));
    insert_field(&mut root, "retryable", json!(row.retryable));
    insert_field(&mut root, "userAction", json!(&row.user_action));
    insert_field(
        &mut root,
        "hasStoppingPredecessor",
        json!(row.has_stopping_predecessor),
    );
    insert_field(&mut root, "recentSpawnCount", json!(row.recent_spawn_count));
    insert_field(
        &mut root,
        "recentReplaceCount",
        json!(row.recent_replace_count),
    );
    insert_field(
        &mut root,
        "recentForceKillCount",
        json!(row.recent_force_kill_count),
    );
    Value::Object(root)
}

fn sanitize_runtime_process_diagnostics(
    diagnostics: Option<&crate::runtime::RuntimeProcessDiagnostics>,
) -> Value {
    let Some(diagnostics) = diagnostics else {
        return Value::Null;
    };
    json!({
        "rootProcesses": diagnostics.root_processes,
        "totalProcesses": diagnostics.total_processes,
        "nodeProcesses": diagnostics.node_processes,
        "rootCommand": summarize_optional_string(diagnostics.root_command.as_deref()),
        "managedRuntimeProcesses": diagnostics.managed_runtime_processes,
        "resumeHelperProcesses": diagnostics.resume_helper_processes,
        "orphanResidueProcesses": diagnostics.orphan_residue_processes,
    })
}

fn collect_renderer_diagnostics(client_store_summary: &Value) -> Value {
    let (diagnostics_store_path, app_store_path) = match app_paths::client_storage_dir() {
        Ok(client_dir) => (
            client_dir.join("diagnostics.json"),
            client_dir.join("app.json"),
        ),
        Err(error) => {
            return json!({
                "entries": [],
                "readError": error,
                "summary": renderer_diagnostics_summary_from_store_summary(client_store_summary),
                "maxEntries": MAX_RENDERER_DIAGNOSTICS,
            });
        }
    };
    let diagnostics_store_value = read_json_file_best_effort(&diagnostics_store_path);
    let app_store_value = read_json_file_best_effort(&app_store_path);
    let entries = diagnostics_store_value
        .get("diagnostics.rendererLifecycleLog")
        .or_else(|| app_store_value.get("diagnostics.rendererLifecycleLog"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .rev()
                .take(MAX_RENDERER_DIAGNOSTICS)
                .map(sanitize_renderer_diagnostic_entry)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let entry_count = entries.len();

    json!({
        "entries": entries,
        "entryCount": entry_count,
        "summary": renderer_diagnostics_summary_from_store_summary(client_store_summary),
        "maxEntries": MAX_RENDERER_DIAGNOSTICS,
    })
}

fn renderer_diagnostics_summary_from_store_summary(client_store_summary: &Value) -> Value {
    for store_name in ["diagnostics", "app"] {
        let Some(store) = client_store_summary.get(store_name) else {
            continue;
        };
        let Some(keys) = store.get("keys").and_then(Value::as_object) else {
            continue;
        };
        if let Some(summary) = keys.get("diagnostics.rendererLifecycleLog") {
            return summary.clone();
        }
    }
    Value::Null
}

fn sanitize_renderer_diagnostic_entry(entry: &Value) -> Value {
    let timestamp = entry
        .get("timestamp")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let label = entry
        .get("label")
        .and_then(Value::as_str)
        .map(|value| truncate_string(value, MAX_DIAGNOSTIC_LABEL_CHARS))
        .unwrap_or_default();
    let payload = entry
        .get("payload")
        .map(sanitize_diagnostic_payload)
        .unwrap_or_else(|| json!({ "kind": "missing" }));

    json!({
        "timestamp": timestamp,
        "label": label,
        "payload": payload,
    })
}

fn sanitize_diagnostic_payload(value: &Value) -> Value {
    match value {
        Value::Null => json!({ "kind": "null" }),
        Value::Bool(value) => json!({ "kind": "boolean", "value": value }),
        Value::Number(value) => json!({ "kind": "number", "value": value }),
        Value::String(value) => json!({
            "kind": "string",
            "length": value.chars().count(),
            "fingerprint": fingerprint_string(value),
        }),
        Value::Array(items) => json!({
            "kind": "array",
            "length": items.len(),
            "itemsTruncated": items.len() > MAX_DIAGNOSTIC_ARRAY_ITEMS,
            "items": items
                .iter()
                .take(MAX_DIAGNOSTIC_ARRAY_ITEMS)
                .map(sanitize_diagnostic_payload)
                .collect::<Vec<_>>(),
        }),
        Value::Object(map) => {
            let mut fields = BTreeMap::new();
            for (key, value) in map.iter().take(MAX_DIAGNOSTIC_PAYLOAD_KEYS) {
                fields.insert(key.clone(), sanitize_diagnostic_payload(value));
            }
            json!({
                "kind": "object",
                "keyCount": map.len(),
                "keysTruncated": map.len() > MAX_DIAGNOSTIC_PAYLOAD_KEYS,
                "fields": fields,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        sanitize_app_settings, sanitize_renderer_diagnostic_entry, sanitize_runtime_pool_row,
        summarize_store_value, write_json_atomically, MAX_DIAGNOSTIC_ARRAY_ITEMS,
    };
    use crate::runtime::{
        RuntimePoolRow, RuntimeProcessDiagnostics, RuntimeStartupState, RuntimeState,
    };
    use crate::types::AppSettings;
    use serde_json::json;
    use std::fs;

    #[test]
    fn sanitize_app_settings_omits_sensitive_values() {
        let mut settings = AppSettings::default();
        settings.remote_backend_token = Some("secret-token".to_string());
        settings.web_service_token = Some("fixed-web-token".to_string());
        settings.email_sender.username = "user@example.com".to_string();
        settings.performance_compatibility_mode_enabled = true;

        let value = sanitize_app_settings(&settings);
        let serialized = serde_json::to_string(&value).expect("serialize sanitized settings");

        assert!(serialized.contains("performanceCompatibilityModeEnabled"));
        assert!(serialized.contains("hasRemoteBackendToken"));
        assert!(serialized.contains("hasWebServiceToken"));
        assert!(!serialized.contains("secret-token"));
        assert!(!serialized.contains("fixed-web-token"));
        assert!(!serialized.contains("user@example.com"));
    }

    #[test]
    fn sanitize_renderer_diagnostic_entry_bounds_payload() {
        let sensitive_message =
            "prompt contains sk-user-secret token for alice@example.com inside component stack"
                .repeat(4);
        let frames = (0..80).collect::<Vec<u32>>();
        let value = sanitize_renderer_diagnostic_entry(&json!({
            "timestamp": 42,
            "label": "window/error",
            "payload": {
                "message": sensitive_message,
                "href": "file:///Users/alice/private/repo/index.html",
                "filename": "/Users/alice/private/repo/src/App.tsx",
                "frames": frames
            }
        }));
        let serialized =
            serde_json::to_string(&value).expect("serialize sanitized renderer diagnostic");

        assert_eq!(value["timestamp"], 42);
        assert_eq!(value["label"], "window/error");
        assert_eq!(value["payload"]["kind"], "object");
        assert_eq!(value["payload"]["fields"]["message"]["kind"], "string");
        assert!(value["payload"]["fields"]["message"]["preview"].is_null());
        assert!(value["payload"]["fields"]["message"]["fingerprint"].is_string());
        assert!(!serialized.contains("sk-user-secret"));
        assert!(!serialized.contains("alice@example.com"));
        assert!(!serialized.contains("component stack"));
        assert!(!serialized.contains("/Users/alice/private/repo"));
        assert_eq!(value["payload"]["fields"]["frames"]["length"], 80);
        assert_eq!(
            value["payload"]["fields"]["frames"]["items"]
                .as_array()
                .expect("array items")
                .len(),
            MAX_DIAGNOSTIC_ARRAY_ITEMS
        );
    }

    #[test]
    fn summarize_store_value_omits_prompt_token_email_and_draft_text() {
        let value = summarize_store_value(json!({
            "composer.promptHistory": [
                "please deploy with token sk-user-secret for alice@example.com"
            ],
            "kanban.draft": "draft contains customer@example.com and private prompt text",
            "threads.customNames": {
                "thread-a": "confidential roadmap"
            }
        }));
        let serialized = serde_json::to_string(&value).expect("serialize store summary");

        assert!(serialized.contains("composer.promptHistory"));
        assert!(!serialized.contains("sk-user-secret"));
        assert!(!serialized.contains("alice@example.com"));
        assert!(!serialized.contains("customer@example.com"));
        assert!(!serialized.contains("private prompt text"));
        assert!(!serialized.contains("confidential roadmap"));
    }

    #[test]
    fn sanitize_runtime_pool_row_omits_paths_and_error_messages() {
        let row = RuntimePoolRow {
            workspace_id: "workspace-secret".to_string(),
            workspace_name: "Secret Repo".to_string(),
            workspace_path: "/Users/alice/private/repo".to_string(),
            engine: "codex".to_string(),
            state: RuntimeState::Failed,
            lifecycle_state: crate::runtime::RuntimeLifecycleState::Ended,
            pid: Some(4242),
            runtime_generation: Some("pid:4242:startedAt:1".to_string()),
            wrapper_kind: Some("node".to_string()),
            resolved_bin: Some("/Users/alice/bin/codex-secret".to_string()),
            started_at_ms: Some(1),
            last_used_at_ms: 2,
            pinned: false,
            turn_lease_count: 1,
            stream_lease_count: 0,
            lease_sources: vec!["turn:secret-prompt".to_string()],
            active_work_protected: true,
            active_work_reason: Some("turn".to_string()),
            active_work_since_ms: Some(1),
            active_work_last_renewed_at_ms: Some(2),
            foreground_work_state: None,
            foreground_work_source: None,
            foreground_work_thread_id: Some("thread-user-message-secret".to_string()),
            foreground_work_turn_id: Some("turn-token-secret".to_string()),
            foreground_work_since_ms: None,
            foreground_work_timeout_at_ms: None,
            foreground_work_last_event_at_ms: None,
            foreground_work_timed_out: false,
            evict_candidate: false,
            eviction_reason: None,
            error: Some(
                "failed in /Users/alice/private/repo with token sk-user-secret".to_string(),
            ),
            last_exit_reason_code: Some("error".to_string()),
            last_exit_message: Some("alice@example.com prompt crashed".to_string()),
            last_exit_at_ms: Some(3),
            last_exit_code: Some(1),
            last_exit_signal: None,
            last_exit_pending_request_count: 0,
            process_diagnostics: Some(RuntimeProcessDiagnostics {
                root_processes: 1,
                total_processes: 2,
                node_processes: 1,
                root_command: Some(
                    "/Users/alice/private/repo/node --token sk-user-secret".to_string(),
                ),
                managed_runtime_processes: 1,
                resume_helper_processes: 0,
                orphan_residue_processes: 0,
            }),
            startup_state: Some(RuntimeStartupState::Quarantined),
            last_recovery_source: Some("thread-list-live".to_string()),
            last_guard_state: Some("ready".to_string()),
            last_replace_reason: None,
            last_probe_failure: Some(
                "probe failed for /Users/alice/private/repo and alice@example.com".to_string(),
            ),
            last_probe_failure_source: Some("doctor".to_string()),
            reason_code: Some("probe-failed".to_string()),
            recovery_source: Some("thread-list-live".to_string()),
            retryable: true,
            user_action: Some("retry".to_string()),
            has_stopping_predecessor: false,
            recent_spawn_count: 1,
            recent_replace_count: 0,
            recent_force_kill_count: 0,
        };
        let value = sanitize_runtime_pool_row(&row);
        let serialized = serde_json::to_string(&value).expect("serialize runtime row");

        assert_eq!(value["workspacePath"]["basename"], "repo");
        assert_eq!(value["resolvedBin"]["basename"], "codex-secret");
        assert!(!serialized.contains("/Users/alice/private/repo"));
        assert!(!serialized.contains("/Users/alice/bin"));
        assert!(!serialized.contains("sk-user-secret"));
        assert!(!serialized.contains("alice@example.com"));
        assert!(!serialized.contains("prompt crashed"));
    }

    #[test]
    fn write_json_atomically_cleans_temp_file_when_finalize_fails() {
        let test_dir = std::env::temp_dir().join(format!(
            "ccgui-diagnostics-bundle-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&test_dir).expect("create test dir");

        let target_dir = test_dir.join("existing-target");
        fs::create_dir_all(&target_dir).expect("create target dir");

        let result = write_json_atomically(&target_dir, &json!({ "ok": true }));
        assert!(result.is_err());

        let temp_entries = fs::read_dir(&test_dir)
            .expect("read test dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .count();
        assert_eq!(temp_entries, 0);

        fs::remove_dir_all(&test_dir).expect("cleanup test dir");
    }
}
