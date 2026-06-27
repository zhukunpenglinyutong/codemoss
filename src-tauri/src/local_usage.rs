use chrono::{DateTime, Duration, Local, TimeZone, Utc};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration as StdDuration, SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::app_paths;
use crate::codex::home::{resolve_default_codex_home, resolve_workspace_codex_home};
use crate::state::AppState;
use crate::types::{
    LocalUsageDailyCodeChange, LocalUsageDailyUsage, LocalUsageDay, LocalUsageEngineUsage,
    LocalUsageModel, LocalUsageModelUsage, LocalUsageSessionSummary, LocalUsageSnapshot,
    LocalUsageStatistics, LocalUsageTotals, LocalUsageTrends, LocalUsageUsageData,
    LocalUsageWeekData, LocalUsageWeeklyComparison, WorkspaceEntry,
};

#[path = "local_usage/codex_rewind.rs"]
mod codex_rewind;
pub(crate) use codex_rewind::commit_codex_rewind_for_workspace;
#[path = "local_usage/gemini_sessions.rs"]
mod gemini_sessions;
use gemini_sessions::scan_gemini_session_summaries;
#[cfg(test)]
use gemini_sessions::{gemini_project_matches_workspace, scan_gemini_session_summaries_from_base};
#[path = "local_usage/session_delete.rs"]
mod session_delete;
pub(crate) use session_delete::{
    delete_codex_session_for_workspace, delete_codex_sessions_for_workspace,
};

#[derive(Default, Clone, Copy)]
struct DailyTotals {
    input: i64,
    cached: i64,
    output: i64,
    agent_ms: i64,
    agent_runs: i64,
}

#[derive(Default, Clone, Copy)]
struct UsageTotals {
    input: i64,
    cached: i64,
    output: i64,
}

const MAX_ACTIVITY_GAP_MS: i64 = 2 * 60 * 1000;
const USAGE_LIMIT_SESSIONS: usize = 200;
const LOCAL_SESSION_SCAN_TIMEOUT: StdDuration = StdDuration::from_secs(60);
const CODEX_PROVIDER_PROFILE_SOURCE_MANAGED: &str = "managed";
const CODEX_PROVIDER_PROFILE_AVAILABILITY_UNKNOWN: &str = "unknown";

#[derive(Default, Clone, Copy)]
struct CostRates {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct CodexSessionRootResolution {
    pub(crate) roots: Vec<PathBuf>,
    pub(crate) provider_home_diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct CodexSessionSummaryList {
    pub(crate) workspace_path: String,
    pub(crate) sessions: Vec<LocalUsageSessionSummary>,
    pub(crate) provider_home_diagnostics: Vec<String>,
}

#[tauri::command]
pub(crate) async fn local_usage_snapshot(
    days: Option<u32>,
    workspace_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<LocalUsageSnapshot, String> {
    let days = days.unwrap_or(30).clamp(1, 90);
    let workspace_path = workspace_path.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    });
    let sessions_roots = {
        let workspaces = state.workspaces.lock().await;
        resolve_sessions_roots(&workspaces, workspace_path.as_deref())
    };
    let snapshot = tokio::task::spawn_blocking(move || {
        scan_local_usage(days, workspace_path.as_deref(), &sessions_roots)
    })
    .await
    .map_err(|err| err.to_string())??;
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn local_usage_statistics(
    scope: Option<String>,
    provider: Option<String>,
    date_range: Option<String>,
    workspace_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<LocalUsageStatistics, String> {
    local_usage_statistics_for_workspaces(
        &state.workspaces,
        scope,
        provider,
        date_range,
        workspace_path,
    )
    .await
}

pub(crate) async fn local_usage_statistics_for_workspaces(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    scope: Option<String>,
    provider: Option<String>,
    date_range: Option<String>,
    workspace_path: Option<String>,
) -> Result<LocalUsageStatistics, String> {
    let scope = scope.unwrap_or_else(|| "current".to_string());
    let provider = provider.unwrap_or_else(|| "all".to_string());
    let date_range = date_range.unwrap_or_else(|| "7d".to_string());
    let workspace_path = workspace_path.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    });
    let filter_workspace = if scope == "current" {
        workspace_path
    } else {
        None
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let cutoff_time = match date_range.as_str() {
        "7d" => now_ms - 7 * 24 * 60 * 60 * 1000,
        "30d" => now_ms - 30 * 24 * 60 * 60 * 1000,
        _ => 0,
    };
    let project_path = if scope == "all" {
        "all".to_string()
    } else if let Some(path) = filter_workspace.as_ref() {
        path.to_string_lossy().to_string()
    } else {
        "current".to_string()
    };
    let project_name = if scope == "all" {
        "All Projects".to_string()
    } else if let Some(path) = filter_workspace.as_ref() {
        path.file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("Current Project")
            .to_string()
    } else {
        "Current Project".to_string()
    };

    let sessions_roots = {
        let workspaces = workspaces.lock().await;
        resolve_sessions_roots(&workspaces, filter_workspace.as_deref())
    };
    tokio::task::spawn_blocking(move || {
        scan_local_usage_statistics(
            &provider,
            filter_workspace.as_deref(),
            &sessions_roots,
            cutoff_time,
            project_path,
            project_name,
            now_ms,
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

pub(crate) async fn list_codex_session_summaries_for_workspace(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
    limit: usize,
) -> Result<(String, Vec<LocalUsageSessionSummary>), String> {
    let result =
        list_codex_session_summary_list_for_workspace(workspaces, workspace_id, limit).await?;
    Ok((result.workspace_path, result.sessions))
}

pub(crate) async fn list_codex_session_summary_list_for_workspace(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
    limit: usize,
) -> Result<CodexSessionSummaryList, String> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("workspace_id is required".to_string());
    }
    let requested_limit = limit.max(1);
    let (workspace_path_str, workspace_path, root_resolution) = {
        let workspaces = workspaces.lock().await;
        let entry = workspaces
            .get(workspace_id)
            .ok_or_else(|| "workspace not found".to_string())?;
        let workspace_path = PathBuf::from(&entry.path);
        let root_resolution =
            resolve_sessions_roots_with_diagnostics(&workspaces, Some(workspace_path.as_path()));
        (entry.path.clone(), workspace_path, root_resolution)
    };
    for diagnostic in &root_resolution.provider_home_diagnostics {
        log::warn!(
            "[local_usage.codex] provider home source degraded for workspace {}: {}",
            workspace_id,
            diagnostic
        );
    }
    let sessions_roots = root_resolution.roots;
    let sessions = timeout(
        LOCAL_SESSION_SCAN_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let mut summaries =
                scan_codex_session_summaries(Some(workspace_path.as_path()), &sessions_roots)?;
            if summaries.len() > requested_limit {
                summaries.truncate(requested_limit);
            }
            Ok::<Vec<LocalUsageSessionSummary>, String>(summaries)
        }),
    )
    .await
    .map_err(|_| "local codex session fallback timed out".to_string())?
    .map_err(|err| err.to_string())??;

    Ok(CodexSessionSummaryList {
        workspace_path: workspace_path_str,
        sessions,
        provider_home_diagnostics: root_resolution.provider_home_diagnostics,
    })
}

pub(crate) async fn list_global_codex_session_summaries(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    limit: usize,
) -> Result<Vec<LocalUsageSessionSummary>, String> {
    let requested_limit = limit.max(1);
    let root_resolution = {
        let workspaces = workspaces.lock().await;
        resolve_sessions_roots_with_diagnostics(&workspaces, None)
    };
    for diagnostic in &root_resolution.provider_home_diagnostics {
        log::warn!(
            "[local_usage.codex] provider home source degraded for global scan: {}",
            diagnostic
        );
    }
    let sessions_roots = root_resolution.roots;
    let sessions = timeout(
        LOCAL_SESSION_SCAN_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let mut summaries = scan_codex_session_summaries(None, &sessions_roots)?;
            if summaries.len() > requested_limit {
                summaries.truncate(requested_limit);
            }
            Ok::<Vec<LocalUsageSessionSummary>, String>(summaries)
        }),
    )
    .await
    .map_err(|_| "global codex session scan timed out".to_string())?
    .map_err(|err| err.to_string())??;

    Ok(sessions)
}

