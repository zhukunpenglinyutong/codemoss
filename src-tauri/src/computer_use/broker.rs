use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::time::Instant;
use tauri::{AppHandle, State};
use tokio::time::{timeout, Duration};

use super::{
    computer_use_authorization_continuity_path, path_looks_like_codex_cli_computer_use_cache,
    persist_last_successful_authorization_host, resolve_computer_use_bridge_status,
    ComputerUseAuthorizationContinuityKind, ComputerUseAvailabilityStatus,
    ComputerUseBlockedReason, ComputerUseBridgeStatus, COMPUTER_USE_BRIDGE_ENABLED,
};

const COMPUTER_USE_BROKER_RESULT_LIMIT: usize = 4_000;
const COMPUTER_USE_BROKER_TIMEOUT_SECS: u64 = 600;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerUseBrokerRequest {
    pub(crate) workspace_id: String,
    pub(crate) instruction: String,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseBrokerOutcome {
    Completed,
    Blocked,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseBrokerFailureKind {
    UnsupportedPlatform,
    BridgeUnavailable,
    BridgeBlocked,
    AuthorizationContinuityBlocked,
    WorkspaceMissing,
    CodexRuntimeUnavailable,
    AlreadyRunning,
    InvalidInstruction,
    PermissionRequired,
    Timeout,
    CodexError,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerUseBrokerResult {
    pub(crate) outcome: ComputerUseBrokerOutcome,
    pub(crate) failure_kind: Option<ComputerUseBrokerFailureKind>,
    pub(crate) bridge_status: ComputerUseBridgeStatus,
    pub(crate) text: Option<String>,
    pub(crate) diagnostic_message: Option<String>,
    pub(crate) duration_ms: u64,
}

#[tauri::command]
pub(crate) async fn run_computer_use_codex_broker(
    _app: AppHandle,
    state: State<'_, crate::state::AppState>,
    request: ComputerUseBrokerRequest,
) -> Result<ComputerUseBrokerResult, String> {
    let started_at = Instant::now();
    let instruction = request.instruction.trim().to_string();
    let activation_verification = state
        .computer_use_activation_verification
        .lock()
        .await
        .clone();
    let backend_mode = state.app_settings.lock().await.backend_mode.clone();
    let continuity_store_path = computer_use_authorization_continuity_path(&state.settings_path);
    let bridge_status = tokio::task::spawn_blocking(move || {
        resolve_computer_use_bridge_status(
            activation_verification.as_ref(),
            backend_mode,
            continuity_store_path,
        )
    })
    .await
    .map_err(|error| format!("failed to join computer use broker preflight task: {error}"))?;

    if let Some(failure_kind) = evaluate_broker_gate(&bridge_status, &instruction) {
        return Ok(build_broker_result(
            broker_outcome_for_failure(failure_kind),
            Some(failure_kind),
            bridge_status,
            None,
            Some(broker_failure_message(failure_kind).to_string()),
            started_at.elapsed().as_millis() as u64,
        ));
    }

    let workspace_context =
        match resolve_broker_workspace_context(&state, &request.workspace_id).await {
            Some(context) => context,
            None => {
                return Ok(build_broker_result(
                    ComputerUseBrokerOutcome::Failed,
                    Some(ComputerUseBrokerFailureKind::WorkspaceMissing),
                    bridge_status,
                    None,
                    Some("Computer Use broker workspace was not found.".to_string()),
                    started_at.elapsed().as_millis() as u64,
                ));
            }
        };

    if !Path::new(&workspace_context.path).is_dir() {
        return Ok(build_broker_result(
            ComputerUseBrokerOutcome::Failed,
            Some(ComputerUseBrokerFailureKind::WorkspaceMissing),
            bridge_status,
            None,
            Some("Computer Use broker workspace path is missing or not a directory.".to_string()),
            started_at.elapsed().as_millis() as u64,
        ));
    }

    let _broker_guard = match state.computer_use_activation_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return Ok(build_broker_result(
                ComputerUseBrokerOutcome::Failed,
                Some(ComputerUseBrokerFailureKind::AlreadyRunning),
                bridge_status,
                None,
                Some(
                    "Another Computer Use investigation or broker run is already running."
                        .to_string(),
                ),
                started_at.elapsed().as_millis() as u64,
            ));
        }
    };

    let broker_prompt = build_codex_broker_prompt(&instruction);
    let broker_result = run_codex_exec_computer_use_broker(
        workspace_context,
        &broker_prompt,
        request.model,
        request.effort,
    )
    .await;

    match broker_result {
        Ok(text) => {
            let updated_bridge_status = if let Some(current_host) =
                bridge_status.authorization_continuity.current_host.clone()
            {
                let persist_path = computer_use_authorization_continuity_path(&state.settings_path);
                let refresh_path = computer_use_authorization_continuity_path(&state.settings_path);
                let refreshed_activation_verification = state
                    .computer_use_activation_verification
                    .lock()
                    .await
                    .clone();
                let refreshed_backend_mode = state.app_settings.lock().await.backend_mode.clone();
                tokio::task::spawn_blocking(move || {
                    persist_last_successful_authorization_host(&persist_path, &current_host)
                })
                .await
                .map_err(|error| {
                    format!(
                        "failed to join computer use authorization continuity persist task: {error}"
                    )
                })??;

                tokio::task::spawn_blocking(move || {
                    resolve_computer_use_bridge_status(
                        refreshed_activation_verification.as_ref(),
                        refreshed_backend_mode,
                        refresh_path,
                    )
                })
                .await
                .map_err(|error| {
                    format!(
                        "failed to join computer use authorization continuity refresh task: {error}"
                    )
                })?
            } else {
                bridge_status
            };

            Ok(build_broker_result(
                ComputerUseBrokerOutcome::Completed,
                None,
                updated_bridge_status,
                bounded_broker_text(text),
                Some("Computer Use task completed through the official Codex runtime.".to_string()),
                started_at.elapsed().as_millis() as u64,
            ))
        }
        Err(error) => {
            let failure_kind =
                classify_broker_codex_error(&error, &bridge_status.authorization_continuity.kind);
            Ok(build_broker_result(
                broker_outcome_for_failure(failure_kind),
                Some(failure_kind),
                bridge_status,
                None,
                Some(error),
                started_at.elapsed().as_millis() as u64,
            ))
        }
    }
}

fn evaluate_broker_gate(
    status: &ComputerUseBridgeStatus,
    instruction: &str,
) -> Option<ComputerUseBrokerFailureKind> {
    if instruction.trim().is_empty() {
        return Some(ComputerUseBrokerFailureKind::InvalidInstruction);
    }

    if !COMPUTER_USE_BRIDGE_ENABLED {
        return Some(ComputerUseBrokerFailureKind::BridgeUnavailable);
    }

    if status.platform != "macos" || status.status == ComputerUseAvailabilityStatus::Unsupported {
        return Some(ComputerUseBrokerFailureKind::UnsupportedPlatform);
    }

    if status.status == ComputerUseAvailabilityStatus::Unavailable
        || !status.plugin_detected
        || !status.plugin_enabled
        || status.helper_path.is_none()
        || status.helper_descriptor_path.is_none()
    {
        return Some(ComputerUseBrokerFailureKind::BridgeUnavailable);
    }

    let uses_cli_cache_contract = status
        .helper_path
        .as_deref()
        .map(Path::new)
        .is_some_and(path_looks_like_codex_cli_computer_use_cache)
        && status
            .helper_descriptor_path
            .as_deref()
            .map(Path::new)
            .is_some_and(path_looks_like_codex_cli_computer_use_cache);
    if !uses_cli_cache_contract {
        return Some(ComputerUseBrokerFailureKind::BridgeBlocked);
    }

    if status
        .blocked_reasons
        .contains(&ComputerUseBlockedReason::HelperBridgeUnverified)
    {
        return Some(ComputerUseBrokerFailureKind::BridgeBlocked);
    }

    let has_hard_blocker = status.blocked_reasons.iter().any(|reason| {
        !matches!(
            reason,
            ComputerUseBlockedReason::PermissionRequired
                | ComputerUseBlockedReason::ApprovalRequired
        )
    });
    if has_hard_blocker {
        return Some(ComputerUseBrokerFailureKind::BridgeBlocked);
    }

    if matches!(
        status.authorization_continuity.kind,
        ComputerUseAuthorizationContinuityKind::HostDriftDetected
            | ComputerUseAuthorizationContinuityKind::UnsupportedContext
    ) {
        return Some(ComputerUseBrokerFailureKind::AuthorizationContinuityBlocked);
    }

    None
}

fn broker_outcome_for_failure(
    failure_kind: ComputerUseBrokerFailureKind,
) -> ComputerUseBrokerOutcome {
    match failure_kind {
        ComputerUseBrokerFailureKind::BridgeUnavailable
        | ComputerUseBrokerFailureKind::BridgeBlocked
        | ComputerUseBrokerFailureKind::AuthorizationContinuityBlocked
        | ComputerUseBrokerFailureKind::UnsupportedPlatform => ComputerUseBrokerOutcome::Blocked,
        _ => ComputerUseBrokerOutcome::Failed,
    }
}

fn broker_failure_message(failure_kind: ComputerUseBrokerFailureKind) -> &'static str {
    match failure_kind {
        ComputerUseBrokerFailureKind::UnsupportedPlatform => {
            "Computer Use broker is only available on macOS."
        }
        ComputerUseBrokerFailureKind::BridgeUnavailable => {
            "Computer Use broker prerequisites are unavailable."
        }
        ComputerUseBrokerFailureKind::BridgeBlocked => {
            "Computer Use broker is blocked until the CLI helper bridge is verified."
        }
        ComputerUseBrokerFailureKind::AuthorizationContinuityBlocked => {
            "Computer Use broker is blocked until the current authorization host matches a continuity-safe host."
        }
        ComputerUseBrokerFailureKind::WorkspaceMissing => {
            "Computer Use broker workspace was not found."
        }
        ComputerUseBrokerFailureKind::CodexRuntimeUnavailable => {
            "Codex runtime is unavailable for Computer Use broker."
        }
        ComputerUseBrokerFailureKind::AlreadyRunning => {
            "Another Computer Use broker run is already running."
        }
        ComputerUseBrokerFailureKind::InvalidInstruction => {
            "Computer Use broker instruction cannot be empty."
        }
        ComputerUseBrokerFailureKind::PermissionRequired => {
            "Computer Use broker needs macOS permissions or allowed-app approval."
        }
        ComputerUseBrokerFailureKind::Timeout => "Computer Use broker timed out.",
        ComputerUseBrokerFailureKind::CodexError => {
            "Codex returned an error for Computer Use broker."
        }
        ComputerUseBrokerFailureKind::Unknown => {
            "Computer Use broker ended in an unexpected state."
        }
    }
}

