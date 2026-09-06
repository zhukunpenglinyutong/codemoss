use super::{alias_table_catalog, promote_default, AliasFields, EngineModel};

/// Grok's local catalog: the `[model."<alias>"]` tables in
/// $GROK_HOME/config.toml — id = alias, which is exactly what `grok -m`
/// resolves and what the CLI's own /model menu lists.
pub(super) fn grok_local_models() -> Vec<EngineModel> {
    let home = crate::engine::engine_home(Some("GROK_HOME"), ".grok");
    let Ok(content) = std::fs::read_to_string(home.join("config.toml")) else {
        return Vec::new();
    };
    parse_grok_config_models(&content)
}

/// `[model."<alias>"]` tables → catalog entries (id = alias, label = the
/// table's `name`, context window from `context_window`). The CLI's current
/// pick — `[models].default`, or the top-level `model` scalar — leads the
/// list; remaining aliases follow sorted. A bare top-level `model` with no
/// tables still yields that single entry. Malformed TOML yields an empty
/// catalog (the frontend falls back to provider-config models).
pub fn parse_grok_config_models(content: &str) -> Vec<EngineModel> {
    const FIELDS: AliasFields = AliasFields {
        name_keys: &["name"],
        context_keys: &["context_window"],
        provider_key: None,
    };
    let Ok(root) = content.parse::<toml::Value>() else {
        return Vec::new();
    };
    let current = root
        .get("models")
        .and_then(|v| v.get("default"))
        .and_then(toml::Value::as_str)
        .or_else(|| root.get("model").and_then(toml::Value::as_str))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let mut models = alias_table_catalog(&root, "model", "grok", &FIELDS);
    if models.is_empty() {
        // Scalar `model = "…"` and no tables: that id alone is what runs.
        return current
            .into_iter()
            .map(|id| EngineModel {
                id,
                name: None,
                provider: "grok".to_string(),
                context_window: None,
            })
            .collect();
    }
    promote_default(&mut models, current.as_deref());
    models
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_config_models_default_first_then_sorted() {
        let toml = "\
[models]
default = \"grok-4.6\"

[model.\"grok-4.5\"]
name = \"Grok 4.5\"
context_window = 131072

[model.\"grok-4.6\"]
name = \"Grok 4.6\"
api_backend = \"responses\"
context_window = 200000
";
        let models = parse_grok_config_models(toml);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["grok-4.6", "grok-4.5"]);
        assert_eq!(models[0].name.as_deref(), Some("Grok 4.6"));
        assert_eq!(models[0].context_window, Some(200_000));
        assert_eq!(models[1].context_window, Some(131_072));
    }

    #[test]
    fn grok_config_models_scalar_model_is_single_entry() {
        // No [model.*] tables: the top-level scalar is all the CLI can run.
        let models = parse_grok_config_models("model = \"grok-4.6\"\n");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "grok-4.6");
        assert!(parse_grok_config_models("not [valid").is_empty());
        assert!(parse_grok_config_models("[session]\n").is_empty());
    }

    #[test]
    fn grok_config_models_name_matching_alias_is_dropped() {
        let toml = "\
[model.\"grok-4.6\"]
name = \"grok-4.6\"
";
        let models = parse_grok_config_models(toml);
        assert_eq!(models.len(), 1);
        // name identical to the alias carries no information — dropped.
        assert_eq!(models[0].name, None);
    }
}