#[tauri::command]
pub(crate) async fn list_codex_session_summaries(
    workspace_id: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<LocalUsageSessionSummary>, String> {
    let capped_limit = limit.unwrap_or(200).clamp(1, 200) as usize;
    let (_, sessions) =
        list_codex_session_summaries_for_workspace(&state.workspaces, &workspace_id, capped_limit)
            .await?;
    Ok(sessions)
}

#[tauri::command]
pub(crate) async fn load_codex_session(
    workspace_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let workspace_id = workspace_id.trim().to_string();
    let session_id = session_id.trim().to_string();
    if workspace_id.is_empty() {
        return Err("workspace_id is required".to_string());
    }
    if session_id.is_empty() {
        return Err("session_id is required".to_string());
    }
    if is_invalid_session_path_segment(&session_id) {
        return Err("invalid session_id".to_string());
    }

    let (workspace_path, sessions_roots) = {
        let workspaces = state.workspaces.lock().await;
        let entry = workspaces
            .get(&workspace_id)
            .ok_or_else(|| "workspace not found".to_string())?;
        let workspace_path = PathBuf::from(&entry.path);
        let sessions_roots = resolve_sessions_roots(&workspaces, Some(workspace_path.as_path()));
        (workspace_path, sessions_roots)
    };

    let session_id_for_load = session_id.clone();
    let entries = tokio::task::spawn_blocking(move || {
        load_codex_session_entries(
            session_id_for_load.as_str(),
            workspace_path.as_path(),
            &sessions_roots,
        )
    })
    .await
    .map_err(|err| err.to_string())??;

    Ok(json!({
        "sessionId": session_id,
        "entries": entries,
    }))
}

pub(super) fn is_invalid_session_path_segment(session_id: &str) -> bool {
    session_id == "."
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
}

fn find_codex_session_file(
    session_id: &str,
    workspace_path: &Path,
    sessions_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let matches = session_delete::collect_matching_codex_session_files(
        session_id,
        workspace_path,
        sessions_roots,
    )?;
    matches
        .into_iter()
        .next()
        .ok_or_else(|| format!("codex session file not found for session {}", session_id))
}

fn load_codex_session_entries(
    session_id: &str,
    workspace_path: &Path,
    sessions_roots: &[PathBuf],
) -> Result<Vec<Value>, String> {
    let session_path = find_codex_session_file(session_id, workspace_path, sessions_roots)?;
    let file = File::open(&session_path).map_err(|err| {
        format!(
            "failed to open codex session file {}: {}",
            session_path.display(),
            err
        )
    })?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|err| err.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&line).map_err(|err| {
            format!(
                "failed to parse codex session entry {}: {}",
                session_path.display(),
                err
            )
        })?;
        entries.push(value);
    }
    Ok(entries)
}

fn scan_local_usage_statistics(
    provider: &str,
    workspace_path: Option<&Path>,
    sessions_roots: &[PathBuf],
    cutoff_time: i64,
    project_path: String,
    project_name: String,
    now_ms: i64,
) -> Result<LocalUsageStatistics, String> {
    let provider_mode = provider.trim().to_ascii_lowercase();
    let mut sessions = match provider_mode.as_str() {
        "codex" => scan_codex_session_summaries(workspace_path, sessions_roots)?,
        "claude" => scan_claude_session_summaries(workspace_path)?,
        "gemini" => scan_gemini_session_summaries(workspace_path)?,
        "all" | "" => scan_all_provider_session_summaries(workspace_path, sessions_roots)?,
        _ => scan_all_provider_session_summaries(workspace_path, sessions_roots)?,
    };

    if cutoff_time > 0 {
        sessions.retain(|session| session.timestamp >= cutoff_time);
    }
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    if provider_mode == "claude" && sessions.len() > USAGE_LIMIT_SESSIONS {
        sessions.truncate(USAGE_LIMIT_SESSIONS);
    }

    Ok(build_usage_statistics(
        project_path,
        project_name,
        provider,
        sessions,
        now_ms,
    ))
}

fn scan_all_provider_session_summaries(
    workspace_path: Option<&Path>,
    sessions_roots: &[PathBuf],
) -> Result<Vec<LocalUsageSessionSummary>, String> {
    let mut sessions = scan_codex_session_summaries(workspace_path, sessions_roots)?;
    sessions.extend(scan_claude_session_summaries(workspace_path)?);
    sessions.extend(scan_gemini_session_summaries(workspace_path)?);
    Ok(sessions)
}

fn scan_local_usage(
    days: u32,
    workspace_path: Option<&Path>,
    sessions_roots: &[PathBuf],
) -> Result<LocalUsageSnapshot, String> {
    scan_local_usage_core(days, workspace_path, sessions_roots, true)
}

fn scan_local_usage_core(
    days: u32,
    workspace_path: Option<&Path>,
    sessions_roots: &[PathBuf],
    include_claude: bool,
) -> Result<LocalUsageSnapshot, String> {
    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let day_keys = make_day_keys(days);
    let mut daily: HashMap<String, DailyTotals> = day_keys
        .iter()
        .map(|key| (key.clone(), DailyTotals::default()))
        .collect();
    let mut model_totals: HashMap<String, i64> = HashMap::new();

    // Scan Codex sessions
    for root in sessions_roots {
        for day_key in &day_keys {
            let day_dir = day_dir_for_key(root, day_key);
            if !day_dir.exists() {
                continue;
            }
            let entries = match std::fs::read_dir(&day_dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                    continue;
                }
                scan_file(&path, &mut daily, &mut model_totals, workspace_path)?;
            }
        }
    }

    // Also scan Claude Code projects
    if include_claude {
        scan_claude_projects(&day_keys, &mut daily, &mut model_totals, workspace_path)?;
    }

    Ok(build_snapshot(updated_at, day_keys, daily, model_totals))
}

fn build_snapshot(
    updated_at: i64,
    day_keys: Vec<String>,
    daily: HashMap<String, DailyTotals>,
    model_totals: HashMap<String, i64>,
) -> LocalUsageSnapshot {
    let mut days: Vec<LocalUsageDay> = Vec::with_capacity(day_keys.len());
    let mut total_tokens = 0;

    for day_key in &day_keys {
        let totals = daily.get(day_key).copied().unwrap_or_default();
        let total = totals.input + totals.output;
        total_tokens += total;
        days.push(LocalUsageDay {
            day: day_key.clone(),
            input_tokens: totals.input,
            cached_input_tokens: totals.cached,
            output_tokens: totals.output,
            total_tokens: total,
            agent_time_ms: totals.agent_ms,
            agent_runs: totals.agent_runs,
        });
    }

    let last7 = days.iter().rev().take(7).cloned().collect::<Vec<_>>();
    let last7_tokens: i64 = last7.iter().map(|day| day.total_tokens).sum();
    let last7_input: i64 = last7.iter().map(|day| day.input_tokens).sum();
    let last7_cached: i64 = last7.iter().map(|day| day.cached_input_tokens).sum();

    let average_daily_tokens = if last7.is_empty() {
        0
    } else {
        ((last7_tokens as f64) / (last7.len() as f64)).round() as i64
    };

    let cache_hit_rate_percent = if last7_input > 0 {
        ((last7_cached as f64) / (last7_input as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };

    let peak = days
        .iter()
        .max_by_key(|day| day.total_tokens)
        .filter(|day| day.total_tokens > 0);
    let peak_day = peak.map(|day| day.day.clone());
    let peak_day_tokens = peak.map(|day| day.total_tokens).unwrap_or(0);

    let mut top_models: Vec<LocalUsageModel> = model_totals
        .into_iter()
        .filter(|(model, tokens)| model != "unknown" && *tokens > 0)
        .map(|(model, tokens)| LocalUsageModel {
            model,
            tokens,
            share_percent: if total_tokens > 0 {
                ((tokens as f64) / (total_tokens as f64) * 1000.0).round() / 10.0
            } else {
                0.0
            },
        })
        .collect();
    top_models.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    top_models.truncate(4);

    LocalUsageSnapshot {
        updated_at,
        days,
        totals: LocalUsageTotals {
            last7_days_tokens: last7_tokens,
            last30_days_tokens: total_tokens,
            average_daily_tokens,
            cache_hit_rate_percent,
            peak_day,
            peak_day_tokens,
        },
        top_models,
    }
}

fn build_usage_statistics(
    project_path: String,
    project_name: String,
    provider: &str,
    sessions: Vec<LocalUsageSessionSummary>,
    now_ms: i64,
) -> LocalUsageStatistics {
    let mut total_usage = LocalUsageUsageData::default();
    let mut estimated_cost = 0.0;
    let mut daily_map: HashMap<String, LocalUsageDailyUsage> = HashMap::new();
    let mut daily_code_changes_map: HashMap<String, i64> = HashMap::new();
    let mut model_map: HashMap<String, LocalUsageModelUsage> = HashMap::new();
    let mut engine_usage_map: HashMap<String, i64> = HashMap::new();
    let one_week_ago = now_ms - 7 * 24 * 60 * 60 * 1000;
    let two_weeks_ago = now_ms - 14 * 24 * 60 * 60 * 1000;
    let mut current_week = LocalUsageWeekData::default();
    let mut last_week = LocalUsageWeekData::default();
    let mut ai_code_modified_lines = 0_i64;

    for session in &sessions {
        add_usage(&mut total_usage, &session.usage);
        estimated_cost += session.cost;
        ai_code_modified_lines += session.modified_lines.max(0);

        let engine_label = infer_engine_label(provider, session);
        *engine_usage_map.entry(engine_label).or_insert(0) += 1;

        let day_key =
            day_key_for_timestamp_ms(session.timestamp).unwrap_or_else(|| "1970-01-01".to_string());
        let daily = daily_map
            .entry(day_key.clone())
            .or_insert_with(|| LocalUsageDailyUsage {
                date: day_key.clone(),
                ..LocalUsageDailyUsage::default()
            });
        daily.sessions += 1;
        daily.cost += session.cost;
        add_usage(&mut daily.usage, &session.usage);
        if session.modified_lines > 0 {
            *daily_code_changes_map.entry(day_key.clone()).or_insert(0) += session.modified_lines;
        }
        if !daily
            .models_used
            .iter()
            .any(|model| model == &session.model)
        {
            daily.models_used.push(session.model.clone());
        }

        let model_usage =
            model_map
                .entry(session.model.clone())
                .or_insert_with(|| LocalUsageModelUsage {
                    model: session.model.clone(),
                    ..LocalUsageModelUsage::default()
                });
        model_usage.session_count += 1;
        model_usage.total_cost += session.cost;
        model_usage.total_tokens += session.usage.total_tokens;
        model_usage.input_tokens += session.usage.input_tokens;
        model_usage.output_tokens += session.usage.output_tokens;
        model_usage.cache_creation_tokens += session.usage.cache_write_tokens;
        model_usage.cache_read_tokens += session.usage.cache_read_tokens;

        if session.timestamp >= one_week_ago {
            current_week.sessions += 1;
            current_week.cost += session.cost;
            current_week.tokens += session.usage.total_tokens;
        } else if session.timestamp >= two_weeks_ago {
            last_week.sessions += 1;
            last_week.cost += session.cost;
            last_week.tokens += session.usage.total_tokens;
        }
    }

    total_usage.total_tokens = total_usage.input_tokens
        + total_usage.output_tokens
        + total_usage.cache_write_tokens
        + total_usage.cache_read_tokens;

    let mut daily_usage: Vec<LocalUsageDailyUsage> = daily_map.into_values().collect();
    daily_usage.sort_by(|a, b| a.date.cmp(&b.date));
    let mut by_model: Vec<LocalUsageModelUsage> = model_map.into_values().collect();
    by_model.sort_by(|a, b| b.total_cost.total_cmp(&a.total_cost));
    let mut engine_usage: Vec<LocalUsageEngineUsage> = engine_usage_map
        .into_iter()
        .map(|(engine, count)| LocalUsageEngineUsage { engine, count })
        .collect();
    engine_usage.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.engine.cmp(&b.engine)));
    let total_engine_usage_count = engine_usage.iter().map(|item| item.count).sum();
    let mut daily_code_changes: Vec<LocalUsageDailyCodeChange> = daily_code_changes_map
        .into_iter()
        .map(|(date, modified_lines)| LocalUsageDailyCodeChange {
            date,
            modified_lines,
        })
        .collect();
    daily_code_changes.sort_by(|a, b| a.date.cmp(&b.date));

    LocalUsageStatistics {
        project_path,
        project_name,
        total_sessions: sessions.len() as i64,
        total_usage,
        estimated_cost,
        sessions,
        daily_usage,
        weekly_comparison: LocalUsageWeeklyComparison {
            current_week: current_week.clone(),
            last_week: last_week.clone(),
            trends: LocalUsageTrends {
                sessions: calculate_trend(current_week.sessions as f64, last_week.sessions as f64),
                cost: calculate_trend(current_week.cost, last_week.cost),
                tokens: calculate_trend(current_week.tokens as f64, last_week.tokens as f64),
            },
        },
        by_model,
        total_engine_usage_count,
        engine_usage,
        ai_code_modified_lines,
        daily_code_changes,
        last_updated: now_ms,
    }
}