#[derive(Debug, Clone)]
struct ComputerUseBrokerWorkspaceContext {
    path: String,
    codex_bin: Option<String>,
    codex_args: Option<String>,
    codex_home: Option<std::path::PathBuf>,
}

async fn resolve_broker_workspace_context(
    state: &crate::state::AppState,
    workspace_id: &str,
) -> Option<ComputerUseBrokerWorkspaceContext> {
    let trimmed = workspace_id.trim();
    if trimmed.is_empty() {
        return None;
    }

    let workspaces = state.workspaces.lock().await;
    let entry = workspaces.get(trimmed)?.clone();
    let parent_entry = entry
        .parent_id
        .as_ref()
        .and_then(|parent_id| workspaces.get(parent_id))
        .cloned();
    drop(workspaces);

    let app_settings = state.app_settings.lock().await.clone();
    let codex_bin = entry
        .codex_bin
        .clone()
        .or_else(|| app_settings.codex_bin.clone());
    let codex_args = crate::codex::args::resolve_workspace_codex_args(
        &entry,
        parent_entry.as_ref(),
        Some(&app_settings),
    );
    let codex_home = crate::codex::resolve_workspace_codex_home(&entry, parent_entry.as_ref());

    Some(ComputerUseBrokerWorkspaceContext {
        path: entry.path,
        codex_bin,
        codex_args,
        codex_home,
    })
}

