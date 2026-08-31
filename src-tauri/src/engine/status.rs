//! Engine status detection
//!
//! Detects installed CLI tools and their capabilities.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use tokio::time::timeout;

use super::pi_rpc::PiRpcClient;
use super::{disabled_engine_status, EngineFeatures, EngineStatus, EngineType, ModelInfo};
use crate::app_paths;
use crate::backend::app_server::{
    build_codex_path_env, claude_cached_version_text, find_claude_code_binary, find_cli_binary,
    invalidate_environment_resolution_caches,
};
use crate::backend::app_server_cli::resolve_safe_opencode_binary;

/// Timeout for CLI commands
const DETECTION_TIMEOUT: Duration = Duration::from_secs(10);
/// OpenCode model listing can be significantly slower than version probes.
const OPENCODE_MODELS_TIMEOUT: Duration = Duration::from_secs(30);
const GENERATED_MODEL_CATALOG_JSON: &str =
    include_str!("../../../src/features/models/generatedModelCatalog.json");
static OPENCODE_RUNTIME_MODEL_CATALOG: OnceLock<RwLock<Vec<ModelInfo>>> = OnceLock::new();

#[derive(Deserialize)]
struct GeneratedModelCatalog {
    #[serde(rename = "lastVerifiedAt")]
    last_verified_at: String,
    engines: GeneratedModelCatalogEngines,
}

#[derive(Deserialize)]
struct GeneratedModelCatalogEngines {
    codex: Vec<GeneratedModelEntry>,
    gemini: Vec<GeneratedModelEntry>,
    grok: Vec<GeneratedModelEntry>,
    kimi: Vec<GeneratedModelEntry>,
    #[serde(default)]
    opencode: Vec<GeneratedModelEntry>,
    #[serde(default)]
    pi: Vec<GeneratedModelEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedModelEntry {
    id: String,
    label: String,
    #[serde(default)]
    description: String,
    provider: String,
    protocol: String,
    lifecycle: String,
    #[serde(default)]
    default: bool,
}

fn get_generated_fallback_models(engine: EngineType) -> Vec<ModelInfo> {
    let Ok(catalog) = serde_json::from_str::<GeneratedModelCatalog>(GENERATED_MODEL_CATALOG_JSON)
    else {
        log::error!("[model-catalog] generated fallback artifact is invalid");
        return Vec::new();
    };
    let last_verified_at = catalog.last_verified_at;
    let entries = match engine {
        EngineType::Codex => catalog.engines.codex,
        EngineType::Gemini => catalog.engines.gemini,
        EngineType::Grok => catalog.engines.grok,
        EngineType::Kimi => catalog.engines.kimi,
        EngineType::Pi => catalog.engines.pi,
        EngineType::OpenCode => catalog.engines.opencode,
        _ => return Vec::new(),
    };
    entries
        .into_iter()
        .map(|entry| {
            let mut model = ModelInfo::new(entry.id, entry.label)
                .with_description(entry.description)
                .with_provider(entry.provider)
                .with_protocol(entry.protocol)
                .with_provenance("generated:model-catalog")
                .with_fallback_freshness(last_verified_at.clone(), entry.lifecycle)
                .with_source("fallback");
            if entry.default {
                model = model.as_default();
            }
            model
        })
        .collect()
}

fn model_catalog_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn merge_provider_models_with_public(
    provider_models: Vec<ModelInfo>,
    public_models: Vec<ModelInfo>,
) -> Vec<ModelInfo> {
    dedupe_models_preserve_order(provider_models.into_iter().chain(public_models).collect())
}

fn public_models_for_engine(engine_type: EngineType) -> Vec<ModelInfo> {
    match engine_type {
        EngineType::Claude => get_builtin_claude_models(),
        EngineType::Codex | EngineType::Grok | EngineType::Kimi | EngineType::OpenCode => {
            get_generated_fallback_models(engine_type)
        }
        EngineType::Pi => get_generated_fallback_models(engine_type),
        // Qoder catalog is ACP runtime-only (no static fallback roster).
        EngineType::Gemini | EngineType::Dsh | EngineType::Qoder => Vec::new(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnlistedRuntimeModelPolicy {
    Allow,
    Reject,
}

pub(crate) fn validate_model_catalog_pair(
    model_catalog_entry_id: Option<&str>,
    runtime_model: Option<&str>,
    catalog: &[ModelInfo],
    unlisted_runtime_model_policy: UnlistedRuntimeModelPolicy,
) -> Result<(), String> {
    let model_catalog_entry_id = model_catalog_entry_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let runtime_model = runtime_model
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(entry_id) = model_catalog_entry_id {
        if let Some(entry) = catalog.iter().find(|entry| entry.id.trim() == entry_id) {
            let expected_runtime_model = if entry.model.trim().is_empty() {
                entry.id.trim()
            } else {
                entry.model.trim()
            };
            if runtime_model != Some(expected_runtime_model) {
                return Err(format!(
                    "invalid-target-model: catalog entry '{entry_id}' requires runtime model '{expected_runtime_model}'"
                ));
            }
            return Ok(());
        }
        // Catalog 未登记的自定义 / 自由模型名：Allow 时不拦截用户输入的 model id。
        // Reject 仍 fail-closed（旧 Shared 语义）；调用方若允许自定义应传 Allow。
        if unlisted_runtime_model_policy == UnlistedRuntimeModelPolicy::Allow {
            return Ok(());
        }
        return Err(format!(
            "invalid-target-model: catalog entry '{entry_id}' is unavailable for the selected Provider"
        ));
    }

    let Some(runtime_model) = runtime_model else {
        return Ok(());
    };
    if let Some(entry) = catalog.iter().find(|entry| {
        entry.id.trim() == runtime_model
            && !entry.model.trim().is_empty()
            && entry.model.trim() != runtime_model
    }) {
        return Err(format!(
            "invalid-target-model: '{}' is a catalog entry id; use runtime model '{}'",
            entry.id.trim(),
            entry.model.trim()
        ));
    }
    if catalog
        .iter()
        .any(|entry| entry.model.trim() == runtime_model)
        || unlisted_runtime_model_policy == UnlistedRuntimeModelPolicy::Allow
    {
        return Ok(());
    }
    Err(format!(
        "invalid-target-model: runtime model '{runtime_model}' is unavailable for the selected Provider"
    ))
}

pub(crate) fn get_local_engine_models_for_validation(
    engine_type: EngineType,
) -> Option<Vec<ModelInfo>> {
    match engine_type {
        EngineType::Claude => {
            let mut models = get_builtin_claude_models();
            apply_claude_model_overrides(&mut models, read_claude_model_overrides());
            ensure_default_model(&mut models);
            Some(dedupe_models_preserve_order(models))
        }
        EngineType::Codex => Some(get_codex_models()),
        EngineType::Kimi => Some(get_kimi_models(get_kimi_home_dir().as_deref()).0),
        // PI models are async CLI-probed; callers use detect_pi_status / refresh path.
        EngineType::Pi => Some(get_generated_fallback_models(EngineType::Pi)),
        EngineType::Grok => Some(get_grok_models(get_grok_home_dir().as_deref()).0),
        EngineType::OpenCode => Some(resolve_opencode_validation_catalog(
            cached_opencode_runtime_models(),
            public_models_for_engine(EngineType::OpenCode),
        )),
        // Qoder models come from the live ACP handshake, not a local store.
        EngineType::Gemini | EngineType::Dsh | EngineType::Qoder => None,
    }
}

fn claude_provider_models_from_env(
    provider_profile_id: &str,
    env: &std::collections::BTreeMap<String, String>,
) -> Vec<ModelInfo> {
    let overrides = ClaudeModelOverrides {
        main: normalize_non_empty(env.get("ANTHROPIC_MODEL").cloned()),
        fable: normalize_non_empty(env.get("ANTHROPIC_DEFAULT_FABLE_MODEL").cloned()),
        sonnet: normalize_non_empty(env.get("ANTHROPIC_DEFAULT_SONNET_MODEL").cloned()),
        opus: normalize_non_empty(env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").cloned()),
        haiku: normalize_non_empty(env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").cloned()),
        reasoning: normalize_non_empty(env.get("ANTHROPIC_REASONING_MODEL").cloned()),
    };
    let mut models = get_builtin_claude_models();
    apply_claude_model_overrides(&mut models, overrides);
    ensure_default_model(&mut models);
    dedupe_models_preserve_order(models)
        .into_iter()
        .map(|model| model.with_provider_profile_id(provider_profile_id))
        .collect()
}

fn codex_provider_models_from_config(
    provider_profile_id: &str,
    config_toml: &str,
    custom_models: Vec<crate::types::CodexCustomModel>,
) -> Result<Vec<ModelInfo>, String> {
    let config: toml::Value = config_toml
        .parse()
        .map_err(|error| format!("invalid Codex provider configToml: {error}"))?;
    let configured_model = config
        .get("model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let configured_provider = config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut models = custom_models
        .into_iter()
        .filter_map(|custom_model| {
            let id = custom_model.id.trim().to_string();
            if id.is_empty() {
                return None;
            }
            let label = custom_model.label.trim();
            let mut model = ModelInfo::new(
                id.clone(),
                if label.is_empty() { id.as_str() } else { label },
            )
            .with_runtime_model(id)
            .with_source("provider-custom")
            .with_provenance("provider:codex-custom-model")
            .with_provider_profile_id(provider_profile_id);
            if let Some(description) = custom_model
                .description
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                model = model.with_description(description);
            }
            if let Some(provider) = configured_provider {
                model = model.with_provider(provider);
            }
            Some(model)
        })
        .collect::<Vec<_>>();
    if let Some(runtime_model) = configured_model {
        if let Some(existing) = models
            .iter_mut()
            .find(|model| model.model.trim() == runtime_model)
        {
            existing.default = true;
        } else {
            let mut model = ModelInfo::new(runtime_model, runtime_model)
                .with_runtime_model(runtime_model)
                .with_source("provider-config")
                .with_provenance("provider:codex-config-toml")
                .with_provider_profile_id(provider_profile_id)
                .as_default();
            if let Some(provider) = configured_provider {
                model = model.with_provider(provider);
            }
            models.insert(0, model);
        }
    }
    Ok(dedupe_models_preserve_order(models))
}

fn kimi_provider_models_from_config(
    provider_profile_id: &str,
    provider: crate::types::KimiProviderConfig,
) -> Vec<ModelInfo> {
    let runtime_model = provider.model.trim();
    if runtime_model.is_empty() {
        return Vec::new();
    }
    let display_name = provider
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(runtime_model);
    let provider_name = provider
        .provider_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("kimi");
    vec![ModelInfo::new(runtime_model, display_name)
        .with_runtime_model(runtime_model)
        .with_provider(provider_name)
        .with_protocol("kimi")
        .with_source("provider-config")
        .with_provenance("provider:kimi-config")
        .with_provider_profile_id(provider_profile_id)
        .as_default()]
}

fn grok_provider_models_from_config(
    provider_profile_id: &str,
    provider: crate::types::GrokProviderConfig,
) -> Vec<ModelInfo> {
    let runtime_model = provider.model.trim();
    if runtime_model.is_empty() {
        return Vec::new();
    }
    // Managed providers are materialized into the isolated GROK_HOME as
    // `[model."ccgui/<model>"]`. Grok's `-m` resolves config section aliases
    // (not inner `model` fields), so the catalog id must be the materialized
    // alias — passing the bare API model name would select the built-in model
    // and bypass the provider's base_url/api_key.
    let alias = format!(
        "{}{}",
        crate::engine::grok_provider_profile::GROK_MODEL_TOML_PREFIX,
        runtime_model
    );
    let display_name = provider
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(runtime_model);
    let provider_name = provider
        .provider_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("grok");
    vec![ModelInfo::new(alias, display_name)
        .with_provider(provider_name)
        .with_protocol("grok")
        .with_source("provider-config")
        .with_provenance("provider:grok-config")
        .with_provider_profile_id(provider_profile_id)
        .as_default()]
}

fn opencode_provider_models_from_config(
    provider_profile_id: &str,
    provider: &crate::types::OpenCodeProviderConfig,
) -> Vec<ModelInfo> {
    // Managed providers are injected via OPENCODE_CONFIG_CONTENT under the
    // stable `ccgui` provider key, so the catalog id must be the qualified
    // `ccgui/<model>` ref — passing the bare API model name would bypass the
    // provider's base_url/api_key.
    let provider_name = provider.name.trim();
    let provider_name = if provider_name.is_empty() {
        "opencode"
    } else {
        provider_name
    };
    let mut models = Vec::new();
    for raw_model in &provider.models {
        let runtime_model = raw_model.trim();
        if runtime_model.is_empty() {
            continue;
        }
        let qualified =
            crate::engine::opencode_provider_profile::qualify_managed_model_ref(runtime_model);
        models.push(
            ModelInfo::new(qualified.clone(), runtime_model)
                .with_runtime_model(qualified)
                .with_provider(provider_name)
                .with_protocol("opencode")
                .with_source("provider-config")
                .with_provenance("provider:opencode-config")
                .with_provider_profile_id(provider_profile_id),
        );
    }
    if let Some(first) = models.first_mut() {
        *first = first.clone().as_default();
    }
    models
}

/// 按引擎收尾 provider-scoped catalog：Codex 不拼 public generated fallback。
///
/// Codex generated fallback 描述的是官方 OpenAI 模型的可用性，属 provider relay
/// 的事实而非 binding 的事实：拼进三方 scope 会呈现幽灵可选模型（选中即 API
/// 报错，且假条目带满档 reasoning metadata，与真实三方条目形成误导对比）。
/// 空 catalog 由前端 configured-default / custom-model guidance 降级链路兜底
/// （fix-codex-third-party-provider-model-catalog）。Claude / Kimi / Grok 的
/// public 拼接行为保持不变。
fn finalize_provider_scoped_catalog(
    engine_type: EngineType,
    provider_models: Vec<ModelInfo>,
) -> Vec<ModelInfo> {
    if engine_type == EngineType::Codex {
        return provider_models;
    }
    merge_provider_models_with_public(provider_models, public_models_for_engine(engine_type))
}

pub(crate) fn get_provider_scoped_engine_models(
    engine_type: EngineType,
    provider_profile_id: Option<&str>,
) -> Result<Option<Vec<ModelInfo>>, String> {
    let Some(provider_profile_id) = provider_profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let provider_models = match engine_type {
        EngineType::Claude => {
            let Some(env) =
                crate::engine::claude::provider_profile::resolve_claude_provider_model_env(
                    provider_profile_id,
                )?
            else {
                return Ok(None);
            };
            claude_provider_models_from_env(provider_profile_id, &env)
        }
        EngineType::Codex => {
            let Some((config_toml, custom_models)) =
                crate::codex::provider_profile::resolve_codex_provider_model_config(
                    provider_profile_id,
                )?
            else {
                return Ok(None);
            };
            codex_provider_models_from_config(provider_profile_id, &config_toml, custom_models)?
        }
        EngineType::Kimi => {
            let Some(provider) =
                crate::engine::kimi_provider_profile::resolve_kimi_provider_model_config(
                    provider_profile_id,
                )?
            else {
                return Ok(None);
            };
            kimi_provider_models_from_config(provider_profile_id, provider)
        }
        EngineType::Grok => {
            let Some(provider) =
                crate::engine::grok_provider_profile::resolve_grok_provider_model_config(
                    provider_profile_id,
                )?
            else {
                return Ok(None);
            };
            grok_provider_models_from_config(provider_profile_id, provider)
        }
        EngineType::OpenCode => {
            let Some(provider) =
                crate::engine::opencode_provider_profile::resolve_opencode_provider_model_config(
                    provider_profile_id,
                )?
            else {
                return Ok(None);
            };
            // Unlike kimi/grok (materialized configs that keep built-in
            // providers working), an env-injected OPENCODE_CONFIG_CONTENT
            // disturbs the CLI's own provider auth resolution (observed: zen
            // 401 on 1.4.6 once a custom npm provider is declared). Managed
            // profiles therefore expose only their own models.
            return Ok(Some(opencode_provider_models_from_config(
                provider_profile_id,
                &provider,
            )));
        }
        EngineType::Gemini | EngineType::Pi | EngineType::Dsh | EngineType::Qoder => {
            return Ok(None)
        }
    };
    Ok(Some(finalize_provider_scoped_catalog(
        engine_type,
        provider_models,
    )))
}

/// Build a tokio Command that correctly handles .cmd/.bat files on Windows.
/// Uses CREATE_NO_WINDOW to prevent visible console windows.
#[allow(unused_variables)]
fn build_async_command(bin: &str) -> Command {
    #[cfg(windows)]
    {
        // On Windows, .cmd/.bat files need to be run through cmd.exe
        let bin_lower = bin.to_lowercase();
        if bin_lower.ends_with(".cmd") || bin_lower.ends_with(".bat") {
            let mut cmd = crate::utils::async_command("cmd");
            cmd.arg("/c");
            cmd.arg(bin);
            return cmd;
        }
    }
    crate::utils::async_command(bin)
}

fn resolve_bin_path(name: &str, custom_bin: Option<&str>) -> Option<PathBuf> {
    if let Some(custom) = custom_bin.filter(|v| !v.trim().is_empty()) {
        let custom_path = PathBuf::from(custom);
        if custom_path.exists() {
            return Some(custom_path);
        }
    }
    if name == "claude" {
        return find_claude_code_binary(None);
    }
    find_cli_binary(name, None)
}

/// Probe a CLI binary for its version using `--version`.
/// Returns `(installed, version, error)`.
async fn probe_cli_version(
    bin: &str,
    cli_name: &str,
    path_env: Option<&String>,
) -> (bool, Option<String>, Option<String>) {
    let version_result = timeout(DETECTION_TIMEOUT, async {
        let mut cmd = build_async_command(bin);
        if let Some(path) = path_env {
            cmd.env("PATH", path);
        }
        let output = cmd
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await;

        match output {
            Ok(out) if out.status.success() => {
                let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
                Ok(version)
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                Err(format!("{} --version failed: {}", cli_name, stderr.trim()))
            }
            Err(e) => Err(format!("Failed to execute {}: {}", cli_name, e)),
        }
    })
    .await;

    match version_result {
        Ok(Ok(v)) => (true, Some(v), None),
        Ok(Err(e)) => (false, None, Some(e)),
        Err(_) => (
            false,
            None,
            Some(format!("Timeout detecting {} CLI", cli_name)),
        ),
    }
}

async fn probe_cli_help(bin: &str, path_env: Option<&String>) -> bool {
    let help_result = timeout(DETECTION_TIMEOUT, async {
        let mut cmd = build_async_command(bin);
        if let Some(path) = path_env {
            cmd.env("PATH", path);
        }
        cmd.arg("--help")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .await
    })
    .await;

    matches!(help_result, Ok(Ok(output)) if output.status.success())
}

async fn probe_opencode_cli_version(
    bin: &str,
    path_env: Option<&String>,
) -> (bool, Option<String>, Option<String>) {
    let version_result = timeout(DETECTION_TIMEOUT, async {
        let mut cmd = build_async_command(bin);
        if let Some(path) = path_env {
            cmd.env("PATH", path);
        }
        let _native_artifact_lease =
            crate::engine::opencode_native_artifact::OpenCodeNativeArtifactLease::prepare(
                &mut cmd,
            )?;
        let output = cmd
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .map_err(|error| format!("Failed to execute opencode: {error}"))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("opencode --version failed: {}", stderr.trim()))
        }
    })
    .await;

    match version_result {
        Ok(Ok(version)) => (true, Some(version), None),
        Ok(Err(error)) => (false, None, Some(error)),
        Err(_) => (
            false,
            None,
            Some("Timeout detecting opencode CLI".to_string()),
        ),
    }
}

async fn probe_opencode_cli_help(bin: &str, path_env: Option<&String>) -> bool {
    let help_result = timeout(DETECTION_TIMEOUT, async {
        let mut cmd = build_async_command(bin);
        if let Some(path) = path_env {
            cmd.env("PATH", path);
        }
        let _native_artifact_lease =
            crate::engine::opencode_native_artifact::OpenCodeNativeArtifactLease::prepare(
                &mut cmd,
            )?;
        cmd.arg("--help")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .await
            .map_err(|error| error.to_string())
    })
    .await;

    matches!(help_result, Ok(Ok(output)) if output.status.success())
}

/// Build an uninstalled EngineStatus stub.
fn not_installed_status(engine_type: EngineType, error: Option<String>) -> EngineStatus {
    EngineStatus {
        engine_type,
        auth_state: crate::engine::AuthState::default(),
        installed: false,
        version: None,
        bin_path: None,
        home_dir: None,
        models: Vec::new(),
        default_model: None,
        features: EngineFeatures::default(),
        error,
    }
}

/// Detect Claude Code CLI installation status
pub async fn detect_claude_status(custom_bin: Option<&str>) -> EngineStatus {
    let bin_path = resolve_bin_path("claude", custom_bin);
    let bin = bin_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "claude".to_string());
    let path_env = build_codex_path_env(custom_bin);

    // B2 版本去重：find_claude_code_binary 的候选验证已 spawn 过 `claude
    // --version`（结果在进程级 memo），同轮检测直接复用，不再二次探测。
    let memoized_version = bin_path.as_deref().and_then(claude_cached_version_text);
    let (mut installed, mut version, mut error) = match memoized_version {
        Some(text) => (true, Some(text), None),
        None => probe_cli_version(&bin, "claude", path_env.as_ref()).await,
    };

    if !installed && probe_cli_help(&bin, path_env.as_ref()).await {
        installed = true;
        if version.is_none() {
            version = Some("unknown".to_string());
        }
        error = None;
    }

    if !installed {
        return not_installed_status(EngineType::Claude, error);
    }

    let home_dir = get_claude_home_dir();
    let models = get_claude_models(&bin, path_env.as_ref()).await;
    let default_model = models.iter().find(|m| m.default).map(|m| m.id.clone());

    EngineStatus {
        engine_type: EngineType::Claude,
        auth_state: crate::engine::AuthState::default(),
        installed: true,
        version,
        bin_path: Some(bin.to_string()),
        home_dir: home_dir.map(|p| p.to_string_lossy().to_string()),
        models,
        default_model,
        features: EngineFeatures::claude(),
        error: None,
    }
}

/// Detect Codex CLI installation status
pub async fn detect_codex_status(custom_bin: Option<&str>) -> EngineStatus {
    let Some(bin_path) = resolve_bin_path("codex", custom_bin) else {
        return not_installed_status(
            EngineType::Codex,
            Some("Codex CLI not found during startup detection".to_string()),
        );
    };
    let bin = bin_path.to_string_lossy().to_string();

    let home_dir = get_codex_home_dir();
    let models = get_codex_models();
    let default_model = models.iter().find(|m| m.default).map(|m| m.id.clone());

    EngineStatus {
        engine_type: EngineType::Codex,
        auth_state: crate::engine::AuthState::default(),
        installed: true,
        version: None,
        bin_path: Some(bin.to_string()),
        home_dir: home_dir.map(|p| p.to_string_lossy().to_string()),
        models,
        default_model,
        features: EngineFeatures::codex(),
        error: None,
    }
}

pub async fn detect_opencode_status_with_options(
    custom_bin: Option<&str>,
    include_models: bool,
) -> EngineStatus {
    let safe_bin = resolve_safe_opencode_binary(custom_bin);
    let bin_path = match safe_bin {
        Ok(path) => Some(path),
        Err(error) if error == "OpenCode CLI not found" => None,
        Err(error) => {
            return not_installed_status(EngineType::OpenCode, Some(error));
        }
    };
    let bin = bin_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "opencode".to_string());
    let path_env = build_codex_path_env(custom_bin);

    let (mut installed, mut version, mut error) =
        probe_opencode_cli_version(&bin, path_env.as_ref()).await;

    // OpenCode CLI in GUI-launched environments can intermittently fail `--version`
    // due to startup env quirks. Use a lightweight second probe to avoid false
    // "not installed" states in engine selector.
    if !installed && probe_opencode_cli_help(&bin, path_env.as_ref()).await {
        installed = true;
        if version.is_none() {
            version = Some("unknown".to_string());
        }
        error = None;
    }

    if !installed {
        return not_installed_status(EngineType::OpenCode, error);
    }

    let home_dir = get_opencode_home_dir();
    let (models, models_error) = if include_models {
        match get_opencode_models(&bin, path_env.as_ref()).await {
            Ok(models) if !models.is_empty() => {
                remember_opencode_runtime_models(&models);
                (models, None)
            }
            Ok(_) => (public_models_for_engine(EngineType::OpenCode), None),
            Err(err) => {
                let fallback = public_models_for_engine(EngineType::OpenCode);
                if fallback.is_empty() {
                    (Vec::new(), Some(err))
                } else {
                    (fallback, None)
                }
            }
        }
    } else {
        // 快照回填撤销：同 PI（乐观选中/默认解析消费权威链路）。
        (Vec::new(), None)
    };
    let default_model = models.iter().find(|m| m.default).map(|m| m.id.clone());

    EngineStatus {
        engine_type: EngineType::OpenCode,
        auth_state: crate::engine::AuthState::default(),
        installed: true,
        version,
        bin_path: Some(bin.to_string()),
        home_dir: home_dir.map(|p| p.to_string_lossy().to_string()),
        models,
        default_model,
        features: EngineFeatures::opencode(),
        error: models_error,
    }
}

/// Detect OpenCode CLI installation status. Probes the CLI model catalog
/// (like the kimi/grok detection paths) so engine selectors can render the
/// model list without a second round trip; falls back to the generated
/// roster when the probe is unavailable.
pub async fn detect_opencode_status(custom_bin: Option<&str>) -> EngineStatus {
    detect_opencode_status_with_options(custom_bin, true).await
}

/// Query OpenCode CLI for available models on demand.
pub async fn load_opencode_models(custom_bin: Option<&str>) -> Result<Vec<ModelInfo>, String> {
    let safe_bin = resolve_safe_opencode_binary(custom_bin)?;
    let bin = safe_bin.to_string_lossy().to_string();
    let path_env = build_codex_path_env(custom_bin);
    let models = get_opencode_models(&bin, path_env.as_ref()).await?;
    remember_opencode_runtime_models(&models);
    Ok(models)
}

/// Detect Gemini CLI installation status
pub async fn detect_gemini_status(custom_bin: Option<&str>) -> EngineStatus {
    if !crate::engine_policy::GEMINI_RUNTIME_ENABLED {
        return disabled_engine_status(EngineType::Gemini);
    }

    let bin_path = resolve_bin_path("gemini", custom_bin);
    let bin = bin_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "gemini".to_string());
    let path_env = build_codex_path_env(custom_bin);

    let (installed, version, error) = probe_cli_version(&bin, "gemini", path_env.as_ref()).await;

    if !installed {
        return not_installed_status(EngineType::Gemini, error);
    }

    let home_dir = get_gemini_home_dir();
    let models = get_gemini_models();
    let default_model = models.iter().find(|m| m.default).map(|m| m.id.clone());

    EngineStatus {
        engine_type: EngineType::Gemini,
        auth_state: crate::engine::AuthState::default(),
        installed: true,
        version,
        bin_path: Some(bin.to_string()),
        home_dir: home_dir.map(|p| p.to_string_lossy().to_string()),
        models,
        default_model,
        features: EngineFeatures::gemini(),
        error: None,
    }
}

/// Detect Kimi CLI installation status
pub async fn detect_kimi_status(custom_bin: Option<&str>) -> EngineStatus {
    let bin_path = resolve_bin_path("kimi", custom_bin);
    let bin = bin_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "kimi".to_string());
    let path_env = build_codex_path_env(custom_bin);