fn calculate_trend(current: f64, last: f64) -> f64 {
    if last == 0.0 {
        return 0.0;
    }
    ((current - last) / last) * 100.0
}

fn infer_engine_label(provider: &str, session: &LocalUsageSessionSummary) -> String {
    let model_lower = session.model.to_ascii_lowercase();
    if model_lower.contains("claude") {
        return "Claude Code".to_string();
    }
    if model_lower.contains("gemini") {
        return "Gemini CLI".to_string();
    }
    if model_lower.contains("opencode") {
        return "OpenCode CLI".to_string();
    }
    if model_lower.contains("gpt") || model_lower.contains("codex") {
        return "Codex CLI".to_string();
    }

    let provider_hint = session
        .provider
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if provider_hint.contains("anthropic") || provider_hint.contains("claude") {
        return "Claude Code".to_string();
    }
    if provider_hint.contains("gemini") || provider_hint.contains("google") {
        return "Gemini CLI".to_string();
    }
    if provider_hint.contains("opencode") {
        return "OpenCode CLI".to_string();
    }
    if provider_hint.contains("openai") {
        return "Codex CLI".to_string();
    }

    let source_hint = session
        .source
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if source_hint.contains("claude") {
        return "Claude Code".to_string();
    }
    if source_hint.contains("gemini") {
        return "Gemini CLI".to_string();
    }
    if source_hint.contains("opencode") {
        return "OpenCode CLI".to_string();
    }
    if source_hint.contains("codex")
        || source_hint.contains("ccgui")
        || source_hint.contains("mossx")
        || source_hint.contains("cli")
    {
        return "Codex CLI".to_string();
    }

    let provider_lower = provider.trim().to_ascii_lowercase();
    match provider_lower.as_str() {
        "claude" => "Claude Code".to_string(),
        "gemini" => "Gemini CLI".to_string(),
        "opencode" => "OpenCode CLI".to_string(),
        "codex" => "Codex CLI".to_string(),
        _ => "Other/Custom".to_string(),
    }
}

fn add_usage(target: &mut LocalUsageUsageData, usage: &LocalUsageUsageData) {
    target.input_tokens += usage.input_tokens;
    target.output_tokens += usage.output_tokens;
    target.cache_write_tokens += usage.cache_write_tokens;
    target.cache_read_tokens += usage.cache_read_tokens;
    target.total_tokens += usage.total_tokens;
}

fn calculate_usage_cost(usage: &LocalUsageUsageData, rates: CostRates) -> f64 {
    let input_cost = (usage.input_tokens as f64 / 1_000_000.0) * rates.input;
    let output_cost = (usage.output_tokens as f64 / 1_000_000.0) * rates.output;
    let cache_write_cost = (usage.cache_write_tokens as f64 / 1_000_000.0) * rates.cache_write;
    let cache_read_cost = (usage.cache_read_tokens as f64 / 1_000_000.0) * rates.cache_read;
    input_cost + output_cost + cache_write_cost + cache_read_cost
}

fn codex_cost_rates() -> CostRates {
    CostRates {
        input: 3.0,
        output: 15.0,
        cache_write: 0.0,
        cache_read: 0.30,
    }
}

fn claude_cost_rates(model: &str) -> CostRates {
    let model_lower = model.to_lowercase();
    if model_lower.contains("opus-4") || model_lower.contains("claude-opus-4") {
        return CostRates {
            input: 15.0,
            output: 75.0,
            cache_write: 18.75,
            cache_read: 1.50,
        };
    }
    if model_lower.contains("haiku-4") || model_lower.contains("claude-haiku-4") {
        return CostRates {
            input: 0.8,
            output: 4.0,
            cache_write: 1.0,
            cache_read: 0.08,
        };
    }
    CostRates {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30,
    }
}

fn scan_codex_session_summaries(
    workspace_path: Option<&Path>,
    sessions_roots: &[PathBuf],
) -> Result<Vec<LocalUsageSessionSummary>, String> {
    let mut files = Vec::new();
    let mut seen_files = HashSet::new();
    for root in sessions_roots {
        collect_jsonl_files(root, &mut files, &mut seen_files);
    }

    let mut sessions = Vec::new();
    for file in files {
        if let Some(summary) = parse_codex_session_summary(&file, workspace_path)? {
            sessions.push(summary);
        }
    }
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
}

