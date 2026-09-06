use super::{parse_top_level_toml_string, run_probe, EngineModel};

/// Codex's active model from its own config: `$CODEX_HOME/config.toml`
/// (default ~/.codex), the same file `codex exec` reads when no provider
/// channel injects env.
pub(super) fn codex_config_model() -> Option<EngineModel> {
    let home = crate::engine::engine_home(Some("CODEX_HOME"), ".codex");
    let content = std::fs::read_to_string(home.join("config.toml")).ok()?;
    let model = parse_top_level_toml_string(&content, "model")?;
    Some(EngineModel {
        id: model,
        name: None,
        provider: "codex".to_string(),
        context_window: None,
    })
}
/// `codex debug models` → {"models":[{slug,display_name,visibility,
/// context_window,…}]}; `visibility: "list"` marks exactly the entries the
/// interactive picker offers ("hide" = internal/deprecated).
pub(super) async fn run_codex_debug_models(bin: &str) -> Result<Vec<EngineModel>, String> {
    parse_codex_models_json(&run_probe(bin, &["debug", "models"], "debug models").await?)
}

pub fn parse_codex_models_json(stdout: &str) -> Result<Vec<EngineModel>, String> {
    let value: serde_json::Value =
        serde_json::from_str(stdout).map_err(|e| format!("invalid codex models json: {e}"))?;
    let rows = value
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "codex models json has no models array".to_string())?;
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        if row.get("visibility").and_then(serde_json::Value::as_str) != Some("list") {
            continue;
        }
        let Some(slug) = row.get("slug").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if slug.is_empty() || !seen.insert(slug.to_string()) {
            continue;
        }
        models.push(EngineModel {
            id: slug.to_string(),
            name: row
                .get("display_name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            provider: "codex".to_string(),
            context_window: row.get("context_window").and_then(serde_json::Value::as_u64),
        });
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_catalog_keeps_only_picker_visible_entries() {
        let stdout = r#"{"models":[
          {"slug":"gpt-5.6-sol","display_name":"GPT-5.6-Sol","visibility":"list","context_window":272000},
          {"slug":"gpt-daybreak-blue-latest","display_name":"Daybreak Blue","visibility":"hide","context_window":272000},
          {"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","context_window":272000},
          {"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","context_window":272000}
        ]}"#;
        let models = parse_codex_models_json(stdout).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-5.6-sol");
        assert_eq!(models[0].name.as_deref(), Some("GPT-5.6-Sol"));
        assert_eq!(models[0].context_window, Some(272_000));
        assert_eq!(models[1].id, "gpt-5.5");
    }
}