    let (installed, version, error) = probe_cli_version(&bin, "kimi", path_env.as_ref()).await;

    if !installed {
        return not_installed_status(EngineType::Kimi, error);
    }

    let home_dir = get_kimi_home_dir();
    let (models, config_diagnostic) = get_kimi_models(home_dir.as_deref());
    let default_model = models.iter().find(|m| m.default).map(|m| m.id.clone());

    EngineStatus {
        engine_type: EngineType::Kimi,
        auth_state: crate::engine::AuthState::default(),
        installed: true,
        version,
        bin_path: Some(bin.to_string()),
        home_dir: home_dir.map(|p| p.to_string_lossy().to_string()),
        models,
        default_model,
        features: EngineFeatures::kimi(),
        error: config_diagnostic,
    }
}

pub async fn detect_pi_status(custom_bin: Option<&str>) -> EngineStatus {
    detect_pi_status_with_options(custom_bin, true).await
}

/// `include_models = false` 为启动检测轻量分支：只回答「装没装 / 版本」，
/// models 目录留给 `get_engine_models` 按需路径（refactor-engine-detection-pipeline D1）。
pub async fn detect_pi_status_with_options(
    custom_bin: Option<&str>,
    include_models: bool,
) -> EngineStatus {
    detect_pi_status_with_options_and_home(custom_bin, include_models, None).await
}

pub async fn detect_pi_status_with_home(
    custom_bin: Option<&str>,
    home_override: Option<&str>,
) -> EngineStatus {
    detect_pi_status_with_options_and_home(custom_bin, true, home_override).await
}

pub async fn detect_pi_status_with_options_and_home(
    custom_bin: Option<&str>,
    include_models: bool,
    home_override: Option<&str>,
) -> EngineStatus {
    let bin_path = resolve_bin_path("pi", custom_bin);
    let bin = bin_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "pi".to_string());
    let path_env = build_codex_path_env(custom_bin);
    if !include_models {
        let (installed, version, error) = probe_cli_version(&bin, "pi", path_env.as_ref()).await;
        if !installed {
            return not_installed_status(EngineType::Pi, error);
        }
        // 快照回填已撤销（P0 教训）：EngineStatus.models 会被引擎切换的乐观
        // 选中 / 新会话默认解析当作**可选模型**消费——静态 fallback 条目
        // （auto，default=true）曾把错误模型绑进 PI 会话（dispatch 解析为
        // 「跟随配置默认」→ 跳过对账 → resident 落 broken 默认链）。目录
        // 只能由 get_engine_models 的真实探测权威填充（on-demand 22s 预算）。
        return EngineStatus {
            engine_type: EngineType::Pi,
            auth_state: crate::engine::AuthState::default(),
            installed: true,
            version,
            bin_path: Some(bin.to_string()),
            home_dir: home_override
                .map(PathBuf::from)
                .or_else(get_pi_home_dir)
                .map(|p| p.to_string_lossy().to_string()),
            models: Vec::new(),
            default_model: None,
            features: EngineFeatures::pi(),
            error: None,
        };
    }
    // version 与 models 探测无数据依赖：并行发起，最坏路径 30s → 20s
    // （max(version 10s, RPC 10s + list-models 10s 回退)），与 FE on-demand
    // timeout 对齐。未安装时 models 探测 spawn 立即失败，结果被丢弃。
    let version_probe = probe_cli_version(&bin, "pi", path_env.as_ref());
    let home_dir = home_override.map(PathBuf::from).or_else(get_pi_home_dir);
    let home_dir_str = home_dir.as_ref().map(|p| p.to_string_lossy().to_string());
    let models_probe = get_pi_models(&bin, path_env.as_ref(), home_dir_str.as_deref());
    let ((installed, version, error), (models, config_diagnostic)) =
        tokio::join!(version_probe, models_probe);
    if !installed {
        return not_installed_status(EngineType::Pi, error);
    }
    let default_model = models.iter().find(|m| m.default).map(|m| m.id.clone());
    EngineStatus {
        engine_type: EngineType::Pi,
        auth_state: crate::engine::AuthState::default(),
        installed: true,
        version,
        bin_path: Some(bin.to_string()),
        home_dir: home_dir.map(|p| p.to_string_lossy().to_string()),
        models,
        default_model,
        features: EngineFeatures::pi(),
        error: config_diagnostic,
    }
}

fn get_pi_home_dir() -> Option<PathBuf> {
    if let Ok(agent_dir) = std::env::var("PI_CODING_AGENT_DIR") {
        let trimmed = agent_dir.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir().map(|home| home.join(".pi").join("agent"))
}

pub fn get_qoder_home_dir() -> Option<PathBuf> {
    crate::engine::qoder_provider_profile::resolve_qoder_home_dir(None)
}

/// Parse `qodercli status -o json`; returns Some(logged_in) when the probe ran.
pub(crate) fn parse_qoder_status_json(stdout: &str) -> Option<bool> {
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    value.get("logged_in")?.as_bool()
}

async fn probe_qoder_logged_in(
    distribution: crate::engine::qoder_provider_profile::QoderDistribution,
    bin: &str,
    path_env: Option<&String>,
    home_dir: Option<&Path>,
) -> Option<bool> {
    let mut command = crate::backend::app_server::build_command_for_binary(bin);
    if let Some(home_dir) = home_dir {
        command.env(distribution.config_dir_env_var(), home_dir);
        command.arg("--config-dir").arg(home_dir);
    }
    command.args(["status", "-o", "json"]);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::null());
    if let Some(path_env) = path_env {
        command.env("PATH", path_env);
    }
    crate::engine::qoder_auth::apply_qoder_pat_env_for_distribution(&mut command, distribution);
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_qoder_status_json(&String::from_utf8_lossy(&output.stdout))
}

/// Fetch the live ACP model catalog (models.availableModels + reasoning
/// options) via a throwaway `qodercli --acp` handshake. Never blocks engine
/// detection: any failure degrades to an empty catalog with a diagnostic.
async fn get_qoder_models(
    distribution: crate::engine::qoder_provider_profile::QoderDistribution,
    custom_bin: Option<&str>,
    home_dir: Option<&str>,
) -> (Vec<ModelInfo>, Option<String>) {
    let cwd = std::env::temp_dir();
    let cwd_string = cwd.to_string_lossy().to_string();
    let result = crate::engine::qoder::run_qoder_acp_initialized_for_distribution(
        distribution,
        custom_bin,
        &cwd,
        home_dir,
        std::time::Duration::from_secs(20),
        |acp| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Vec<ModelInfo>, String>> + Send + '_>,
        > {
            let cwd_string = cwd_string.clone();
            Box::pin(async move {
                let session = acp
                    .request(
                        "session/new",
                        serde_json::json!({
                            "cwd": cwd_string,
                            "mcpServers": [],
                        }),
                        QODER_MODEL_PROBE_TIMEOUT,
                    )
                    .await?;
                Ok(crate::engine::qoder::parse_qoder_models_from_session_new(
                    &session,
                ))
            })
        },
    )
    .await;
    match result {
        Ok(models) if !models.is_empty() => (models, None),
        Ok(_) => (
            Vec::new(),
            Some("Qoder CLI 未返回可用模型（确认已登录且账号有可用模型）".to_string()),
        ),
        Err(error) => (Vec::new(), Some(format!("Qoder 模型目录探测失败：{error}"))),
    }
}