fn collect_jsonl_files(root: &Path, output: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    for path in paths {
        if path.is_dir() {
            collect_jsonl_files(&path, output, seen);
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if seen.insert(path.clone()) {
            output.push(path);
        }
    }
}

fn parse_codex_session_summary(
    path: &Path,
    workspace_path: Option<&Path>,
) -> Result<Option<LocalUsageSessionSummary>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };
    let reader = BufReader::new(file);
    let mut usage = LocalUsageUsageData::default();
    let mut summary: Option<String> = None;
    let mut model: Option<String> = None;
    let mut source: Option<String> = None;
    let mut provider: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut canonical_session_id: Option<String> = None;
    let mut latest_timestamp = 0_i64;
    let mut previous_totals: Option<UsageTotals> = None;
    let mut match_known = workspace_path.is_none();
    let mut matches_workspace = workspace_path.is_none();
    let mut saw_session_signal = false;
    let mut modified_lines = 0_i64;
    let mut max_diff_stat_lines = 0_i64;
    let mut pending_apply_patch_lines: HashMap<String, i64> = HashMap::new();
    let mut response_item_user_summary: Option<String> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.len() > 512_000 {
            continue;
        }

        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        latest_timestamp = latest_timestamp.max(read_timestamp_ms(&value).unwrap_or(0));

        let entry_type = value
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");

        if entry_type == "response_item" {
            if let Some(payload) = value.get("payload").and_then(|payload| payload.as_object()) {
                let payload_type = payload
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");

                if payload_type == "message" {
                    let role = payload
                        .get("role")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if role == "user" {
                        saw_session_signal = true;
                        if response_item_user_summary.is_none() {
                            if let Some(message) = extract_codex_message_text(payload) {
                                response_item_user_summary = truncate_summary(&message);
                            }
                        }
                    }
                } else if payload_type == "custom_tool_call" {
                    let tool_name = payload
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if tool_name == "apply_patch" {
                        let call_id = payload
                            .get("call_id")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !call_id.is_empty() {
                            let patch_input = payload
                                .get("input")
                                .and_then(|value| value.as_str())
                                .unwrap_or("");
                            pending_apply_patch_lines
                                .insert(call_id, count_apply_patch_changed_lines(patch_input));
                            saw_session_signal = true;
                        }
                    }
                } else if payload_type == "custom_tool_call_output" {
                    let call_id = payload
                        .get("call_id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if let Some(pending_lines) = pending_apply_patch_lines.remove(call_id) {
                        let output = payload
                            .get("output")
                            .map(stringify_tool_output_value)
                            .unwrap_or_default();
                        if is_successful_apply_patch_output(&output) {
                            modified_lines += pending_lines.max(0);
                        }
                    }
                } else if payload_type == "function_call_output" {
                    let output = payload
                        .get("output")
                        .map(extract_tool_output_text)
                        .unwrap_or_default();
                    if let Some(lines) = parse_changed_lines_from_git_diff_stat_output(&output) {
                        max_diff_stat_lines = max_diff_stat_lines.max(lines.max(0));
                    }
                }
            }
            continue;
        }

        if entry_type == "session_meta" || entry_type == "turn_context" {
            saw_session_signal = true;
            if canonical_session_id.is_none() {
                canonical_session_id = extract_session_id_from_session_value(&value);
            }
            if let Some(detected_cwd) = extract_cwd(&value) {
                if cwd.is_none() {
                    cwd = Some(detected_cwd.clone());
                }
                if let Some(filter) = workspace_path {
                    matches_workspace = path_matches_workspace(&detected_cwd, filter);
                    match_known = true;
                    if !matches_workspace {
                        break;
                    }
                }
            }
            let (detected_source, detected_provider) =
                extract_source_provider_from_session_value(&value);
            if source.is_none() {
                source = detected_source;
            }
            if provider.is_none() {
                provider = detected_provider;
            }
        }

        if entry_type == "turn_context" {
            if model.is_none() {
                model = extract_model_from_turn_context(&value);
            }
            continue;
        }

        if !matches_workspace {
            if match_known {
                break;
            }
            continue;
        }

        if workspace_path.is_some() && !match_known {
            continue;
        }

        if summary.is_none() && entry_type == "event_msg" {
            if let Some(payload) = value.get("payload").and_then(|payload| payload.as_object()) {
                let payload_type = payload
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if matches!(payload_type, "user_message" | "userMessage") {
                    saw_session_signal = true;
                    if let Some(message) = payload.get("message").and_then(|value| value.as_str()) {
                        summary = truncate_summary(message);
                    }
                }
            }
        }

        if !(entry_type == "event_msg" || entry_type.is_empty()) {
            continue;
        }
        let payload = value.get("payload").and_then(|value| value.as_object());
        let payload_type = payload
            .and_then(|payload| payload.get("type"))
            .and_then(|value| value.as_str());
        if payload_type != Some("token_count") {
            continue;
        }
        saw_session_signal = true;

        let info = payload
            .and_then(|payload| payload.get("info"))
            .and_then(|value| value.as_object());
        let (input, cached, output, used_total) = if let Some(info) = info {
            if let Some(total) = find_usage_map(info, &["total_token_usage", "totalTokenUsage"]) {
                (
                    read_i64(total, &["input_tokens", "inputTokens"]),
                    read_i64(
                        total,
                        &[
                            "cached_input_tokens",
                            "cache_read_input_tokens",
                            "cachedInputTokens",
                            "cacheReadInputTokens",
                        ],
                    ),
                    read_i64(total, &["output_tokens", "outputTokens"]),
                    true,
                )
            } else if let Some(last) = find_usage_map(info, &["last_token_usage", "lastTokenUsage"])
            {
                (
                    read_i64(last, &["input_tokens", "inputTokens"]),
                    read_i64(
                        last,
                        &[
                            "cached_input_tokens",
                            "cache_read_input_tokens",
                            "cachedInputTokens",
                            "cacheReadInputTokens",
                        ],
                    ),
                    read_i64(last, &["output_tokens", "outputTokens"]),
                    false,
                )
            } else {
                continue;
            }
        } else {
            continue;
        };

        let mut delta = UsageTotals {
            input,
            cached,
            output,
        };
        if used_total {
            let prev = previous_totals.unwrap_or_default();
            delta = UsageTotals {
                input: (input - prev.input).max(0),
                cached: (cached - prev.cached).max(0),
                output: (output - prev.output).max(0),
            };
            previous_totals = Some(UsageTotals {
                input,
                cached,
                output,
            });
        } else {
            let mut next = previous_totals.unwrap_or_default();
            next.input += delta.input;
            next.cached += delta.cached;
            next.output += delta.output;
            previous_totals = Some(next);
        }

        if delta.input == 0 && delta.cached == 0 && delta.output == 0 {
            continue;
        }

        usage.input_tokens += delta.input.max(0);
        usage.output_tokens += delta.output.max(0);
        usage.cache_read_tokens += delta.cached.max(0);
        if model.is_none() {
            model = extract_model_from_token_count(&value);
        }
    }

    if workspace_path.is_some() && !matches_workspace {
        return Ok(None);
    }

    usage.total_tokens = usage.input_tokens
        + usage.output_tokens
        + usage.cache_write_tokens
        + usage.cache_read_tokens;
    if modified_lines == 0 && max_diff_stat_lines > 0 {
        modified_lines = max_diff_stat_lines;
    }

    if !saw_session_signal {
        return Ok(None);
    }

    if summary.is_none()
        && response_item_user_summary.is_none()
        && usage.total_tokens == 0
        && modified_lines == 0
        && canonical_session_id.is_none()
        && source.is_none()
        && provider.is_none()
    {
        return Ok(None);
    }

    let file_stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let session_id = canonical_session_id.unwrap_or_else(|| file_stem.clone());
    let mut session_id_aliases = Vec::new();
    if !file_stem.is_empty() && file_stem != session_id {
        session_id_aliases.push(file_stem);
    }
    let model = model.unwrap_or_else(|| "gpt-5.1".to_string());
    let cost = calculate_usage_cost(&usage, codex_cost_rates());
    let timestamp = if latest_timestamp > 0 {
        latest_timestamp
    } else {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    };

    let summary = summary.or(response_item_user_summary);
    let provider_profile_id = infer_managed_codex_provider_profile_id_from_session_path(path);
    let provider_profile_source = provider_profile_id
        .as_ref()
        .map(|_| CODEX_PROVIDER_PROFILE_SOURCE_MANAGED.to_string());
    let provider_availability = provider_profile_id
        .as_ref()
        .map(|_| CODEX_PROVIDER_PROFILE_AVAILABILITY_UNKNOWN.to_string());
    let physical_path = Some(path.to_string_lossy().to_string());

    Ok(Some(LocalUsageSessionSummary {
        session_id,
        session_id_aliases,
        timestamp,
        cwd,
        model,
        usage,
        cost,
        summary,
        source,
        provider,
        provider_profile_id,
        provider_profile_source,
        provider_profile_name: None,
        provider_availability,
        physical_path,
        file_size_bytes: fs::metadata(path).ok().map(|metadata| metadata.len()),
        modified_lines,
    }))
}

fn infer_managed_codex_provider_profile_id_from_session_path(path: &Path) -> Option<String> {
    for ancestor in path.ancestors() {
        let segment = ancestor.file_name().and_then(|value| value.to_str())?;
        if segment != "sessions" && segment != "archived_sessions" {
            continue;
        }
        let provider_home = ancestor.parent()?;
        let provider_homes_root = provider_home.parent()?;
        if provider_homes_root
            .file_name()
            .and_then(|value| value.to_str())
            != Some("codex-provider-homes")
        {
            continue;
        }
        let provider_id = provider_home
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        return Some(provider_id.to_string());
    }
    None
}

fn count_apply_patch_changed_lines(input: &str) -> i64 {
    let mut changed_lines = 0_i64;
    for raw_line in input.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.starts_with('+') {
            if is_unified_diff_file_header(line, "+++") {
                continue;
            }
            changed_lines += 1;
            continue;
        }
        if line.starts_with('-') {
            if is_unified_diff_file_header(line, "---") {
                continue;
            }
            changed_lines += 1;
        }
    }
    changed_lines
}

fn is_unified_diff_file_header(line: &str, marker: &str) -> bool {
    if !line.starts_with(marker) {
        return false;
    }
    line.as_bytes()
        .get(marker.len())
        .map(|next| *next == b' ' || *next == b'\t')
        .unwrap_or(false)
}

fn is_successful_apply_patch_output(raw_output: &str) -> bool {
    fn read_exit_code(value: &Value) -> Option<i64> {
        value
            .as_i64()
            .or_else(|| value.as_f64().map(|value| value as i64))
            .or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<i64>().ok())
            })
    }

    let trimmed = raw_output.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.contains("verification failed") {
        return false;
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        let exit_code = parsed
            .get("metadata")
            .and_then(|value| value.get("exit_code").or_else(|| value.get("exitCode")))
            .and_then(read_exit_code)
            .or_else(|| parsed.get("exitCode").and_then(read_exit_code))
            .unwrap_or(-1);
        if exit_code == 0 {
            return true;
        }
        if let Some(output_value) = parsed.get("output") {
            let output_text = extract_tool_output_text(output_value);
            if contains_apply_patch_success_marker(&output_text) {
                return true;
            }
        }
        return false;
    }

    contains_apply_patch_success_marker(trimmed)
}