async fn run_codex_exec_computer_use_broker(
    context: ComputerUseBrokerWorkspaceContext,
    broker_prompt: &str,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    let launch_context =
        crate::backend::app_server_cli::resolve_codex_launch_context(context.codex_bin.as_deref());
    let mut command = crate::backend::app_server_cli::build_codex_command_from_launch_context(
        &launch_context,
        true,
    );
    crate::codex::args::apply_codex_args(&mut command, context.codex_args.as_deref())?;
    if let Some(codex_home) = context.codex_home {
        command.env("CODEX_HOME", codex_home);
    }
    command
        .arg("exec")
        .arg("--json")
        .arg("--skip-git-repo-check")
        .arg("--sandbox")
        .arg("read-only")
        .arg("-C")
        .arg(&context.path);
    if let Some(model) = normalize_optional_cli_arg(model.as_deref()) {
        command.arg("-m").arg(model);
    }
    if let Some(effort) = normalize_optional_cli_arg(effort.as_deref()) {
        command
            .arg("-c")
            .arg(format!("model_reasoning_effort=\"{effort}\""));
    }
    command.arg(broker_prompt);
    command.current_dir(&context.path);
    command.kill_on_drop(true);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let output = timeout(
        Duration::from_secs(COMPUTER_USE_BROKER_TIMEOUT_SECS),
        command.output(),
    )
    .await
    .map_err(|_| "Timeout waiting for Codex exec Computer Use broker.".to_string())?
    .map_err(|error| format!("Failed to start Codex exec Computer Use broker: {error}"))?;

    parse_codex_exec_broker_output(output)
}