const QODER_MODEL_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

fn scope_qoder_models_to_distribution(
    distribution: crate::engine::qoder_provider_profile::QoderDistribution,
    models: Vec<ModelInfo>,
) -> Vec<ModelInfo> {
    models
        .into_iter()
        .map(|model| model.with_provider_profile_id(distribution.provider_profile_id()))
        .collect()
}

pub async fn detect_qoder_status(custom_bin: Option<&str>) -> EngineStatus {
    detect_qoder_status_with_home(custom_bin, None).await
}

/// phase 2 登录探测（spawn \`status -o json\`，10s 预算）：detect 返回后异步执行，
/// 结果经缓存覆写 + 事件补推（B6/D6）。返回 None 表示探测失败（保持 Unknown）。
pub async fn detect_qoder_login_state_phase_two() -> Option<bool> {
    let bin_path = resolve_bin_path("qodercli", None);
    let bin = bin_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "qodercli".to_string());
    let path_env = build_codex_path_env(None);
    let home_dir = crate::engine::qoder_provider_profile::resolve_qoder_distribution_home_dir(
        crate::engine::qoder_provider_profile::QoderDistribution::Global,
        None,
    );
    probe_qoder_logged_in(
        crate::engine::qoder_provider_profile::QoderDistribution::Global,
        &bin,
        path_env.as_ref(),
        home_dir.as_deref(),
    )
    .await
}

/// 启动检测轻量入口：跳过 ACP models 探测（refactor-engine-detection-pipeline D1）。
pub async fn detect_qoder_status_with_options(
    custom_bin: Option<&str>,
    include_models: bool,
) -> EngineStatus {
    detect_qoder_distribution_status_with_options(
        crate::engine::qoder_provider_profile::QoderDistribution::Global,
        custom_bin,
        None,
        include_models,
    )
    .await
}

pub async fn detect_qoder_status_with_home(
    custom_bin: Option<&str>,
    configured_home_dir: Option<&str>,
) -> EngineStatus {
    detect_qoder_distribution_status(
        crate::engine::qoder_provider_profile::QoderDistribution::Global,
        custom_bin,
        configured_home_dir,
    )
    .await
}

pub async fn detect_qoder_distribution_status(
    distribution: crate::engine::qoder_provider_profile::QoderDistribution,
    custom_bin: Option<&str>,
    configured_home_dir: Option<&str>,
) -> EngineStatus {
    detect_qoder_distribution_status_with_options(
        distribution,
        custom_bin,
        configured_home_dir,
        true,
    )
    .await
}

/// `include_models = false` 为启动检测轻量分支：version + 登录检查即返回，
/// ACP 握手 / `session/new` models 探测留给 `get_engine_models` 按需路径
/// （refactor-engine-detection-pipeline D1）。
pub async fn detect_qoder_distribution_status_with_options(
    distribution: crate::engine::qoder_provider_profile::QoderDistribution,
    custom_bin: Option<&str>,
    configured_home_dir: Option<&str>,
    include_models: bool,
) -> EngineStatus {
    let cli_name = distribution.cli_name();
    let bin_path = resolve_bin_path(cli_name, custom_bin);
    let bin = bin_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| cli_name.to_string());
    let path_env = build_codex_path_env(custom_bin);
    let (installed, version, error) = probe_cli_version(&bin, cli_name, path_env.as_ref()).await;
    if !installed {
        return not_installed_status(EngineType::Qoder, error);
    }
    let home_dir = crate::engine::qoder_provider_profile::resolve_qoder_distribution_home_dir(
        distribution,
        configured_home_dir.map(Path::new),
    );
    // B6/D6 二段式：phase 1（启动检测，include_models=false）不做 spawn 型登录
    // 探测，auth_state 留 Unknown 由 phase 2 异步补推；完整路径（catalog 语义）
    // 保持既有登录检查。
    let has_pat =
        crate::engine::qoder_auth::qoder_has_pat_credential_for_distribution(distribution);
    let logged_in = if include_models {
        probe_qoder_logged_in(distribution, &bin, path_env.as_ref(), home_dir.as_deref()).await
    } else {
        None
    };
    let qoder_auth_state = match logged_in {
        Some(true) => crate::engine::AuthState::Authenticated,
        Some(false) if !has_pat => crate::engine::AuthState::RequiresLogin,
        _ => crate::engine::AuthState::Unknown,
    };
    if logged_in == Some(false) && !has_pat {
        return EngineStatus {
            engine_type: EngineType::Qoder,
            auth_state: crate::engine::AuthState::RequiresLogin,
            installed: true,
            version,
            bin_path: Some(bin),
            home_dir: home_dir.map(|p| p.to_string_lossy().to_string()),
            models: Vec::new(),
            default_model: None,
            features: EngineFeatures::qoder(),
            error: Some(format!("Qoder CLI 未登录：请先运行 {} login", cli_name)),
        };
    }
    let (models, config_diagnostic) = if include_models {
        get_qoder_models(
            distribution,
            Some(&bin),
            home_dir.as_deref().and_then(|p| p.to_str()),
        )
        .await
    } else {
        (Vec::new(), None)
    };
    let models = scope_qoder_models_to_distribution(distribution, models);
    let default_model = models.iter().find(|m| m.default).map(|m| m.id.clone());
    EngineStatus {
        engine_type: EngineType::Qoder,
        auth_state: qoder_auth_state,
        installed: true,
        version,
        bin_path: Some(bin),
        home_dir: home_dir.map(|p| p.to_string_lossy().to_string()),
        models,
        default_model,
        features: EngineFeatures::qoder(),
        error: config_diagnostic,
    }
}

const PI_STANDARD_THINKING_LEVELS: &[&str] =
    &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Port of pi `getSupportedThinkingLevels`.
/// Non-reasoning models return empty so the composer hides the selector.
pub(crate) fn supported_thinking_levels_for_pi_model(
    reasoning: bool,
    thinking_level_map: Option<&Value>,
) -> Vec<String> {
    if !reasoning {
        return Vec::new();
    }
    PI_STANDARD_THINKING_LEVELS
        .iter()
        .copied()
        .filter(|level| {
            let mapped = thinking_level_map.and_then(|map| map.get(*level));
            if mapped.map(Value::is_null).unwrap_or(false) {
                return false;
            }
            if *level == "xhigh" || *level == "max" {
                return mapped.is_some();
            }
            true
        })
        .map(str::to_string)
        .collect()
}

fn pi_model_catalog_id(provider: &str, model_id: &str) -> String {
    if provider.is_empty() {
        model_id.to_string()
    } else {
        format!("{provider}/{model_id}")
    }
}

fn apply_pi_thinking_levels(info: ModelInfo, levels: Vec<String>) -> ModelInfo {
    if levels.is_empty() {
        info
    } else {
        info.with_reasoning(levels, None)
    }
}

/// Parse RPC `get_available_models` `data` into catalog rows.
pub(crate) fn parse_pi_available_models(data: &Value) -> Vec<ModelInfo> {
    let models = data
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| data.as_array())
        .into_iter()
        .flatten();
    let mut parsed = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for model in models {
        let provider = model
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("");
        let model_id = model
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("");
        if model_id.is_empty() {
            continue;
        }
        let id = pi_model_catalog_id(provider, model_id);
        if !seen.insert(id.clone()) {
            continue;
        }
        let name = model
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(model_id);
        let reasoning = model
            .get("reasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let levels =
            supported_thinking_levels_for_pi_model(reasoning, model.get("thinkingLevelMap"));
        let mut details = Vec::new();
        if let Some(ctx) = model.get("contextWindow").and_then(Value::as_u64) {
            details.push(format!("ctx {ctx}"));
        }
        if reasoning {
            details.push("thinking".to_string());
        }
        let images = model
            .get("input")
            .and_then(Value::as_array)
            .map(|input| input.iter().any(|value| value.as_str() == Some("image")))
            .unwrap_or(false);
        if images {
            details.push("vision".to_string());
        }
        let description = if details.is_empty() {
            id.clone()
        } else {
            details.join(" · ")
        };
        let mut info = ModelInfo::new(id.clone(), name.to_string())
            .with_description(description)
            .with_protocol("pi")
            .with_provenance("cli:pi-available-models")
            .with_source("detected");
        if !provider.is_empty() {
            info = info.with_provider(provider.to_string());
        }
        parsed.push(apply_pi_thinking_levels(info, levels));
    }
    if parsed.is_empty() {
        parsed.push(
            ModelInfo::new("auto", "PI Auto")
                .with_description("Use PI CLI default model")
                .with_provider("pi")
                .with_protocol("pi")
                .with_source("fallback")
                .as_default(),
        );
    } else if let Some(first) = parsed.first_mut() {
        first.default = true;
    }
    parsed
}

/// PI catalog RPC 探测 spawn 参数：跳过 extension boot。扩展齐全的 pi 冷启动
/// 实测 ~10s，贴爆/超出预算；跳过后 ~1s 且模型与 thinkingLevelMap 元数据
/// 完全一致。
const PI_CATALOG_PROBE_RPC_ARGS: &str = "--no-session --no-extensions";

/// PI catalog 探测预算：比全局 DETECTION_TIMEOUT(10s) 放宽到 15s 兜底。
/// 跳过 extension boot 后常态 ~1s，15s 纯属慢机/冷 FS 缓存的余量；只圈
/// catalog 探测（RPC 请求 + `--list-models`），version 探测与其他引擎不动。
const PI_CATALOG_PROBE_TIMEOUT: Duration = Duration::from_secs(15);

async fn fetch_pi_models_via_rpc(
    bin: &str,
    home_dir: Option<&str>,
) -> Result<Vec<ModelInfo>, String> {
    let cwd = std::env::temp_dir();
    let client = PiRpcClient::spawn(
        bin,
        &cwd,
        None,
        None,
        home_dir,
        Some(PI_CATALOG_PROBE_RPC_ARGS),
    )
    .await?;
    let data = match timeout(
        PI_CATALOG_PROBE_TIMEOUT,
        client.request(json!({"type": "get_available_models"})),
    )
    .await
    {
        Ok(result) => {
            client.kill().await;
            result?
        }
        Err(_) => {
            client.kill().await;
            return Err("pi get_available_models timed out".to_string());
        }
    };
    let models = parse_pi_available_models(&data);
    if models.is_empty() || models.iter().all(|model| model.source == "fallback") {
        Err("pi get_available_models returned no models".to_string())
    } else {
        Ok(models)
    }
}

/// Parse `pi --list-models` fixed-width table into ModelInfo entries.
pub(crate) fn parse_pi_models_output(stdout: &str) -> Vec<ModelInfo> {
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw_line in stdout.lines() {
        let line = {
            let mut out = String::new();
            let mut chars = raw_line.chars().peekable();
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
        };
        if line.is_empty() {
            continue;
        }
        let parts: Vec<String> = line
            .split(|c: char| c.is_whitespace())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        if parts.len() < 2 {
            continue;
        }
        let provider = &parts[0];
        let model = &parts[1];
        if provider == "provider" && model == "model" {
            continue;
        }
        // 跳过表头/分隔线等杂音行,但 provider 允许 Unicode(中文自定义供应商名)。
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
        let thinking = parts.get(4).map(|s| s.as_str()) == Some("yes");
        let images = parts.get(5).map(|s| s.as_str()) == Some("yes");
        let mut details = Vec::new();
        if let Some(ctx) = parts.get(2) {
            details.push(format!("ctx {ctx}"));
        }
        if thinking {
            details.push("thinking".to_string());
        }
        if images {
            details.push("vision".to_string());
        }
        let description = if details.is_empty() {
            id.clone()
        } else {
            details.join(" · ")
        };
        let info = ModelInfo::new(id.clone(), id.clone())
            .with_description(description)
            .with_provider(provider.clone())
            .with_protocol("pi")
            .with_provenance("cli:pi-list-models")
            .with_source("detected");
        models.push(apply_pi_thinking_levels(
            info,
            supported_thinking_levels_for_pi_model(thinking, None),
        ));
    }
    if models.is_empty() {
        models.push(
            ModelInfo::new("auto", "PI Auto")
                .with_description("Use PI CLI default model")
                .with_provider("pi")
                .with_protocol("pi")
                .with_source("fallback")
                .as_default(),
        );
    } else if let Some(first) = models.first_mut() {
        first.default = true;
    }
    models
}

async fn run_pi_list_models(
    bin: &str,
    path_env: Option<&String>,
    home_dir: Option<&str>,
    extra_args: &[&str],
) -> Result<Vec<ModelInfo>, String> {
    let mut cmd = crate::backend::app_server::build_command_for_binary(bin);
    cmd.arg("--list-models");
    for arg in extra_args {
        cmd.arg(arg);
    }
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    if let Some(home) = home_dir {
        cmd.env("PI_CODING_AGENT_DIR", home);
    }
    let output = timeout(PI_CATALOG_PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "pi --list-models timed out".to_string())?
        .map_err(|error| format!("failed to run pi --list-models: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pi --list-models failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let models = parse_pi_models_output(&stdout);
    if models.is_empty() {
        return Err("pi --list-models returned no models".to_string());
    }
    Ok(models)
}

fn merge_pi_custom_models(mut models: Vec<ModelInfo>, home_dir: Option<&str>) -> Vec<ModelInfo> {
    let mut seen: std::collections::HashSet<String> = models.iter().map(|m| m.id.clone()).collect();
    for (provider, value) in crate::engine::pi_models_config::load_custom_model_entries(home_dir) {
        let Some(model_id) = value
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let id = pi_model_catalog_id(&provider, model_id);
        if !seen.insert(id.clone()) {
            continue;
        }
        let configured_name = value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(model_id);
        let mut info = ModelInfo::new(id.clone(), id.clone())
            .with_description(configured_name)
            .with_provider(provider)
            .with_protocol("pi")
            .with_provenance("config:pi-models.json")
            .with_source("configured");
        if value
            .get("reasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            info = info.with_reasoning(
                PI_STANDARD_THINKING_LEVELS
                    .iter()
                    .map(|v| (*v).to_string())
                    .collect(),
                None,
            );
        }
        models.push(info);
    }
    if models.iter().all(|m| !m.default) {
        if let Some(first) = models.first_mut() {
            first.default = true;
        }
    }
    models
}

async fn get_pi_models(
    bin: &str,
    path_env: Option<&String>,
    home_dir: Option<&str>,
) -> (Vec<ModelInfo>, Option<String>) {
    let (mut models, config_diagnostic) = probe_pi_models_chain(bin, path_env, home_dir).await;
    promote_pi_default_from_settings(&mut models, home_dir.map(Path::new));
    (models, config_diagnostic)
}

/// PI catalog 三条取数路径（RPC `get_available_models` → `--list-models` 两跳 →
/// generated fallback）。每条路径都使用同一 profile/home，并在汇合前合并
/// configured models。
async fn probe_pi_models_chain(
    bin: &str,
    path_env: Option<&String>,
    home_dir: Option<&str>,
) -> (Vec<ModelInfo>, Option<String>) {
    match fetch_pi_models_via_rpc(bin, home_dir).await {
        Ok(models) => return (merge_pi_custom_models(models, home_dir), None),
        Err(error) => {
            log::info!("[pi] catalog rpc unavailable ({error}); falling back to --list-models");
        }
    }
    // 先跳过 extension boot（同 RPC 探测理由，实测 9.3s → 1.0s）；失败再裸
    // 跑一次兜底不识别 --no-extensions 的旧版 pi，两次皆败才落 generated fallback。
    match run_pi_list_models(bin, path_env, home_dir, &["--no-extensions"]).await {
        Ok(models) => return (merge_pi_custom_models(models, home_dir), None),
        Err(error) => {
            log::info!("[pi] --list-models with --no-extensions failed ({error}); retrying bare");
        }
    }
    match run_pi_list_models(bin, path_env, home_dir, &[]).await {
        Ok(models) => (merge_pi_custom_models(models, home_dir), None),
        Err(error) => (
            merge_pi_custom_models(get_generated_fallback_models(EngineType::Pi), home_dir),
            Some(error),
        ),
    }
}

/// Read `(defaultProvider, defaultModel)` from `<agent>/settings.json`.
/// Provider is optional (custom models.json entries may be provider-less);
/// any failure (missing file / malformed JSON / non-string / blank) → None.
/// 探测链禁止为 settings 缺失注入诊断噪音，故全部静默容错。
fn read_pi_default_model_selection(home_dir: Option<&Path>) -> Option<(Option<String>, String)> {
    let path = home_dir?.join("settings.json");
    let content = std::fs::read_to_string(&path).ok()?;
    let root: serde_json::Value = serde_json::from_str(&content).ok()?;
    let read_field = |key: &str| -> Option<String> {
        root.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    Some((read_field("defaultProvider"), read_field("defaultModel")?))
}

/// 通用「CLI 默认模型置顶」约定（同 kimi / grok 既有内联实现语义）：
/// 清除全部 default 标记 → 命中 `default_id` 的条目标 default 并移到 index 0。
/// 未命中返回 `false` 且列表零变化——调用方维持 parse 层首条目兜底语义。
fn promote_default_model(models: &mut Vec<ModelInfo>, default_id: &str) -> bool {
    let Some(index) = models.iter().position(|model| model.id == default_id) else {
        return false;
    };
    for model in models.iter_mut() {
        model.default = false;
    }
    let mut matched = models.remove(index);
    matched.default = true;
    models.insert(0, matched);
    true
}

/// PI default 解析：settings 候选 id 依次 `{defaultProvider}/{defaultModel}` →
/// 裸 `{defaultModel}`；全部未命中或 settings 不可用时不动列表。
fn promote_pi_default_from_settings(models: &mut Vec<ModelInfo>, home_dir: Option<&Path>) {
    let Some((provider, model)) = read_pi_default_model_selection(home_dir) else {
        return;
    };
    for candidate in pi_default_candidate_ids(provider.as_deref(), &model) {
        if promote_default_model(models, &candidate) {
            return;
        }
    }
}

/// 候选 id 顺序：`{defaultProvider}/{defaultModel}` 优先，裸 `{defaultModel}`
/// 兜底（覆盖自定义 models.json 无 provider 前缀条目）。
fn pi_default_candidate_ids(provider: Option<&str>, model: &str) -> Vec<String> {
    match provider.map(str::trim).filter(|value| !value.is_empty()) {
        Some(provider) => vec![pi_model_catalog_id(&provider, model), model.to_string()],
        None => vec![model.to_string()],
    }
}

/// Detect Grok CLI installation status
pub async fn detect_grok_status(custom_bin: Option<&str>) -> EngineStatus {
    let bin_path = resolve_bin_path("grok", custom_bin);
    let bin = bin_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "grok".to_string());
    let path_env = build_codex_path_env(custom_bin);

    let (installed, version, error) = probe_cli_version(&bin, "grok", path_env.as_ref()).await;

    if !installed {
        return not_installed_status(EngineType::Grok, error);
    }

    let home_dir = get_grok_home_dir();
    let (models, config_diagnostic) = get_grok_models(home_dir.as_deref());
    let default_model = models.iter().find(|m| m.default).map(|m| m.id.clone());

    EngineStatus {
        engine_type: EngineType::Grok,
        auth_state: crate::engine::AuthState::default(),
        installed: true,
        version,
        bin_path: Some(bin.to_string()),
        home_dir: home_dir.map(|p| p.to_string_lossy().to_string()),
        models,
        default_model,
        features: EngineFeatures::grok(),
        error: config_diagnostic,
    }
}

/// Get Claude Code home directory
fn get_claude_home_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude"))
}

