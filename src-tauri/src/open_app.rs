//! Open the workspace folder in an external app (VS Code / Cursor / IntelliJ)
//! or reveal it in the OS file manager.
//!
//! Lean port of the legacy `workspaces/open_app.rs`: preset probing, custom
//! command targets and OS icon extraction were dropped along with the
//! settings UI; only the four curated header targets remain.

use std::path::PathBuf;

#[cfg(not(target_os = "macos"))]
use std::process::Stdio;

/// Expand a leading `~` and reject empty paths.
pub(crate) fn expand_user_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is empty".to_string());
    }
    if trimmed == "~" {
        return dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string());
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
        return Ok(home.join(rest));
    }
    Ok(PathBuf::from(trimmed))
}

/// Trim whitespace and one layer of wrapping quotes; empty → None.
fn normalize_target_value(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .map(|trimmed| {
            if trimmed.len() >= 2 {
                let double = trimmed.starts_with('"') && trimmed.ends_with('"');
                let single = trimmed.starts_with('\'') && trimmed.ends_with('\'');
                if double || single {
                    return trimmed[1..trimmed.len() - 1].trim();
                }
            }
            trimmed
        })
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn format_exit_detail(code: Option<i32>) -> String {
    code.map(|value| format!("exit code {value}"))
        .unwrap_or_else(|| "terminated by signal".to_string())
}

/// CLI binaries the backend will spawn for "open with" (non-macOS).
/// Anything else is rejected: `app` comes over IPC and a free-form value
/// would be arbitrary command execution.
#[cfg(not(target_os = "macos"))]
const ALLOWED_CLI_BINS: &[&str] = &[
    "code",
    "code-insiders",
    "codium",
    "cursor",
    "idea",
    "idea64",
    "webstorm",
    "subl",
    "zed",
    "atom",
];

/// App names accepted for `open -a` on macOS (exact match after trimming).
#[cfg(target_os = "macos")]
const ALLOWED_MACOS_APPS: &[&str] = &[
    "Visual Studio Code",
    "Visual Studio Code - Insiders",
    "Cursor",
    "IntelliJ IDEA",
    "WebStorm",
    "Sublime Text",
    "Zed",
    "Xcode",
    "Finder",
];

/// Command names / install paths to try for an app, first match wins.
/// `open -a` resolves app bundles on macOS; elsewhere we need a real binary.
/// Returns None when the requested app is not whitelisted.
#[cfg(not(target_os = "macos"))]
fn open_app_command_candidates(app: &str) -> Option<Vec<String>> {
    let trimmed = app.trim();
    // Friendly aliases resolve onto the whitelisted binary names.
    let mapped = match trimmed.to_ascii_lowercase().as_str() {
        "visual studio code" | "vs code" | "vscode" => "code",
        "intellij idea" | "intellij" => "idea",
        other => other,
    };
    if !ALLOWED_CLI_BINS.contains(&mapped) {
        return None;
    }
    let mut candidates = vec![mapped.to_string()];
    let mut push = |candidate: String| {
        if !candidate.is_empty()
            && !candidates
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&candidate))
        {
            candidates.push(candidate);
        }
    };
    match mapped {
        "code" => {
            push("code-insiders".to_string());
            #[cfg(target_os = "windows")]
            for (env, rel) in [
                ("LOCALAPPDATA", "Programs\\Microsoft VS Code\\Code.exe"),
                ("PROGRAMFILES", "Microsoft VS Code\\Code.exe"),
                ("PROGRAMFILES(X86)", "Microsoft VS Code\\Code.exe"),
            ] {
                if let Some(base) = std::env::var_os(env) {
                    let path = PathBuf::from(base).join(rel);
                    if path.is_file() {
                        push(path.to_string_lossy().to_string());
                    }
                }
            }
        }
        "cursor" => {
            #[cfg(target_os = "windows")]
            for (env, rel) in [
                ("LOCALAPPDATA", "Programs\\Cursor\\Cursor.exe"),
                ("PROGRAMFILES", "Cursor\\Cursor.exe"),
            ] {
                if let Some(base) = std::env::var_os(env) {
                    let path = PathBuf::from(base).join(rel);
                    if path.is_file() {
                        push(path.to_string_lossy().to_string());
                    }
                }
            }
        }
        "idea" => {
            #[cfg(target_os = "windows")]
            push("idea64".to_string());
        }
        _ => {}
    }
    Some(candidates)
}

