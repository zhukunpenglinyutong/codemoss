//! Claude's catalog comes from the CLI's own configuration, not the app's
//! provider channels: `claude --model` resolves the built-in aliases the
//! /model menu lists, and the CLI's configured default lives in
//! ~/.claude/settings.json (settings.local.json overrides it). No relay
//! probe: the /model menu is built into the CLI binary, so a channel's
//! /v1/models would list ids the CLI never offers.

use std::path::PathBuf;

use super::{with_default_first, EngineModel};

/// Selectors `claude --model` accepts out of the box, mirroring the CLI's
/// own /model menu (order matters: the picker lists them verbatim). The
/// `[1m]` suffix opts into the 1M-context variant; "fable" only exists on
/// newer CLI builds — the catalog is advisory, an unresolvable pick fails
/// at launch with the CLI's own error.
const CLI_ALIASES: &[(&str, &str)] = &[
    ("default", "Default"),
    ("opus", "Opus"),
    ("opus[1m]", "Opus (1M context)"),
    ("sonnet", "Sonnet"),
    ("sonnet[1m]", "Sonnet (1M context)"),
    ("haiku", "Haiku"),
    ("fable", "Fable"),
];

/// The CLI's config root: $CLAUDE_CONFIG_DIR when set, else ~/.claude.
fn claude_config_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::home_dir()
        .expect("no home directory")
        .join(".claude")
}

/// The CLI's configured default model. Per file, env.ANTHROPIC_MODEL beats
/// the `model` key (the CLI applies settings env as real environment
/// variables); settings.local.json beats settings.json per field.
fn read_cli_model() -> Option<String> {
    read_cli_model_from(&claude_config_dir())
}

fn read_cli_model_from(dir: &std::path::Path) -> Option<String> {
    let parse = |name: &str| {
        let content = std::fs::read_to_string(dir.join(name)).ok()?;
        let v = serde_json::from_str::<serde_json::Value>(&content).ok()?;
        let pick = |value: Option<&serde_json::Value>| {
            value
                .and_then(|m| m.as_str())
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(str::to_string)
        };
        pick(v.get("env").and_then(|e| e.get("ANTHROPIC_MODEL"))).or_else(|| pick(v.get("model")))
    };
    parse("settings.local.json").or_else(|| parse("settings.json"))
}

/// Claude's picker catalog: the CLI's built-in aliases, with the CLI's
/// configured default leading.
pub(super) fn claude_models() -> Vec<EngineModel> {
    let models = CLI_ALIASES
        .iter()
        .map(|(id, name)| EngineModel {
            id: id.to_string(),
            name: Some(name.to_string()),
            provider: "claude".to_string(),
            context_window: None,
        })
        .collect();
    let configured = read_cli_model().map(|id| EngineModel {
        id,
        name: None,
        provider: "claude".to_string(),
        context_window: None,
    });
    with_default_first(models, configured)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_cover_the_cli_model_menu() {
        let ids: Vec<&str> = CLI_ALIASES.iter().map(|(id, _)| *id).collect();
        assert_eq!(
            ids,
            vec![
                "default",
                "opus",
                "opus[1m]",
                "sonnet",
                "sonnet[1m]",
                "haiku",
                "fable"
            ]
        );
    }

    #[test]
    fn cli_model_local_overrides_user() {
        let dir = std::env::temp_dir().join(format!("ccgui-claude-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"model":"opus","env":{"ANTHROPIC_MODEL":"sonnet"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("settings.local.json"), r#"{"model":"haiku"}"#).unwrap();
        let model = read_cli_model_from(&dir);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(model.as_deref(), Some("haiku"));
    }

    #[test]
    fn cli_model_reads_env_when_no_local_file() {
        let dir = std::env::temp_dir().join(format!("ccgui-claude-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"model":"opus","env":{"ANTHROPIC_MODEL":"k3"}}"#,
        )
        .unwrap();
        let model = read_cli_model_from(&dir);
        std::fs::remove_dir_all(&dir).ok();
        // env.ANTHROPIC_MODEL outranks the `model` key within one file.
        assert_eq!(model.as_deref(), Some("k3"));
    }
}