/// Get Codex home directory
fn get_codex_home_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex"))
}

/// Get OpenCode home directory
fn get_opencode_home_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".opencode"))
}

/// Candidate OpenCode config file paths in probe order: `$OPENCODE_CONFIG`,
/// then `~/.config/opencode/opencode.json(c)`, then `~/.opencode/opencode.json(c)`.
pub fn opencode_config_candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(config) = std::env::var_os("OPENCODE_CONFIG").filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(config));
    }
    if let Some(home) = dirs::home_dir() {
        for file_name in ["opencode.json", "opencode.jsonc"] {
            candidates.push(home.join(".config").join("opencode").join(file_name));
        }
        for file_name in ["opencode.json", "opencode.jsonc"] {
            candidates.push(home.join(".opencode").join(file_name));
        }
    }
    candidates
}

/// Read the first existing OpenCode config document best-effort.
///
/// Returns `(status, path, document, diagnostic)` where status is one of
/// `loaded` / `missing` / `malformed` / `io-error`. JSONC-only syntax
/// (comments, trailing commas) is not stripped; such files report `malformed`
/// and callers should treat dependent checks as inconclusive rather than broken.
pub fn read_opencode_config_document() -> (String, Option<PathBuf>, Value, Option<String>) {
    let Some(path) = opencode_config_candidate_paths()
        .into_iter()
        .find(|candidate| candidate.is_file())
    else {
        return ("missing".to_string(), None, Value::Null, None);
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => {
            return (
                "io-error".to_string(),
                Some(path.clone()),
                Value::Null,
                Some(format!("Failed to read {}: {}", path.display(), error)),
            )
        }
    };
    if raw.trim().is_empty() {
        return ("loaded".to_string(), Some(path), Value::Null, None);
    }
    match serde_json::from_str::<Value>(&raw) {
        Ok(document) => ("loaded".to_string(), Some(path), document, None),
        Err(error) => (
            "malformed".to_string(),
            Some(path.clone()),
            Value::Null,
            Some(format!("Failed to parse {}: {}", path.display(), error)),
        ),
    }
}

/// Get Gemini home directory
fn get_gemini_home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("GEMINI_CLI_HOME").filter(|v| !v.is_empty()) {
        let configured = PathBuf::from(home);
        let configured_text = configured.to_string_lossy();
        if configured_text == "~" {
            return dirs::home_dir();
        }
        if let Some(relative) = configured_text
            .strip_prefix("~/")
            .or_else(|| configured_text.strip_prefix("~\\"))
            .filter(|value| !value.is_empty())
        {
            return dirs::home_dir().map(|home| home.join(relative));
        }
        return Some(configured);
    }
    dirs::home_dir().map(|home| home.join(".gemini"))
}

/// Get Kimi home directory
fn get_kimi_home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("KIMI_CODE_HOME").filter(|v| !v.is_empty()) {
        let configured = PathBuf::from(home);
        let configured_text = configured.to_string_lossy();
        if configured_text == "~" {
            return dirs::home_dir();
        }
        if let Some(relative) = configured_text
            .strip_prefix("~/")
            .or_else(|| configured_text.strip_prefix("~\\"))
            .filter(|value| !value.is_empty())
        {
            return dirs::home_dir().map(|home| home.join(relative));
        }
        return Some(configured);
    }
    dirs::home_dir().map(|home| home.join(".kimi-code"))
}

/// Get Grok home directory
fn get_grok_home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("GROK_HOME").filter(|v| !v.is_empty()) {
        let configured = PathBuf::from(home);
        let configured_text = configured.to_string_lossy();
        if configured_text == "~" {
            return dirs::home_dir();
        }
        if let Some(relative) = configured_text
            .strip_prefix("~/")
            .or_else(|| configured_text.strip_prefix("~\\"))
            .filter(|value| !value.is_empty())
        {
            return dirs::home_dir().map(|home| home.join(relative));
        }
        return Some(configured);
    }
    dirs::home_dir().map(|home| home.join(".grok"))
}

/// Built-in fallback models used when `~/.grok/config.toml` is missing
/// or has no `[model]` tables yet (e.g. fresh install before first run).
fn get_builtin_grok_models() -> Vec<ModelInfo> {
    get_generated_fallback_models(EngineType::Grok)
}

/// Get Grok CLI available models by parsing `$GROK_HOME/config.toml`.
/// Falls back to the built-in catalog when the config file is missing or
/// defines no models.
fn get_grok_models(home_dir: Option<&std::path::Path>) -> (Vec<ModelInfo>, Option<String>) {
    let (models, config_diagnostic) = match read_grok_models_from_config(home_dir) {
        Ok(models) => (models.unwrap_or_default(), None),
        Err(error) => (Vec::new(), Some(error)),
    };

    if models.is_empty() {
        return (get_builtin_grok_models(), config_diagnostic);
    }
    (models, config_diagnostic)
}

/// Parse `[model.*]` entries and `[models].default` from grok's config.toml.
fn read_grok_models_from_config(
    home_dir: Option<&std::path::Path>,
) -> Result<Option<Vec<ModelInfo>>, String> {
    let Some(home_dir) = home_dir else {
        return Ok(None);
    };
    let config_path = home_dir.join("config.toml");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Grok config io-error at {}: {}",
                config_path.display(),
                error
            ))
        }
    };
    let root = content.parse::<toml::Value>().map_err(|error| {
        format!(
            "Grok config malformed at {}: {}",
            config_path.display(),
            error
        )
    })?;
    let default_alias = root
        .get("models")
        .and_then(|value| value.get("default"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(models_table) = root.get("model").and_then(|value| value.as_table()) else {
        return Ok(Some(Vec::new()));
    };

    let mut models = Vec::new();
    for (alias, entry) in models_table {
        let display_name = entry
            .get("name")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| alias.clone());
        // Grok's `-m/--model` resolves a `[model.<alias>]` section (or a
        // built-in model name), NOT the section's inner `model` field. Keep
        // `ModelInfo.model` equal to the alias so the composer sends the
        // alias and the CLI resolves base_url/api_key from the config
        // section (same alias semantics as kimi's `--model`).
        let mut info = ModelInfo::new(alias.clone(), display_name)
            .with_protocol("grok-config")
            .with_provenance("config:GROK_HOME/config.toml")
            .with_observed_at(model_catalog_now_ms())
            .with_source("config");
        if default_alias.as_deref() == Some(alias.as_str()) {
            info = info.as_default();
        }
        models.push(info);
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    if let Some(index) = models.iter().position(|model| model.default) {
        let default = models.remove(index);
        models.insert(0, default);
    }
    Ok(Some(models))
}

/// Built-in fallback models used when `~/.kimi-code/config.toml` is missing
/// or has no `[models]` table yet (e.g. fresh install before first run).
fn get_builtin_kimi_models() -> Vec<ModelInfo> {
    get_generated_fallback_models(EngineType::Kimi)
}

/// Get Kimi CLI available models by parsing `$KIMI_CODE_HOME/config.toml`.
/// Falls back to the built-in catalog when the config file is missing or
/// defines no models.
fn get_kimi_models(home_dir: Option<&std::path::Path>) -> (Vec<ModelInfo>, Option<String>) {
    let (mut models, config_diagnostic) = match read_kimi_models_from_config(home_dir) {
        Ok(models) => (models.unwrap_or_default(), None),
        Err(error) => (Vec::new(), Some(error)),
    };

    // KIMI_MODEL_NAME synthesizes a temporary model that takes priority over
    // default_model in config.toml (mirrors the CLI's own precedence).
    if let Ok(env_model) = std::env::var("KIMI_MODEL_NAME") {
        let env_model = env_model.trim().to_string();
        if !env_model.is_empty() {
            for model in &mut models {
                model.default = false;
            }
            if let Some(index) = models.iter().position(|model| model.id == env_model) {
                let mut existing = models.remove(index);
                existing.default = true;
                models.insert(0, existing);
            } else {
                let display = std::env::var("KIMI_MODEL_DISPLAY_NAME")
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| env_model.clone());
                models.insert(
                    0,
                    ModelInfo::new(env_model, display)
                        .as_default()
                        .with_provider("kimi")
                        .with_protocol("kimi")
                        .with_provenance("env:KIMI_MODEL_NAME")
                        .with_observed_at(model_catalog_now_ms())
                        .with_description("Configured via KIMI_MODEL_NAME")
                        .with_source("env"),
                );
            }
        }
    }

    if models.is_empty() {
        return (get_builtin_kimi_models(), config_diagnostic);
    }
    (models, config_diagnostic)
}

/// Parse `[models.*]` entries and `default_model` from kimi's config.toml.
fn read_kimi_models_from_config(
    home_dir: Option<&std::path::Path>,
) -> Result<Option<Vec<ModelInfo>>, String> {
    let Some(home_dir) = home_dir else {
        return Ok(None);
    };
    let config_path = home_dir.join("config.toml");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Kimi config io-error at {}: {}",
                config_path.display(),
                error
            ))
        }
    };
    let root = content.parse::<toml::Value>().map_err(|error| {
        format!(
            "Kimi config malformed at {}: {}",
            config_path.display(),
            error
        )
    })?;
    let default_alias = root
        .get("default_model")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(models_table) = root.get("models").and_then(|value| value.as_table()) else {
        return Ok(Some(Vec::new()));
    };

    let mut models = Vec::new();
    for (alias, entry) in models_table {
        let display_name = entry
            .get("display_name")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                entry
                    .get("model")
                    .and_then(|value| value.as_str())
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or_else(|| alias.clone());
        let provider = entry
            .get("provider")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let mut info = ModelInfo::new(alias.clone(), display_name)
            .with_protocol("kimi-config")
            .with_provenance("config:KIMI_CODE_HOME/config.toml")
            .with_observed_at(model_catalog_now_ms())
            .with_source("config");
        if let Some(provider) = provider {
            info = info.with_provider(provider);
        }
        if default_alias.as_deref() == Some(alias.as_str()) {
            info = info.as_default();
        }
        models.push(info);
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    if let Some(index) = models.iter().position(|model| model.default) {
        let default = models.remove(index);
        models.insert(0, default);
    }
    Ok(Some(models))
}

/// Get Codex CLI available models (hardcoded as they don't change frequently)
fn get_codex_models() -> Vec<ModelInfo> {
    get_generated_fallback_models(EngineType::Codex)
}

/// Get Gemini CLI available models (stable defaults + preview model).
fn get_gemini_models() -> Vec<ModelInfo> {
    let mut models = get_generated_fallback_models(EngineType::Gemini);

    if let Some(configured_model) = read_configured_gemini_model() {
        for model in &mut models {
            model.default = false;
        }
        if let Some(existing_index) = models.iter().position(|model| model.id == configured_model) {
            let mut existing = models.remove(existing_index);
            existing.default = true;
            models.insert(0, existing);
        } else {
            models.insert(
                0,
                ModelInfo::new(configured_model.clone(), configured_model)
                    .as_default()
                    .with_provider("google")
                    .with_description("Configured in Gemini vendor settings"),
            );
        }
    }

    models
}

fn read_configured_gemini_model() -> Option<String> {
    if let Some(from_config) = read_gemini_model_from_ccgui_config() {
        return Some(from_config);
    }
    std::env::var("GEMINI_MODEL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_gemini_model_from_ccgui_config() -> Option<String> {
    let config_path = app_paths::config_file_path().ok()?;
    let content = std::fs::read_to_string(config_path).ok()?;
    let root = serde_json::from_str::<Value>(&content).ok()?;
    parse_gemini_model_from_config_json(&root)
}

fn parse_gemini_model_from_config_json(root: &Value) -> Option<String> {
    root.get("gemini")?
        .get("env")?
        .get("GEMINI_MODEL")?
        .as_str()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Built-in Claude Code model catalog (mirrors the CLI `/model` roster).
///
/// The Claude CLI does not expose a model-list RPC, so this catalog is
/// hardcoded like `get_codex_models`. Settings/env overrides rewrite each
/// tier's runtime model + display name via `apply_claude_model_overrides`
/// (tier ids stay unique so the picker can keep one row per family).
fn get_builtin_claude_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo::new("claude-fable-5", "Fable 5")
            .with_provider("anthropic")
            .with_protocol("anthropic-messages")
            .with_provenance("curated:claude-builtin")
            .with_description("Fable 5 · Most powerful · Mythos-class")
            .with_source("builtin"),
        ModelInfo::new("claude-opus-5", "Opus 5")
            .as_default()
            .with_provider("anthropic")
            .with_protocol("anthropic-messages")
            .with_provenance("curated:claude-builtin")
            .with_description("Opus 5 · Latest Opus upgrade")
            .with_source("builtin"),
        ModelInfo::new("claude-sonnet-5", "Sonnet 5")
            .with_provider("anthropic")
            .with_protocol("anthropic-messages")
            .with_provenance("curated:claude-builtin")
            .with_description("Sonnet 5 · Upgraded Sonnet model")
            .with_source("builtin"),
        ModelInfo::new("claude-haiku-4-5-20251001", "Haiku 4.5")
            .with_provider("anthropic")
            .with_protocol("anthropic-messages")
            .with_provenance("curated:claude-builtin")
            .with_description("Haiku 4.5 · Fastest for quick answers")
            .with_source("builtin"),
    ]
}

/// Build Claude model list.
///
/// Priority:
/// 1. Local Claude settings (`~/.claude/settings.json`) and env overrides
/// 2. Built-in catalog (see `get_builtin_claude_models`)
/// 3. Frontend user custom models (merged in the webview layer)
///
/// `claude --help` examples are intentionally not treated as a model catalog:
/// they are documentation snippets, not the current provider's configured list.
async fn get_claude_models(_bin: &str, _path_env: Option<&String>) -> Vec<ModelInfo> {
    let mut models = get_builtin_claude_models();
    apply_claude_model_overrides(&mut models, read_claude_model_overrides());
    ensure_default_model(&mut models);
    dedupe_models_preserve_order(models)
}

#[derive(Default, Clone)]
struct ClaudeModelOverrides {
    main: Option<String>,
    fable: Option<String>,
    sonnet: Option<String>,
    opus: Option<String>,
    haiku: Option<String>,
    reasoning: Option<String>,
}

