use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub default_models: HashMap<String, String>,
    #[serde(default)]
    pub default_efforts: HashMap<String, String>,
    /// Max sessions shown per workspace in the sidebar before collapsing
    /// behind a "show more" row.
    #[serde(default = "default_sidebar_thread_limit")]
    pub sidebar_thread_limit: u32,
    /// Composer send gesture: "enter" (Enter sends, Shift+Enter newline) or
    /// "cmdEnter" (Cmd/Ctrl+Enter sends, Enter newline).
    #[serde(default = "default_composer_send_shortcut")]
    pub composer_send_shortcut: String,
    /// Terminal shell override; None/empty = auto-detect from $SHELL/COMSPEC.
    /// Validated with the same spawn-target rules as bin overrides.
    #[serde(default)]
    pub terminal_shell_path: Option<String>,
    /// Per-engine binary overrides. flatten keeps the legacy flat shape
    /// (`"claudeBin": …`) the frontend depends on; keys stay camelCase and
    /// unknown extra fields round-trip untouched.
    #[serde(flatten)]
    pub bin_overrides: HashMap<String, Value>,
}

fn default_theme() -> String {
    "system".to_string()
}
fn default_sidebar_thread_limit() -> u32 {
    5
}

fn default_composer_send_shortcut() -> String {
    "enter".to_string()
}

fn default_language() -> String {
    "zh".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            language: default_language(),
            default_models: HashMap::new(),
            default_efforts: HashMap::new(),
            sidebar_thread_limit: default_sidebar_thread_limit(),
            composer_send_shortcut: default_composer_send_shortcut(),
            terminal_shell_path: None,
            bin_overrides: HashMap::new(),
        }
    }
}

impl AppSettings {
    pub fn bin_override(&self, engine: &str) -> Option<&str> {
        self.bin_overrides
            .get(&format!("{engine}Bin"))
            .and_then(Value::as_str)
    }
}

/// A bin override is a spawn target, so it must be a stable absolute path —
/// canonicalizable and outside temp dirs (a redirected /tmp path is the
/// classic local privilege-escalation plant).
pub(crate) fn validate_bin_override(value: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("empty path".to_string());
    }
    let path = std::path::PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("{trimmed}: not an absolute path"));
    }
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("{}: cannot resolve ({e})", path.display()))?;
    const TEMP_ROOTS: &[&str] = &["/tmp", "/var/folders", "/private/tmp", "/private/var/folders"];
    for root in TEMP_ROOTS {
        if canonical.starts_with(root) {
            return Err(format!(
                "{}: binaries under {root} are not allowed",
                canonical.display()
            ));
        }
    }
    Ok(canonical)
}

pub fn read_settings() -> Result<AppSettings, String> {
    let path = crate::paths::settings_path();
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(AppSettings::default());
    }
    serde_json::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Write-then-rename so a crash mid-write never leaves a truncated file that
/// the next read would reject as corrupt.
pub(crate) fn atomic_write(path: &std::path::Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

#[tauri::command]
pub fn get_app_settings() -> Result<AppSettings, String> {
    read_settings()
}

#[tauri::command]
pub fn update_app_settings(mut settings: AppSettings) -> Result<(), String> {
    // Reject only the offending bin-override fields: the rest of the settings
    // still persist, and the error names what was dropped.
    let mut rejected = Vec::new();
    settings.bin_overrides.retain(|key, value| {
        let Some(text) = value.as_str() else {
            return true; // non-string extras round-trip untouched
        };
        if !key.ends_with("Bin") || text.trim().is_empty() {
            return true;
        }
        match validate_bin_override(text) {
            Ok(_) => true,
            Err(reason) => {
                rejected.push(format!("{key}: {reason}"));
                false
            }
        }
    });
    // Same spawn-target validation as bin overrides; an invalid shell path is
    // dropped so a typo can never wedge every terminal spawn.
    if let Some(shell) = settings.terminal_shell_path.take() {
        let trimmed = shell.trim().to_string();
        if !trimmed.is_empty() {
            match validate_bin_override(&trimmed) {
                Ok(_) => settings.terminal_shell_path = Some(trimmed),
                Err(reason) => rejected.push(format!("terminalShellPath: {reason}")),
            }
        }
    }
    let path = crate::paths::settings_path();
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    atomic_write(&path, &content)?;
    if rejected.is_empty() {
        Ok(())
    } else {
        Err(format!("rejected settings: {}", rejected.join("; ")))
    }
}
