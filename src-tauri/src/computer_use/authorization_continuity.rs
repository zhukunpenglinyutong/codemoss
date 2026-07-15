use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::types::BackendMode;

use super::{output_snippet, path_to_string};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseAuthorizationBackendMode {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseAuthorizationHostRole {
    ForegroundApp,
    Daemon,
    DebugBinary,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseAuthorizationLaunchMode {
    PackagedApp,
    Daemon,
    Debug,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerUseAuthorizationContinuityKind {
    Unknown,
    NoSuccessfulHost,
    MatchingHost,
    HostDriftDetected,
    UnsupportedContext,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerUseAuthorizationHostSnapshot {
    pub(crate) display_name: String,
    pub(crate) executable_path: String,
    pub(crate) identifier: Option<String>,
    pub(crate) team_identifier: Option<String>,
    pub(crate) backend_mode: ComputerUseAuthorizationBackendMode,
    pub(crate) host_role: ComputerUseAuthorizationHostRole,
    pub(crate) launch_mode: ComputerUseAuthorizationLaunchMode,
    pub(crate) signing_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerUseAuthorizationContinuityStatus {
    pub(crate) kind: ComputerUseAuthorizationContinuityKind,
    pub(crate) diagnostic_message: Option<String>,
    pub(crate) current_host: Option<ComputerUseAuthorizationHostSnapshot>,
    pub(crate) last_successful_host: Option<ComputerUseAuthorizationHostSnapshot>,
    pub(crate) drift_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
struct ComputerUseAuthorizationContinuityStore {
    last_successful_host: Option<ComputerUseAuthorizationHostSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct ComputerUseHostSigningMetadata {
    identifier: Option<String>,
    team_identifier: Option<String>,
    signing_summary: Option<String>,
}

pub(crate) fn computer_use_authorization_continuity_path(settings_path: &Path) -> PathBuf {
    settings_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("computer_use_authorization_continuity.json")
}

pub(crate) fn persist_last_successful_authorization_host(
    continuity_store_path: &Path,
    host: &ComputerUseAuthorizationHostSnapshot,
) -> Result<(), String> {
    crate::storage::write_json_file(
        continuity_store_path,
        &ComputerUseAuthorizationContinuityStore {
            last_successful_host: Some(host.clone()),
        },
    )
}

pub(crate) fn build_authorization_continuity_status(
    backend_mode: BackendMode,
    continuity_store_path: &Path,
) -> ComputerUseAuthorizationContinuityStatus {
    let current_host = capture_current_authorization_host_snapshot(backend_mode.clone());
    let last_successful_host = read_last_successful_authorization_host(continuity_store_path);

    let Some(current_host) = current_host else {
        return ComputerUseAuthorizationContinuityStatus {
            kind: ComputerUseAuthorizationContinuityKind::Unknown,
            diagnostic_message: Some(
                "Current Computer Use authorization host could not be resolved from this process."
                    .to_string(),
            ),
            current_host: None,
            last_successful_host,
            drift_fields: Vec::new(),
        };
    };

    if let Some(message) = unsupported_authorization_context_message(&current_host) {
        return ComputerUseAuthorizationContinuityStatus {
            kind: ComputerUseAuthorizationContinuityKind::UnsupportedContext,
            diagnostic_message: Some(message),
            current_host: Some(current_host),
            last_successful_host,
            drift_fields: Vec::new(),
        };
    }

    let drift_fields = last_successful_host
        .as_ref()
        .map(|last_successful| authorization_host_drift_fields(&current_host, last_successful))
        .unwrap_or_default();

    let (kind, diagnostic_message) = match last_successful_host.as_ref() {
        Some(_) if !drift_fields.is_empty() => (
            ComputerUseAuthorizationContinuityKind::HostDriftDetected,
            Some(format!(
                "Current Computer Use authorization host drifted from the last successful host. Drift fields: {}.",
                drift_fields.join(", ")
            )),
        ),
        Some(_) => (
            ComputerUseAuthorizationContinuityKind::MatchingHost,
            Some(
                "Current Computer Use authorization host matches the last successful host."
                    .to_string(),
            ),
        ),
        None => (
            ComputerUseAuthorizationContinuityKind::NoSuccessfulHost,
            Some(
                "No successful Computer Use authorization host has been recorded for this app data directory yet."
                    .to_string(),
            ),
        ),
    };

    ComputerUseAuthorizationContinuityStatus {
        kind,
        diagnostic_message,
        current_host: Some(current_host),
        last_successful_host,
        drift_fields,
    }
}

fn read_last_successful_authorization_host(
    continuity_store_path: &Path,
) -> Option<ComputerUseAuthorizationHostSnapshot> {
    crate::storage::read_json_file::<ComputerUseAuthorizationContinuityStore>(continuity_store_path)
        .ok()
        .flatten()
        .and_then(|store| store.last_successful_host)
}

fn capture_current_authorization_host_snapshot(
    backend_mode: BackendMode,
) -> Option<ComputerUseAuthorizationHostSnapshot> {
    let current_executable = std::env::current_exe().ok()?;
    let executable_path = path_to_string(current_executable.clone())?;
    let backend_mode = authorization_backend_mode(&backend_mode);
    let host_role = authorization_host_role_for_path(&current_executable);
    let launch_mode = authorization_launch_mode_for_path(&current_executable);
    let signing_metadata = read_current_host_signing_metadata(&current_executable);
    let display_name = authorization_host_display_name(&current_executable, host_role);

    Some(ComputerUseAuthorizationHostSnapshot {
        display_name,
        executable_path,
        identifier: signing_metadata.identifier,
        team_identifier: signing_metadata.team_identifier,
        backend_mode,
        host_role,
        launch_mode,
        signing_summary: signing_metadata.signing_summary,
    })
}

fn authorization_backend_mode(backend_mode: &BackendMode) -> ComputerUseAuthorizationBackendMode {
    match backend_mode {
        BackendMode::Local => ComputerUseAuthorizationBackendMode::Local,
        BackendMode::Remote => ComputerUseAuthorizationBackendMode::Remote,
    }
}

fn authorization_host_role_for_path(path: &Path) -> ComputerUseAuthorizationHostRole {
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if normalized.contains("/target/debug/") || normalized.contains("/target/release/") {
        return ComputerUseAuthorizationHostRole::DebugBinary;
    }

    if file_name.contains("daemon") {
        return ComputerUseAuthorizationHostRole::Daemon;
    }

    if normalized.contains(".app/contents/macos/") {
        return ComputerUseAuthorizationHostRole::ForegroundApp;
    }

    ComputerUseAuthorizationHostRole::Unknown
}

fn authorization_launch_mode_for_path(path: &Path) -> ComputerUseAuthorizationLaunchMode {
    match authorization_host_role_for_path(path) {
        ComputerUseAuthorizationHostRole::DebugBinary => ComputerUseAuthorizationLaunchMode::Debug,
        ComputerUseAuthorizationHostRole::Daemon => ComputerUseAuthorizationLaunchMode::Daemon,
        ComputerUseAuthorizationHostRole::ForegroundApp => {
            ComputerUseAuthorizationLaunchMode::PackagedApp
        }
        ComputerUseAuthorizationHostRole::Unknown => ComputerUseAuthorizationLaunchMode::Unknown,
    }
}

fn authorization_host_display_name(
    path: &Path,
    host_role: ComputerUseAuthorizationHostRole,
) -> String {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown-host");

    match host_role {
        ComputerUseAuthorizationHostRole::DebugBinary => format!("{file_name} (debug)"),
        _ => file_name.to_string(),
    }
}

fn read_current_host_signing_metadata(path: &Path) -> ComputerUseHostSigningMetadata {
    let path_str = path.to_string_lossy().to_string();
    let output = match std::process::Command::new("codesign")
        .args(["-dv", "--verbose=4", &path_str])
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return ComputerUseHostSigningMetadata {
                signing_summary: Some(format!("codesign unavailable: {error}")),
                ..ComputerUseHostSigningMetadata::default()
            };
        }
    };

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let detail = if stderr.trim().is_empty() {
        &stdout
    } else {
        &stderr
    };

    ComputerUseHostSigningMetadata {
        identifier: parse_codesign_field(detail.as_str(), "Identifier="),
        team_identifier: parse_codesign_field(detail.as_str(), "TeamIdentifier="),
        signing_summary: output_snippet(detail.as_str()),
    }
}

fn parse_codesign_field(output: &str, prefix: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.trim().strip_prefix(prefix).map(str::trim))
        .filter(|value| !value.is_empty() && *value != "not set")
        .map(ToString::to_string)
}

fn unsupported_authorization_context_message(
    current_host: &ComputerUseAuthorizationHostSnapshot,
) -> Option<String> {
    match current_host.backend_mode {
        ComputerUseAuthorizationBackendMode::Remote => Some(
            "Computer Use authorization continuity is blocked in remote backend mode until the broker is explicitly routed through a verifiable remote host."
                .to_string(),
        ),
        ComputerUseAuthorizationBackendMode::Local => match current_host.launch_mode {
            ComputerUseAuthorizationLaunchMode::PackagedApp
                if packaged_app_sender_lacks_stable_signing_identity(current_host) =>
            {
                Some(
                    "Computer Use authorization continuity is blocked because the current packaged app sender is not signed with a stable Developer ID identity. Rebuild and relaunch a signed packaged app before retrying."
                        .to_string(),
                )
            }
            ComputerUseAuthorizationLaunchMode::Debug => Some(
                "Computer Use authorization continuity is blocked while running from a debug binary. Re-authorize the packaged app host or switch back to the packaged app before retrying."
                    .to_string(),
            ),
            ComputerUseAuthorizationLaunchMode::Daemon => Some(
                "Computer Use authorization continuity is blocked while the local daemon is the active sender. Route broker execution through the packaged app host before retrying."
                    .to_string(),
            ),
            ComputerUseAuthorizationLaunchMode::PackagedApp
            | ComputerUseAuthorizationLaunchMode::Unknown => None,
        },
    }
}

fn packaged_app_sender_lacks_stable_signing_identity(
    current_host: &ComputerUseAuthorizationHostSnapshot,
) -> bool {
    if current_host.launch_mode != ComputerUseAuthorizationLaunchMode::PackagedApp {
        return false;
    }

    if current_host.team_identifier.is_none() {
        return true;
    }

    let normalized_summary = current_host
        .signing_summary
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();

    normalized_summary.contains("adhoc")
        || normalized_summary.contains("linker-signed")
        || normalized_summary.contains("teamidentifier=not set")
}

fn authorization_host_drift_fields(
    current_host: &ComputerUseAuthorizationHostSnapshot,
    last_successful_host: &ComputerUseAuthorizationHostSnapshot,
) -> Vec<String> {
    let mut fields = Vec::new();

    if current_host.identifier != last_successful_host.identifier {
        fields.push("identifier".to_string());
    }
    if current_host.team_identifier != last_successful_host.team_identifier {
        fields.push("team_identifier".to_string());
    }
    if current_host.backend_mode != last_successful_host.backend_mode {
        fields.push("backend_mode".to_string());
    }
    if current_host.host_role != last_successful_host.host_role {
        fields.push("host_role".to_string());
    }
    if current_host.launch_mode != last_successful_host.launch_mode {
        fields.push("launch_mode".to_string());
    }
    if current_host.signing_summary != last_successful_host.signing_summary {
        fields.push("signing_summary".to_string());
    }
    if !authorization_host_paths_match(
        &current_host.executable_path,
        &last_successful_host.executable_path,
    ) {
        fields.push("executable_path".to_string());
    }

    fields
}

fn authorization_host_paths_match(current_path: &str, last_successful_path: &str) -> bool {
    let normalized_current = normalize_authorization_host_path_for_compare(current_path);
    let normalized_last = normalize_authorization_host_path_for_compare(last_successful_path);
    if normalized_current == normalized_last {
        return true;
    }

    match (
        canonicalize_authorization_host_path(current_path),
        canonicalize_authorization_host_path(last_successful_path),
    ) {
        (Some(current), Some(last_successful)) => current == last_successful,
        _ => false,
    }
}

fn normalize_authorization_host_path_for_compare(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if cfg!(target_os = "windows") {
        normalized.make_ascii_lowercase();
    }
    normalized
}

fn canonicalize_authorization_host_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let canonical = std::fs::canonicalize(trimmed).ok()?;
    let canonical_string = path_to_string(canonical)?;
    Some(normalize_authorization_host_path_for_compare(
        canonical_string.as_str(),
    ))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn host_snapshot(
        executable_path: &str,
        backend_mode: ComputerUseAuthorizationBackendMode,
        host_role: ComputerUseAuthorizationHostRole,
        launch_mode: ComputerUseAuthorizationLaunchMode,
    ) -> ComputerUseAuthorizationHostSnapshot {
        ComputerUseAuthorizationHostSnapshot {
            display_name: Path::new(executable_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("host")
                .to_string(),
            executable_path: executable_path.to_string(),
            identifier: Some("com.zhukunpenglinyutong.ccgui".to_string()),
            team_identifier: Some("RLHBM56QRH".to_string()),
            backend_mode,
            host_role,
            launch_mode,
            signing_summary: Some("Identifier=com.zhukunpenglinyutong.ccgui".to_string()),
        }
    }

    #[test]
    fn authorization_host_role_classifies_debug_and_daemon_paths() {
        assert_eq!(
            authorization_host_role_for_path(Path::new(
                "/Users/demo/code/project/target/debug/cc-gui"
            )),
            ComputerUseAuthorizationHostRole::DebugBinary
        );
        assert_eq!(
            authorization_launch_mode_for_path(Path::new(
                "/Applications/CodePort.app/Contents/MacOS/cc_gui_daemon"
            )),
            ComputerUseAuthorizationLaunchMode::Daemon
        );
        assert_eq!(
            authorization_launch_mode_for_path(Path::new(
                "/Applications/CodePort.app/Contents/MacOS/cc-gui"
            )),
            ComputerUseAuthorizationLaunchMode::PackagedApp
        );
    }

    #[test]
    fn authorization_continuity_detects_drifted_last_successful_host() {
        let temp_path = std::env::temp_dir().join(format!(
            "computer-use-continuity-{}.json",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let store = ComputerUseAuthorizationContinuityStore {
            last_successful_host: Some(host_snapshot(
                "/Applications/CodePort.app/Contents/MacOS/cc-gui",
                ComputerUseAuthorizationBackendMode::Local,
                ComputerUseAuthorizationHostRole::ForegroundApp,
                ComputerUseAuthorizationLaunchMode::PackagedApp,
            )),
        };
        crate::storage::write_json_file(&temp_path, &store).expect("write continuity store");

        let current_host = host_snapshot(
            "/Users/demo/code/project/target/debug/cc-gui",
            ComputerUseAuthorizationBackendMode::Local,
            ComputerUseAuthorizationHostRole::DebugBinary,
            ComputerUseAuthorizationLaunchMode::Debug,
        );
        let last_successful_host =
            read_last_successful_authorization_host(&temp_path).expect("last successful host");
        let drift_fields = authorization_host_drift_fields(&current_host, &last_successful_host);

        assert!(drift_fields.contains(&"host_role".to_string()));
        assert!(drift_fields.contains(&"launch_mode".to_string()));
        assert!(drift_fields.contains(&"executable_path".to_string()));

        let _ = std::fs::remove_file(temp_path);
    }

    #[test]
    fn persist_last_successful_authorization_host_round_trips_snapshot() {
        let temp_path = std::env::temp_dir().join(format!(
            "computer-use-continuity-roundtrip-{}.json",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let expected_host = host_snapshot(
            "/Applications/CodePort.app/Contents/MacOS/cc-gui",
            ComputerUseAuthorizationBackendMode::Local,
            ComputerUseAuthorizationHostRole::ForegroundApp,
            ComputerUseAuthorizationLaunchMode::PackagedApp,
        );

        persist_last_successful_authorization_host(&temp_path, &expected_host)
            .expect("persist continuity store");

        let actual_host =
            read_last_successful_authorization_host(&temp_path).expect("read continuity store");
        assert_eq!(actual_host, expected_host);

        let _ = std::fs::remove_file(temp_path);
    }

    #[test]
    fn authorization_host_drift_fields_are_empty_for_matching_host() {
        let host = host_snapshot(
            "/Applications/CodePort.app/Contents/MacOS/cc-gui",
            ComputerUseAuthorizationBackendMode::Local,
            ComputerUseAuthorizationHostRole::ForegroundApp,
            ComputerUseAuthorizationLaunchMode::PackagedApp,
        );

        assert!(
            authorization_host_drift_fields(&host, &host).is_empty(),
            "matching hosts must not report drift fields"
        );
    }

    #[test]
    fn authorization_host_drift_fields_ignore_canonical_equivalent_executable_paths() {
        let temp_root = std::env::temp_dir().join(format!(
            "computer-use-host-path-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let executable_dir = temp_root.join("Codex.app").join("Contents").join("MacOS");
        fs::create_dir_all(&executable_dir).expect("create executable dir");
        let executable_path = executable_dir.join("Codex");
        fs::write(&executable_path, "").expect("write executable");

        let canonical_path = executable_path
            .canonicalize()
            .expect("canonicalize executable");
        let equivalent_path = executable_dir.join(".").join("Codex");
        let current_host = host_snapshot(
            canonical_path.to_str().expect("canonical path"),
            ComputerUseAuthorizationBackendMode::Local,
            ComputerUseAuthorizationHostRole::ForegroundApp,
            ComputerUseAuthorizationLaunchMode::PackagedApp,
        );
        let last_successful_host = host_snapshot(
            equivalent_path.to_str().expect("equivalent path"),
            ComputerUseAuthorizationBackendMode::Local,
            ComputerUseAuthorizationHostRole::ForegroundApp,
            ComputerUseAuthorizationLaunchMode::PackagedApp,
        );

        let drift_fields = authorization_host_drift_fields(&current_host, &last_successful_host);

        assert!(
            !drift_fields.contains(&"executable_path".to_string()),
            "canonical-equivalent executable paths must not report drift"
        );

        let _ = fs::remove_file(&executable_path);
        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn authorization_continuity_reports_unsupported_context_for_remote_mode() {
        let current_host = host_snapshot(
            "/Applications/CodePort.app/Contents/MacOS/cc-gui",
            ComputerUseAuthorizationBackendMode::Remote,
            ComputerUseAuthorizationHostRole::ForegroundApp,
            ComputerUseAuthorizationLaunchMode::PackagedApp,
        );

        assert_eq!(
            unsupported_authorization_context_message(&current_host),
            Some(
                "Computer Use authorization continuity is blocked in remote backend mode until the broker is explicitly routed through a verifiable remote host."
                .to_string()
            )
        );
    }

    #[test]
    fn authorization_continuity_reports_unsupported_context_for_unsigned_packaged_app() {
        let mut current_host = host_snapshot(
            "/Applications/CodePort.app/Contents/MacOS/cc-gui",
            ComputerUseAuthorizationBackendMode::Local,
            ComputerUseAuthorizationHostRole::ForegroundApp,
            ComputerUseAuthorizationLaunchMode::PackagedApp,
        );
        current_host.team_identifier = None;
        current_host.signing_summary =
            Some("flags=0x20002(adhoc,linker-signed) TeamIdentifier=not set".to_string());

        assert_eq!(
            unsupported_authorization_context_message(&current_host),
            Some(
                "Computer Use authorization continuity is blocked because the current packaged app sender is not signed with a stable Developer ID identity. Rebuild and relaunch a signed packaged app before retrying."
                    .to_string()
            )
        );
    }
}