fn normalize_non_empty(input: Option<String>) -> Option<String> {
    input.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn read_claude_model_overrides() -> ClaudeModelOverrides {
    let mut overrides = ClaudeModelOverrides {
        main: normalize_non_empty(std::env::var("ANTHROPIC_MODEL").ok()),
        fable: normalize_non_empty(std::env::var("ANTHROPIC_DEFAULT_FABLE_MODEL").ok()),
        sonnet: normalize_non_empty(std::env::var("ANTHROPIC_DEFAULT_SONNET_MODEL").ok()),
        opus: normalize_non_empty(std::env::var("ANTHROPIC_DEFAULT_OPUS_MODEL").ok()),
        haiku: normalize_non_empty(std::env::var("ANTHROPIC_DEFAULT_HAIKU_MODEL").ok()),
        reasoning: normalize_non_empty(std::env::var("ANTHROPIC_REASONING_MODEL").ok()),
    };

    if let Some(file_overrides) = read_claude_model_overrides_from_settings() {
        if file_overrides.main.is_some() {
            overrides.main = file_overrides.main;
        }
        if file_overrides.fable.is_some() {
            overrides.fable = file_overrides.fable;
        }
        if file_overrides.sonnet.is_some() {
            overrides.sonnet = file_overrides.sonnet;
        }
        if file_overrides.opus.is_some() {
            overrides.opus = file_overrides.opus;
        }
        if file_overrides.haiku.is_some() {
            overrides.haiku = file_overrides.haiku;
        }
        if file_overrides.reasoning.is_some() {
            overrides.reasoning = file_overrides.reasoning;
        }
    }

    overrides
}

fn read_claude_model_overrides_from_settings() -> Option<ClaudeModelOverrides> {
    let path = get_claude_home_dir()?.join("settings.json");
    let content = std::fs::read_to_string(path).ok()?;
    let root = serde_json::from_str::<Value>(&content).ok()?;
    let env = root.get("env")?;
    Some(ClaudeModelOverrides {
        main: normalize_non_empty(
            env.get("ANTHROPIC_MODEL")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        ),
        fable: normalize_non_empty(
            env.get("ANTHROPIC_DEFAULT_FABLE_MODEL")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        ),
        sonnet: normalize_non_empty(
            env.get("ANTHROPIC_DEFAULT_SONNET_MODEL")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        ),
        opus: normalize_non_empty(
            env.get("ANTHROPIC_DEFAULT_OPUS_MODEL")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        ),
        haiku: normalize_non_empty(
            env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        ),
        reasoning: normalize_non_empty(
            env.get("ANTHROPIC_REASONING_MODEL")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        ),
    })
}

/// Infer Claude model family for ANTHROPIC_DEFAULT_* slot resolution.
fn claude_model_family_key(model_id: &str) -> Option<&'static str> {
    let normalized = model_id.to_ascii_lowercase();
    if normalized.contains("fable") {
        return Some("fable");
    }
    if normalized.contains("haiku") {
        return Some("haiku");
    }
    if normalized.contains("sonnet") {
        return Some("sonnet");
    }
    if normalized.contains("opus") {
        return Some("opus");
    }
    None
}

fn resolve_override_for_family<'a>(
    family: &str,
    overrides: &'a ClaudeModelOverrides,
) -> Option<&'a str> {
    let tier = match family {
        "fable" => overrides.fable.as_deref(),
        "haiku" => overrides.haiku.as_deref(),
        "sonnet" => overrides.sonnet.as_deref(),
        "opus" => overrides.opus.as_deref(),
        _ => None,
    };
    tier.or(overrides.main.as_deref())
}

/// Apply settings/env model mapping onto the builtin tier catalog.
///
/// Keeps stable catalog ids (claude-opus-5, …) so the UI can still present
/// one row per family with the original tier description, while rewriting:
/// - `model` (runtime id sent to CLI)
/// - `name` / displayName (what the picker shows when mapping is active)
///
/// This matches jetbrains-cc-gui: mapping changes labels, not the tier list.
fn apply_claude_model_overrides(models: &mut Vec<ModelInfo>, overrides: ClaudeModelOverrides) {
    let has_any = overrides.main.is_some()
        || overrides.fable.is_some()
        || overrides.sonnet.is_some()
        || overrides.opus.is_some()
        || overrides.haiku.is_some();
    if !has_any {
        return;
    }

    for model in models.iter_mut() {
        let Some(family) = claude_model_family_key(&model.id) else {
            continue;
        };
        let Some(mapped) = resolve_override_for_family(family, &overrides) else {
            continue;
        };
        model.model = mapped.to_string();
        model.name = mapped.to_string();
        model.provenance = Some("settings:claude-model-override".to_string());
        // Keep builtin tier descriptions so the subtitle still explains the family.
        if model.source == "builtin" || model.source.is_empty() {
            model.source = "settings-mapped".to_string();
        }
    }
}

fn ensure_default_model(models: &mut [ModelInfo]) {
    if models.is_empty() {
        return;
    }
    if models.iter().any(|model| model.default) {
        return;
    }
    if let Some(first) = models.first_mut() {
        first.default = true;
    }
}

fn dedupe_models_preserve_order(models: Vec<ModelInfo>) -> Vec<ModelInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::with_capacity(models.len());
    for model in models {
        // Prefer stable catalog id so family-mapped tiers (same runtime model)
        // remain distinct rows in the picker.
        let identity = if model.id.trim().is_empty() {
            if model.model.trim().is_empty() {
                continue;
            }
            model.model.clone()
        } else {
            model.id.clone()
        };
        if seen.insert(identity) {
            deduped.push(model);
        }
    }
    deduped
}

fn opencode_runtime_model_catalog() -> &'static RwLock<Vec<ModelInfo>> {
    OPENCODE_RUNTIME_MODEL_CATALOG.get_or_init(|| RwLock::new(Vec::new()))
}

fn remember_opencode_runtime_models(models: &[ModelInfo]) {
    if models.is_empty() {
        return;
    }
    let mut cached = opencode_runtime_model_catalog()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cached = models.to_vec();
}

fn cached_opencode_runtime_models() -> Option<Vec<ModelInfo>> {
    let cached = opencode_runtime_model_catalog()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    (!cached.is_empty()).then(|| cached.clone())
}

fn resolve_opencode_validation_catalog(
    runtime_snapshot: Option<Vec<ModelInfo>>,
    generated_fallback: Vec<ModelInfo>,
) -> Vec<ModelInfo> {
    runtime_snapshot
        .filter(|models| !models.is_empty())
        .unwrap_or(generated_fallback)
}

/// Query OpenCode CLI for available models.
async fn get_opencode_models(
    bin: &str,
    path_env: Option<&String>,
) -> Result<Vec<ModelInfo>, String> {
    let output_result = timeout(OPENCODE_MODELS_TIMEOUT, async {
        let mut cmd = build_async_command(bin);
        if let Some(path) = path_env {
            cmd.env("PATH", path);
        }
        let _native_artifact_lease =
            crate::engine::opencode_native_artifact::OpenCodeNativeArtifactLease::prepare(
                &mut cmd,
            )?;
        cmd.arg("models")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .map_err(|error| error.to_string())
    })
    .await;

    let output = match output_result {
        Ok(Ok(out)) => out,
        Ok(Err(err)) => return Err(format!("Failed to execute opencode models: {err}")),
        Err(_) => return Err("Timeout listing OpenCode models".to_string()),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("opencode models failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_opencode_models_output(&stdout))
}

fn parse_opencode_models_output(stdout: &str) -> Vec<ModelInfo> {
    fn strip_ansi_codes(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        let mut chars = input.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\u{1b}' {
                if let Some('[') = chars.peek().copied() {
                    let _ = chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                    continue;
                }
            }
            out.push(ch);
        }
        out
    }

    let clean = strip_ansi_codes(stdout);
    let mut models: Vec<ModelInfo> = clean
        .lines()
        .map(str::trim)
        .filter_map(|line| {
            if line.is_empty() {
                return None;
            }
            line.split_whitespace().find(|token| token.contains('/'))
        })
        .map(|full_id| {
            let (provider, model_id) = full_id.split_once('/').unwrap_or(("opencode", full_id));
            ModelInfo::new(full_id, format_opencode_model_name(provider, model_id))
                .with_provider(provider)
        })
        .collect();

    if models.is_empty() {
        return models;
    }

    let default_index = models
        .iter()
        .position(|m| m.id == "openai/gpt-5.3-codex")
        .or_else(|| models.iter().position(|m| m.id.starts_with("openai/")))
        .unwrap_or(0);

    if let Some(model) = models.get_mut(default_index) {
        model.default = true;
    }

    models
}

fn format_opencode_model_name(provider: &str, model_id: &str) -> String {
    let provider_name = match provider {
        "openai" => "OpenAI",
        "opencode" => "OpenCode",
        _ => provider,
    };
    let model_name = model_id
        .split('-')
        .map(|part| {
            if part.chars().all(|c| c.is_ascii_digit()) {
                part.to_string()
            } else {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => {
                        let mut chunk = first.to_uppercase().to_string();
                        chunk.push_str(chars.as_str());
                        chunk
                    }
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join("-");
    format!("{}/{}", provider_name, model_name)
}

/// 逐引擎检测完成事件回调（B4）：`(detectRunId, status)`，每引擎每轮恰好
/// 一次；前端据此刻画逐项 reveal（ccgui:engine-status-updated）。
pub type EngineStatusEventSink = Arc<dyn Fn(u64, EngineStatus) + Send + Sync>;

/// Wrap a single engine probe in its own task：任一引擎探测 panic / abort
/// 只落该引擎 error，MUST NOT 影响其他引擎的探测与结果（隔离铁律，
/// refactor-engine-detection-pipeline D10）。探测完成即回调 sink（B4 逐项推送）。
async fn run_engine_detection_isolated<F, Fut>(
    engine_type: EngineType,
    probe: F,
    detect_run_id: u64,
    on_status: Option<EngineStatusEventSink>,
) -> EngineStatus
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = EngineStatus> + Send + 'static,
{
    let status = match tokio::spawn(probe()).await {
        Ok(status) => status,
        Err(join_error) => {
            let mut status = disabled_engine_status(engine_type);
            status.installed = false;
            status.error = Some(format!("engine detection task failed: {join_error}"));
            status
        }
    };
    if let Some(on_status) = on_status.as_ref() {
        on_status(detect_run_id, status.clone());
    }
    status
}

/// Detect all supported engines
pub async fn detect_all_engines(
    claude_bin: Option<&str>,
    codex_bin: Option<&str>,
    gemini_bin: Option<&str>,
    opencode_bin: Option<&str>,
    kimi_bin: Option<&str>,
    grok_bin: Option<&str>,
    pi_bin: Option<&str>,
    qoder_bin: Option<&str>,
    dsh_settings: &crate::engine::dsh::supervisor::DshRuntimeSettings,
    gemini_enabled: bool,
) -> Vec<EngineStatus> {
    detect_all_engines_scoped(
        claude_bin,
        codex_bin,
        gemini_bin,
        opencode_bin,
        kimi_bin,
        grok_bin,
        pi_bin,
        qoder_bin,
        dsh_settings,
        gemini_enabled,
        &[],
        0,
        None,
    )
    .await
}

/// 同 `detect_all_engines`，但 `disabled_engines` 内的引擎不进入检测
/// （0 spawn、结果不出现；refactor-engine-detection-pipeline D9 启用范围铁律）。
/// 各引擎 MUST 走启动轻量分支（models 目录探测只在 `get_engine_models` 按需路径）。
pub async fn detect_all_engines_scoped(
    claude_bin: Option<&str>,
    codex_bin: Option<&str>,
    gemini_bin: Option<&str>,
    opencode_bin: Option<&str>,
    kimi_bin: Option<&str>,
    grok_bin: Option<&str>,
    pi_bin: Option<&str>,
    qoder_bin: Option<&str>,
    dsh_settings: &crate::engine::dsh::supervisor::DshRuntimeSettings,
    gemini_enabled: bool,
    disabled_engines: &[EngineType],
    detect_run_id: u64,
    on_status: Option<EngineStatusEventSink>,
) -> Vec<EngineStatus> {
    // 参数 owned 化：per-engine 独立 task 要求 'static（隔离铁律）。
    let claude_bin = claude_bin.map(str::to_string);
    let codex_bin = codex_bin.map(str::to_string);
    let gemini_bin = gemini_bin.map(str::to_string);
    let opencode_bin = opencode_bin.map(str::to_string);
    let kimi_bin = kimi_bin.map(str::to_string);
    let grok_bin = grok_bin.map(str::to_string);
    let pi_bin = pi_bin.map(str::to_string);
    let qoder_bin = qoder_bin.map(str::to_string);
    let dsh_settings = dsh_settings.clone();

    let is_enabled = |engine_type: EngineType| !disabled_engines.contains(&engine_type);

    let claude_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Claude) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Claude,
                move || async move { detect_claude_status(claude_bin.as_deref()).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(
                EngineType::Claude,
            )))
        };
    let codex_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Codex) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Codex,
                move || async move { detect_codex_status(codex_bin.as_deref()).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(
                EngineType::Codex,
            )))
        };
    let gemini_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if gemini_enabled && crate::engine_policy::GEMINI_RUNTIME_ENABLED {
            Box::pin(run_engine_detection_isolated(
                EngineType::Gemini,
                move || async move { detect_gemini_status(gemini_bin.as_deref()).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(
                EngineType::Gemini,
            )))
        };
    let opencode_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::OpenCode) {
            Box::pin(run_engine_detection_isolated(
                EngineType::OpenCode,
                move || async move {
                    detect_opencode_status_with_options(opencode_bin.as_deref(), false).await
                },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(
                EngineType::OpenCode,
            )))
        };
    let kimi_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Kimi) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Kimi,
                move || async move { detect_kimi_status(kimi_bin.as_deref()).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(EngineType::Kimi)))
        };
    let grok_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Grok) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Grok,
                move || async move { detect_grok_status(grok_bin.as_deref()).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(EngineType::Grok)))
        };
    let pi_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Pi) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Pi,
                move || async move { detect_pi_status_with_options(pi_bin.as_deref(), false).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(EngineType::Pi)))
        };
    let qoder_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Qoder) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Qoder,
                move || async move {
                    detect_qoder_status_with_options(qoder_bin.as_deref(), false).await
                },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(
                EngineType::Qoder,
            )))
        };
    let dsh_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Dsh) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Dsh,
                move || async move { crate::engine::dsh::detect_dsh_status(&dsh_settings).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(EngineType::Dsh)))
        };

    let (
        claude_status,
        codex_status,
        gemini_status,
        opencode_status,
        kimi_status,
        grok_status,
        pi_status,
        qoder_status,
        dsh_status,
    ) = tokio::join!(
        claude_status,
        codex_status,
        gemini_status,
        opencode_status,
        kimi_status,
        grok_status,
        pi_status,
        qoder_status,
        dsh_status,
    );

    let statuses = vec![
        claude_status,
        codex_status,
        gemini_status,
        opencode_status,
        kimi_status,
        grok_status,
        pi_status,
        qoder_status,
        dsh_status,
    ];
    // D4 失效条件：开启引擎全部 not_installed 时清环境解析缓存（npm prefix /
    // 登录 shell / claude version memo），覆盖「用户刚装好 CLI」的场景；
    // 下一轮检测重新解析。不视为引擎间错误传播（D10）。
    if !statuses.is_empty() && statuses.iter().all(|status| !status.installed) {
        invalidate_environment_resolution_caches();
    }
    statuses
        .into_iter()
        .filter(|status| is_enabled(status.engine_type))
        .collect()
}

/// Detect available engines and return the preferred default engine.
/// Priority: Claude > Codex > OpenCode (user can override in settings)
pub async fn detect_preferred_engine(
    claude_bin: Option<&str>,
    codex_bin: Option<&str>,
    gemini_bin: Option<&str>,
    opencode_bin: Option<&str>,
    kimi_bin: Option<&str>,
    grok_bin: Option<&str>,
    pi_bin: Option<&str>,
    qoder_bin: Option<&str>,
    dsh_settings: Option<&crate::engine::dsh::supervisor::DshRuntimeSettings>,
) -> EngineType {
    detect_preferred_engine_scoped(
        claude_bin,
        codex_bin,
        gemini_bin,
        opencode_bin,
        kimi_bin,
        grok_bin,
        pi_bin,
        qoder_bin,
        dsh_settings,
        &[],
        0,
        None,
    )
    .await
}

