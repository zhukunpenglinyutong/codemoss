use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tauri::State;

use crate::codex::{config as codex_config, home as codex_home};
use crate::types::BackendMode;

mod authorization_continuity;
pub(crate) mod broker;
mod platform;
mod plist_helpers;

pub(crate) use authorization_continuity::{
    build_authorization_continuity_status, computer_use_authorization_continuity_path,
    persist_last_successful_authorization_host, ComputerUseAuthorizationContinuityKind,
    ComputerUseAuthorizationContinuityStatus,
};
use plist_helpers::{plist_array_strings, plist_string};

const COMPUTER_USE_BRIDGE_ENABLED: bool = true;
const COMPUTER_USE_ACTIVATION_ENABLED: bool = true;
const COMPUTER_USE_ACTIVATION_DISABLED_ENV: &str = "MOSSX_DISABLE_COMPUTER_USE_ACTIVATION";
const COMPUTER_USE_PLUGIN_ID: &str = "computer-use@openai-bundled";
const COMPUTER_USE_PLUGIN_NAME: &str = "computer-use";
const COMPUTER_USE_MCP_SERVER_NAME: &str = "computer-use";
const COMPUTER_USE_ACTIVATION_TIMEOUT_MS: u64 = 5_000;
const COMPUTER_USE_ACTIVATION_HELP_ARG: &str = "--help";
const COMPUTER_USE_ACTIVATION_SNIPPET_LIMIT: usize = 240;
const COMPUTER_USE_HOST_CONTRACT_COMMAND_TIMEOUT_MS: u64 = 1_500;
const COMPUTER_USE_PARENT_CODE_REQUIREMENT_FILENAME: &str =
    "SkyComputerUseClient_Parent.coderequirement";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ComputerUseAvailabilityStatus {
    Ready,
    Blocked,
    Unavailable,
    Unsupported,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseBlockedReason {
    PlatformUnsupported,
    CodexAppMissing,
    PluginMissing,
    PluginDisabled,
    HelperMissing,
    HelperBridgeUnverified,
    PermissionRequired,
    ApprovalRequired,
    UnknownPrerequisite,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseGuidanceCode {
    UnsupportedPlatform,
    InstallCodexApp,
    InstallOfficialPlugin,
    EnableOfficialPlugin,
    VerifyHelperInstallation,
    VerifyHelperBridge,
    GrantSystemPermissions,
    ReviewAllowedApps,
    InspectOfficialCodexSetup,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerUseBridgeStatus {
    pub(crate) feature_enabled: bool,
    pub(crate) activation_enabled: bool,
    pub(crate) status: ComputerUseAvailabilityStatus,
    pub(crate) platform: String,
    pub(crate) codex_app_detected: bool,
    pub(crate) plugin_detected: bool,
    pub(crate) plugin_enabled: bool,
    pub(crate) blocked_reasons: Vec<ComputerUseBlockedReason>,
    pub(crate) guidance_codes: Vec<ComputerUseGuidanceCode>,
    pub(crate) codex_config_path: Option<String>,
    pub(crate) plugin_manifest_path: Option<String>,
    pub(crate) helper_path: Option<String>,
    pub(crate) helper_descriptor_path: Option<String>,
    pub(crate) marketplace_path: Option<String>,
    pub(crate) diagnostic_message: Option<String>,
    pub(crate) authorization_continuity: ComputerUseAuthorizationContinuityStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseActivationOutcome {
    Verified,
    Blocked,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseActivationFailureKind {
    ActivationDisabled,
    UnsupportedPlatform,
    IneligibleHost,
    HostIncompatible,
    AlreadyRunning,
    RemainingBlockers,
    Timeout,
    LaunchFailed,
    NonZeroExit,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerUseActivationResult {
    pub(crate) outcome: ComputerUseActivationOutcome,
    pub(crate) failure_kind: Option<ComputerUseActivationFailureKind>,
    pub(crate) bridge_status: ComputerUseBridgeStatus,
    pub(crate) duration_ms: u64,
    pub(crate) diagnostic_message: Option<String>,
    pub(crate) stderr_snippet: Option<String>,
    pub(crate) exit_code: Option<i32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseHostContractDiagnosticsKind {
    RequiresOfficialParent,
    HandoffUnavailable,
    HandoffVerified,
    ManualPermissionRequired,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseOfficialParentHandoffKind {
    HandoffCandidateFound,
    HandoffUnavailable,
    RequiresOfficialParent,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerUseOfficialParentHandoffMethod {
    pub(crate) method: String,
    pub(crate) source_path: Option<String>,
    pub(crate) identifier: String,
    pub(crate) confidence: String,
    pub(crate) notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerUseOfficialParentHandoffEvidence {
    pub(crate) codex_info_plist_path: Option<String>,
    pub(crate) service_info_plist_path: Option<String>,
    pub(crate) helper_info_plist_path: Option<String>,
    pub(crate) parent_code_requirement_path: Option<String>,
    pub(crate) plugin_manifest_path: Option<String>,
    pub(crate) mcp_descriptor_path: Option<String>,
    pub(crate) codex_url_schemes: Vec<String>,
    pub(crate) service_bundle_identifier: Option<String>,
    pub(crate) helper_bundle_identifier: Option<String>,
    pub(crate) parent_team_identifier: Option<String>,
    pub(crate) application_groups: Vec<String>,
    pub(crate) xpc_service_identifiers: Vec<String>,
    pub(crate) duration_ms: u64,
    pub(crate) stdout_snippet: Option<String>,
    pub(crate) stderr_snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerUseOfficialParentHandoffDiscovery {
    pub(crate) kind: ComputerUseOfficialParentHandoffKind,
    pub(crate) methods: Vec<ComputerUseOfficialParentHandoffMethod>,
    pub(crate) evidence: ComputerUseOfficialParentHandoffEvidence,
    pub(crate) duration_ms: u64,
    pub(crate) diagnostic_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerUseHostContractEvidence {
    pub(crate) helper_path: Option<String>,
    pub(crate) helper_descriptor_path: Option<String>,
    pub(crate) current_host_path: Option<String>,
    pub(crate) handoff_method: String,
    pub(crate) codesign_summary: Option<String>,
    pub(crate) spctl_summary: Option<String>,
    pub(crate) duration_ms: u64,
    pub(crate) stdout_snippet: Option<String>,
    pub(crate) stderr_snippet: Option<String>,
    pub(crate) official_parent_handoff: ComputerUseOfficialParentHandoffDiscovery,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerUseHostContractDiagnosticsResult {
    pub(crate) kind: ComputerUseHostContractDiagnosticsKind,
    pub(crate) bridge_status: ComputerUseBridgeStatus,
    pub(crate) evidence: ComputerUseHostContractEvidence,
    pub(crate) duration_ms: u64,
    pub(crate) diagnostic_message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ComputerUseActivationVerification {
    helper_identity: ComputerUseActivationIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ComputerUseActivationIdentity {
    helper_path: String,
    helper_descriptor_path: Option<String>,
    plugin_manifest_path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ComputerUseDetectionSnapshot {
    codex_app_detected: bool,
    plugin_detected: bool,
    plugin_enabled: bool,
    helper_present: bool,
    helper_bridge_verified: bool,
    permission_verified: bool,
    approval_verified: bool,
    codex_config_path: Option<String>,
    plugin_manifest_path: Option<String>,
    helper_path: Option<String>,
    helper_descriptor_path: Option<String>,
    marketplace_path: Option<String>,
    diagnostic_message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlatformAvailability {
    Supported,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PlatformAdapterResult {
    platform: &'static str,
    availability: PlatformAvailability,
    snapshot: ComputerUseDetectionSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ComputerUseActivationContext {
    adapter_result: PlatformAdapterResult,
    bridge_status: ComputerUseBridgeStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ComputerUseHelperProbeExecution {
    succeeded: bool,
    failure_kind: Option<ComputerUseActivationFailureKind>,
    diagnostic_message: String,
    stderr_snippet: Option<String>,
    exit_code: Option<i32>,
    duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ComputerUseHelperLaunchSpec {
    command_path: PathBuf,
    args: Vec<String>,
    current_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ComputerUseHostCommandEvidence {
    summary: String,
    stdout_snippet: Option<String>,
    stderr_snippet: Option<String>,
}

#[tauri::command]
pub(crate) async fn get_computer_use_bridge_status(
    state: State<'_, crate::state::AppState>,
) -> Result<ComputerUseBridgeStatus, String> {
    let activation_verification = state
        .computer_use_activation_verification
        .lock()
        .await
        .clone();
    let backend_mode = state.app_settings.lock().await.backend_mode.clone();
    let continuity_store_path = computer_use_authorization_continuity_path(&state.settings_path);
    tokio::task::spawn_blocking(move || {
        resolve_computer_use_bridge_status(
            activation_verification.as_ref(),
            backend_mode,
            continuity_store_path,
        )
    })
    .await
    .map_err(|error| format!("failed to join computer use bridge status task: {error}"))
}

#[tauri::command]
pub(crate) async fn run_computer_use_activation_probe(
    state: State<'_, crate::state::AppState>,
) -> Result<ComputerUseActivationResult, String> {
    let activation_verification = state
        .computer_use_activation_verification
        .lock()
        .await
        .clone();
    let backend_mode = state.app_settings.lock().await.backend_mode.clone();
    let continuity_store_path = computer_use_authorization_continuity_path(&state.settings_path);
    let context = tokio::task::spawn_blocking(move || {
        resolve_activation_context(
            activation_verification.as_ref(),
            backend_mode,
            continuity_store_path,
        )
    })
    .await
    .map_err(|error| format!("failed to join computer use activation preflight task: {error}"))?;

    if !computer_use_activation_enabled() {
        return Ok(build_activation_result(
            ComputerUseActivationOutcome::Failed,
            Some(ComputerUseActivationFailureKind::ActivationDisabled),
            context.bridge_status,
            0,
            Some("Computer Use activation lane is disabled by host flag.".to_string()),
            None,
            None,
        ));
    }

    let _probe_guard = match state.computer_use_activation_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return Ok(build_activation_result(
                ComputerUseActivationOutcome::Failed,
                Some(ComputerUseActivationFailureKind::AlreadyRunning),
                context.bridge_status,
                0,
                Some("A Computer Use activation probe is already running.".to_string()),
                None,
                None,
            ));
        }
    };

    if !is_activation_probe_eligible(&context.bridge_status) {
        return Ok(build_non_executable_activation_result(
            context.bridge_status,
        ));
    }

    let Some(verification) =
        ComputerUseActivationVerification::from_snapshot(&context.adapter_result.snapshot)
    else {
        return Ok(build_activation_result(
            ComputerUseActivationOutcome::Failed,
            Some(ComputerUseActivationFailureKind::IneligibleHost),
            context.bridge_status,
            0,
            Some(
                "Computer Use helper path is missing, so the activation probe cannot start."
                    .to_string(),
            ),
            None,
            None,
        ));
    };

    let probe_execution = run_helper_bridge_probe(
        &verification.helper_identity.helper_path,
        context
            .adapter_result
            .snapshot
            .helper_descriptor_path
            .as_deref(),
    )
    .await;

    if !probe_execution.succeeded {
        return Ok(build_activation_result(
            ComputerUseActivationOutcome::Failed,
            probe_execution.failure_kind,
            context.bridge_status,
            probe_execution.duration_ms,
            Some(probe_execution.diagnostic_message),
            probe_execution.stderr_snippet,
            probe_execution.exit_code,
        ));
    }

    {
        let mut stored = state.computer_use_activation_verification.lock().await;
        *stored = Some(verification.clone());
    }

    let verified_bridge_message = probe_execution.diagnostic_message.clone();
    let refreshed_backend_mode = state.app_settings.lock().await.backend_mode.clone();
    let refreshed_continuity_store_path =
        computer_use_authorization_continuity_path(&state.settings_path);
    let refreshed_context = tokio::task::spawn_blocking(move || {
        resolve_activation_context(
            Some(&verification),
            refreshed_backend_mode,
            refreshed_continuity_store_path,
        )
    })
    .await
    .map_err(|error| format!("failed to join computer use activation refresh task: {error}"))?;

    let (outcome, failure_kind, diagnostic_message) = match refreshed_context.bridge_status.status {
        ComputerUseAvailabilityStatus::Ready => (
            ComputerUseActivationOutcome::Verified,
            None,
            Some(verified_bridge_message.clone()),
        ),
        ComputerUseAvailabilityStatus::Blocked => (
            ComputerUseActivationOutcome::Blocked,
            Some(ComputerUseActivationFailureKind::RemainingBlockers),
            Some(format!(
                "{verified_bridge_message} Remaining permissions or approvals still require manual confirmation."
            )),
        ),
        _ => (
            ComputerUseActivationOutcome::Failed,
            Some(ComputerUseActivationFailureKind::Unknown),
            Some(
                "Computer Use probe completed, but the bridge status did not converge to a usable state."
                    .to_string(),
            ),
        ),
    };

    Ok(build_activation_result(
        outcome,
        failure_kind,
        refreshed_context.bridge_status,
        probe_execution.duration_ms,
        diagnostic_message,
        probe_execution.stderr_snippet,
        probe_execution.exit_code,
    ))
}

#[tauri::command]
pub(crate) async fn run_computer_use_host_contract_diagnostics(
    state: State<'_, crate::state::AppState>,
) -> Result<ComputerUseHostContractDiagnosticsResult, String> {
    let started_at = Instant::now();
    let activation_verification = state
        .computer_use_activation_verification
        .lock()
        .await
        .clone();
    let backend_mode = state.app_settings.lock().await.backend_mode.clone();
    let continuity_store_path = computer_use_authorization_continuity_path(&state.settings_path);
    let context = tokio::task::spawn_blocking(move || {
        resolve_activation_context(
            activation_verification.as_ref(),
            backend_mode,
            continuity_store_path,
        )
    })
    .await
    .map_err(|error| {
        format!("failed to join computer use host contract preflight task: {error}")
    })?;

    if !computer_use_activation_enabled() {
        let duration_ms = started_at.elapsed().as_millis() as u64;
        return Ok(build_host_contract_result(
            ComputerUseHostContractDiagnosticsKind::Unknown,
            context.bridge_status,
            build_host_contract_evidence(
                &context.adapter_result.snapshot,
                current_host_path(),
                "skipped_activation_disabled".to_string(),
                None,
                None,
                duration_ms,
                None,
                None,
                skipped_official_parent_handoff_discovery("activation_disabled", duration_ms),
            ),
            duration_ms,
            "Computer Use host-contract diagnostics are disabled by host flag.".to_string(),
        ));
    }

    let _probe_guard = match state.computer_use_activation_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            let duration_ms = started_at.elapsed().as_millis() as u64;
            return Ok(build_host_contract_result(
                ComputerUseHostContractDiagnosticsKind::Unknown,
                context.bridge_status,
                build_host_contract_evidence(
                    &context.adapter_result.snapshot,
                    current_host_path(),
                    "skipped_already_running".to_string(),
                    None,
                    None,
                    duration_ms,
                    None,
                    None,
                    skipped_official_parent_handoff_discovery("already_running", duration_ms),
                ),
                duration_ms,
                "A Computer Use activation or host-contract diagnostics run is already running."
                    .to_string(),
            ));
        }
    };

    let helper_path = context.adapter_result.snapshot.helper_path.clone();
    let discovery_snapshot = context.adapter_result.snapshot.clone();
    let official_parent_handoff =
        tokio::task::spawn_blocking(move || discover_official_parent_handoff(&discovery_snapshot))
            .await
            .unwrap_or_else(|error| {
                skipped_official_parent_handoff_discovery(
                    &format!("handoff discovery task failed: {error}"),
                    started_at.elapsed().as_millis() as u64,
                )
            });
    let (codesign_evidence, spctl_evidence) =
        collect_host_contract_command_evidence(helper_path.as_deref()).await;
    let current_host_path = current_host_path();
    let duration_ms = started_at.elapsed().as_millis() as u64;
    let kind = classify_host_contract_diagnostics(
        &context.bridge_status,
        helper_path.as_deref(),
        current_host_path.as_deref(),
    );
    let evidence = build_host_contract_evidence(
        &context.adapter_result.snapshot,
        current_host_path,
        host_contract_handoff_method(kind, helper_path.as_deref()).to_string(),
        Some(codesign_evidence.summary),
        Some(spctl_evidence.summary),
        duration_ms,
        first_available_snippet([
            codesign_evidence.stdout_snippet,
            spctl_evidence.stdout_snippet,
        ]),
        first_available_snippet([
            codesign_evidence.stderr_snippet,
            spctl_evidence.stderr_snippet,
        ]),
        official_parent_handoff,
    );
    let diagnostic_message = host_contract_diagnostic_message(kind);

    Ok(build_host_contract_result(
        kind,
        context.bridge_status,
        evidence,
        duration_ms,
        diagnostic_message.to_string(),
    ))
}

fn resolve_computer_use_bridge_status(
    activation_verification: Option<&ComputerUseActivationVerification>,
    backend_mode: BackendMode,
    continuity_store_path: PathBuf,
) -> ComputerUseBridgeStatus {
    if !COMPUTER_USE_BRIDGE_ENABLED {
        return ComputerUseBridgeStatus {
            feature_enabled: false,
            activation_enabled: false,
            status: ComputerUseAvailabilityStatus::Unavailable,
            platform: platform::platform_name().to_string(),
            codex_app_detected: false,
            plugin_detected: false,
            plugin_enabled: false,
            blocked_reasons: Vec::new(),
            guidance_codes: Vec::new(),
            codex_config_path: codex_config::config_toml_path().and_then(path_to_string),
            plugin_manifest_path: None,
            helper_path: None,
            helper_descriptor_path: None,
            marketplace_path: None,
            diagnostic_message: Some("computer use bridge is disabled by host flag".to_string()),
            authorization_continuity: build_authorization_continuity_status(
                backend_mode,
                &continuity_store_path,
            ),
        };
    }

    resolve_activation_context(activation_verification, backend_mode, continuity_store_path)
        .bridge_status
}

fn resolve_activation_context(
    activation_verification: Option<&ComputerUseActivationVerification>,
    backend_mode: BackendMode,
    continuity_store_path: PathBuf,
) -> ComputerUseActivationContext {
    let mut adapter_result = platform::detect_platform_state(detect_computer_use_snapshot());
    apply_activation_verification(&mut adapter_result.snapshot, activation_verification);
    let bridge_status = build_bridge_status(
        adapter_result.clone(),
        build_authorization_continuity_status(backend_mode, &continuity_store_path),
    );

    ComputerUseActivationContext {
        adapter_result,
        bridge_status,
    }
}

fn detect_computer_use_snapshot() -> ComputerUseDetectionSnapshot {
    let mut snapshot = ComputerUseDetectionSnapshot {
        codex_config_path: codex_config::config_toml_path().and_then(path_to_string),
        ..ComputerUseDetectionSnapshot::default()
    };

    let config_path = snapshot
        .codex_config_path
        .as_ref()
        .map(PathBuf::from)
        .or_else(codex_config::config_toml_path);

    if let Some(path) = config_path.as_ref() {
        match read_plugin_enabled_from_config(path) {
            Ok(Some(enabled)) => {
                snapshot.plugin_detected = true;
                snapshot.plugin_enabled = enabled;
            }
            Ok(None) => {}
            Err(error) => {
                snapshot.diagnostic_message = Some(error);
            }
        }
    }

    let cache_root = resolve_computer_use_cache_root();
    if let Some(manifest_path) = detect_plugin_manifest_path(cache_root.as_deref()) {
        snapshot.plugin_detected = true;
        let plugin_root = plugin_root_from_manifest_path(&manifest_path);
        snapshot.plugin_manifest_path = path_to_string(manifest_path);
        if let Some(descriptor_path) = plugin_root
            .map(|root| root.join(".mcp.json"))
            .filter(|path| path.is_file())
        {
            apply_helper_descriptor_path(&mut snapshot, &descriptor_path);
        }
    }

    snapshot
}

fn apply_activation_verification(
    snapshot: &mut ComputerUseDetectionSnapshot,
    activation_verification: Option<&ComputerUseActivationVerification>,
) {
    if activation_verification.is_some_and(|verification| verification.applies_to(snapshot)) {
        snapshot.helper_bridge_verified = true;
    }
}

fn build_bridge_status(
    adapter_result: PlatformAdapterResult,
    authorization_continuity: ComputerUseAuthorizationContinuityStatus,
) -> ComputerUseBridgeStatus {
    let snapshot = adapter_result.snapshot;
    let (status, blocked_reasons, guidance_codes) =
        classify_status(adapter_result.availability, &snapshot);

    ComputerUseBridgeStatus {
        feature_enabled: COMPUTER_USE_BRIDGE_ENABLED,
        activation_enabled: computer_use_activation_enabled(),
        status,
        platform: adapter_result.platform.to_string(),
        codex_app_detected: snapshot.codex_app_detected,
        plugin_detected: snapshot.plugin_detected,
        plugin_enabled: snapshot.plugin_enabled,
        blocked_reasons,
        guidance_codes,
        codex_config_path: snapshot.codex_config_path,
        plugin_manifest_path: snapshot.plugin_manifest_path,
        helper_path: snapshot.helper_path,
        helper_descriptor_path: snapshot.helper_descriptor_path,
        marketplace_path: snapshot.marketplace_path,
        diagnostic_message: snapshot.diagnostic_message,
        authorization_continuity,
    }
}

fn classify_status(
    availability: PlatformAvailability,
    snapshot: &ComputerUseDetectionSnapshot,
) -> (
    ComputerUseAvailabilityStatus,
    Vec<ComputerUseBlockedReason>,
    Vec<ComputerUseGuidanceCode>,
) {
    if availability == PlatformAvailability::Unsupported {
        return (
            ComputerUseAvailabilityStatus::Unsupported,
            vec![ComputerUseBlockedReason::PlatformUnsupported],
            vec![ComputerUseGuidanceCode::UnsupportedPlatform],
        );
    }

    if !snapshot.codex_app_detected && !snapshot.plugin_detected {
        return (
            ComputerUseAvailabilityStatus::Unavailable,
            vec![ComputerUseBlockedReason::CodexAppMissing],
            vec![ComputerUseGuidanceCode::InstallCodexApp],
        );
    }

    if !snapshot.plugin_detected {
        return (
            ComputerUseAvailabilityStatus::Unavailable,
            vec![ComputerUseBlockedReason::PluginMissing],
            vec![ComputerUseGuidanceCode::InstallOfficialPlugin],
        );
    }

    if !snapshot.plugin_enabled {
        return (
            ComputerUseAvailabilityStatus::Blocked,
            vec![ComputerUseBlockedReason::PluginDisabled],
            vec![ComputerUseGuidanceCode::EnableOfficialPlugin],
        );
    }

    if !snapshot.helper_present {
        return (
            ComputerUseAvailabilityStatus::Blocked,
            vec![ComputerUseBlockedReason::HelperMissing],
            vec![ComputerUseGuidanceCode::VerifyHelperInstallation],
        );
    }

    let mut blocked_reasons = Vec::new();
    let mut guidance_codes = Vec::new();

    if !snapshot.helper_bridge_verified {
        blocked_reasons.push(ComputerUseBlockedReason::HelperBridgeUnverified);
        guidance_codes.push(ComputerUseGuidanceCode::VerifyHelperBridge);
    }

    if !snapshot.permission_verified {
        blocked_reasons.push(ComputerUseBlockedReason::PermissionRequired);
        guidance_codes.push(ComputerUseGuidanceCode::GrantSystemPermissions);
    }

    if !snapshot.approval_verified {
        blocked_reasons.push(ComputerUseBlockedReason::ApprovalRequired);
        guidance_codes.push(ComputerUseGuidanceCode::ReviewAllowedApps);
    }

    if !blocked_reasons.is_empty() {
        return (
            ComputerUseAvailabilityStatus::Blocked,
            blocked_reasons,
            dedupe_guidance_codes(guidance_codes),
        );
    }

    (ComputerUseAvailabilityStatus::Ready, Vec::new(), Vec::new())
}

fn is_activation_probe_eligible(status: &ComputerUseBridgeStatus) -> bool {
    status.activation_enabled
        && status.platform == "macos"
        && status.status == ComputerUseAvailabilityStatus::Blocked
        && status.plugin_detected
        && status.plugin_enabled
        && status.helper_path.is_some()
        && status
            .blocked_reasons
            .contains(&ComputerUseBlockedReason::HelperBridgeUnverified)
}

fn computer_use_activation_enabled() -> bool {
    COMPUTER_USE_ACTIVATION_ENABLED
        && !activation_disabled_env_value(std::env::var(COMPUTER_USE_ACTIVATION_DISABLED_ENV).ok())
}

fn activation_disabled_env_value(value: Option<String>) -> bool {
    value
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

fn build_non_executable_activation_result(
    bridge_status: ComputerUseBridgeStatus,
) -> ComputerUseActivationResult {
    match bridge_status.status {
        ComputerUseAvailabilityStatus::Ready => build_activation_result(
            ComputerUseActivationOutcome::Verified,
            None,
            bridge_status,
            0,
            Some("Computer Use helper bridge is already verified in this app session.".to_string()),
            None,
            None,
        ),
        ComputerUseAvailabilityStatus::Blocked
            if !bridge_status
                .blocked_reasons
                .contains(&ComputerUseBlockedReason::HelperBridgeUnverified) =>
        {
            build_activation_result(
                ComputerUseActivationOutcome::Blocked,
                Some(ComputerUseActivationFailureKind::RemainingBlockers),
                bridge_status,
                0,
                Some(
                    "Computer Use helper bridge is already verified, but remaining blockers still need manual resolution."
                        .to_string(),
                ),
                None,
                None,
            )
        }
        ComputerUseAvailabilityStatus::Unsupported => build_activation_result(
            ComputerUseActivationOutcome::Failed,
            Some(ComputerUseActivationFailureKind::UnsupportedPlatform),
            bridge_status,
            0,
            Some("Computer Use activation probe is only available on macOS.".to_string()),
            None,
            None,
        ),
        _ => build_activation_result(
            ComputerUseActivationOutcome::Failed,
            Some(ComputerUseActivationFailureKind::IneligibleHost),
            bridge_status,
            0,
            Some(
                "Computer Use activation probe is only available after Codex App, plugin, and helper detection all succeed."
                    .to_string(),
            ),
            None,
            None,
        ),
    }
}

fn build_activation_result(
    outcome: ComputerUseActivationOutcome,
    failure_kind: Option<ComputerUseActivationFailureKind>,
    bridge_status: ComputerUseBridgeStatus,
    duration_ms: u64,
    diagnostic_message: Option<String>,
    stderr_snippet: Option<String>,
    exit_code: Option<i32>,
) -> ComputerUseActivationResult {
    ComputerUseActivationResult {
        outcome,
        failure_kind,
        bridge_status,
        duration_ms,
        diagnostic_message,
        stderr_snippet,
        exit_code,
    }
}

fn build_host_contract_result(
    kind: ComputerUseHostContractDiagnosticsKind,
    bridge_status: ComputerUseBridgeStatus,
    evidence: ComputerUseHostContractEvidence,
    duration_ms: u64,
    diagnostic_message: String,
) -> ComputerUseHostContractDiagnosticsResult {
    ComputerUseHostContractDiagnosticsResult {
        kind,
        bridge_status,
        evidence,
        duration_ms,
        diagnostic_message,
    }
}

fn build_host_contract_evidence(
    snapshot: &ComputerUseDetectionSnapshot,
    current_host_path: Option<String>,
    handoff_method: String,
    codesign_summary: Option<String>,
    spctl_summary: Option<String>,
    duration_ms: u64,
    stdout_snippet: Option<String>,
    stderr_snippet: Option<String>,
    official_parent_handoff: ComputerUseOfficialParentHandoffDiscovery,
) -> ComputerUseHostContractEvidence {
    ComputerUseHostContractEvidence {
        helper_path: snapshot.helper_path.clone(),
        helper_descriptor_path: snapshot.helper_descriptor_path.clone(),
        current_host_path,
        handoff_method,
        codesign_summary,
        spctl_summary,
        duration_ms,
        stdout_snippet,
        stderr_snippet,
        official_parent_handoff,
    }
}

fn classify_host_contract_diagnostics(
    bridge_status: &ComputerUseBridgeStatus,
    helper_path: Option<&str>,
    current_host_path: Option<&str>,
) -> ComputerUseHostContractDiagnosticsKind {
    if bridge_status.platform != "macos" {
        return ComputerUseHostContractDiagnosticsKind::Unknown;
    }

    if bridge_status
        .blocked_reasons
        .contains(&ComputerUseBlockedReason::PermissionRequired)
        || bridge_status
            .blocked_reasons
            .contains(&ComputerUseBlockedReason::ApprovalRequired)
    {
        if !bridge_status
            .blocked_reasons
            .contains(&ComputerUseBlockedReason::HelperBridgeUnverified)
        {
            return ComputerUseHostContractDiagnosticsKind::ManualPermissionRequired;
        }
    }

    let Some(path) = helper_path.map(Path::new) else {
        return ComputerUseHostContractDiagnosticsKind::Unknown;
    };

    if path_looks_like_codex_cli_computer_use_cache(path) {
        return ComputerUseHostContractDiagnosticsKind::HandoffVerified;
    }

    if path_looks_like_nested_app_binary(path) {
        if current_host_path
            .map(|path| path.contains("/Codex.app/"))
            .unwrap_or(false)
        {
            return ComputerUseHostContractDiagnosticsKind::HandoffVerified;
        }

        return ComputerUseHostContractDiagnosticsKind::RequiresOfficialParent;
    }

    ComputerUseHostContractDiagnosticsKind::HandoffUnavailable
}

fn host_contract_handoff_method(
    kind: ComputerUseHostContractDiagnosticsKind,
    helper_path: Option<&str>,
) -> &'static str {
    match kind {
        ComputerUseHostContractDiagnosticsKind::HandoffVerified
            if helper_path
                .map(Path::new)
                .is_some_and(path_looks_like_codex_cli_computer_use_cache) =>
        {
            "codex_cli_plugin_cache_mcp_descriptor"
        }
        ComputerUseHostContractDiagnosticsKind::RequiresOfficialParent
            if helper_path
                .map(Path::new)
                .is_some_and(path_looks_like_nested_app_binary) =>
        {
            "direct_exec_skipped_nested_app_bundle"
        }
        ComputerUseHostContractDiagnosticsKind::HandoffVerified => {
            "current_host_matches_official_codex_parent"
        }
        ComputerUseHostContractDiagnosticsKind::ManualPermissionRequired => {
            "manual_permission_or_approval_review"
        }
        ComputerUseHostContractDiagnosticsKind::HandoffUnavailable => {
            "official_handoff_not_detected"
        }
        ComputerUseHostContractDiagnosticsKind::Unknown => "not_applicable",
        ComputerUseHostContractDiagnosticsKind::RequiresOfficialParent => {
            "requires_official_parent"
        }
    }
}

fn host_contract_diagnostic_message(kind: ComputerUseHostContractDiagnosticsKind) -> &'static str {
    match kind {
        ComputerUseHostContractDiagnosticsKind::RequiresOfficialParent => {
            "Computer Use helper appears to require the official Codex parent contract. The nested helper was not directly executed."
        }
        ComputerUseHostContractDiagnosticsKind::HandoffUnavailable => {
            "No supported official handoff method was detected for this helper from the current host."
        }
        ComputerUseHostContractDiagnosticsKind::HandoffVerified => {
            "Computer Use helper has a supported Codex parent or CLI plugin launch contract. This is diagnostic evidence only, not runtime enablement."
        }
        ComputerUseHostContractDiagnosticsKind::ManualPermissionRequired => {
            "Helper bridge identity is no longer the primary blocker; manual permissions or app approvals still need review."
        }
        ComputerUseHostContractDiagnosticsKind::Unknown => {
            "Computer Use host-contract diagnostics could not classify the current state from available evidence."
        }
    }
}

fn current_host_path() -> Option<String> {
    std::env::current_exe().ok().and_then(path_to_string)
}

fn discover_official_parent_handoff(
    snapshot: &ComputerUseDetectionSnapshot,
) -> ComputerUseOfficialParentHandoffDiscovery {
    let started_at = Instant::now();
    let helper_path = snapshot.helper_path.as_deref().map(Path::new);
    let helper_app_root = helper_path.and_then(find_nearest_app_bundle_root);
    let service_app_root = helper_app_root.and_then(resolve_service_app_root_from_helper_app);
    let codex_app_root = helper_path
        .and_then(|path| find_ancestor_app_bundle_named(path, "Codex.app"))
        .or_else(|| {
            snapshot
                .marketplace_path
                .as_deref()
                .map(Path::new)
                .and_then(|path| find_ancestor_app_bundle_named(path, "Codex.app"))
        });

    let codex_info_plist_path = codex_app_root.map(app_info_plist_path);
    let service_info_plist_path = service_app_root.map(app_info_plist_path);
    let helper_info_plist_path = helper_app_root.map(app_info_plist_path);
    let parent_code_requirement_path = helper_app_root.map(|root| {
        root.join("Contents")
            .join("Resources")
            .join(COMPUTER_USE_PARENT_CODE_REQUIREMENT_FILENAME)
    });

    let codex_info = codex_info_plist_path
        .as_ref()
        .and_then(|path| read_file_to_string_if_file(path));
    let service_info = service_info_plist_path
        .as_ref()
        .and_then(|path| read_file_to_string_if_file(path));
    let helper_info = helper_info_plist_path
        .as_ref()
        .and_then(|path| read_file_to_string_if_file(path));
    let parent_requirement = parent_code_requirement_path
        .as_ref()
        .and_then(|path| read_file_to_string_if_file(path));

    let codex_url_schemes = codex_info
        .as_deref()
        .map(|contents| plist_array_strings(contents, "CFBundleURLSchemes"))
        .unwrap_or_default();
    let service_bundle_identifier = service_info
        .as_deref()
        .and_then(|contents| plist_string(contents, "CFBundleIdentifier"));
    let helper_bundle_identifier = helper_info
        .as_deref()
        .and_then(|contents| plist_string(contents, "CFBundleIdentifier"));
    let parent_team_identifier = parent_requirement
        .as_deref()
        .and_then(|contents| plist_string(contents, "team-identifier"));
    let application_groups =
        collect_application_groups([service_info.as_deref(), helper_info.as_deref()]);
    let xpc_service_identifiers = codex_app_root
        .map(|root| collect_xpc_service_identifiers(root, 6, 512))
        .unwrap_or_default();

    let mut methods = Vec::new();
    for scheme in codex_url_schemes.iter().filter(|scheme| {
        let normalized = scheme.to_ascii_lowercase();
        normalized.contains("computer") || normalized.contains("cua")
    }) {
        methods.push(ComputerUseOfficialParentHandoffMethod {
            method: "launch_services_url_scheme".to_string(),
            source_path: codex_info_plist_path
                .as_ref()
                .and_then(|path| path_to_string(path.clone())),
            identifier: scheme.clone(),
            confidence: "medium".to_string(),
            notes: "Codex declares a Computer Use-specific URL scheme candidate.".to_string(),
        });
    }

    for identifier in &xpc_service_identifiers {
        methods.push(ComputerUseOfficialParentHandoffMethod {
            method: "xpc_service".to_string(),
            source_path: codex_app_root.and_then(|path| path_to_string(path.to_path_buf())),
            identifier: identifier.clone(),
            confidence: "low".to_string(),
            notes: "XPC service declaration exists in the official app bundle; this is evidence only and was not launched.".to_string(),
        });
    }

    let mcp_descriptor_path = snapshot.helper_descriptor_path.clone();
    let parsed_mcp_descriptor = snapshot
        .helper_descriptor_path
        .as_deref()
        .map(Path::new)
        .and_then(parse_helper_descriptor);
    if parsed_mcp_descriptor.as_ref().is_some_and(|descriptor| {
        snapshot
            .helper_descriptor_path
            .as_deref()
            .map(Path::new)
            .is_some_and(path_looks_like_codex_cli_computer_use_cache)
            || path_looks_like_codex_cli_computer_use_cache(&descriptor.command_path)
            || !path_looks_like_nested_app_binary(&descriptor.command_path)
    }) {
        methods.push(ComputerUseOfficialParentHandoffMethod {
            method: "mcp_descriptor".to_string(),
            source_path: mcp_descriptor_path.clone(),
            identifier: COMPUTER_USE_MCP_SERVER_NAME.to_string(),
            confidence: if parsed_mcp_descriptor
                .as_ref()
                .is_some_and(|descriptor| {
                    path_looks_like_codex_cli_computer_use_cache(&descriptor.command_path)
                })
            {
                "high".to_string()
            } else {
                "medium".to_string()
            },
            notes: "MCP descriptor is treated as a Codex CLI/plugin handoff candidate. This is evidence only and was not launched by CodePort."
                .to_string(),
        });
    }

    let duration_ms = started_at.elapsed().as_millis() as u64;
    let kind = classify_official_parent_handoff(
        !methods.is_empty(),
        parent_team_identifier.as_deref(),
        helper_bundle_identifier.as_deref(),
        service_bundle_identifier.as_deref(),
    );
    let diagnostic_message = official_parent_handoff_message(kind).to_string();
    let evidence = ComputerUseOfficialParentHandoffEvidence {
        codex_info_plist_path: codex_info_plist_path.and_then(path_to_string),
        service_info_plist_path: service_info_plist_path.and_then(path_to_string),
        helper_info_plist_path: helper_info_plist_path.and_then(path_to_string),
        parent_code_requirement_path: parent_code_requirement_path.and_then(path_to_string),
        plugin_manifest_path: snapshot.plugin_manifest_path.clone(),
        mcp_descriptor_path,
        codex_url_schemes,
        service_bundle_identifier,
        helper_bundle_identifier,
        parent_team_identifier,
        application_groups,
        xpc_service_identifiers,
        duration_ms,
        stdout_snippet: None,
        stderr_snippet: None,
    };

    ComputerUseOfficialParentHandoffDiscovery {
        kind,
        methods,
        evidence,
        duration_ms,
        diagnostic_message,
    }
}

fn skipped_official_parent_handoff_discovery(
    reason: &str,
    duration_ms: u64,
) -> ComputerUseOfficialParentHandoffDiscovery {
    ComputerUseOfficialParentHandoffDiscovery {
        kind: ComputerUseOfficialParentHandoffKind::Unknown,
        methods: Vec::new(),
        evidence: ComputerUseOfficialParentHandoffEvidence {
            codex_info_plist_path: None,
            service_info_plist_path: None,
            helper_info_plist_path: None,
            parent_code_requirement_path: None,
            plugin_manifest_path: None,
            mcp_descriptor_path: None,
            codex_url_schemes: Vec::new(),
            service_bundle_identifier: None,
            helper_bundle_identifier: None,
            parent_team_identifier: None,
            application_groups: Vec::new(),
            xpc_service_identifiers: Vec::new(),
            duration_ms,
            stdout_snippet: None,
            stderr_snippet: Some(output_snippet(reason).unwrap_or_else(|| reason.to_string())),
        },
        duration_ms,
        diagnostic_message: format!("Official parent handoff discovery was skipped: {reason}."),
    }
}

fn classify_official_parent_handoff(
    has_candidate_method: bool,
    parent_team_identifier: Option<&str>,
    helper_bundle_identifier: Option<&str>,
    service_bundle_identifier: Option<&str>,
) -> ComputerUseOfficialParentHandoffKind {
    if has_candidate_method {
        return ComputerUseOfficialParentHandoffKind::HandoffCandidateFound;
    }

    if parent_team_identifier.is_some()
        || helper_bundle_identifier.is_some_and(|identifier| identifier.contains(".CUAService.cli"))
        || service_bundle_identifier.is_some_and(|identifier| identifier.contains(".CUAService"))
    {
        return ComputerUseOfficialParentHandoffKind::RequiresOfficialParent;
    }

    if helper_bundle_identifier.is_none() && service_bundle_identifier.is_none() {
        return ComputerUseOfficialParentHandoffKind::Unknown;
    }

    ComputerUseOfficialParentHandoffKind::HandoffUnavailable
}

fn official_parent_handoff_message(kind: ComputerUseOfficialParentHandoffKind) -> &'static str {
    match kind {
        ComputerUseOfficialParentHandoffKind::HandoffCandidateFound => {
            "Official Codex metadata contains a handoff candidate. This is evidence only and does not enable runtime integration."
        }
        ComputerUseOfficialParentHandoffKind::HandoffUnavailable => {
            "No supported official parent handoff method was detected from readable metadata."
        }
        ComputerUseOfficialParentHandoffKind::RequiresOfficialParent => {
            "Readable metadata points to an official OpenAI parent/team contract, but no public handoff entry was detected."
        }
        ComputerUseOfficialParentHandoffKind::Unknown => {
            "Official parent handoff discovery could not classify the available metadata."
        }
    }
}

fn app_info_plist_path(app_root: &Path) -> PathBuf {
    app_root.join("Contents").join("Info.plist")
}

fn read_file_to_string_if_file(path: &Path) -> Option<String> {
    path.is_file()
        .then(|| fs::read_to_string(path).ok())
        .flatten()
}

fn find_nearest_app_bundle_root(path: &Path) -> Option<&Path> {
    path.ancestors().find(|ancestor| {
        ancestor
            .extension()
            .is_some_and(|extension| extension == "app")
    })
}

fn find_ancestor_app_bundle_named<'a>(path: &'a Path, app_name: &str) -> Option<&'a Path> {
    path.ancestors().find(|ancestor| {
        ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == app_name)
    })
}

fn resolve_service_app_root_from_helper_app(helper_app_root: &Path) -> Option<&Path> {
    helper_app_root
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .filter(|path| path.extension().is_some_and(|extension| extension == "app"))
}

fn collect_application_groups(plists: [Option<&str>; 2]) -> Vec<String> {
    let mut groups = Vec::new();
    for contents in plists.into_iter().flatten() {
        for group in plist_array_strings(contents, "com.apple.security.application-groups") {
            if !groups.contains(&group) {
                groups.push(group);
            }
        }
    }
    groups
}

fn collect_xpc_service_identifiers(
    root: &Path,
    max_depth: usize,
    max_entries: usize,
) -> Vec<String> {
    let mut identifiers = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited_entries = 0usize;

    while let Some((path, depth)) = stack.pop() {
        if visited_entries >= max_entries || depth > max_depth {
            break;
        }

        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };

        for entry in entries.filter_map(Result::ok) {
            if visited_entries >= max_entries {
                break;
            }
            visited_entries += 1;
            let entry_path = entry.path();
            if entry_path
                .extension()
                .is_some_and(|extension| extension == "xpc")
            {
                let info_path = app_info_plist_path(&entry_path);
                if let Some(identifier) = read_file_to_string_if_file(&info_path)
                    .as_deref()
                    .and_then(|contents| plist_string(contents, "CFBundleIdentifier"))
                {
                    identifiers.push(identifier);
                }
                continue;
            }

            if depth < max_depth && entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
                stack.push((entry_path, depth + 1));
            }
        }
    }

    identifiers.sort();
    identifiers.dedup();
    identifiers
}

async fn collect_host_contract_command_evidence(
    helper_path: Option<&str>,
) -> (
    ComputerUseHostCommandEvidence,
    ComputerUseHostCommandEvidence,
) {
    let Some(path) = helper_path else {
        return (
            skipped_host_command_evidence("codesign", "helper path unavailable"),
            skipped_host_command_evidence("spctl", "helper path unavailable"),
        );
    };

    let codesign = run_host_contract_command("codesign", &["-dv", "--verbose=2", path]).await;
    let spctl = run_host_contract_command("spctl", &["--assess", "--type", "execute", path]).await;
    (codesign, spctl)
}

async fn run_host_contract_command(program: &str, args: &[&str]) -> ComputerUseHostCommandEvidence {
    let mut command = crate::utils::async_command(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ComputerUseHostCommandEvidence {
                summary: format!("{program} unavailable: {error}"),
                stdout_snippet: None,
                stderr_snippet: None,
            };
        }
    };

    let output = match tokio::time::timeout(
        Duration::from_millis(COMPUTER_USE_HOST_CONTRACT_COMMAND_TIMEOUT_MS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return ComputerUseHostCommandEvidence {
                summary: format!("{program} failed while waiting for output: {error}"),
                stdout_snippet: None,
                stderr_snippet: None,
            };
        }
        Err(_) => {
            return ComputerUseHostCommandEvidence {
                summary: format!(
                    "{program} timed out after {}ms",
                    COMPUTER_USE_HOST_CONTRACT_COMMAND_TIMEOUT_MS
                ),
                stdout_snippet: None,
                stderr_snippet: None,
            };
        }
    };

    let exit_code = output.status.code().unwrap_or(-1);
    let stdout_snippet = output_snippet(&String::from_utf8_lossy(&output.stdout));
    let stderr_snippet = output_snippet(&String::from_utf8_lossy(&output.stderr));
    let summary_detail = stderr_snippet
        .as_deref()
        .or(stdout_snippet.as_deref())
        .map(|snippet| format!(": {snippet}"))
        .unwrap_or_default();

    ComputerUseHostCommandEvidence {
        summary: format!("{program} exited with status {exit_code}{summary_detail}"),
        stdout_snippet,
        stderr_snippet,
    }
}

fn skipped_host_command_evidence(program: &str, reason: &str) -> ComputerUseHostCommandEvidence {
    ComputerUseHostCommandEvidence {
        summary: format!("{program} skipped: {reason}"),
        stdout_snippet: None,
        stderr_snippet: None,
    }
}

fn first_available_snippet<const N: usize>(snippets: [Option<String>; N]) -> Option<String> {
    snippets.into_iter().find_map(|snippet| snippet)
}

async fn run_helper_bridge_probe(
    helper_path: &str,
    helper_descriptor_path: Option<&str>,
) -> ComputerUseHelperProbeExecution {
    let started_at = Instant::now();
    let Some(launch_spec) = resolve_helper_probe_launch_spec(helper_descriptor_path, helper_path)
    else {
        return ComputerUseHelperProbeExecution {
            succeeded: false,
            failure_kind: Some(ComputerUseActivationFailureKind::IneligibleHost),
            diagnostic_message:
                "Computer Use helper descriptor could not be resolved into a launch contract."
                    .to_string(),
            stderr_snippet: None,
            exit_code: None,
            duration_ms: started_at.elapsed().as_millis() as u64,
        };
    };

    if should_use_diagnostics_only_probe(&launch_spec.command_path) {
        return ComputerUseHelperProbeExecution {
            succeeded: false,
            failure_kind: Some(ComputerUseActivationFailureKind::HostIncompatible),
            diagnostic_message:
                "Computer Use helper is packaged as a nested app-bundle CLI. This host now uses diagnostics-only fallback instead of direct exec because macOS can reject that launch path outside the official Codex parent contract."
                    .to_string(),
            stderr_snippet: Some(format!(
                "Skipped direct helper launch for {} {}",
                launch_spec.command_path.display(),
                launch_spec.args.join(" ")
            )),
            exit_code: None,
            duration_ms: started_at.elapsed().as_millis() as u64,
        };
    }

    if launch_spec_looks_like_codex_cli_plugin_contract(&launch_spec) {
        if !launch_spec.command_path.is_file() {
            return ComputerUseHelperProbeExecution {
                succeeded: false,
                failure_kind: Some(ComputerUseActivationFailureKind::LaunchFailed),
                diagnostic_message: "Codex CLI Computer Use helper path is not a file.".to_string(),
                stderr_snippet: None,
                exit_code: None,
                duration_ms: started_at.elapsed().as_millis() as u64,
            };
        }

        if !launch_spec.args.iter().any(|arg| arg == "mcp") {
            return ComputerUseHelperProbeExecution {
                succeeded: false,
                failure_kind: Some(ComputerUseActivationFailureKind::IneligibleHost),
                diagnostic_message:
                    "Codex CLI Computer Use descriptor is missing the expected mcp argument."
                        .to_string(),
                stderr_snippet: None,
                exit_code: None,
                duration_ms: started_at.elapsed().as_millis() as u64,
            };
        }

        return ComputerUseHelperProbeExecution {
            succeeded: true,
            failure_kind: None,
            diagnostic_message:
                "Codex CLI Computer Use plugin cache launch contract verified. CodePort did not direct-exec the helper; Codex CLI remains the supported parent."
                    .to_string(),
            stderr_snippet: None,
            exit_code: None,
            duration_ms: started_at.elapsed().as_millis() as u64,
        };
    }

    let mut command = crate::utils::async_command(&launch_spec.command_path);
    command
        .args(&launch_spec.args)
        .arg(COMPUTER_USE_ACTIVATION_HELP_ARG)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .current_dir(&launch_spec.current_dir);

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ComputerUseHelperProbeExecution {
                succeeded: false,
                failure_kind: Some(ComputerUseActivationFailureKind::LaunchFailed),
                diagnostic_message: format!(
                    "Failed to start the official Computer Use helper probe: {error}"
                ),
                stderr_snippet: None,
                exit_code: None,
                duration_ms: started_at.elapsed().as_millis() as u64,
            };
        }
    };

    let output = match tokio::time::timeout(
        Duration::from_millis(COMPUTER_USE_ACTIVATION_TIMEOUT_MS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return ComputerUseHelperProbeExecution {
                succeeded: false,
                failure_kind: Some(ComputerUseActivationFailureKind::LaunchFailed),
                diagnostic_message: format!(
                    "Computer Use helper probe started but failed while waiting for output: {error}"
                ),
                stderr_snippet: None,
                exit_code: None,
                duration_ms: started_at.elapsed().as_millis() as u64,
            };
        }
        Err(_) => {
            return ComputerUseHelperProbeExecution {
                succeeded: false,
                failure_kind: Some(ComputerUseActivationFailureKind::Timeout),
                diagnostic_message: format!(
                    "Computer Use helper probe did not finish within {}ms.",
                    COMPUTER_USE_ACTIVATION_TIMEOUT_MS
                ),
                stderr_snippet: None,
                exit_code: None,
                duration_ms: started_at.elapsed().as_millis() as u64,
            };
        }
    };

    let duration_ms = started_at.elapsed().as_millis() as u64;
    let stdout_snippet = output_snippet(&String::from_utf8_lossy(&output.stdout));
    let stderr_snippet = output_snippet(&String::from_utf8_lossy(&output.stderr));

    if !output.status.success() {
        return ComputerUseHelperProbeExecution {
            succeeded: false,
            failure_kind: Some(ComputerUseActivationFailureKind::NonZeroExit),
            diagnostic_message: format!(
                "Computer Use helper probe exited with non-zero status {}.",
                output.status.code().unwrap_or(-1)
            ),
            stderr_snippet: stderr_snippet.or(stdout_snippet),
            exit_code: output.status.code(),
            duration_ms,
        };
    }

    let diagnostic_message = match stdout_snippet {
        Some(snippet) => format!(
            "Computer Use helper accepted '--help' within {}ms. Sample output: {snippet}",
            duration_ms
        ),
        None => format!(
            "Computer Use helper accepted '--help' within {}ms.",
            duration_ms
        ),
    };

    ComputerUseHelperProbeExecution {
        succeeded: true,
        failure_kind: None,
        diagnostic_message,
        stderr_snippet,
        exit_code: output.status.code(),
        duration_ms,
    }
}

fn resolve_helper_probe_launch_spec(
    helper_descriptor_path: Option<&str>,
    helper_path: &str,
) -> Option<ComputerUseHelperLaunchSpec> {
    if let Some(descriptor_path) = helper_descriptor_path.map(PathBuf::from) {
        if let Some(descriptor) = parse_helper_descriptor(&descriptor_path) {
            return Some(ComputerUseHelperLaunchSpec {
                command_path: descriptor.command_path,
                args: descriptor.args,
                current_dir: descriptor.current_dir,
            });
        }
    }

    Some(ComputerUseHelperLaunchSpec {
        command_path: PathBuf::from(helper_path),
        args: Vec::new(),
        current_dir: Path::new(helper_path).parent()?.to_path_buf(),
    })
}

fn should_use_diagnostics_only_probe(command_path: &Path) -> bool {
    cfg!(target_os = "macos")
        && path_looks_like_nested_app_binary(command_path)
        && !path_looks_like_codex_cli_computer_use_cache(command_path)
        && !current_host_looks_like_official_codex()
}

fn current_host_looks_like_official_codex() -> bool {
    std::env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().contains("/Codex.app/"))
        .unwrap_or(false)
}

fn path_looks_like_nested_app_binary(path: &Path) -> bool {
    path.to_string_lossy().contains(".app/Contents/MacOS/")
}

fn launch_spec_looks_like_codex_cli_plugin_contract(
    launch_spec: &ComputerUseHelperLaunchSpec,
) -> bool {
    path_looks_like_codex_cli_computer_use_cache(&launch_spec.command_path)
        || path_looks_like_codex_cli_computer_use_cache(&launch_spec.current_dir)
}

fn path_looks_like_codex_cli_computer_use_cache(path: &Path) -> bool {
    if resolve_computer_use_cache_root()
        .as_ref()
        .is_some_and(|root| path.starts_with(root))
    {
        return true;
    }

    path.to_string_lossy()
        .replace('\\', "/")
        .contains("/plugins/cache/openai-bundled/computer-use/")
}

fn output_snippet(output: &str) -> Option<String> {
    let compact = output.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return None;
    }
    let snippet: String = compact
        .chars()
        .take(COMPUTER_USE_ACTIVATION_SNIPPET_LIMIT)
        .collect();
    if compact.chars().count() > COMPUTER_USE_ACTIVATION_SNIPPET_LIMIT {
        Some(format!("{snippet}..."))
    } else {
        Some(snippet)
    }
}

fn dedupe_guidance_codes(
    guidance_codes: Vec<ComputerUseGuidanceCode>,
) -> Vec<ComputerUseGuidanceCode> {
    let mut deduped = Vec::new();
    for code in guidance_codes {
        if !deduped.contains(&code) {
            deduped.push(code);
        }
    }
    deduped
}

fn resolve_computer_use_cache_root() -> Option<PathBuf> {
    codex_home::resolve_default_codex_home().map(|root| {
        root.join("plugins")
            .join("cache")
            .join("openai-bundled")
            .join(COMPUTER_USE_PLUGIN_NAME)
    })
}

fn detect_plugin_manifest_path(cache_root: Option<&Path>) -> Option<PathBuf> {
    let root = cache_root?;
    let entries = fs::read_dir(root).ok()?;
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_dir() {
                return None;
            }
            let manifest_path = entry.path().join(".codex-plugin").join("plugin.json");
            manifest_path.is_file().then_some(manifest_path)
        })
        .max_by(|left, right| compare_plugin_manifest_paths(left, right))
}

fn plugin_root_from_manifest_path(manifest_path: &Path) -> Option<PathBuf> {
    manifest_path
        .parent()
        .and_then(|plugin_dir| {
            (plugin_dir.file_name().and_then(|name| name.to_str()) == Some(".codex-plugin"))
                .then_some(plugin_dir)
        })
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

fn compare_plugin_manifest_paths(left: &PathBuf, right: &PathBuf) -> Ordering {
    let left_numbers = plugin_manifest_version_numbers(left);
    let right_numbers = plugin_manifest_version_numbers(right);
    match compare_version_number_slices(&left_numbers, &right_numbers) {
        Ordering::Equal => {
            plugin_manifest_version_label(left).cmp(&plugin_manifest_version_label(right))
        }
        ordering => ordering,
    }
}

fn compare_version_number_slices(left: &[u64], right: &[u64]) -> Ordering {
    let max_len = left.len().max(right.len());
    for index in 0..max_len {
        let left_value = *left.get(index).unwrap_or(&0);
        let right_value = *right.get(index).unwrap_or(&0);
        match left_value.cmp(&right_value) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    Ordering::Equal
}

fn plugin_manifest_version_label(path: &Path) -> String {
    path.parent()
        .and_then(Path::parent)
        .and_then(|version_dir| version_dir.file_name())
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_default()
}

fn plugin_manifest_version_numbers(path: &Path) -> Vec<u64> {
    let label = plugin_manifest_version_label(path);
    let mut numbers = Vec::new();
    let mut digits = String::new();

    for character in label.chars() {
        if character.is_ascii_digit() {
            digits.push(character);
            continue;
        }
        if !digits.is_empty() {
            if let Ok(value) = digits.parse::<u64>() {
                numbers.push(value);
            }
            digits.clear();
        }
    }

    if !digits.is_empty() {
        if let Ok(value) = digits.parse::<u64>() {
            numbers.push(value);
        }
    }

    numbers
}

fn read_plugin_enabled_from_config(path: &Path) -> Result<Option<bool>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("failed to read codex config {}: {error}", path.display()))?;
    let parsed: toml::Value = toml::from_str(&contents)
        .map_err(|error| format!("failed to parse codex config {}: {error}", path.display()))?;

    Ok(parsed
        .get("plugins")
        .and_then(|value| value.as_table())
        .and_then(|plugins| plugins.get(COMPUTER_USE_PLUGIN_ID))
        .and_then(|plugin| plugin.as_table())
        .and_then(|plugin| plugin.get("enabled"))
        .and_then(|value| value.as_bool()))
}

fn path_to_string(path: PathBuf) -> Option<String> {
    path.to_str().map(|value| value.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ComputerUseHelperDescriptor {
    command_path: PathBuf,
    args: Vec<String>,
    current_dir: PathBuf,
}

pub(crate) fn parse_helper_command_path(path: &Path) -> Option<String> {
    parse_helper_descriptor(path).and_then(|descriptor| path_to_string(descriptor.command_path))
}

fn apply_helper_descriptor_path(snapshot: &mut ComputerUseDetectionSnapshot, path: &Path) {
    snapshot.helper_descriptor_path = path_to_string(path.to_path_buf());
    snapshot.helper_path = parse_helper_command_path(path);
    snapshot.helper_present = snapshot
        .helper_path
        .as_ref()
        .map(PathBuf::from)
        .is_some_and(|path| path.is_file());
}

fn parse_helper_descriptor(path: &Path) -> Option<ComputerUseHelperDescriptor> {
    let contents = fs::read_to_string(path).ok()?;
    let payload: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let servers = payload
        .get("mcpServers")
        .and_then(|value| value.as_object())?;
    let server = servers.get(COMPUTER_USE_MCP_SERVER_NAME).or_else(|| {
        (servers.len() == 1)
            .then(|| servers.values().next())
            .flatten()
    })?;

    let descriptor_dir = path.parent()?;
    let current_dir = server
        .get("cwd")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|cwd| {
            if cwd.is_absolute() {
                cwd
            } else {
                descriptor_dir.join(cwd)
            }
        })
        .unwrap_or_else(|| descriptor_dir.to_path_buf());

    let command_value = server
        .get("command")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let command = PathBuf::from(command_value);
    let command_path = if command.is_absolute() {
        command
    } else {
        normalize_path(current_dir.join(command))
    };

    let args = match server.get("args") {
        Some(value) => value
            .as_array()?
            .iter()
            .map(|item| item.as_str().map(ToOwned::to_owned))
            .collect::<Option<Vec<_>>>()?,
        None => Vec::new(),
    };

    Some(ComputerUseHelperDescriptor {
        command_path,
        args,
        current_dir,
    })
}

fn normalize_path(path: PathBuf) -> PathBuf {
    path.components()
        .fold(PathBuf::new(), |mut normalized, component| {
            normalized.push(component.as_os_str());
            normalized
        })
}

impl ComputerUseActivationVerification {
    fn from_snapshot(snapshot: &ComputerUseDetectionSnapshot) -> Option<Self> {
        Some(Self {
            helper_identity: ComputerUseActivationIdentity::from_snapshot(snapshot)?,
        })
    }

    fn applies_to(&self, snapshot: &ComputerUseDetectionSnapshot) -> bool {
        self.helper_identity.matches_snapshot(snapshot)
    }
}

impl ComputerUseActivationIdentity {
    fn from_snapshot(snapshot: &ComputerUseDetectionSnapshot) -> Option<Self> {
        Some(Self {
            helper_path: snapshot.helper_path.clone()?,
            helper_descriptor_path: snapshot.helper_descriptor_path.clone(),
            plugin_manifest_path: snapshot.plugin_manifest_path.clone(),
        })
    }

    fn matches_snapshot(&self, snapshot: &ComputerUseDetectionSnapshot) -> bool {
        snapshot.helper_path.as_deref() == Some(self.helper_path.as_str())
            && snapshot.helper_descriptor_path == self.helper_descriptor_path
            && snapshot.plugin_manifest_path == self.plugin_manifest_path
    }
}

#[cfg(test)]
mod plugin_contract_tests;

#[cfg(test)]
#[path = "computer_use_tests.rs"]
mod tests;