fn parse_changed_lines_from_git_diff_stat_output(output: &str) -> Option<i64> {
    let mut changed_lines_from_summary = None;
    let mut changed_lines_from_stats = 0_i64;
    let mut saw_stat_line = false;

    for line in output.lines() {
        let normalized = line.trim();
        if normalized.is_empty() {
            continue;
        }

        let normalized_lower = normalized.to_ascii_lowercase();
        if normalized_lower.contains("file changed") || normalized_lower.contains("files changed") {
            let insertions = read_number_before_keyword(normalized, "insertion").unwrap_or(0);
            let deletions = read_number_before_keyword(normalized, "deletion").unwrap_or(0);
            changed_lines_from_summary = Some(insertions + deletions);
        }

        if let Some(changed) = parse_diff_stat_line_changed_count(normalized) {
            saw_stat_line = true;
            changed_lines_from_stats += changed.max(0);
        }
    }

    changed_lines_from_summary.or_else(|| {
        if saw_stat_line {
            Some(changed_lines_from_stats)
        } else {
            None
        }
    })
}

fn parse_diff_stat_line_changed_count(line: &str) -> Option<i64> {
    let (path_segment, stats_segment) = line.split_once('|')?;
    if path_segment.trim().is_empty() {
        return None;
    }

    let numeric_prefix: String = stats_segment
        .trim_start()
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    if numeric_prefix.is_empty() {
        return None;
    }

    numeric_prefix.parse::<i64>().ok()
}

fn read_number_before_keyword(line: &str, keyword: &str) -> Option<i64> {
    let lower = line.to_ascii_lowercase();
    let keyword_index = lower.find(keyword)?;
    let prefix = &line[..keyword_index];
    prefix
        .split(|ch: char| !ch.is_ascii_digit())
        .filter(|segment| !segment.is_empty())
        .last()
        .and_then(|segment| segment.parse::<i64>().ok())
}

fn contains_apply_patch_success_marker(output: &str) -> bool {
    let lowered = output.to_ascii_lowercase();
    lowered.contains("success. updated the following files:")
        || lowered.contains("process exited with code 0")
        || lowered.contains("exit code: 0")
}

fn stringify_tool_output_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn extract_tool_output_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            let joined = items
                .iter()
                .map(extract_tool_output_text)
                .filter(|item| !item.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if joined.is_empty() {
                serde_json::to_string(value).unwrap_or_default()
            } else {
                joined
            }
        }
        Value::Object(map) => {
            for key in ["output", "stdout", "stderr", "text", "message", "result"] {
                if let Some(next) = map.get(key) {
                    let nested = extract_tool_output_text(next);
                    if !nested.trim().is_empty() {
                        return nested;
                    }
                }
            }
            serde_json::to_string(value).unwrap_or_default()
        }
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn normalize_non_empty_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn extract_session_id_from_session_value(value: &Value) -> Option<String> {
    let root = value.as_object()?;
    let payload = root.get("payload").and_then(Value::as_object);
    let session_meta = payload
        .and_then(|payload| payload.get("session_meta"))
        .and_then(Value::as_object)
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("sessionMeta"))
                .and_then(Value::as_object)
        });

    normalize_non_empty_string(
        root.get("session_id")
            .or_else(|| root.get("sessionId"))
            .or_else(|| root.get("id"))
            .and_then(Value::as_str),
    )
    .or_else(|| {
        payload.and_then(|item| read_string_from_object(item, &["id", "session_id", "sessionId"]))
    })
    .or_else(|| {
        session_meta
            .and_then(|item| read_string_from_object(item, &["id", "session_id", "sessionId"]))
    })
}

fn read_string_from_object(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
        if let Some(found) = normalize_non_empty_string(object.get(*key).and_then(Value::as_str)) {
            return Some(found);
        }
    }
    None
}

fn normalize_originator_source(value: Option<String>) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower == "ccgui" || lower == "codemoss" || lower == "mossx" {
        return Some("ccgui".to_string());
    }
    if lower == "codex_cli_rs" {
        return Some("cli".to_string());
    }
    if lower.contains("codex desktop") {
        return Some("desktop".to_string());
    }
    Some(trimmed.to_string())
}

fn extract_source_provider_from_session_value(value: &Value) -> (Option<String>, Option<String>) {
    let Some(root) = value.as_object() else {
        return (None, None);
    };
    let payload = root.get("payload").and_then(Value::as_object);
    let session_meta = payload
        .and_then(|payload| payload.get("session_meta"))
        .and_then(Value::as_object)
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("sessionMeta"))
                .and_then(Value::as_object)
        });
    let originator = normalize_originator_source(
        read_string_from_object(root, &["originator", "origin", "client", "app"])
            .or_else(|| {
                payload.and_then(|item| read_string_from_object(item, &["originator", "origin"]))
            })
            .or_else(|| {
                session_meta
                    .and_then(|item| read_string_from_object(item, &["originator", "origin"]))
            }),
    );

    let source = read_string_from_object(root, &["source", "sessionSource"])
        .or_else(|| {
            payload.and_then(|item| read_string_from_object(item, &["source", "sessionSource"]))
        })
        .or_else(|| {
            session_meta
                .and_then(|item| read_string_from_object(item, &["source", "sessionSource"]))
        });
    let source = match (source, originator) {
        (Some(source), Some(originator))
            if source.eq_ignore_ascii_case("vscode")
                && !originator.eq_ignore_ascii_case("vscode") =>
        {
            Some(originator)
        }
        (None, Some(originator)) => Some(originator),
        (source, _) => source,
    };

    let provider = read_string_from_object(
        root,
        &["provider", "providerId", "model_provider", "modelProvider"],
    )
    .or_else(|| {
        payload.and_then(|item| {
            read_string_from_object(
                item,
                &["provider", "providerId", "model_provider", "modelProvider"],
            )
        })
    })
    .or_else(|| {
        session_meta.and_then(|item| {
            read_string_from_object(
                item,
                &["provider", "providerId", "model_provider", "modelProvider"],
            )
        })
    });

    (source, provider)
}

fn truncate_summary(text: &str) -> Option<String> {
    let cleaned = text.replace('\n', " ").trim().to_string();
    if cleaned.is_empty() {
        return None;
    }
    let limit = 45;
    let truncated = if cleaned.chars().count() > limit {
        format!("{}...", cleaned.chars().take(limit).collect::<String>())
    } else {
        cleaned
    };
    Some(truncated)
}

fn extract_codex_message_text(payload: &serde_json::Map<String, Value>) -> Option<String> {
    if let Some(text) = payload.get("content").and_then(Value::as_str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(content) = payload.get("content").and_then(Value::as_array) {
        for item in content {
            let Some(record) = item.as_object() else {
                continue;
            };
            for key in ["text", "value", "content"] {
                if let Some(text) = record.get(key).and_then(Value::as_str) {
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    parts.push(trimmed.to_string());
                    break;
                }
            }
        }
    }
    if !parts.is_empty() {
        return Some(parts.join("\n\n"));
    }
    for key in ["text", "message"] {
        if let Some(text) = payload.get(key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            return Some(trimmed.to_string());
        }
    }
    None
}

fn scan_claude_session_summaries(
    workspace_path: Option<&Path>,
) -> Result<Vec<LocalUsageSessionSummary>, String> {
    let projects_dir = match claude_projects_dir() {
        Some(dir) if dir.exists() => dir,
        _ => return Ok(Vec::new()),
    };
    let mut sessions = Vec::new();

    if let Some(workspace_path) = workspace_path {
        let encoded = encode_claude_project_path(&workspace_path.to_string_lossy());
        let project_dir = projects_dir.join(encoded);
        if project_dir.exists() {
            scan_claude_project_summaries(&project_dir, &mut sessions)?;
        }
        sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        return Ok(sessions);
    }

    let entries = match fs::read_dir(&projects_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_claude_project_summaries(&path, &mut sessions)?;
        }
    }
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
}

fn scan_claude_project_summaries(
    project_dir: &Path,
    sessions: &mut Vec<LocalUsageSessionSummary>,
) -> Result<(), String> {
    let entries = match fs::read_dir(project_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.ends_with(".jsonl") || name.starts_with("agent-") {
            continue;
        }
        if let Some(summary) = parse_claude_session_summary(&path)? {
            sessions.push(summary);
        }
    }
    Ok(())
}

