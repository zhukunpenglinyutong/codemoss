use super::{
    alias_table_catalog, config_toml_model, promote_default, run_probe, AliasFields, EngineModel,
};

/// `kimi provider list --json` → {"providers":{…},"models":{"selector":
/// {displayName,maxContextSize,provider,…}}}. The selectors ("kimi-code/k3")
/// are what `kimi -m` accepts.
pub(super) async fn run_kimi_provider_list(bin: &str) -> Result<Vec<EngineModel>, String> {
    Ok(parse_kimi_provider_list(
        &run_probe(bin, &["provider", "list", "--json"], "provider list").await?,
    ))
}

pub fn parse_kimi_provider_list(stdout: &str) -> Vec<EngineModel> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return Vec::new();
    };
    let Some(models) = value.get("models").and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };
    models
        .iter()
        .map(|(selector, row)| EngineModel {
            id: selector.clone(),
            name: row
                .get("displayName")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            provider: row
                .get("provider")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("kimi")
                .to_string(),
            context_window: row
                .get("maxContextSize")
                .and_then(serde_json::Value::as_u64),
        })
        .collect()
}

/// Kimi's local catalog: the `[models."<alias>"]` tables in
/// $KIMI_CODE_HOME/config.toml — id = alias, what `kimi -m` resolves.
pub(super) fn kimi_local_models() -> Vec<EngineModel> {
    let home = crate::engine::engine_home(Some("KIMI_CODE_HOME"), ".kimi-code");
    let Ok(content) = std::fs::read_to_string(home.join("config.toml")) else {
        return Vec::new();
    };
    parse_kimi_config_models(&content)
}

/// `[models."<alias>"]` tables → catalog entries (id = alias; label =
/// `display_name`, else the inner `model`; context window from
/// `max_context_size`/`context_window` when present). `default_model` leads;
/// remaining aliases follow sorted. Malformed TOML yields an empty catalog.
pub fn parse_kimi_config_models(content: &str) -> Vec<EngineModel> {
    const FIELDS: AliasFields = AliasFields {
        name_keys: &["display_name", "model"],
        context_keys: &["max_context_size", "context_window"],
        provider_key: Some("provider"),
    };
    let Ok(root) = content.parse::<toml::Value>() else {
        return Vec::new();
    };
    let default = root
        .get("default_model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let mut models = alias_table_catalog(&root, "models", "kimi", &FIELDS);
    promote_default(&mut models, default.as_deref());
    models
}

/// Kimi's configured default: top-level `default_model = "…"` in
/// $KIMI_CODE_HOME/config.toml.
pub(super) fn kimi_default_model() -> Option<EngineModel> {
    let home = crate::engine::engine_home(Some("KIMI_CODE_HOME"), ".kimi-code");
    config_toml_model(&home, "default_model", "kimi")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kimi_config_models_default_first_then_sorted() {
        let toml = "\
default_model = \"kimi-code/k3\"

[models.\"kimi-code/kimi-for-coding\"]
model = \"kimi-for-coding\"
display_name = \"K2.7 Coding\"
max_context_size = 262144

[models.\"kimi-code/k3\"]
model = \"k3\"
provider = \"managed:kimi-code\"
max_context_size = 1048576
";
        let models = parse_kimi_config_models(toml);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["kimi-code/k3", "kimi-code/kimi-for-coding"]);
        // Inner `model` == alias suffix is a fine label when display_name is absent…
        assert_eq!(models[0].name.as_deref(), Some("k3"));
        assert_eq!(models[0].provider, "managed:kimi-code");
        assert_eq!(models[0].context_window, Some(1_048_576));
        assert_eq!(models[1].name.as_deref(), Some("K2.7 Coding"));
        assert!(parse_kimi_config_models("not [valid").is_empty());
        assert!(parse_kimi_config_models("[providers.x]\n").is_empty());
    }

    #[test]
    fn kimi_provider_list_uses_selector_as_id() {
        let stdout = r#"{"providers":{"managed:kimi-code":{}},"models":{
          "kimi-code/k3":{"provider":"managed:kimi-code","model":"k3","maxContextSize":1048576,"displayName":"K3"},
          "kimi-code/kimi-for-coding":{"provider":"managed:kimi-code","model":"kimi-for-coding","maxContextSize":262144,"displayName":"K2.7 Coding"}
        }}"#;
        let models = parse_kimi_provider_list(stdout);
        assert_eq!(models.len(), 2);
        let k3 = models.iter().find(|m| m.id == "kimi-code/k3").unwrap();
        assert_eq!(k3.name.as_deref(), Some("K3"));
        assert_eq!(k3.context_window, Some(1_048_576));
        assert!(parse_kimi_provider_list("not json").is_empty());
    }
}