/// 同 `detect_preferred_engine`，但 `disabled_engines` 内的引擎不参与探测与
/// 默认引擎选择（refactor-engine-detection-pipeline D9）。
pub async fn detect_preferred_engine_scoped(
    claude_bin: Option<&str>,
    codex_bin: Option<&str>,
    gemini_bin: Option<&str>,
    opencode_bin: Option<&str>,
    kimi_bin: Option<&str>,
    grok_bin: Option<&str>,
    pi_bin: Option<&str>,
    qoder_bin: Option<&str>,
    dsh_settings: Option<&crate::engine::dsh::supervisor::DshRuntimeSettings>,
    disabled_engines: &[EngineType],
    detect_run_id: u64,
    on_status: Option<EngineStatusEventSink>,
) -> EngineType {
    let default_dsh = crate::engine::dsh::supervisor::DshRuntimeSettings::default();
    let dsh_settings = dsh_settings.unwrap_or(&default_dsh);
    // 参数 owned 化：per-engine 独立 task 要求 'static（隔离铁律）。
    let claude_bin = claude_bin.map(str::to_string);
    let codex_bin = codex_bin.map(str::to_string);
    let gemini_bin = gemini_bin.map(str::to_string);
    let opencode_bin = opencode_bin.map(str::to_string);
    let kimi_bin = kimi_bin.map(str::to_string);
    let grok_bin = grok_bin.map(str::to_string);
    let pi_bin = pi_bin.map(str::to_string);
    let qoder_bin = qoder_bin.map(str::to_string);
    let dsh_settings = dsh_settings.clone();
    let is_enabled = |engine_type: EngineType| !disabled_engines.contains(&engine_type);

    let claude_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Claude) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Claude,
                move || async move { detect_claude_status(claude_bin.as_deref()).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(
                EngineType::Claude,
            )))
        };
    let codex_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Codex) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Codex,
                move || async move { detect_codex_status(codex_bin.as_deref()).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(
                EngineType::Codex,
            )))
        };
    let gemini_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if crate::engine_policy::GEMINI_RUNTIME_ENABLED {
            Box::pin(run_engine_detection_isolated(
                EngineType::Gemini,
                move || async move { detect_gemini_status(gemini_bin.as_deref()).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(
                EngineType::Gemini,
            )))
        };
    let opencode_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::OpenCode) {
            Box::pin(run_engine_detection_isolated(
                EngineType::OpenCode,
                move || async move {
                    detect_opencode_status_with_options(opencode_bin.as_deref(), false).await
                },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(
                EngineType::OpenCode,
            )))
        };
    let kimi_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Kimi) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Kimi,
                move || async move { detect_kimi_status(kimi_bin.as_deref()).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(EngineType::Kimi)))
        };
    let grok_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Grok) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Grok,
                move || async move { detect_grok_status(grok_bin.as_deref()).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(EngineType::Grok)))
        };
    let pi_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Pi) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Pi,
                move || async move { detect_pi_status_with_options(pi_bin.as_deref(), false).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(EngineType::Pi)))
        };
    let qoder_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Qoder) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Qoder,
                move || async move {
                    detect_qoder_status_with_options(qoder_bin.as_deref(), false).await
                },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(
                EngineType::Qoder,
            )))
        };
    let dsh_status: std::pin::Pin<Box<dyn std::future::Future<Output = EngineStatus> + Send>> =
        if is_enabled(EngineType::Dsh) {
            Box::pin(run_engine_detection_isolated(
                EngineType::Dsh,
                move || async move { crate::engine::dsh::detect_dsh_status(&dsh_settings).await },
                detect_run_id,
                on_status.clone(),
            ))
        } else {
            Box::pin(std::future::ready(disabled_engine_status(EngineType::Dsh)))
        };

    let (
        claude_status,
        codex_status,
        gemini_status,
        opencode_status,
        kimi_status,
        grok_status,
        pi_status,
        qoder_status,
        dsh_status,
    ) = tokio::join!(
        claude_status,
        codex_status,
        gemini_status,
        opencode_status,
        kimi_status,
        grok_status,
        pi_status,
        qoder_status,
        dsh_status,
    );

    // Priority: Claude first (more users have it installed)
    if claude_status.installed {
        return EngineType::Claude;
    }
    if codex_status.installed {
        return EngineType::Codex;
    }
    if crate::engine_policy::GEMINI_RUNTIME_ENABLED && gemini_status.installed {
        return EngineType::Gemini;
    }
    if opencode_status.installed {
        return EngineType::OpenCode;
    }
    if kimi_status.installed {
        return EngineType::Kimi;
    }
    if grok_status.installed {
        return EngineType::Grok;
    }
    if pi_status.installed {
        return EngineType::Pi;
    }
    if dsh_status.installed {
        return EngineType::Dsh;
    }
    if qoder_status.installed {
        return EngineType::Qoder;
    }

    // Default to Claude so error message is helpful
    EngineType::Claude
}