fn normalize_optional_cli_arg(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .map(ToString::to_string)
}

fn parse_codex_exec_broker_output(output: std::process::Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut transcript = Vec::new();
    let mut tool_failures = Vec::new();

    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        collect_codex_exec_event_text(&value, &mut transcript, &mut tool_failures);
    }

    let text = transcript.join("\n").trim().to_string();
    if !tool_failures.is_empty() {
        let failure_text = tool_failures.join("\n");
        let summary = if text.is_empty() {
            failure_text
        } else {
            format!("{text}\n{failure_text}")
        };
        return Err(summary);
    }

    if output.status.success() {
        if text.is_empty() {
            return Err("Codex exec returned empty Computer Use broker output.".to_string());
        }
        return Ok(text);
    }

    let fallback = if !text.is_empty() {
        text
    } else if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        "Codex exec Computer Use broker exited without output.".to_string()
    };
    Err(fallback)
}

fn collect_codex_exec_event_text(
    value: &serde_json::Value,
    transcript: &mut Vec<String>,
    tool_failures: &mut Vec<String>,
) {
    let Some(item) = value.get("item") else {
        return;
    };
    match item.get("type").and_then(|kind| kind.as_str()) {
        Some("agent_message") => {
            if let Some(text) = item.get("text").and_then(|text| text.as_str()) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    transcript.push(trimmed.to_string());
                }
            }
        }
        Some("mcp_tool_call") => collect_mcp_tool_call_text(item, transcript, tool_failures),
        Some("error") => {
            if let Some(message) = item.get("message").and_then(|message| message.as_str()) {
                let trimmed = message.trim();
                if !trimmed.is_empty() {
                    transcript.push(trimmed.to_string());
                }
            }
        }
        _ => {}
    }
}

