use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

pub const LOCAL_PROVIDER_ID: &str = "__local_settings_json__";
/// Legacy kimi marker from the imported v1 config: same "use the CLI's own
/// config" semantics, different spelling.
const LEGACY_LOCAL_CONFIG_TOML_ID: &str = "__local_config_toml__";
pub const DISABLED_PROVIDER_ID: &str = "__disabled__";
pub const ENGINES: [&str; 7] = ["claude", "kimi", "grok", "codex", "pi", "omp", "dsh"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderSection {
    #[serde(default)]
    pub providers: serde_json::Map<String, Value>,
    #[serde(default)]
    pub current: Option<String>,
}

/// Per-engine config sections: engine ids double as field names, so the
/// serialized shape stays flat (`{"claude": …, "kimi": …}`) while
/// section()/section_mut() dispatch is generated, not hand-written.
macro_rules! engine_sections {
    ($($engine:ident),* $(,)?) => {
        #[derive(Debug, Clone, Serialize, Deserialize, Default)]
        pub struct CliConfig {
            $(#[serde(default)] pub $engine: ProviderSection,)*
            /// Preserve unknown top-level fields from legacy config on import.
            #[serde(flatten)]
            pub extra: HashMap<String, Value>,
        }

        impl CliConfig {
            pub fn section(&self, engine: &str) -> Option<&ProviderSection> {
                match engine {
                    $(stringify!($engine) => Some(&self.$engine),)*
                    _ => None,
                }
            }

            pub fn section_mut(&mut self, engine: &str) -> Option<&mut ProviderSection> {
                match engine {
                    $(stringify!($engine) => Some(&mut self.$engine),)*
                    _ => None,
                }
            }
        }
    };
}

engine_sections!(claude, kimi, grok, codex, pi, omp, dsh);

#[derive(Default)]
pub struct ConfigStore(pub Mutex<()>);

pub fn read_config() -> Result<CliConfig, String> {
    let path = crate::paths::config_path();
    if !path.exists() {
        return Ok(CliConfig::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(CliConfig::default());
    }
    serde_json::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_config(config: &CliConfig) -> Result<(), String> {
    let path = crate::paths::config_path();
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    crate::settings::atomic_write(&path, &content)
}

/// One-time import of the legacy ~/.ccgui/config.json claude/kimi/grok
/// sections. Runs only when the new config does not exist yet.
pub fn import_legacy_config_once() {
    let new_path = crate::paths::config_path();
    if new_path.exists() {
        return;
    }
    let legacy_path = crate::paths::legacy_home().join("config.json");
    if !legacy_path.exists() {
        return;
    }
    let Ok(content) = std::fs::read_to_string(&legacy_path) else {
        return;
    };
    let Ok(legacy) = serde_json::from_str::<Value>(&content) else {
        return;
    };
    let mut config = CliConfig::default();
    for engine in ENGINES {
        // Legacy codex providers carry configToml/authJson materialization
        // state that v1's env-injection model cannot honor; skip them.
        if engine == "codex" {
            continue;
        }
        let Some(section) = legacy.get(engine) else {
            continue;
        };
        let providers = section
            .get("providers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let current = section
            .get("current")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(target) = config.section_mut(engine) {
            target.providers = providers;
            target.current = current;
        }
    }
    let _ = write_config(&config);
}

/// Static baseUrl/apiKey/model -> env var mapping per engine.
pub(crate) fn env_mapping(engine: &str) -> [(&'static str, &'static str); 3] {
    match engine {
        "claude" => [
            ("baseUrl", "ANTHROPIC_BASE_URL"),
            ("apiKey", "ANTHROPIC_AUTH_TOKEN"),
            ("model", "ANTHROPIC_MODEL"),
        ],
        "kimi" => [
            ("baseUrl", "KIMI_BASE_URL"),
            ("apiKey", "KIMI_API_KEY"),
            ("model", "KIMI_MODEL_NAME"),
        ],
        "grok" => [
            ("baseUrl", "GROK_BASE_URL"),
            ("apiKey", "GROK_API_KEY"),
            ("model", "GROK_MODEL"),
        ],
        // codex reads OpenAI-compatible env for its default provider.
        "codex" => [
            ("baseUrl", "OPENAI_BASE_URL"),
            ("apiKey", "OPENAI_API_KEY"),
            ("model", ""),
        ],
        // pi/omp keep providers in native models.json; dsh keys live in
        // $DSH_HOME. No env mapping — providers tab is display-only for them.
        "pi" | "omp" | "dsh" => [("baseUrl", ""), ("apiKey", ""), ("model", "")],
        _ => [("baseUrl", ""), ("apiKey", ""), ("model", "")],
    }
}

/// Loader/hook env keys a stored provider config must never smuggle into a
/// spawned engine: they hand code execution to whoever wrote the config file.
/// Prefix families (DYLD_/LD_) are matched by prefix, the rest exactly;
/// comparison is case-insensitive because launchd/cmd env casing varies.
fn is_blocked_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    if upper.starts_with("DYLD_") || upper.starts_with("LD_") {
        return true;
    }
    matches!(
        upper.as_str(),
        "NODE_OPTIONS"
            | "NODE_REPL_EXTERNAL_MODULE"
            | "BASH_ENV"
            | "ENV"
            | "SHELLOPTS"
            | "PYTHONSTARTUP"
            | "PYTHONINSPECT"
            | "RUBYOPT"
            | "PERL5OPT"
            | "GIT_SSH_COMMAND"
            | "SSH_ASKPASS"
            | "PROMPT_COMMAND"
            | "IFS"
    )
}

fn merge_env_object(target: &mut HashMap<String, String>, value: Option<&Value>) {
    let Some(map) = value.and_then(Value::as_object) else {
        return;
    };
    for (key, val) in map {
        if is_blocked_env_key(key) {
            eprintln!("[config] refusing to inject blocked env key: {key}");
            continue;
        }
        let scalar = match val {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => continue,
        };
        if !scalar.trim().is_empty() {
            target.insert(key.clone(), scalar);
        }
    }
}

/// Resolve the environment variables to inject for the current provider of an
/// engine. `__local_settings_json__` / empty current => no injection.
/// `__disabled__` => Err (engine must refuse to send).
pub fn resolve_provider_env(engine: &str) -> Result<HashMap<String, String>, String> {
    let config = read_config()?;
    let section = config
        .section(engine)
        .ok_or_else(|| format!("unknown engine: {engine}"))?;
    let current = section.current.as_deref().unwrap_or("").trim();
    // Claude Code runs entirely on the CLI's own configuration
    // (~/.claude/settings.json): the app's provider channels are never
    // injected. Only the disabled pseudo-provider still gates launches.
    if engine == "claude" {
        return if current == DISABLED_PROVIDER_ID {
            Err(format!("engine {engine} is disabled"))
        } else {
            Ok(HashMap::new())
        };
    }
    if current.is_empty() || current == LOCAL_PROVIDER_ID || current == LEGACY_LOCAL_CONFIG_TOML_ID {
        return Ok(HashMap::new());
    }
    if current == DISABLED_PROVIDER_ID {
        return Err(format!("engine {engine} is disabled"));
    }
    let provider = section
        .providers
        .get(current)
        .ok_or_else(|| format!("provider {current} not found for {engine}"))?;

    let mut env = HashMap::new();
    // Raw env escape hatch: settingsConfig.env (claude legacy shape) then env.
    merge_env_object(
        &mut env,
        provider.get("settingsConfig").and_then(|s| s.get("env")),
    );
    merge_env_object(&mut env, provider.get("env"));
    // Convention fields mapped via the static table; raw env wins.
    for (field, var) in env_mapping(engine) {
        if var.is_empty() || env.contains_key(var) {
            continue;
        }
        if let Some(value) = provider.get(field).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                env.insert(var.to_string(), value.to_string());
            }
        }
    }
    Ok(env)
}

// ==================== Commands ====================

#[tauri::command]
pub fn get_cli_config() -> Result<CliConfig, String> {
    read_config()
}

/// Lock the store, apply `mutate` to one engine's section, persist. A
/// `mutate` error aborts before the write, leaving the config untouched.
fn mutate_section(
    store: &ConfigStore,
    engine: &str,
    mutate: impl FnOnce(&mut ProviderSection) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = store.0.lock().map_err(|e| e.to_string())?;
    let mut config = read_config()?;
    let section = config
        .section_mut(engine)
        .ok_or_else(|| format!("unknown engine: {engine}"))?;
    mutate(section)?;
    write_config(&config)
}

#[tauri::command]
pub fn upsert_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
    json: Value,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        section.providers.insert(id, json);
        Ok(())
    })
}

#[tauri::command]
pub fn delete_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        section.providers.remove(&id);
        if section.current.as_deref() == Some(id.as_str()) {
            section.current = None;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn set_current_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        if id != LOCAL_PROVIDER_ID
            && id != DISABLED_PROVIDER_ID
            && !section.providers.contains_key(&id)
        {
            return Err(format!("provider {id} not found for {engine}"));
        }
        section.current = Some(id);
        Ok(())
    })
}

#[tauri::command]
pub fn reorder_providers(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    ids: Vec<String>,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        // Rebuild map in requested order; keep unknown ids at the end.
        let mut ordered = serde_json::Map::new();
        let mut remaining: Vec<(String, Value)> =
            std::mem::take(&mut section.providers).into_iter().collect();
        for id in &ids {
            if let Some(pos) = remaining.iter().position(|(k, _)| k == id) {
                let (k, v) = remaining.remove(pos);
                ordered.insert(k, v);
            }
        }
        for (k, v) in remaining {
            ordered.insert(k, v);
        }
        section.providers = ordered;
        Ok(())
    })
}