/// Resolve the engine type from user settings or auto-detect.
/// Priority:
/// 1. Workspace-specific setting (entry.settings.engine_type)
/// 2. App default setting (app_settings.default_engine)
/// 3. Auto-detect based on installed CLIs
pub async fn resolve_engine_type(
    workspace_engine: Option<&str>,
    app_default_engine: Option<&str>,
    claude_bin: Option<&str>,
    codex_bin: Option<&str>,
    gemini_bin: Option<&str>,
    opencode_bin: Option<&str>,
    kimi_bin: Option<&str>,
    grok_bin: Option<&str>,
    pi_bin: Option<&str>,
    qoder_bin: Option<&str>,
    disabled_engines: &[EngineType],
) -> EngineType {
    // 1. Check workspace-specific setting
    if let Some(engine) = workspace_engine.filter(|s| !s.is_empty()) {
        match engine.to_lowercase().as_str() {
            "claude" => return EngineType::Claude,
            "codex" => return EngineType::Codex,
            "gemini" if crate::engine_policy::GEMINI_RUNTIME_ENABLED => return EngineType::Gemini,
            "gemini" => {}
            "opencode" => return EngineType::OpenCode,
            "kimi" => return EngineType::Kimi,
            "grok" => return EngineType::Grok,
            "pi" => return EngineType::Pi,
            "dsh" => return EngineType::Dsh,
            "qoder" => return EngineType::Qoder,
            _ => {} // Invalid value, fall through
        }
    }

    // 2. Check app default setting
    if let Some(engine) = app_default_engine.filter(|s| !s.is_empty()) {
        match engine.to_lowercase().as_str() {
            "claude" => return EngineType::Claude,
            "codex" => return EngineType::Codex,
            "gemini" if crate::engine_policy::GEMINI_RUNTIME_ENABLED => return EngineType::Gemini,
            "gemini" => {}
            "opencode" => return EngineType::OpenCode,
            "kimi" => return EngineType::Kimi,
            "grok" => return EngineType::Grok,
            "pi" => return EngineType::Pi,
            "dsh" => return EngineType::Dsh,
            "qoder" => return EngineType::Qoder,
            _ => {} // Invalid value, fall through
        }
    }

    // 3. Auto-detect based on installed CLIs
    // Box 到堆：tokio::join! 并发持有多路 CLI 探测，内联会放大调用方栈帧。
    Box::pin(detect_preferred_engine_scoped(
        claude_bin,
        codex_bin,
        gemini_bin,
        opencode_bin,
        kimi_bin,
        grok_bin,
        pi_bin,
        qoder_bin,
        None,
        disabled_engines,
        0,
        None,
    ))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::qoder_provider_profile::{
        QoderDistribution, QODER_CN_PROVIDER_PROFILE_ID, QODER_GLOBAL_PROVIDER_PROFILE_ID,
    };
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn qoder_catalog_rows_keep_the_requested_distribution_profile() {
        let models = vec![ModelInfo::new("qoder-model", "Qoder model")];
        let global = scope_qoder_models_to_distribution(QoderDistribution::Global, models.clone());
        let cn = scope_qoder_models_to_distribution(QoderDistribution::Cn, models);

        assert_eq!(
            global[0].provider_profile_id.as_deref(),
            Some(QODER_GLOBAL_PROVIDER_PROFILE_ID)
        );
        assert_eq!(
            cn[0].provider_profile_id.as_deref(),
            Some(QODER_CN_PROVIDER_PROFILE_ID)
        );
    }

    #[test]
    fn parse_pi_models_output_keeps_thinking_vision_and_default() {
        let models = parse_pi_models_output(
            "provider model          ctx  max     thinking images
openai   gpt-5.2        400k  128k    yes      yes
anthropic claude-opus    200k   32k    no       yes
",
        );
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "openai/gpt-5.2");
        assert!(models[0].default);
        assert_eq!(models[0].description, "ctx 400k · thinking · vision");
        assert_eq!(
            models[0].supported_reasoning_efforts,
            vec!["off", "minimal", "low", "medium", "high"]
        );
        assert_eq!(models[1].id, "anthropic/claude-opus");
        assert!(!models[1].default);
        assert_eq!(models[1].description, "ctx 200k · vision");
        assert!(models[1].supported_reasoning_efforts.is_empty());
    }

    #[test]
    fn supported_thinking_levels_follow_pi_map_rules() {
        assert!(supported_thinking_levels_for_pi_model(false, None).is_empty());
        assert_eq!(
            supported_thinking_levels_for_pi_model(true, None),
            vec!["off", "minimal", "low", "medium", "high"]
        );
        let map = json!({
            "off": null,
            "minimal": null,
            "low": null,
            "medium": null,
            "high": "high",
            "xhigh": null,
            "max": "max"
        });
        assert_eq!(
            supported_thinking_levels_for_pi_model(true, Some(&map)),
            vec!["high", "max"]
        );
    }

    fn write_pi_settings_for_test(home: &Path, content: &str) {
        fs::create_dir_all(home).expect("create pi home dir");
        fs::write(home.join("settings.json"), content).expect("write settings.json");
    }

    fn pi_test_home(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ccgui-pi-default-{label}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn read_pi_default_model_selection_parses_settings_fields() {
        let home = pi_test_home("full");
        write_pi_settings_for_test(
            &home,
            r#"{"theme":"dark","defaultProvider":"kimi-coding","defaultModel":"k3"}"#,
        );
        assert_eq!(
            read_pi_default_model_selection(Some(&home)),
            Some((Some("kimi-coding".to_string()), "k3".to_string()))
        );
    }

    #[test]
    fn read_pi_default_model_selection_allows_missing_provider() {
        let home = pi_test_home("providerless");
        write_pi_settings_for_test(&home, r#"{"defaultModel":" my-relay/grok-4.6 "}"#);
        assert_eq!(
            read_pi_default_model_selection(Some(&home)),
            Some((None, "my-relay/grok-4.6".to_string()))
        );
    }

    #[test]
    fn read_pi_default_model_selection_tolerates_missing_or_broken_settings() {
        assert_eq!(read_pi_default_model_selection(None), None);

        let missing = pi_test_home("missing");
        assert_eq!(read_pi_default_model_selection(Some(&missing)), None);

        let broken = pi_test_home("broken");
        write_pi_settings_for_test(&broken, "{ not json");
        assert_eq!(read_pi_default_model_selection(Some(&broken)), None);

        let blank = pi_test_home("blank");
        write_pi_settings_for_test(&blank, r#"{"defaultProvider":"","defaultModel":"  "}"#);
        assert_eq!(read_pi_default_model_selection(Some(&blank)), None);

        let non_string = pi_test_home("non-string");
        write_pi_settings_for_test(&non_string, r#"{"defaultModel":3}"#);
        assert_eq!(read_pi_default_model_selection(Some(&non_string)), None);
    }

    #[test]
    fn promote_default_model_moves_match_to_front_and_clears_old_flag() {
        let mut models = vec![
            ModelInfo::new("anthropic/claude-fable-5", "anthropic/claude-fable-5").as_default(),
            ModelInfo::new("kimi-coding/k3", "kimi-coding/k3"),
            ModelInfo::new("deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro"),
        ];
        assert!(promote_default_model(&mut models, "kimi-coding/k3"));
        assert_eq!(models[0].id, "kimi-coding/k3");
        assert!(models[0].default);
        assert!(!models[1].default);
        assert!(!models[2].default);
    }

    #[test]
    fn promote_default_model_leaves_list_untouched_on_miss() {
        let mut models = vec![
            ModelInfo::new("anthropic/claude-fable-5", "anthropic/claude-fable-5").as_default(),
            ModelInfo::new("kimi-coding/k3", "kimi-coding/k3"),
        ];
        assert!(!promote_default_model(&mut models, "openai/gpt-5"));
        assert!(models[0].default);
        assert!(!models[1].default);
        assert_eq!(models[0].id, "anthropic/claude-fable-5");
    }

    #[test]
    fn pi_default_candidate_ids_prefer_provider_prefixed_then_bare() {
        assert_eq!(
            pi_default_candidate_ids(Some("kimi-coding"), "k3"),
            vec!["kimi-coding/k3".to_string(), "k3".to_string()]
        );
        assert_eq!(
            pi_default_candidate_ids(None, "my-relay/grok-4.6"),
            vec!["my-relay/grok-4.6".to_string()]
        );
        assert_eq!(
            pi_default_candidate_ids(Some("  "), "k3"),
            vec!["k3".to_string()]
        );
    }

    #[test]
    fn pi_default_promotion_end_to_end_over_parsed_catalog() {
        // 复刻「settings default 指向 catalog 存在条目」的完整汇合语义：
        // parse 层 first-entry default 被清除，settings default 置顶。
        let mut models = parse_pi_models_output(
            "provider model          ctx  max     thinking images
anthropic claude-fable-5  1M   128K    yes      yes
kimi-coding k3             1.0M 131.1K  yes      yes
",
        );
        for candidate in pi_default_candidate_ids(Some("kimi-coding"), "k3") {
            if promote_default_model(&mut models, &candidate) {
                break;
            }
        }
        assert_eq!(models[0].id, "kimi-coding/k3");
        assert!(models[0].default);
        assert!(!models[1].default);
    }

    /// 探测 spawn 参数必须同时跳过会话恢复与 extension boot：任一缺失都会
    /// 把探测推回 ~10s 量级（2026-08-26 实证）。预算同时钉在 15s 兜底：
    /// 改动任一常量都必须是显式决策（同步更新 OpenSpec 提案设计）。
    #[test]
    fn pi_catalog_probe_rpc_args_skip_session_and_extension_boot() {
        let args: Vec<&str> = PI_CATALOG_PROBE_RPC_ARGS.split_whitespace().collect();
        assert_eq!(args, vec!["--no-session", "--no-extensions"]);
        assert_eq!(PI_CATALOG_PROBE_TIMEOUT, Duration::from_secs(15));
    }

    #[test]
    fn parse_pi_available_models_projects_thinking_levels() {
        let models = parse_pi_available_models(&json!({
            "models": [
                {
                    "id": "gpt-5.2",
                    "name": "GPT-5.2",
                    "provider": "openai",
                    "reasoning": true,
                    "input": ["text", "image"],
                    "contextWindow": 400000,
                    "thinkingLevelMap": {
                        "off": null,
                        "minimal": "low",
                        "xhigh": "xhigh"
                    }
                },
                {
                    "id": "gpt-4.1",
                    "provider": "openai",
                    "reasoning": false,
                    "input": ["text"]
                }
            ]
        }));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "openai/gpt-5.2");
        assert!(models[0].default);
        assert_eq!(
            models[0].supported_reasoning_efforts,
            vec!["minimal", "low", "medium", "high", "xhigh"]
        );
        assert_eq!(models[1].id, "openai/gpt-4.1");
        assert!(models[1].supported_reasoning_efforts.is_empty());
    }

    #[test]
    fn custom_relay_reasoning_model_without_map_uses_pi_default_five_levels() {
        // models.json: { id, reasoning: true } and no thinkingLevelMap.
        // Screenshot collision: my-relay/grok-4.6 shows Off/Minimal/Low/Medium/High.
        let models = parse_pi_available_models(&json!({
            "models": [{
                "id": "grok-4.6",
                "name": "Grok 4.6",
                "provider": "my-relay",
                "reasoning": true,
                "input": ["text", "image"]
            }]
        }));
        assert_eq!(models[0].id, "my-relay/grok-4.6");
        assert_eq!(
            models[0].supported_reasoning_efforts,
            vec!["off", "minimal", "low", "medium", "high"]
        );
        assert_eq!(
            models[0].provenance.as_deref(),
            Some("cli:pi-available-models")
        );
    }

    #[test]
    fn official_grok_thinking_map_hides_off_minimal_and_extended_levels() {
        let map = json!({
            "off": null,
            "minimal": null,
            "low": "low",
            "medium": "medium",
            "high": "high"
        });
        assert_eq!(
            supported_thinking_levels_for_pi_model(true, Some(&map)),
            vec!["low", "medium", "high"]
        );
        let models = parse_pi_available_models(&json!({
            "models": [{
                "id": "grok-4.5",
                "provider": "xai",
                "reasoning": true,
                "thinkingLevelMap": {
                    "off": null,
                    "minimal": null,
                    "low": "low",
                    "medium": "medium",
                    "high": "high"
                }
            }]
        }));
        assert_eq!(
            models[0].supported_reasoning_efforts,
            vec!["low", "medium", "high"]
        );
    }

    #[test]
    fn list_models_thinking_yes_over_approximates_official_grok_allowlist() {
        let models = parse_pi_models_output(
            "provider model          ctx  max     thinking images
xai      grok-4.5        256k   64k    yes      yes
",
        );
        assert_eq!(models[0].id, "xai/grok-4.5");
        assert_eq!(models[0].provenance.as_deref(), Some("cli:pi-list-models"));
        assert_eq!(
            models[0].supported_reasoning_efforts,
            vec!["off", "minimal", "low", "medium", "high"]
        );
    }

    #[test]
    fn parse_pi_models_output_keeps_cjk_and_mixed_provider_rows() {
        let models = parse_pi_models_output(
            "provider  model          ctx   max  thinking images
智谱      glm-5.2         200k  64k  yes      no
123nhh-gpt gpt-5.6-sol   256k  64k  no       no
",
        );
        let cjk = models
            .iter()
            .find(|m| m.id == "智谱/glm-5.2")
            .expect("CJK provider row must survive parsing");
        assert_eq!(cjk.provider.as_deref(), Some("智谱"));
        assert!(models.iter().any(|m| m.id == "123nhh-gpt/gpt-5.6-sol"));
    }

    #[test]
    fn parse_pi_models_output_falls_back_to_auto_when_table_is_empty() {
        let models = parse_pi_models_output("provider model ctx max thinking images\n");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "auto");
        assert!(models[0].default);
        assert_eq!(models[0].source, "fallback");
    }

    #[test]
    fn model_catalog_pair_separates_selection_id_from_runtime_model() {
        let catalog =
            vec![ModelInfo::new("settings-reasoning", "Reasoning")
                .with_runtime_model("deepseek-v4-pro")];

        assert!(validate_model_catalog_pair(
            Some("settings-reasoning"),
            Some("deepseek-v4-pro"),
            &catalog,
            UnlistedRuntimeModelPolicy::Reject,
        )
        .is_ok());
        assert!(validate_model_catalog_pair(
            Some("settings-reasoning"),
            Some("settings-reasoning"),
            &catalog,
            UnlistedRuntimeModelPolicy::Reject,
        )
        .expect_err("catalog id must not become the runtime model")
        .contains("requires runtime model 'deepseek-v4-pro'"));
        assert!(validate_model_catalog_pair(
            None,
            Some("settings-reasoning"),
            &catalog,
            UnlistedRuntimeModelPolicy::Reject,
        )
        .expect_err("legacy target must not treat a catalog id as runtime")
        .contains("is a catalog entry id"));
    }

    #[test]
    fn unlisted_runtime_policy_allow_accepts_custom_model_names() {
        let catalog = vec![ModelInfo::new("known", "Known")];

        assert!(validate_model_catalog_pair(
            None,
            Some("custom/provider-model"),
            &catalog,
            UnlistedRuntimeModelPolicy::Allow,
        )
        .is_ok());
        // 自定义 catalog entry id：Allow 不拦截用户模型名
        assert!(validate_model_catalog_pair(
            Some("gpt-5.3-codex-spark"),
            Some("gpt-5.3-codex-spark"),
            &catalog,
            UnlistedRuntimeModelPolicy::Allow,
        )
        .is_ok());
        assert!(validate_model_catalog_pair(
            None,
            Some("custom/provider-model"),
            &catalog,
            UnlistedRuntimeModelPolicy::Reject,
        )
        .expect_err("Reject still fail-closes unknown runtime models")
        .contains("runtime model 'custom/provider-model' is unavailable"));
        assert!(validate_model_catalog_pair(
            Some("gpt-5.3-codex-spark"),
            Some("gpt-5.3-codex-spark"),
            &catalog,
            UnlistedRuntimeModelPolicy::Reject,
        )
        .expect_err("Reject still fail-closes unknown catalog entries")
        .contains("catalog entry 'gpt-5.3-codex-spark' is unavailable"));
    }

    #[test]
    fn shared_local_validation_catalog_covers_all_supported_cli_engines() {
        for engine in [
            EngineType::Claude,
            EngineType::Codex,
            EngineType::Kimi,
            EngineType::Grok,
            EngineType::OpenCode,
        ] {
            let catalog = get_local_engine_models_for_validation(engine)
                .unwrap_or_else(|| panic!("missing local validation catalog for {engine:?}"));
            let selected = catalog
                .first()
                .unwrap_or_else(|| panic!("empty local validation catalog for {engine:?}"));

            assert!(
                validate_model_catalog_pair(
                    Some(&selected.id),
                    Some(&selected.model),
                    &catalog,
                    UnlistedRuntimeModelPolicy::Reject,
                )
                .is_ok(),
                "{engine:?}"
            );
        }
        assert!(get_local_engine_models_for_validation(EngineType::Gemini).is_none());
    }

    #[test]
    fn claude_settings_overrides_rewrite_builtin_tier_runtime_models() {
        let mut models = get_builtin_claude_models();
        apply_claude_model_overrides(
            &mut models,
            ClaudeModelOverrides {
                main: Some("MiniMax-M1[1m]".to_string()),
                fable: Some("kimi-k3".to_string()),
                sonnet: Some("GLM-5.1".to_string()),
                opus: Some("MiniMax-M4[1m]".to_string()),
                haiku: Some("deepseek-v4-flash".to_string()),
                ..ClaudeModelOverrides::default()
            },
        );
        // Tier ids stay stable; runtime model + display name are rewritten.
        let fable = models.iter().find(|m| m.id == "claude-fable-5").unwrap();
        assert_eq!(fable.model, "kimi-k3");
        assert_eq!(fable.name, "kimi-k3");
        assert!(fable.description.contains("Fable 5"));

        let opus = models.iter().find(|m| m.id == "claude-opus-5").unwrap();
        assert_eq!(opus.model, "MiniMax-M4[1m]");
        assert_eq!(opus.name, "MiniMax-M4[1m]");

        let sonnet = models.iter().find(|m| m.id == "claude-sonnet-5").unwrap();
        assert_eq!(sonnet.model, "GLM-5.1");
        assert_eq!(sonnet.name, "GLM-5.1");

        let haiku = models
            .iter()
            .find(|m| m.id == "claude-haiku-4-5-20251001")
            .unwrap();
        assert_eq!(haiku.model, "deepseek-v4-flash");
        assert_eq!(haiku.name, "deepseek-v4-flash");

        // No synthetic settings-* catalog rows.
        assert!(!models.iter().any(|model| model.id.starts_with("settings-")));
        assert_eq!(models.len(), 4);
    }

    #[tokio::test]
    async fn claude_models_include_builtin_catalog() {
        let models = get_claude_models("claude", None).await;
        // Builtin tier catalog ids always remain, even when settings rewrite the
        // runtime model (e.g. all tiers → kimi-k3).
        for catalog_id in [
            "claude-opus-5",
            "claude-fable-5",
            "claude-sonnet-5",
            "claude-haiku-4-5-20251001",
        ] {
            assert!(
                models.iter().any(|model| model.id == catalog_id),
                "missing builtin catalog id {catalog_id}"
            );
        }
        // Bare help aliases are still not synthesized as catalog entries.
        assert!(!models.iter().any(|model| model.id == "sonnet"));
        assert!(!models.iter().any(|model| model.id == "opus"));
        assert!(!models.iter().any(|model| model.id == "haiku"));
        assert_eq!(models.iter().filter(|model| model.default).count(), 1);
    }

    #[test]
    fn claude_settings_overrides_map_all_tiers_to_same_runtime_without_collapse() {
        let mut models = get_builtin_claude_models();
        apply_claude_model_overrides(
            &mut models,
            ClaudeModelOverrides {
                fable: Some("kimi-k3".to_string()),
                sonnet: Some("kimi-k3".to_string()),
                opus: Some("kimi-k3".to_string()),
                haiku: Some("kimi-k3".to_string()),
                ..ClaudeModelOverrides::default()
            },
        );
        ensure_default_model(&mut models);
        let models = dedupe_models_preserve_order(models);

        // All four tiers remain visible even when they share the same runtime model.
        assert_eq!(models.len(), 4);
        assert!(models.iter().all(|model| model.model == "kimi-k3"));
        assert!(models.iter().all(|model| model.name == "kimi-k3"));
        assert!(models.iter().any(|model| model.id == "claude-fable-5"));
        assert!(models.iter().any(|model| model.id == "claude-opus-5"));
        assert!(models.iter().any(|model| model.id == "claude-sonnet-5"));
        assert!(models
            .iter()
            .any(|model| model.id == "claude-haiku-4-5-20251001"));
        // Tier descriptions are preserved for the subtitle row.
        assert!(models
            .iter()
            .find(|model| model.id == "claude-fable-5")
            .unwrap()
            .description
            .contains("Mythos"));
    }

    #[test]
    fn claude_builtin_catalog_defaults_to_opus() {
        let mut models = get_builtin_claude_models();
        apply_claude_model_overrides(&mut models, ClaudeModelOverrides::default());
        ensure_default_model(&mut models);
        let models = dedupe_models_preserve_order(models);

        assert_eq!(models.len(), 4);
        assert!(models
            .iter()
            .all(|model| model.provider.as_deref() == Some("anthropic")));
        assert!(models.iter().all(|model| model.source == "builtin"));
        let default_model = models.iter().find(|model| model.default).unwrap();
        assert_eq!(default_model.id, "claude-opus-5");
        assert_eq!(default_model.name, "Opus 5");
    }

    #[test]
    fn claude_model_dedupe_uses_catalog_id() {
        // Same catalog id collapses.
        let same_id = dedupe_models_preserve_order(vec![
            ModelInfo::new("cli-sonnet", "Sonnet")
                .with_runtime_model("sonnet")
                .with_source("cli-discovered"),
            ModelInfo::new("cli-sonnet", "Fallback Sonnet")
                .with_runtime_model("sonnet")
                .with_source("builtin-fallback"),
        ]);
        assert_eq!(same_id.len(), 1);
        assert_eq!(same_id[0].source, "cli-discovered");

        // Different catalog ids with the same runtime model stay distinct
        // (required when ANTHROPIC_DEFAULT_* map every tier to one model).
        let shared_runtime = dedupe_models_preserve_order(vec![
            ModelInfo::new("claude-opus-5", "kimi-k3")
                .with_runtime_model("kimi-k3")
                .with_source("settings-mapped"),
            ModelInfo::new("claude-sonnet-5", "kimi-k3")
                .with_runtime_model("kimi-k3")
                .with_source("settings-mapped"),
        ]);
        assert_eq!(shared_runtime.len(), 2);
    }

    #[test]
    fn claude_provider_catalog_precedes_and_appends_public_models() {
        let env = std::collections::BTreeMap::from([(
            "ANTHROPIC_MODEL".to_string(),
            "claude-opus-5".to_string(),
        )]);
        let models = finalize_provider_scoped_catalog(
            EngineType::Claude,
            claude_provider_models_from_env("provider-a", &env),
        );

        // Provider catalog carries the full tier list, all scoped to the profile.
        // With only ANTHROPIC_MODEL set, every family falls back to that main slot.
        assert!(
            models
                .iter()
                .filter(|model| model.provider_profile_id.as_deref() == Some("provider-a"))
                .count()
                >= 4
        );
        assert_eq!(models[0].provider_profile_id.as_deref(), Some("provider-a"));
        assert!(models.iter().any(|model| model.id == "claude-opus-5"));
        assert!(models.iter().any(|model| model.id == "claude-sonnet-5"));
        assert!(models
            .iter()
            .filter(|model| model.provider_profile_id.as_deref() == Some("provider-a"))
            .all(|model| model.model == "claude-opus-5"));
    }

    #[test]
    fn codex_provider_catalog_skips_public_fallback_merge() {
        let provider_models = codex_provider_models_from_config(
            "provider-a",
            "model = \"gpt-5.3-codex\"\nmodel_provider = \"proxy-a\"\n",
            vec![crate::types::CodexCustomModel {
                id: "provider-only".to_string(),
                label: "Provider Only".to_string(),
                description: None,
            }],
        )
        .expect("parse provider catalog");
        let models = finalize_provider_scoped_catalog(EngineType::Codex, provider_models);

        assert_eq!(
            models
                .iter()
                .filter(|model| model.model == "gpt-5.3-codex")
                .count(),
            1
        );
        assert!(models.iter().any(|model| {
            model.model == "provider-only"
                && model.provider_profile_id.as_deref() == Some("provider-a")
        }));
        // Codex managed scope 不得出现幽灵官方 fallback 条目
        assert!(models
            .iter()
            .all(|model| model.source != "fallback" && model.provider_profile_id.is_some()));
    }

    #[test]
    fn kimi_provider_catalog_precedes_duplicate_public_model() {
        let provider = crate::types::KimiProviderConfig {
            id: "provider-a".to_string(),
            name: "Provider A".to_string(),
            remark: None,
            website_url: None,
            created_at: None,
            sort_order: None,
            is_active: false,
            is_local_provider: None,
            base_url: "https://example.test".to_string(),
            api_key: "secret".to_string(),
            model: "kimi-for-coding".to_string(),
            provider_type: Some("openai".to_string()),
            max_context_size: None,
            display_name: Some("Provider Kimi".to_string()),
        };
        let models = finalize_provider_scoped_catalog(
            EngineType::Kimi,
            kimi_provider_models_from_config("provider-a", provider),
        );

        assert_eq!(
            models
                .iter()
                .filter(|model| model.model == "kimi-for-coding")
                .count(),
            1
        );
        assert_eq!(models[0].name, "Provider Kimi");
        assert_eq!(models[0].provider_profile_id.as_deref(), Some("provider-a"));
    }

    #[test]
    fn grok_config_models_use_alias_as_runtime_model() {
        let home = std::env::temp_dir().join(format!("ccgui-grok-alias-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).expect("create temp grok home");
        std::fs::write(
            home.join("config.toml"),
            "[models]\ndefault = \"grok\"\n\n[model.grok]\nmodel = \"grok-4.5\"\nname = \"Grok 4.5\"\nbase_url = \"https://relay.example.test/v1\"\napi_key = \"sk-test\"\n",
        )
        .expect("write config.toml");

        let models = read_grok_models_from_config(Some(home.as_path()))
            .expect("parse config")
            .expect("models present");

        assert_eq!(models.len(), 1);
        // `-m` must receive the section alias so the CLI resolves the custom
        // base_url/api_key; the inner `model` field would select the built-in.
        assert_eq!(models[0].id, "grok");
        assert_eq!(models[0].model, "grok");
        assert_eq!(models[0].name, "Grok 4.5");
        assert!(models[0].default);

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn grok_provider_models_use_materialized_alias() {
        let provider = crate::types::GrokProviderConfig {
            id: "provider-a".to_string(),
            name: "Provider A".to_string(),
            remark: None,
            website_url: None,
            created_at: None,
            sort_order: None,
            is_active: false,
            is_local_provider: None,
            base_url: "https://example.test".to_string(),
            api_key: "secret".to_string(),
            model: "grok-4.5".to_string(),
            provider_type: None,
            api_backend: Some("responses".to_string()),
            max_context_size: None,
            display_name: Some("Provider Grok".to_string()),
        };
        let models = grok_provider_models_from_config("provider-a", provider);

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "ccgui/grok-4.5");
        assert_eq!(models[0].model, "ccgui/grok-4.5");
        assert_eq!(models[0].name, "Provider Grok");
        assert!(models[0].default);
    }

    #[test]
    fn generated_fallback_round_trips_provider_protocol_and_provenance() {
        let codex = get_codex_models();
        let gemini = get_gemini_models();
        let grok = get_builtin_grok_models();
        let kimi = get_builtin_kimi_models();
        assert!(!codex.is_empty());
        assert!(!gemini.is_empty());
        assert!(!grok.is_empty());
        assert!(!kimi.is_empty());
        assert!(codex.iter().all(|model| {
            model.provider.as_deref() == Some("openai")
                && model.protocol.as_deref() == Some("openai-responses")
                && model.provenance.as_deref() == Some("generated:model-catalog")
        }));
        assert!(grok.iter().all(|model| {
            model.provider.as_deref() == Some("grok")
                && model.protocol.as_deref() == Some("grok")
                && model.provenance.as_deref() == Some("generated:model-catalog")
        }));
        assert!(kimi.iter().all(|model| {
            model.provider.as_deref() == Some("kimi")
                && model.protocol.as_deref() == Some("kimi")
                && model.provenance.as_deref() == Some("generated:model-catalog")
        }));
        assert!(gemini.iter().all(|model| {
            model.provider.as_deref() == Some("google")
                && model.protocol.as_deref() == Some("google-gemini")
                && model.provenance.as_deref() == Some("generated:model-catalog")
        }));
        let serialized = serde_json::to_value(&codex[0]).expect("serialize model");
        assert_eq!(serialized["provider"], "openai");
        assert_eq!(serialized["protocol"], "openai-responses");
        assert_eq!(serialized["lastVerifiedAt"], "2026-07-27");
        assert_eq!(serialized["lifecycle"], "fallback");
    }

    #[test]
    fn home_dir_detection() {
        // These should not panic
        let _ = get_claude_home_dir();
        let _ = get_codex_home_dir();
        let _ = get_gemini_home_dir();
        let _ = get_opencode_home_dir();
        let _ = get_kimi_home_dir();
        let _ = get_grok_home_dir();
    }

    #[tokio::test]
    async fn resolve_engine_type_supports_opencode() {
        let resolved = resolve_engine_type(
            Some("opencode"),
            Some("claude"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            &[],
        )
        .await;
        assert_eq!(resolved, EngineType::OpenCode);
    }

    #[tokio::test]
    async fn resolve_engine_type_normalizes_retired_workspace_gemini_to_allowed_default() {
        let resolved = resolve_engine_type(
            Some("gemini"),
            Some("claude"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            &[],
        )
        .await;
        assert_eq!(resolved, EngineType::Claude);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preferred_engine_detection_never_spawns_or_selects_disabled_gemini() {
        let marker_path = std::env::temp_dir().join(format!(
            "ccgui-gemini-preferred-probe-marker-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let script_path = write_unix_test_cli(&format!(
            "#!/bin/sh\nprintf spawned > '{}'\necho '1.2.3'\n",
            marker_path.display()
        ));

        let resolved = detect_preferred_engine(
            None,
            None,
            Some(script_path.to_string_lossy().as_ref()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        assert_ne!(resolved, EngineType::Gemini);
        assert!(
            !marker_path.exists(),
            "preferred detection must skip Gemini"
        );
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker_path);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn add_workspace_resolver_normalizes_legacy_gemini_default_without_spawn() {
        let marker_path = std::env::temp_dir().join(format!(
            "ccgui-gemini-workspace-resolver-marker-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let script_path = write_unix_test_cli(&format!(
            "#!/bin/sh\nprintf spawned > '{}'\necho '1.2.3'\n",
            marker_path.display()
        ));

        let resolved = resolve_engine_type(
            None,
            Some("gemini"),
            None,
            None,
            Some(script_path.to_string_lossy().as_ref()),
            None,
            None,
            None,
            None,
            None,
            &[],
        )
        .await;

        assert_ne!(resolved, EngineType::Gemini);
        assert!(
            !marker_path.exists(),
            "add-workspace resolution must skip Gemini"
        );
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker_path);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    #[tokio::test]
    async fn resolve_engine_type_supports_kimi() {
        let resolved = resolve_engine_type(
            Some("kimi"),
            Some("claude"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            &[],
        )
        .await;
        assert_eq!(resolved, EngineType::Kimi);
    }

    #[tokio::test]
    async fn resolve_engine_type_supports_grok() {
        let resolved = resolve_engine_type(
            Some("grok"),
            Some("claude"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            &[],
        )
        .await;
        assert_eq!(resolved, EngineType::Grok);
    }

    #[test]
    fn opencode_models_have_defaults() {
        let output = r#"
openai/gpt-5.3-codex
openai/gpt-5.4
opencode/gpt-5-nano
"#;
        let models = parse_opencode_models_output(output);
        assert!(!models.is_empty());
        assert!(models.iter().any(|m| m.default));
        assert!(models.iter().any(|m| m.id == "openai/gpt-5.3-codex"));
        assert!(models.iter().any(|m| m.id == "openai/gpt-5.4"));
    }

    #[test]
    fn opencode_model_name_formatting() {
        let name = format_opencode_model_name("openai", "gpt-5.3-codex");
        assert_eq!(name, "OpenAI/Gpt-5.3-Codex");
    }

    #[test]
    fn parse_opencode_models_output_handles_ansi_and_extra_columns() {
        let output = "\u{1b}[32mopenai/gpt-5.3-codex\u{1b}[0m  default\nminimax-cn-coding-plan/MiniMax-M2.5 available\n";
        let models = parse_opencode_models_output(output);
        assert_eq!(models.len(), 2);
        assert!(models.iter().any(|m| m.id == "openai/gpt-5.3-codex"));
        assert!(models
            .iter()
            .any(|m| m.id == "minimax-cn-coding-plan/MiniMax-M2.5"));
    }

    #[test]
    fn opencode_validation_prefers_runtime_snapshot_over_generated_fallback() {
        let runtime_models =
            parse_opencode_models_output("minimax-cn-coding-plan/MiniMax-M2.5 available\n");
        let selected = resolve_opencode_validation_catalog(
            Some(runtime_models),
            public_models_for_engine(EngineType::OpenCode),
        );

        assert!(selected
            .iter()
            .any(|model| model.id == "minimax-cn-coding-plan/MiniMax-M2.5"));
    }

    #[test]
    fn parse_gemini_model_from_config_json_extracts_trimmed_model() {
        let config = json!({
            "gemini": {
                "env": {
                    "GEMINI_MODEL": "  [L]gemini-3-pro-preview  "
                }
            }
        });
        let model = parse_gemini_model_from_config_json(&config);
        assert_eq!(model.as_deref(), Some("[L]gemini-3-pro-preview"));
    }

    #[cfg(unix)]
    fn write_unix_test_cli(script_body: &str) -> PathBuf {
        write_unix_test_cli_named(script_body, "codex-status-cli")
    }

    #[cfg(unix)]
    fn write_unix_test_cli_named(script_body: &str, file_name: &str) -> PathBuf {
        let unique = format!(
            "ccgui-engine-status-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&dir).expect("create temp cli dir");
        let script_path = dir.join(file_name);
        fs::write(&script_path, script_body).expect("write temp cli script");
        let mut permissions = fs::metadata(&script_path)
            .expect("stat temp cli script")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("chmod temp cli script");
        script_path
    }

    #[cfg(unix)]
    fn unique_test_marker(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ccgui-detect-marker-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    /// refactor-engine-detection-pipeline B1.2：detect_all_engines（启动检测路径）
    /// MUST NOT 运行 `opencode models` 目录探测——模型目录只允许走
    /// `get_engine_models` 按需路径。
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_all_engines_skips_opencode_model_listing() {
        let marker = unique_test_marker("opencode-models");
        let script_path = write_unix_test_cli_named(
            &format!(
                "#!/bin/sh\ncase \"$1\" in\n  models) printf x >> '{}'\n  ;;\nesac\necho '1.2.3'\n",
                marker.display()
            ),
            "opencode",
        );
        let opencode_bin = script_path.to_string_lossy().to_string();

        let statuses = detect_all_engines(
            None,
            None,
            None,
            Some(&opencode_bin),
            None,
            None,
            None,
            None,
            &crate::engine::dsh::supervisor::DshRuntimeSettings::default(),
            false,
        )
        .await;

        let opencode = statuses
            .iter()
            .find(|status| status.engine_type == EngineType::OpenCode)
            .expect("opencode status present");
        assert!(
            !marker.exists(),
            "detect_all_engines must not spawn `opencode models` probe"
        );
        assert!(
            opencode.models.is_empty(),
            "lightweight detection must not carry selectable snapshot models"
        );
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    /// refactor-engine-detection-pipeline B1.2：detect_all_engines MUST NOT 运行
    /// PI 的 RPC / `--list-models` models 探测链。
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_all_engines_skips_pi_model_probe_chain() {
        let marker = unique_test_marker("pi-models");
        let script_path = write_unix_test_cli_named(
            &format!(
                "#!/bin/sh\ncase \"$*\" in\n  *list-models*|*rpc*) printf x >> '{}'\n  ;;\nesac\necho '1.2.3'\n",
                marker.display()
            ),
            "pi",
        );
        let pi_bin = script_path.to_string_lossy().to_string();

        let statuses = detect_all_engines(
            None,
            None,
            None,
            None,
            None,
            None,
            Some(&pi_bin),
            None,
            &crate::engine::dsh::supervisor::DshRuntimeSettings::default(),
            false,
        )
        .await;

        let pi = statuses
            .iter()
            .find(|status| status.engine_type == EngineType::Pi)
            .expect("pi status present");
        assert!(
            !marker.exists(),
            "detect_all_engines must not spawn the pi models probe chain"
        );
        assert!(
            pi.models.iter().all(|model| model.source == "fallback"),
            "lightweight detection carries a fallback snapshot only"
        );
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    /// refactor-engine-detection-pipeline B1.1：detect_all_engines MUST NOT 运行
    /// Qoder 的 `--acp` ACP 握手 / `session/new` models 探测。
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_all_engines_skips_qoder_acp_model_probe() {
        let marker = unique_test_marker("qoder-acp");
        let script_path = write_unix_test_cli_named(
            &format!(
                "#!/bin/sh\ncase \"$1\" in\n  --acp) printf x >> '{}'\n  ;;\n  status) printf '{{\"authenticated\": true}}'\n  ;;\nesac\necho '1.2.3'\n",
                marker.display()
            ),
            "qodercli",
        );
        let qoder_bin = script_path.to_string_lossy().to_string();

        let statuses = detect_all_engines(
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(&qoder_bin),
            &crate::engine::dsh::supervisor::DshRuntimeSettings::default(),
            false,
        )
        .await;

        let qoder = statuses
            .iter()
            .find(|status| status.engine_type == EngineType::Qoder)
            .expect("qoder status present");
        assert!(
            qoder.installed,
            "fake qodercli reports a version, detection must treat it as installed"
        );
        assert!(
            !marker.exists(),
            "detect_all_engines must not run the qoder ACP model probe"
        );
        assert!(
            qoder.models.is_empty(),
            "qoder is ACP runtime-only: fallback snapshot stays empty"
        );
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    /// refactor-engine-detection-pipeline B1.3（启用范围铁律）：黑名单引擎
    /// MUST 0 spawn 且不出现在结果中，其余引擎照常。
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_all_engines_scoped_skips_disabled_engines_without_spawning() {
        let marker = unique_test_marker("kimi-disabled");
        let script_path = write_unix_test_cli_named(
            &format!(
                "#!/bin/sh\nprintf x >> '{}'\necho '1.2.3'\n",
                marker.display()
            ),
            "kimi",
        );
        let kimi_bin = script_path.to_string_lossy().to_string();

        let statuses = detect_all_engines_scoped(
            None,
            None,
            None,
            None,
            Some(&kimi_bin),
            None,
            None,
            None,
            &crate::engine::dsh::supervisor::DshRuntimeSettings::default(),
            false,
            &[EngineType::Kimi],
            0,
            None,
        )
        .await;

        assert!(
            statuses
                .iter()
                .all(|status| status.engine_type != EngineType::Kimi),
            "disabled engine must not appear in detection results"
        );
        assert!(
            !marker.exists(),
            "disabled engine must not be probed at all"
        );
        assert!(
            statuses
                .iter()
                .any(|status| status.engine_type == EngineType::Grok),
            "other engines keep being detected"
        );
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    /// refactor-engine-detection-pipeline B1.4（隔离铁律）：单引擎探测 panic
    /// MUST 只落该引擎 error，其他引擎结果不受影响。
    #[tokio::test]
    async fn engine_detection_isolation_contains_panicking_probe() {
        let healthy = run_engine_detection_isolated(
            EngineType::Kimi,
            || async {
                let mut status = disabled_engine_status(EngineType::Kimi);
                status.installed = true;
                status.version = Some("1.0.0".to_string());
                status
            },
            0,
            None,
        );
        let panicking = run_engine_detection_isolated(
            EngineType::Grok,
            || async {
                panic!("probe exploded");
                #[allow(unreachable_code)]
                disabled_engine_status(EngineType::Grok)
            },
            0,
            None,
        );
        let (healthy, panicking) = tokio::join!(healthy, panicking);

        assert!(
            healthy.installed,
            "healthy engine detection must be unaffected by the panicking probe"
        );
        assert!(!panicking.installed);
        assert!(
            panicking
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("engine detection task failed"),
            "panic must be contained as a per-engine error, got {:?}",
            panicking.error
        );
    }

    /// refactor-engine-detection-pipeline B6：Qoder 检测 phase 1 MUST NOT
    /// spawn 登录探测命令（`qodercli status`）——spawn 型探测延后到 phase 2。
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_all_engines_qoder_phase1_never_spawns_login_probe() {
        let marker = unique_test_marker("qoder-login-phase1");
        let script_path = write_unix_test_cli_named(
            &format!(
                "#!/bin/sh\ncase \"$*\" in\n  *status*) printf x >> '{}'\n  ;;\nesac\necho '1.2.3'\n",
                marker.display()
            ),
            "qodercli",
        );
        let qoder_bin = script_path.to_string_lossy().to_string();

        let statuses = detect_all_engines_scoped(
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(&qoder_bin),
            &crate::engine::dsh::supervisor::DshRuntimeSettings::default(),
            false,
            &[],
            0,
            None,
        )
        .await;

        let qoder = statuses
            .iter()
            .find(|status| status.engine_type == EngineType::Qoder)
            .expect("qoder status present");
        assert!(qoder.installed, "fake qodercli reports a version");
        assert!(
            !marker.exists(),
            "phase 1 detection must not spawn `qodercli status` login probe"
        );
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    /// P0 回归锁定：轻量分支 MUST NOT 回填静态快照——EngineStatus.models 是
    /// 乐观选中/新会话默认解析的消费源，静态条目（auto，default=true）曾把
    /// 错误模型绑进 PI 会话（多引擎切换后必现模型错乱 + 发送失败）。目录
    /// 只允许 get_engine_models 真实探测权威填充。
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_pi_light_must_not_carry_snapshot_models() {
        let marker = unique_test_marker("pi-light-backfill");
        let script_path = write_unix_test_cli_named(
            &format!(
                "#!/bin/sh\nprintf x >> '{}'\necho '1.2.3'\n",
                marker.display()
            ),
            "pi",
        );
        let pi_bin = script_path.to_string_lossy().to_string();

        let status = detect_pi_status_with_options(Some(&pi_bin), false).await;

        assert!(status.installed);
        assert!(
            status.models.is_empty() && status.default_model.is_none(),
            "light detection must not carry selectable snapshot models (poisons optimistic selection)"
        );
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    /// refactor-engine-detection-pipeline B4：逐引擎事件——每引擎探测完成
    /// 恰好 emit 一次（runId 单调由 manager 计数保证，这里断言 sink 收集）。
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_all_engines_emits_per_engine_status_events() {
        use std::sync::Mutex as StdMutex;

        let marker = unique_test_marker("kimi-emit");
        let script_path = write_unix_test_cli_named(
            &format!(
                "#!/bin/sh\nprintf x >> '{}'\necho '1.2.3'\n",
                marker.display()
            ),
            "kimi",
        );
        let kimi_bin = script_path.to_string_lossy().to_string();

        let events: Arc<StdMutex<Vec<(u64, EngineType)>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink_events = Arc::clone(&events);
        let on_status: EngineStatusEventSink = Arc::new(move |run_id, status| {
            sink_events
                .lock()
                .expect("events lock")
                .push((run_id, status.engine_type));
        });

        // 仅保留 kimi 启用：事件数 = 实际探测的引擎数（禁用引擎不探测不 emit）。
        let statuses = detect_all_engines_scoped(
            None,
            None,
            None,
            None,
            Some(&kimi_bin),
            None,
            None,
            None,
            &crate::engine::dsh::supervisor::DshRuntimeSettings::default(),
            false,
            &[
                EngineType::Claude,
                EngineType::Codex,
                EngineType::OpenCode,
                EngineType::Grok,
                EngineType::Pi,
                EngineType::Qoder,
                EngineType::Dsh,
            ],
            7,
            Some(on_status),
        )
        .await;

        assert!(
            statuses
                .iter()
                .any(|status| status.engine_type == EngineType::Kimi && status.installed),
            "fake kimi must be detected"
        );
        let events = events.lock().expect("events lock");
        assert_eq!(
            events.len(),
            1,
            "exactly one per-engine event must be emitted"
        );
        assert_eq!(events[0], (7, EngineType::Kimi));
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    /// refactor-engine-detection-pipeline B2：同一轮 Claude 检测内 `claude --version`
    /// MUST 只 spawn 一次（find_claude_code_binary 的候选验证结果 MUST 被复用，
    /// 不得在 probe_cli_version 里重复探测）。
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_claude_status_probes_version_once_per_round() {
        let marker = unique_test_marker("claude-version");
        let script_path = write_unix_test_cli_named(
            &format!(
                "#!/bin/sh\nprintf x >> '{}'\necho '1.2.3 (Claude Code)'\n",
                marker.display()
            ),
            "claude",
        );
        let claude_bin = script_path.to_string_lossy().to_string();

        let status = detect_claude_status(Some(&claude_bin)).await;

        assert!(status.installed, "fake claude reports a version");
        let marker_text = fs::read_to_string(&marker).unwrap_or_default();
        assert_eq!(
            marker_text.chars().count(),
            1,
            "claude --version must be probed exactly once per detection round, got {} invocations",
            marker_text.chars().count()
        );
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disabled_gemini_shared_detection_never_spawns_configured_cli() {
        let marker_path = std::env::temp_dir().join(format!(
            "ccgui-gemini-shared-probe-marker-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let script_path = write_unix_test_cli(&format!(
            "#!/bin/sh\nprintf spawned > '{}'\necho '1.2.3'\n",
            marker_path.display()
        ));

        let status = detect_gemini_status(Some(script_path.to_string_lossy().as_ref())).await;

        assert!(!status.installed);
        assert_eq!(
            status.error.as_deref(),
            Some(crate::engine_policy::GEMINI_DISABLED_DIAGNOSTIC)
        );
        assert!(!marker_path.exists(), "shared Gemini probe must not spawn");
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker_path);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detect_codex_status_does_not_execute_resolved_cli() {
        let marker_path = std::env::temp_dir().join(format!(
            "ccgui-codex-startup-probe-marker-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let script_body = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$1\" >> {}\necho 'codex 0.0.0'\nexit 0\n",
            marker_path.to_string_lossy()
        );
        let script_path = write_unix_test_cli(&script_body);

        let status = detect_codex_status(Some(script_path.to_string_lossy().as_ref())).await;

        assert!(status.installed);
        assert_eq!(status.engine_type, EngineType::Codex);
        assert!(
            !marker_path.exists(),
            "startup Codex status detection must not execute the resolved CLI"
        );

        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&marker_path);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detect_codex_status_reports_metadata_for_unprobeable_cli() {
        let script_path = write_unix_test_cli(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo 'broken version' >&2\n  exit 1\nfi\nif [ \"$1\" = \"--help\" ]; then\n  echo 'usage'\n  exit 0\nfi\nexit 1\n",
        );

        let status = detect_codex_status(Some(script_path.to_string_lossy().as_ref())).await;
        assert!(status.installed);
        assert!(status.version.is_none());
        assert_eq!(status.engine_type, EngineType::Codex);
        assert!(status.bin_path.is_some());
        assert!(status.error.is_none());

        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_dir_all(script_path.parent().unwrap_or(std::path::Path::new("")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detect_opencode_status_falls_back_to_generated_roster_when_models_probe_fails() {
        let unique = format!(
            "ccgui-opencode-light-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&dir).expect("create temp cli dir");
        let script_path = dir.join("opencode");
        let script_body =
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo '1.2.3'\n  exit 0\nfi\nif [ \"$1\" = \"--help\" ]; then\n  echo 'usage'\n  exit 0\nfi\nif [ \"$1\" = \"models\" ]; then\n  echo 'models should not run' >&2\n  exit 7\nfi\nexit 0\n";
        fs::write(&script_path, script_body).expect("write temp cli script");
        let mut permissions = fs::metadata(&script_path)
            .expect("stat temp cli script")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("chmod temp cli script");

        let status = detect_opencode_status(Some(script_path.to_string_lossy().as_ref())).await;
        assert!(status.installed);
        assert!(
            !status.models.is_empty(),
            "failed models probe must fall back to the generated roster"
        );
        assert!(status.error.is_none());

        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn detect_opencode_status_rejects_launcher_like_windows_candidate() {
        let unique = format!(
            "ccgui-opencode-launcher-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let bin_path = root
            .join("AppData")
            .join("Local")
            .join("Programs")
            .join("OpenCode")
            .join("opencode.exe");
        fs::create_dir_all(bin_path.parent().expect("launcher dir")).expect("create launcher dir");
        fs::write(&bin_path, []).expect("create fake launcher");

        let status = detect_opencode_status(Some(bin_path.to_string_lossy().as_ref())).await;
        assert!(!status.installed);
        assert!(status
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("[OPENCODE_CLI_UNSAFE]"));

        let _ = fs::remove_file(&bin_path);
        let _ = fs::remove_dir_all(&root);
    }
}