#[cfg(not(target_os = "macos"))]
fn open_with_app_candidates(
    app: &str,
    args: &[String],
    path: &str,
    target_label: &str,
) -> Result<(), String> {
    let Some(candidates) = open_app_command_candidates(app) else {
        return Err(format!("Failed to open app ({target_label}): app is not allowed"));
    };
    let mut last_not_found: Option<std::io::Error> = None;
    for candidate in candidates {
        let mut cmd = std::process::Command::new(&candidate);
        cmd.args(args).arg(path);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        match cmd.spawn() {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                last_not_found = Some(error);
            }
            Err(error) => {
                return Err(format!("Failed to open app ({target_label}): {error}"));
            }
        }
    }
    let detail = last_not_found
        .map(|error| error.to_string())
        .unwrap_or_else(|| "program not found".to_string());
    Err(format!("Failed to open app ({target_label}): {detail}"))
}

/// Open a folder (or file) in an external application by name.
#[tauri::command]
pub(crate) async fn open_workspace_in(
    path: String,
    app: Option<String>,
    args: Vec<String>,
) -> Result<(), String> {
    let app = normalize_target_value(app).ok_or_else(|| "Missing app".to_string())?;
    let target_label = format!("app `{app}`");

    #[cfg(target_os = "macos")]
    {
        if !ALLOWED_MACOS_APPS.contains(&app.as_str()) {
            return Err(format!("Failed to open app ({target_label}): app is not allowed"));
        }
        let mut cmd = tokio::process::Command::new("open");
        cmd.arg("-a").arg(&app).arg(&path);
        if !args.is_empty() {
            cmd.arg("--args").args(&args);
        }
        let status = cmd
            .status()
            .await
            .map_err(|error| format!("Failed to open app ({target_label}): {error}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!(
            "Failed to open app ({target_label} returned {}).",
            format_exit_detail(status.code())
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        open_with_app_candidates(&app, &args, &path, &target_label)
    }
}

/// Reveal a local path in the OS file manager (Finder / Explorer / …).
///
/// Windows uses `explorer /select,…` rather than the opener plugin: the
/// plugin's SHOpenFolderAndSelectItems can fail with non-FILE_NOT_FOUND
/// HRESULTs that it silently swallows, which presents as "click does nothing".
#[tauri::command]
pub(crate) async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let expanded = expand_user_path(&path)?;
    // dunce: strip the \\?\ prefix std::fs::canonicalize adds on Windows;
    // `explorer /select` cannot parse UNC-prefixed paths.
    let canonical = dunce::canonicalize(&expanded)
        .map_err(|error| format!("Failed to resolve path `{path}`: {error}"))?;

    #[cfg(target_os = "macos")]
    {
        let status = tokio::process::Command::new("open")
            .arg("-R")
            .arg(&canonical)
            .status()
            .await
            .map_err(|error| format!("Failed to reveal in Finder: {error}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!(
            "Failed to reveal in Finder ({}).",
            format_exit_detail(status.code())
        ));
    }

    #[cfg(target_os = "windows")]
    {
        // `spawn` (not `status`): explorer often exits non-zero on success.
        let path_str = canonical.to_string_lossy();
        std::process::Command::new("explorer")
            .arg(format!("/select,{path_str}"))
            .spawn()
            .map_err(|error| format!("Failed to open Explorer: {error}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        tauri_plugin_opener::reveal_item_in_dir(&canonical)
            .map_err(|error| format!("Failed to reveal in file manager: {error}"))
    }
}