fn parse_claude_session_summary(path: &Path) -> Result<Option<LocalUsageSessionSummary>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };
    let reader = BufReader::new(file);
    let mut usage = LocalUsageUsageData::default();
    let mut total_cost = 0.0;
    let mut model = "unknown".to_string();
    let mut first_timestamp = 0_i64;
    let mut summary: Option<String> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.len() > 512_000 {
            continue;
        }

        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if first_timestamp == 0 {
            first_timestamp = read_claude_timestamp(&value).unwrap_or(0);
        }

        let entry_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if summary.is_none() && entry_type == "summary" {
            if let Some(text) = value.get("summary").and_then(|v| v.as_str()) {
                summary = truncate_summary(text);
            }
        }
        if entry_type != "assistant" {
            continue;
        }

        let Some(message) = value.get("message").and_then(|v| v.as_object()) else {
            continue;
        };
        let message_model = message.get("model").and_then(|v| v.as_str());
        if model == "unknown" {
            if let Some(message_model) = message_model {
                model = message_model.to_string();
            }
        }

        let Some(usage_map) = message.get("usage").and_then(|v| v.as_object()) else {
            continue;
        };
        let input_tokens = read_i64(usage_map, &["input_tokens"]);
        let output_tokens = read_i64(usage_map, &["output_tokens"]);
        let cache_write_tokens = read_i64(usage_map, &["cache_creation_input_tokens"]);
        let cache_read_tokens = read_i64(usage_map, &["cache_read_input_tokens"]);
        if input_tokens == 0
            && output_tokens == 0
            && cache_write_tokens == 0
            && cache_read_tokens == 0
        {
            continue;
        }

        let message_usage = LocalUsageUsageData {
            input_tokens,
            output_tokens,
            cache_write_tokens,
            cache_read_tokens,
            total_tokens: input_tokens + output_tokens + cache_write_tokens + cache_read_tokens,
        };
        add_usage(&mut usage, &message_usage);

        let pricing_model = message_model.unwrap_or(model.as_str());
        total_cost += calculate_usage_cost(&message_usage, claude_cost_rates(pricing_model));
    }

    usage.total_tokens = usage.input_tokens
        + usage.output_tokens
        + usage.cache_write_tokens
        + usage.cache_read_tokens;
    if usage.total_tokens == 0 {
        return Ok(None);
    }

    let session_id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let timestamp = if first_timestamp > 0 {
        first_timestamp
    } else {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    };

    Ok(Some(LocalUsageSessionSummary {
        session_id,
        session_id_aliases: Vec::new(),
        timestamp,
        cwd: None,
        model,
        usage,
        cost: total_cost,
        summary,
        source: Some("claude".to_string()),
        provider: Some("anthropic".to_string()),
        provider_profile_id: None,
        provider_profile_source: None,
        provider_profile_name: None,
        provider_availability: None,
        physical_path: Some(path.to_string_lossy().to_string()),
        file_size_bytes: fs::metadata(path).ok().map(|metadata| metadata.len()),
        modified_lines: 0,
    }))
}

fn scan_file(
    path: &Path,
    daily: &mut HashMap<String, DailyTotals>,
    model_totals: &mut HashMap<String, i64>,
    workspace_path: Option<&Path>,
) -> Result<(), String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            return Ok(());
        }
    };
    let reader = BufReader::new(file);
    let mut previous_totals: Option<UsageTotals> = None;
    let mut current_model: Option<String> = None;
    let mut last_activity_ms: Option<i64> = None;
    let mut seen_runs: HashSet<i64> = HashSet::new();
    let mut match_known = workspace_path.is_none();
    let mut matches_workspace = workspace_path.is_none();

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.len() > 512_000 {
            continue;
        }

        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let entry_type = value
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");

        if entry_type == "session_meta" || entry_type == "turn_context" {
            if let Some(cwd) = extract_cwd(&value) {
                if let Some(filter) = workspace_path {
                    matches_workspace = path_matches_workspace(&cwd, filter);
                    match_known = true;
                    if !matches_workspace {
                        break;
                    }
                }
            }
        }

        if entry_type == "turn_context" {
            if let Some(model) = extract_model_from_turn_context(&value) {
                current_model = Some(model);
            }
            continue;
        }

        if entry_type == "session_meta" {
            continue;
        }

        if !matches_workspace {
            if match_known {
                break;
            }
            continue;
        }

        if !match_known {
            continue;
        }

        if entry_type == "event_msg" || entry_type.is_empty() {
            let payload = value.get("payload").and_then(|value| value.as_object());
            let payload_type = payload
                .and_then(|payload| payload.get("type"))
                .and_then(|value| value.as_str());

            if payload_type == Some("agent_message") {
                if let Some(timestamp_ms) = read_timestamp_ms(&value) {
                    if seen_runs.insert(timestamp_ms) {
                        if let Some(day_key) = day_key_for_timestamp_ms(timestamp_ms) {
                            if let Some(entry) = daily.get_mut(&day_key) {
                                entry.agent_runs += 1;
                            }
                        }
                    }
                    track_activity(daily, &mut last_activity_ms, timestamp_ms);
                }
                continue;
            }

            if payload_type == Some("agent_reasoning") {
                if let Some(timestamp_ms) = read_timestamp_ms(&value) {
                    track_activity(daily, &mut last_activity_ms, timestamp_ms);
                }
                continue;
            }

            if payload_type != Some("token_count") {
                continue;
            }

            let info = payload
                .and_then(|payload| payload.get("info"))
                .and_then(|v| v.as_object());
            let (input, cached, output, used_total) = if let Some(info) = info {
                if let Some(total) = find_usage_map(info, &["total_token_usage", "totalTokenUsage"])
                {
                    (
                        read_i64(total, &["input_tokens", "inputTokens"]),
                        read_i64(
                            total,
                            &[
                                "cached_input_tokens",
                                "cache_read_input_tokens",
                                "cachedInputTokens",
                                "cacheReadInputTokens",
                            ],
                        ),
                        read_i64(total, &["output_tokens", "outputTokens"]),
                        true,
                    )
                } else if let Some(last) =
                    find_usage_map(info, &["last_token_usage", "lastTokenUsage"])
                {
                    (
                        read_i64(last, &["input_tokens", "inputTokens"]),
                        read_i64(
                            last,
                            &[
                                "cached_input_tokens",
                                "cache_read_input_tokens",
                                "cachedInputTokens",
                                "cacheReadInputTokens",
                            ],
                        ),
                        read_i64(last, &["output_tokens", "outputTokens"]),
                        false,
                    )
                } else {
                    continue;
                }
            } else {
                continue;
            };

            let mut delta = UsageTotals {
                input,
                cached,
                output,
            };

            if used_total {
                let prev = previous_totals.unwrap_or_default();
                delta = UsageTotals {
                    input: (input - prev.input).max(0),
                    cached: (cached - prev.cached).max(0),
                    output: (output - prev.output).max(0),
                };
                previous_totals = Some(UsageTotals {
                    input,
                    cached,
                    output,
                });
            } else {
                // Some streams emit `last_token_usage` deltas between `total_token_usage` snapshots.
                // Treat those as already-counted to avoid double-counting when the next total arrives.
                let mut next = previous_totals.unwrap_or_default();
                next.input += delta.input;
                next.cached += delta.cached;
                next.output += delta.output;
                previous_totals = Some(next);
            }

            if delta.input == 0 && delta.cached == 0 && delta.output == 0 {
                continue;
            }

            let timestamp_ms = read_timestamp_ms(&value);
            if let Some(day_key) = timestamp_ms.and_then(|ms| day_key_for_timestamp_ms(ms)) {
                if let Some(entry) = daily.get_mut(&day_key) {
                    let cached = delta.cached.min(delta.input);
                    entry.input += delta.input;
                    entry.cached += cached;
                    entry.output += delta.output;

                    let model = current_model
                        .clone()
                        .or_else(|| extract_model_from_token_count(&value))
                        .unwrap_or_else(|| "unknown".to_string());
                    *model_totals.entry(model).or_insert(0) += delta.input + delta.output;
                }
            }

            if let Some(timestamp_ms) = timestamp_ms {
                track_activity(daily, &mut last_activity_ms, timestamp_ms);
            }
            continue;
        }

        if entry_type == "response_item" {
            let payload = value.get("payload").and_then(|value| value.as_object());
            let payload_type = payload
                .and_then(|payload| payload.get("type"))
                .and_then(|value| value.as_str());
            let role = payload
                .and_then(|payload| payload.get("role"))
                .and_then(|value| value.as_str())
                .unwrap_or("");

            if role == "assistant" {
                if let Some(timestamp_ms) = read_timestamp_ms(&value) {
                    if seen_runs.insert(timestamp_ms) {
                        if let Some(day_key) = day_key_for_timestamp_ms(timestamp_ms) {
                            if let Some(entry) = daily.get_mut(&day_key) {
                                entry.agent_runs += 1;
                            }
                        }
                    }
                    track_activity(daily, &mut last_activity_ms, timestamp_ms);
                }
            } else if payload_type != Some("message") {
                if let Some(timestamp_ms) = read_timestamp_ms(&value) {
                    track_activity(daily, &mut last_activity_ms, timestamp_ms);
                }
            }
        }
    }

    Ok(())
}

