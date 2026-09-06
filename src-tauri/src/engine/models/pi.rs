use super::{run_probe, EngineModel};

/// `<bin> models --json` → {"models":[{provider,id,selector,name,contextWindow,…}]}.
pub(super) async fn run_models_json(bin: &str) -> Result<Vec<EngineModel>, String> {
    parse_models_json(&run_probe(bin, &["models", "--json"], "models --json").await?)
}

pub fn parse_models_json(stdout: &str) -> Result<Vec<EngineModel>, String> {
    let value: serde_json::Value =
        serde_json::from_str(stdout).map_err(|e| format!("invalid models json: {e}"))?;
    let rows = value
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "models json has no models array".to_string())?;
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let str_field = |k: &str| row.get(k).and_then(serde_json::Value::as_str);
        let provider = str_field("provider").unwrap_or("");
        let id = match str_field("selector") {
            Some(selector) if !selector.is_empty() => selector.to_string(),
            _ => match str_field("id") {
                Some(model) if !provider.is_empty() => format!("{provider}/{model}"),
                Some(model) => model.to_string(),
                None => continue,
            },
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        models.push(EngineModel {
            id,
            name: str_field("name").map(str::to_string),
            provider: provider.to_string(),
            context_window: row.get("contextWindow").and_then(serde_json::Value::as_u64),
        });
    }
    Ok(models)
}

pub(super) async fn run_list_models(bin: &str, extra: &[&str]) -> Result<Vec<EngineModel>, String> {
    let mut args = vec!["--list-models"];
    args.extend_from_slice(extra);
    Ok(parse_list_models(
        &run_probe(bin, &args, "--list-models").await?,
    ))
}

/// Parse the `--list-models` table: strips ANSI escapes, skips the header
/// and separator rows, dedupes on the `provider/model` selector.
pub fn parse_list_models(stdout: &str) -> Vec<EngineModel> {
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw_line in stdout.lines() {
        let line = strip_ansi(raw_line);
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let (provider, model) = (parts[0], parts[1]);
        if provider == "provider" && model == "model" {
            continue;
        }
        // Skip separators and other noise; provider names may be Unicode.
        if provider
            .chars()
            .any(|c| !c.is_alphanumeric() && c != '-' && c != '_')
        {
            continue;
        }
        let id = format!("{provider}/{model}");
        if !seen.insert(id.clone()) {
            continue;
        }
        models.push(EngineModel {
            id,
            name: None,
            provider: provider.to_string(),
            context_window: parts.get(2).and_then(|raw| parse_token_count(raw)),
        });
    }
    models
}

fn strip_ansi(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out.trim().to_string()
}

/// "131.1K" -> 131_100, "1M" -> 1_000_000, "8192" -> 8192.
fn parse_token_count(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    let (digits, mult) = match raw.chars().last()? {
        'K' | 'k' => (&raw[..raw.len() - 1], 1_000_f64),
        'M' | 'm' => (&raw[..raw.len() - 1], 1_000_000_f64),
        _ => (raw, 1_f64),
    };
    let value = digits.parse::<f64>().ok()? * mult;
    (value.is_finite() && value >= 0.0).then_some(value as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_table_with_header_ansi_and_dupes() {
        let stdout = "\
\u{1b}[1mprovider       model          context   max out  thinking  vision\u{1b}[0m
\u{1b}[1m──────────────  ─────────────  ────────  ───────  ────────  ──────\u{1b}[0m
kimi-code      k3             262.1K    32.8K    yes       no
mossx-grok-relay grok-4-relay 131.1K    8.2K     yes       no
kimi-code      k3             262.1K    32.8K    yes       no
";
        let models = parse_list_models(stdout);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "kimi-code/k3");
        assert_eq!(models[0].provider, "kimi-code");
        assert_eq!(models[0].context_window, Some(262_100));
        assert_eq!(models[1].id, "mossx-grok-relay/grok-4-relay");
        assert_eq!(models[1].context_window, Some(131_100));
    }

    #[test]
    fn parses_models_json() {
        let stdout = r#"{"models":[
          {"provider":"fufei","id":"kimi-k3","selector":"fufei/kimi-k3","name":"Kimi K3 (fufei)","contextWindow":262144},
          {"provider":"kimi-code","id":"k3","name":"K3","contextWindow":1048576}
        ]}"#;
        let models = parse_models_json(stdout).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "fufei/kimi-k3");
        assert_eq!(models[0].name.as_deref(), Some("Kimi K3 (fufei)"));
        assert_eq!(models[0].context_window, Some(262_144));
        // No selector: id falls back to provider/model.
        assert_eq!(models[1].id, "kimi-code/k3");
    }

    #[test]
    fn token_counts() {
        assert_eq!(parse_token_count("131.1K"), Some(131_100));
        assert_eq!(parse_token_count("1M"), Some(1_000_000));
        assert_eq!(parse_token_count("8192"), Some(8192));
        assert_eq!(parse_token_count("—"), None);
    }
}