fn collect_mcp_tool_call_text(
    item: &serde_json::Value,
    transcript: &mut Vec<String>,
    tool_failures: &mut Vec<String>,
) {
    let server = item
        .get("server")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let tool = item
        .get("tool")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let status = item
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");

    if status == "in_progress" {
        return;
    }

    let detail = extract_mcp_tool_detail(item).unwrap_or_else(|| status.to_string());
    let line = format!("Computer Use tool `{server}.{tool}` {status}: {detail}");
    if status == "failed" || item.get("error").is_some_and(|error| !error.is_null()) {
        tool_failures.push(line);
    } else {
        transcript.push(line);
    }
}

fn extract_mcp_tool_detail(item: &serde_json::Value) -> Option<String> {
    if let Some(error) = item.get("error").filter(|error| !error.is_null()) {
        return Some(error.to_string());
    }

    let result = item.get("result")?;
    let content = result.get("content")?.as_array()?;
    let mut parts = Vec::new();
    for entry in content {
        if let Some(text) = entry.get("text").and_then(|text| text.as_str()) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn build_codex_broker_prompt(instruction: &str) -> String {
    format!(
        r#"You are running inside the official Codex runtime with the official Computer Use plugin available when this host is authorized.

This is an explicit user-requested Computer Use task from CodePort.

Task:
"""
{instruction}
"""

Use the official Computer Use tools only if they are needed to inspect or operate desktop apps. Do not edit repository files unless the task explicitly asks for file changes. If macOS permissions or app approvals are missing, report the exact blocker and stop. Finish with a concise summary of what you did and the observed result."#
    )
}

fn bounded_broker_text(text: String) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.len() <= COMPUTER_USE_BROKER_RESULT_LIMIT {
        return Some(trimmed.to_string());
    }

    let mut bounded = trimmed
        .chars()
        .take(COMPUTER_USE_BROKER_RESULT_LIMIT)
        .collect::<String>();
    bounded.push_str("...");
    Some(bounded)
}

fn classify_broker_codex_error(
    error: &str,
    continuity_kind: &ComputerUseAuthorizationContinuityKind,
) -> ComputerUseBrokerFailureKind {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("timeout") || normalized.contains("timed out") {
        return ComputerUseBrokerFailureKind::Timeout;
    }
    if (normalized.contains("apple event error -10000")
        || normalized.contains("sender process is not authenticated"))
        && matches!(
            continuity_kind,
            ComputerUseAuthorizationContinuityKind::HostDriftDetected
                | ComputerUseAuthorizationContinuityKind::UnsupportedContext
        )
    {
        return ComputerUseBrokerFailureKind::AuthorizationContinuityBlocked;
    }
    if normalized.contains("apple event error -1743")
        || normalized.contains("apple event error -10000")
        || normalized.contains("sender process is not authenticated")
        || normalized.contains("not authorized")
        || normalized.contains("accessibility")
        || normalized.contains("screen recording")
        || normalized.contains("allowed app")
        || normalized.contains("approval")
        || normalized.contains("permission")
    {
        return ComputerUseBrokerFailureKind::PermissionRequired;
    }
    if normalized.contains("workspace") && normalized.contains("not found") {
        return ComputerUseBrokerFailureKind::WorkspaceMissing;
    }
    if normalized.contains("not inside a trusted directory")
        || normalized.contains("skip-git-repo-check")
    {
        return ComputerUseBrokerFailureKind::WorkspaceMissing;
    }
    if normalized.contains("codex") || normalized.contains("runtime") {
        return ComputerUseBrokerFailureKind::CodexRuntimeUnavailable;
    }
    ComputerUseBrokerFailureKind::CodexError
}

fn build_broker_result(
    outcome: ComputerUseBrokerOutcome,
    failure_kind: Option<ComputerUseBrokerFailureKind>,
    bridge_status: ComputerUseBridgeStatus,
    text: Option<String>,
    diagnostic_message: Option<String>,
    duration_ms: u64,
) -> ComputerUseBrokerResult {
    ComputerUseBrokerResult {
        outcome,
        failure_kind,
        bridge_status,
        text,
        diagnostic_message,
        duration_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer_use::{ComputerUseAvailabilityStatus, ComputerUseGuidanceCode};

    fn blocked_bridge_status(
        blocked_reasons: Vec<ComputerUseBlockedReason>,
    ) -> ComputerUseBridgeStatus {
        ComputerUseBridgeStatus {
            feature_enabled: true,
            activation_enabled: true,
            status: if blocked_reasons.is_empty() {
                ComputerUseAvailabilityStatus::Ready
            } else {
                ComputerUseAvailabilityStatus::Blocked
            },
            platform: "macos".to_string(),
            codex_app_detected: true,
            plugin_detected: true,
            plugin_enabled: true,
            blocked_reasons,
            guidance_codes: Vec::<ComputerUseGuidanceCode>::new(),
            codex_config_path: Some("/Users/demo/.codex/config.toml".to_string()),
            plugin_manifest_path: Some(
                "/Users/demo/.codex/plugins/cache/openai-bundled/computer-use/1/.codex-plugin/plugin.json"
                    .to_string(),
            ),
            helper_path: Some(
                "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
                    .to_string(),
            ),
            helper_descriptor_path: Some(
                "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/.mcp.json"
                    .to_string(),
            ),
            marketplace_path: None,
            diagnostic_message: None,
            authorization_continuity: crate::computer_use::ComputerUseAuthorizationContinuityStatus {
                kind: ComputerUseAuthorizationContinuityKind::NoSuccessfulHost,
                diagnostic_message: None,
                current_host: None,
                last_successful_host: None,
                drift_fields: Vec::new(),
            },
        }
    }

    fn broker_ready_cli_cache_status(
        blocked_reasons: Vec<ComputerUseBlockedReason>,
    ) -> ComputerUseBridgeStatus {
        ComputerUseBridgeStatus {
            helper_path: Some(
                "/Users/demo/.codex/plugins/cache/openai-bundled/computer-use/1.0.755/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
                    .to_string(),
            ),
            helper_descriptor_path: Some(
                "/Users/demo/.codex/plugins/cache/openai-bundled/computer-use/1.0.755/.mcp.json"
                    .to_string(),
            ),
            ..blocked_bridge_status(blocked_reasons)
        }
    }

    fn with_continuity_kind(
        mut status: ComputerUseBridgeStatus,
        kind: ComputerUseAuthorizationContinuityKind,
    ) -> ComputerUseBridgeStatus {
        status.authorization_continuity.kind = kind;
        status
    }

    #[test]
    fn broker_gate_allows_cli_cache_with_manual_permission_blockers() {
        let status = broker_ready_cli_cache_status(vec![
            ComputerUseBlockedReason::PermissionRequired,
            ComputerUseBlockedReason::ApprovalRequired,
        ]);

        assert_eq!(evaluate_broker_gate(&status, "open Safari"), None);
    }

    #[test]
    fn broker_gate_rejects_empty_instruction_and_unverified_helper() {
        let status = broker_ready_cli_cache_status(Vec::new());
        assert_eq!(
            evaluate_broker_gate(&status, "   "),
            Some(ComputerUseBrokerFailureKind::InvalidInstruction)
        );

        let blocked_status =
            broker_ready_cli_cache_status(vec![ComputerUseBlockedReason::HelperBridgeUnverified]);
        assert_eq!(
            evaluate_broker_gate(&blocked_status, "open Safari"),
            Some(ComputerUseBrokerFailureKind::BridgeBlocked)
        );
    }

    #[test]
    fn broker_gate_rejects_non_cli_cache_helper_contract() {
        let status = blocked_bridge_status(Vec::new());

        assert_eq!(
            evaluate_broker_gate(&status, "open Safari"),
            Some(ComputerUseBrokerFailureKind::BridgeBlocked)
        );
    }

    #[test]
    fn broker_gate_rejects_drifted_authorization_host() {
        let status = with_continuity_kind(
            broker_ready_cli_cache_status(vec![
                ComputerUseBlockedReason::PermissionRequired,
                ComputerUseBlockedReason::ApprovalRequired,
            ]),
            ComputerUseAuthorizationContinuityKind::HostDriftDetected,
        );

        assert_eq!(
            evaluate_broker_gate(&status, "open Safari"),
            Some(ComputerUseBrokerFailureKind::AuthorizationContinuityBlocked)
        );
    }

    #[test]
    fn broker_text_is_bounded_and_trimmed() {
        assert_eq!(
            bounded_broker_text("  done  ".to_string()),
            Some("done".to_string())
        );
        assert_eq!(bounded_broker_text("   ".to_string()), None);

        let oversized = "a".repeat(COMPUTER_USE_BROKER_RESULT_LIMIT + 5);
        let bounded = bounded_broker_text(oversized).expect("bounded text");
        assert!(bounded.ends_with("..."));
        assert_eq!(
            bounded.chars().count(),
            COMPUTER_USE_BROKER_RESULT_LIMIT + 3
        );
    }

    #[test]
    fn codex_exec_output_collects_agent_and_tool_text() {
        let stdout = r#"{"type":"item.completed","item":{"type":"agent_message","text":"checking apps"}}
{"type":"item.completed","item":{"type":"mcp_tool_call","server":"computer-use","tool":"list_apps","status":"completed","result":{"content":[{"type":"text","text":"Safari\nTerminal"}]}}}
"#;
        let output = std::process::Output {
            status: success_status(),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        };

        let parsed = parse_codex_exec_broker_output(output).expect("parsed output");

        assert!(parsed.contains("checking apps"));
        assert!(parsed.contains("computer-use.list_apps"));
        assert!(parsed.contains("Safari"));
    }

    #[test]
    fn codex_exec_output_classifies_failed_tool_as_permission_required() {
        let stdout = r#"{"type":"item.completed","item":{"type":"mcp_tool_call","server":"computer-use","tool":"list_apps","status":"failed","result":{"content":[{"type":"text","text":"Apple event error -1743: Unknown error"}]}}}
"#;
        let output = std::process::Output {
            status: success_status(),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        };

        let error = parse_codex_exec_broker_output(output).expect_err("tool failure");

        assert_eq!(
            classify_broker_codex_error(
                &error,
                &ComputerUseAuthorizationContinuityKind::MatchingHost,
            ),
            ComputerUseBrokerFailureKind::PermissionRequired
        );
    }

    #[test]
    fn broker_error_classifies_sender_auth_failure_as_continuity_block_when_host_drifted() {
        assert_eq!(
            classify_broker_codex_error(
                "Computer Use tool `computer-use.list_apps` failed: Apple event error -10000: Sender process is not authenticated",
                &ComputerUseAuthorizationContinuityKind::HostDriftDetected,
            ),
            ComputerUseBrokerFailureKind::AuthorizationContinuityBlocked
        );
    }

    #[test]
    fn broker_error_classifies_trust_gate_as_workspace_failure() {
        assert_eq!(
            classify_broker_codex_error(
                "Reading additional input from stdin... Not inside a trusted directory and --skip-git-repo-check was not specified.",
                &ComputerUseAuthorizationContinuityKind::MatchingHost,
            ),
            ComputerUseBrokerFailureKind::WorkspaceMissing
        );
    }

    #[cfg(unix)]
    fn success_status() -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(0)
    }

    #[cfg(windows)]
    fn success_status() -> std::process::ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(0)
    }
}