fn extract_model_from_turn_context(value: &Value) -> Option<String> {
    let payload = value.get("payload").and_then(|value| value.as_object())?;
    if let Some(model) = payload.get("model").and_then(|value| value.as_str()) {
        return Some(model.to_string());
    }
    let info = payload.get("info").and_then(|value| value.as_object())?;
    info.get("model")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

fn extract_model_from_token_count(value: &Value) -> Option<String> {
    let payload = value.get("payload").and_then(|value| value.as_object())?;
    let info = payload.get("info").and_then(|value| value.as_object());
    let model = info
        .and_then(|info| {
            info.get("model")
                .or_else(|| info.get("model_name"))
                .and_then(|value| value.as_str())
        })
        .or_else(|| payload.get("model").and_then(|value| value.as_str()))
        .or_else(|| value.get("model").and_then(|value| value.as_str()));
    model.map(|value| value.to_string())
}

fn find_usage_map<'a>(
    info: &'a serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<&'a serde_json::Map<String, Value>> {
    keys.iter()
        .find_map(|key| info.get(*key).and_then(|value| value.as_object()))
}

fn read_i64(map: &serde_json::Map<String, Value>, keys: &[&str]) -> i64 {
    keys.iter()
        .find_map(|key| map.get(*key))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|value| value as i64))
                .or_else(|| {
                    value
                        .as_str()
                        .and_then(|text| text.trim().parse::<i64>().ok())
                })
        })
        .unwrap_or(0)
}

fn read_timestamp_ms(value: &Value) -> Option<i64> {
    let raw = value.get("timestamp")?;
    if let Some(text) = raw.as_str() {
        return DateTime::parse_from_rfc3339(text)
            .map(|value| value.timestamp_millis())
            .ok();
    }
    let numeric = raw
        .as_i64()
        .or_else(|| raw.as_f64().map(|value| value as i64))?;
    if numeric > 0 && numeric < 1_000_000_000_000 {
        return Some(numeric * 1000);
    }
    Some(numeric)
}

fn track_activity(
    daily: &mut HashMap<String, DailyTotals>,
    last_activity_ms: &mut Option<i64>,
    timestamp_ms: i64,
) {
    if let Some(prev_ms) = *last_activity_ms {
        let delta = timestamp_ms - prev_ms;
        if delta > 0 && delta <= MAX_ACTIVITY_GAP_MS {
            if let Some(day_key) = day_key_for_timestamp_ms(timestamp_ms) {
                if let Some(entry) = daily.get_mut(&day_key) {
                    entry.agent_ms += delta;
                }
            }
        }
    }
    *last_activity_ms = Some(timestamp_ms);
}

fn day_key_for_timestamp_ms(timestamp_ms: i64) -> Option<String> {
    let utc = Utc.timestamp_millis_opt(timestamp_ms).single()?;
    Some(utc.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

fn extract_cwd(value: &Value) -> Option<String> {
    let root = value.as_object()?;
    let payload = root.get("payload").and_then(Value::as_object);
    let session_meta = root
        .get("session_meta")
        .and_then(Value::as_object)
        .or_else(|| root.get("sessionMeta").and_then(Value::as_object))
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("context"))
                .and_then(Value::as_object)
        })
        .and_then(|context| {
            context
                .get("session_meta")
                .and_then(Value::as_object)
                .or_else(|| context.get("sessionMeta").and_then(Value::as_object))
                .or_else(|| Some(context))
        })
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("turnContext"))
                .and_then(Value::as_object)
        })
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("turn_context"))
                .and_then(Value::as_object)
        })
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("session_meta"))
                .and_then(Value::as_object)
        })
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("sessionMeta"))
                .and_then(Value::as_object)
        });

    read_string_from_object(root, &["cwd"])
        .or_else(|| payload.and_then(|item| read_string_from_object(item, &["cwd"])))
        .or_else(|| {
            payload
                .and_then(|item| item.get("context"))
                .and_then(Value::as_object)
                .and_then(|item| read_string_from_object(item, &["cwd"]))
        })
        .or_else(|| {
            payload
                .and_then(|item| item.get("turnContext"))
                .and_then(Value::as_object)
                .and_then(|item| read_string_from_object(item, &["cwd"]))
        })
        .or_else(|| {
            payload
                .and_then(|item| item.get("turn_context"))
                .and_then(Value::as_object)
                .and_then(|item| read_string_from_object(item, &["cwd"]))
        })
        .or_else(|| session_meta.and_then(|item| read_string_from_object(item, &["cwd"])))
}

#[cfg(windows)]
fn normalize_workspace_match_path(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    if let Some(stripped) = normalized.strip_prefix("//?/UNC/") {
        normalized = format!("//{stripped}");
    } else if let Some(stripped) = normalized.strip_prefix("//?/") {
        normalized = stripped.to_string();
    }
    normalized.trim_end_matches('/').to_ascii_lowercase()
}

#[cfg(not(windows))]
fn normalize_posix_workspace_match_path(value: &str) -> String {
    let normalized = value.trim().replace('\\', "/");
    if normalized == "/" {
        "/".to_string()
    } else {
        normalized.trim_end_matches('/').to_string()
    }
}

#[cfg(not(windows))]
fn build_posix_workspace_match_variants(value: &str) -> Vec<String> {
    let normalized = normalize_posix_workspace_match_path(value);
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut variants = vec![normalized.clone()];
    if let Some(stripped) = normalized.strip_prefix("/private/") {
        variants.push(format!("/{}", stripped));
    } else if normalized.starts_with('/') && normalized != "/private" {
        variants.push(format!("/private{}", normalized));
    }
    variants.sort();
    variants.dedup();
    variants
}

#[cfg(not(windows))]
fn posix_path_is_same_or_child(candidate: &str, base: &str) -> bool {
    if candidate.is_empty() || base.is_empty() {
        return false;
    }
    if candidate == base {
        return true;
    }
    if base == "/" {
        return candidate.starts_with('/');
    }
    candidate
        .strip_prefix(base)
        .map(|rest| rest.starts_with('/'))
        .unwrap_or(false)
}

pub(crate) fn path_matches_workspace(cwd: &str, workspace_path: &Path) -> bool {
    #[cfg(windows)]
    {
        let cwd_path = normalize_workspace_match_path(cwd);
        let workspace = normalize_workspace_match_path(&workspace_path.to_string_lossy());
        if cwd_path.is_empty() || workspace.is_empty() {
            return false;
        }
        if cwd_path == workspace {
            return true;
        }
        return cwd_path
            .strip_prefix(&workspace)
            .map(|rest| rest.starts_with('/'))
            .unwrap_or(false);
    }

    #[cfg(not(windows))]
    {
        let workspace_raw = workspace_path.to_string_lossy();
        let workspace_variants = build_posix_workspace_match_variants(&workspace_raw);
        if workspace_variants.is_empty() {
            return false;
        }
        let cwd_variants = build_posix_workspace_match_variants(cwd);
        if cwd_variants.is_empty() {
            return false;
        }

        for cwd_variant in cwd_variants {
            for workspace_variant in &workspace_variants {
                if posix_path_is_same_or_child(&cwd_variant, workspace_variant) {
                    return true;
                }
            }
        }
        false
    }
}

fn make_day_keys(days: u32) -> Vec<String> {
    let today = Local::now().date_naive();
    (0..days)
        .rev()
        .map(|offset| {
            let day = today - Duration::days(offset as i64);
            day.format("%Y-%m-%d").to_string()
        })
        .collect()
}

fn resolve_codex_sessions_roots(codex_home_override: Option<PathBuf>) -> Vec<PathBuf> {
    let Some(home) = codex_home_override.or_else(resolve_default_codex_home) else {
        return Vec::new();
    };
    vec![home.join("sessions"), home.join("archived_sessions")]
}

fn resolve_managed_codex_provider_session_roots() -> (Vec<PathBuf>, Vec<String>) {
    match app_paths::codex_provider_homes_dir() {
        Ok(provider_homes_root) => {
            resolve_managed_codex_provider_session_roots_from_root(&provider_homes_root)
        }
        Err(error) => (
            Vec::new(),
            vec![format!("codex-provider-homes-unavailable: {error}")],
        ),
    }
}

fn resolve_managed_codex_provider_session_roots_from_root(
    provider_homes_root: &Path,
) -> (Vec<PathBuf>, Vec<String>) {
    let entries = match fs::read_dir(provider_homes_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (Vec::new(), Vec::new());
        }
        Err(error) => {
            return (
                Vec::new(),
                vec![format!(
                    "codex-provider-homes-unreadable:{}:{error}",
                    provider_homes_root.display()
                )],
            );
        }
    };

    let mut provider_dirs = Vec::new();
    let mut diagnostics = Vec::new();
    for entry_result in entries {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(error) => {
                diagnostics.push(format!(
                    "codex-provider-home-entry-unreadable:{}:{error}",
                    provider_homes_root.display()
                ));
                continue;
            }
        };
        let path = entry.path();
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => provider_dirs.push(path),
            Ok(_) => {}
            Err(error) => diagnostics.push(format!(
                "codex-provider-home-type-unreadable:{}:{error}",
                path.display()
            )),
        }
    }
    provider_dirs.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));

    let roots = provider_dirs
        .into_iter()
        .flat_map(|provider_home| {
            [
                provider_home.join("sessions"),
                provider_home.join("archived_sessions"),
            ]
        })
        .collect();
    (roots, diagnostics)
}

fn normalized_sessions_root_key(root: &Path) -> String {
    #[cfg(windows)]
    {
        normalize_workspace_match_path(&root.to_string_lossy())
    }

    #[cfg(not(windows))]
    {
        normalize_posix_workspace_match_path(&root.to_string_lossy())
    }
}

#[cfg(test)]
fn merge_codex_session_roots(
    override_home: Option<PathBuf>,
    default_home: Option<PathBuf>,
) -> Vec<PathBuf> {
    merge_codex_session_roots_with_provider_homes(override_home, default_home).roots
}

fn push_unique_session_roots(
    roots: &mut Vec<PathBuf>,
    seen_keys: &mut HashSet<String>,
    candidates: impl IntoIterator<Item = PathBuf>,
) {
    for root in candidates {
        if seen_keys.insert(normalized_sessions_root_key(&root)) {
            roots.push(root);
        }
    }
}

fn merge_codex_session_roots_with_provider_homes(
    override_home: Option<PathBuf>,
    default_home: Option<PathBuf>,
) -> CodexSessionRootResolution {
    let mut roots = Vec::new();
    let mut seen_keys = HashSet::new();
    for root in resolve_codex_sessions_roots(override_home) {
        push_unique_session_roots(&mut roots, &mut seen_keys, [root]);
    }

    push_unique_session_roots(
        &mut roots,
        &mut seen_keys,
        default_home
            .map(|home| vec![home.join("sessions"), home.join("archived_sessions")])
            .unwrap_or_default(),
    );

    let (provider_roots, provider_home_diagnostics) =
        resolve_managed_codex_provider_session_roots();
    push_unique_session_roots(&mut roots, &mut seen_keys, provider_roots);

    CodexSessionRootResolution {
        roots,
        provider_home_diagnostics,
    }
}

fn resolve_sessions_roots(
    workspaces: &HashMap<String, WorkspaceEntry>,
    workspace_path: Option<&Path>,
) -> Vec<PathBuf> {
    resolve_sessions_roots_with_diagnostics(workspaces, workspace_path).roots
}

pub(crate) fn resolve_sessions_roots_with_diagnostics(
    workspaces: &HashMap<String, WorkspaceEntry>,
    workspace_path: Option<&Path>,
) -> CodexSessionRootResolution {
    if let Some(workspace_path) = workspace_path {
        let codex_home_override =
            resolve_workspace_codex_home_for_path(workspaces, Some(workspace_path));
        return merge_codex_session_roots_with_provider_homes(
            codex_home_override,
            resolve_default_codex_home(),
        );
    }

    let mut roots = Vec::new();
    let mut seen_keys = HashSet::new();

    push_unique_session_roots(
        &mut roots,
        &mut seen_keys,
        resolve_codex_sessions_roots(None),
    );

    for entry in workspaces.values() {
        let parent_entry = entry
            .parent_id
            .as_ref()
            .and_then(|parent_id| workspaces.get(parent_id));
        let Some(codex_home) = resolve_workspace_codex_home(entry, parent_entry) else {
            continue;
        };
        push_unique_session_roots(
            &mut roots,
            &mut seen_keys,
            resolve_codex_sessions_roots(Some(codex_home)),
        );
    }

    let (provider_roots, provider_home_diagnostics) =
        resolve_managed_codex_provider_session_roots();
    push_unique_session_roots(&mut roots, &mut seen_keys, provider_roots);

    CodexSessionRootResolution {
        roots,
        provider_home_diagnostics,
    }
}

fn resolve_workspace_codex_home_for_path(
    workspaces: &HashMap<String, crate::types::WorkspaceEntry>,
    workspace_path: Option<&Path>,
) -> Option<PathBuf> {
    let workspace_path = workspace_path?;
    let entry = workspaces
        .values()
        .filter(|entry| {
            path_matches_workspace(&workspace_path.to_string_lossy(), Path::new(&entry.path))
        })
        .max_by_key(|entry| entry.path.len())?;

    let parent_entry = entry
        .parent_id
        .as_ref()
        .and_then(|parent_id| workspaces.get(parent_id));

    resolve_workspace_codex_home(entry, parent_entry)
}

fn day_dir_for_key(root: &Path, day_key: &str) -> PathBuf {
    let mut parts = day_key.split('-');
    let year = parts.next().unwrap_or("1970");
    let month = parts.next().unwrap_or("01");
    let day = parts.next().unwrap_or("01");
    root.join(year).join(month).join(day)
}

/// Get Claude Code projects directory (~/.claude/projects/)
fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join("projects"))
}

/// Scan Claude Code session files for usage statistics.
/// Claude Code stores sessions in ~/.claude/projects/{encoded-path}/{session-id}.jsonl
fn scan_claude_projects(
    day_keys: &[String],
    daily: &mut HashMap<String, DailyTotals>,
    model_totals: &mut HashMap<String, i64>,
    workspace_path: Option<&Path>,
) -> Result<(), String> {
    let projects_dir = match claude_projects_dir() {
        Some(dir) if dir.exists() => dir,
        _ => return Ok(()),
    };

    // Convert day_keys to a set for quick lookup
    let day_set: HashSet<&str> = day_keys.iter().map(|s| s.as_str()).collect();

    // If workspace_path is specified, only scan that project's directory
    if let Some(workspace_path) = workspace_path {
        let encoded = encode_claude_project_path(&workspace_path.to_string_lossy());
        let project_dir = projects_dir.join(&encoded);
        if project_dir.exists() {
            scan_claude_project_dir(&project_dir, &day_set, daily, model_totals)?;
        }
        return Ok(());
    }

    // Otherwise, scan all project directories
    let entries = match std::fs::read_dir(&projects_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_claude_project_dir(&path, &day_set, daily, model_totals)?;
        }
    }

    Ok(())
}

/// Encode a filesystem path to Claude's project directory name.
/// All non-alphanumeric characters (except hyphens) become hyphens.
fn encode_claude_project_path(path: &str) -> String {
    path.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Scan all JSONL files in a Claude project directory
fn scan_claude_project_dir(
    project_dir: &Path,
    day_set: &HashSet<&str>,
    daily: &mut HashMap<String, DailyTotals>,
    model_totals: &mut HashMap<String, i64>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(project_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        // Only .jsonl files, skip agent-* subagent sessions
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.ends_with(".jsonl") && !name.starts_with("agent-") {
                scan_claude_file(&path, day_set, daily, model_totals)?;
            }
        }
    }

    Ok(())
}

/// Scan a single Claude Code JSONL file for usage statistics.
/// Claude Code format has token info in message.usage and model in message.model
fn scan_claude_file(
    path: &Path,
    day_set: &HashSet<&str>,
    daily: &mut HashMap<String, DailyTotals>,
    model_totals: &mut HashMap<String, i64>,
) -> Result<(), String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(()),
    };
    let reader = BufReader::new(file);
    let mut last_activity_ms: Option<i64> = None;
    let mut seen_runs: HashSet<i64> = HashSet::new();

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.len() > 512_000 {
            continue;
        }

        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let entry_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // Only process assistant messages which contain usage info
        if entry_type != "assistant" {
            // Track user messages for activity and agent runs
            if entry_type == "user" {
                if let Some(timestamp_ms) = read_claude_timestamp(&value) {
                    if let Some(day_key) = day_key_for_timestamp_ms(timestamp_ms) {
                        if day_set.contains(day_key.as_str()) {
                            track_activity(daily, &mut last_activity_ms, timestamp_ms);
                        }
                    }
                }
            }
            continue;
        }

        // Extract message object which contains model and usage
        let message = match value.get("message").and_then(|v| v.as_object()) {
            Some(msg) => msg,
            None => continue,
        };

        // Extract model name
        let model = message
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Extract usage info
        let usage = match message.get("usage").and_then(|v| v.as_object()) {
            Some(u) => u,
            None => continue,
        };

        // Read token counts - Claude Code uses input_tokens, output_tokens, cache_read_input_tokens
        let input_tokens = usage
            .get("input_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let output_tokens = usage
            .get("output_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let cache_read = usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let cache_creation = usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        // Skip if no meaningful usage
        if input_tokens == 0 && output_tokens == 0 {
            continue;
        }

        // Get timestamp and day key
        let timestamp_ms = match read_claude_timestamp(&value) {
            Some(ts) => ts,
            None => continue,
        };

        let day_key = match day_key_for_timestamp_ms(timestamp_ms) {
            Some(key) => key,
            None => continue,
        };

        // Only process if this day is in our range
        if !day_set.contains(day_key.as_str()) {
            continue;
        }

        // Update daily totals
        if let Some(entry) = daily.get_mut(&day_key) {
            entry.input += input_tokens;
            entry.cached += cache_read + cache_creation;
            entry.output += output_tokens;

            // Count as agent run
            if seen_runs.insert(timestamp_ms) {
                entry.agent_runs += 1;
            }
        }

        // Update model totals
        if let Some(model_name) = model {
            let tokens = input_tokens + output_tokens;
            *model_totals.entry(model_name).or_insert(0) += tokens;
        }

        track_activity(daily, &mut last_activity_ms, timestamp_ms);
    }

    Ok(())
}

/// Read timestamp from Claude Code format (ISO 8601 string)
fn read_claude_timestamp(value: &Value) -> Option<i64> {
    value
        .get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(|ts| {
            DateTime::parse_from_rfc3339(ts)
                .ok()
                .map(|dt| dt.timestamp_millis())
        })
}

#[cfg(test)]
#[path = "local_usage/tests.rs"]
mod tests;
