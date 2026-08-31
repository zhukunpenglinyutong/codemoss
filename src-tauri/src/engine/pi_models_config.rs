//! PI CLI custom providers: read/write `~/.pi/agent/models.json`.
//!
//! Contract (openspec/changes/add-pi-models-json-config):
//! - models.json defines custom providers / relays (baseUrl, api type, models).
//! - Validation is intentionally LOOSE: JSONC-parseable, `providers` object,
//!   each provider's `models` array items carry a string `id`. Unknown fields
//!   are accepted and preserved.
//! - Writes store the user's RAW TEXT (no parse→serialize roundtrip): comments,
//!   field order and unknown fields survive. Writes are atomic (same-dir tmp +
//!   rename) with `0600` permissions on Unix.
//! - Fail-closed: any validation/IO error leaves the existing file untouched.
//!
//! Security boundary — deliberately different from `pi_auth.rs`:
//! models.json `apiKey` values are the user's own config (literal / `$ENV` /
//! `!command`), so the raw file text IS returned to the frontend for editing.
//! Do NOT merge this module with the auth.json masking policy: auth.json keys
//! never leave `pi_auth.rs`, while models.json content is user-editable text.

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::remote_backend;
use crate::state::AppState;

use super::EngineType;

/// Read custom provider models for the runtime catalog. Invalid or missing
/// files fail soft; the CLI probe remains the source of truth for built-ins.
pub fn load_custom_model_entries(home_override: Option<&str>) -> Vec<(String, Value)> {
    let path = resolve_pi_models_config_file(home_override);
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(root) = validate_models_config_text(&text) else {
        return Vec::new();
    };
    let Some(providers) = root.get("providers").and_then(Value::as_object) else {
        return Vec::new();
    };
    providers
        .iter()
        .flat_map(|(provider, value)| {
            value
                .get("models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|model| Some((provider.clone(), model.clone())))
        })
        .collect()
}

/// Default template offered when models.json is missing or empty.
/// Frontend pre-fills the editor with this; it is NOT written until the user saves.
const DEFAULT_TEMPLATE: &str = r#"{
  "providers": {
    "my-relay": {
      "baseUrl": "https://your-relay.com/v1",
      // api 类型：openai-completions | openai-responses | anthropic-messages | google-generative-ai
      "api": "openai-responses",
      // 推荐引用环境变量；也支持明文 key 或 !command（如 !op read 'op://vault/item'）
      "apiKey": "$MY_RELAY_API_KEY",
      "models": [
        {
          "id": "grok-4.6",
          "name": "Grok 4.6 (中转)",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 500000,
          "maxTokens": 500000
        }
      ]
    }
  }
}
"#;

/// Resolve `<agent>/models.json`, mirroring `pi_auth::resolve_pi_auth_file`:
/// engine-config home override → `PI_CODING_AGENT_DIR` → `~/.pi/agent`.
pub fn resolve_pi_models_config_file(home_override: Option<&str>) -> PathBuf {
    if let Some(home) = home_override.map(str::trim).filter(|v| !v.is_empty()) {
        return PathBuf::from(home).join("models.json");
    }
    if let Ok(agent_dir) = std::env::var("PI_CODING_AGENT_DIR") {
        let trimmed = agent_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("models.json");
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("models.json")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiCustomProviderSummary {
    pub id: String,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub api: Option<String>,
    pub model_count: usize,
    pub has_api_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModelsFileInfo {
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModelsConfigReadResult {
    pub file: PiModelsFileInfo,
    /// Raw file text (comments included); `None` when the file does not exist.
    pub text: Option<String>,
    /// Default example for the editor when `text` is missing/blank.
    pub template: String,
    pub providers: Vec<PiCustomProviderSummary>,
    /// Human-readable parse error when the file is corrupted; summaries stay empty.
    pub parse_error: Option<String>,
}

/// Strip `//` and `/* */` comments outside string literals (JSONC → JSON).
/// Kept deliberately small; sufficient for hand-written config files.
fn strip_jsonc_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(ch) = chars.next() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
            }
            '/' if chars.peek() == Some(&'/') => {
                // Line comment: consume to (not including) newline.
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next(); // consume '*'
                let mut prev = '\0';
                for c in chars.by_ref() {
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Loose structural validation (design D2). Returns the parsed value on success.
fn validate_models_config_text(text: &str) -> Result<Value, String> {
    let stripped = strip_jsonc_comments(text);
    let value: Value = serde_json::from_str(&stripped)
        .map_err(|error| format!("[PI_MODELS_INVALID_JSON] models.json 不是合法 JSON：{error}"))?;
    let root = value.as_object().ok_or_else(|| {
        "[PI_MODELS_INVALID_SHAPE] models.json 根节点必须是 JSON 对象".to_string()
    })?;
    if let Some(providers) = root.get("providers") {
        let providers = providers.as_object().ok_or_else(|| {
            "[PI_MODELS_INVALID_SHAPE] providers 必须是对象（providerId → 配置）".to_string()
        })?;
        for (provider_id, provider) in providers {
            if !provider.is_object() {
                return Err(format!(
                    "[PI_MODELS_INVALID_SHAPE] providers.{provider_id} 必须是对象"
                ));
            }
            if let Some(models) = provider.get("models") {
                let models = models.as_array().ok_or_else(|| {
                    format!("[PI_MODELS_INVALID_SHAPE] providers.{provider_id}.models 必须是数组")
                })?;
                for (index, model) in models.iter().enumerate() {
                    let has_id = model.get("id").and_then(Value::as_str).is_some();
                    if !has_id {
                        return Err(format!(
                            "[PI_MODELS_INVALID_SHAPE] providers.{provider_id}.models[{index}] 缺少字符串 id"
                        ));
                    }
                }
            }
        }
    }
    Ok(value)
}

fn summarize_providers(value: &Value) -> Vec<PiCustomProviderSummary> {
    let mut out = Vec::new();
    let Some(providers) = value.get("providers").and_then(Value::as_object) else {
        return out;
    };
    for (id, provider) in providers {
        let model_count = provider
            .get("models")
            .and_then(Value::as_array)
            .map(|models| models.len())
            .unwrap_or(0);
        let has_api_key = provider
            .get("apiKey")
            .and_then(Value::as_str)
            .map(|key| !key.trim().is_empty())
            .unwrap_or(false);
        out.push(PiCustomProviderSummary {
            id: id.clone(),
            name: provider
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            base_url: provider
                .get("baseUrl")
                .and_then(Value::as_str)
                .map(str::to_string),
            api: provider
                .get("api")
                .and_then(Value::as_str)
                .map(str::to_string),
            model_count,
            has_api_key,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub async fn read_pi_models_config(
    home_override: Option<&str>,
) -> Result<PiModelsConfigReadResult, String> {
    let path = resolve_pi_models_config_file(home_override);
    let file_info = |exists: bool| PiModelsFileInfo {
        path: path.to_string_lossy().to_string(),
        exists,
    };

    let text = match tokio::fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PiModelsConfigReadResult {
                file: file_info(false),
                text: None,
                template: DEFAULT_TEMPLATE.to_string(),
                providers: Vec::new(),
                parse_error: None,
            });
        }
        Err(error) => {
            return Err(format!("[PI_MODELS_READ] 读取 models.json 失败：{error}"));
        }
    };

    // Corrupted JSON: fail open for EDITING — return raw text + parseError so the
    // user can fix in place; never block the section (design D6).
    match validate_models_config_text(&text) {
        Ok(value) => Ok(PiModelsConfigReadResult {
            file: file_info(true),
            providers: summarize_providers(&value),
            text: Some(text),
            template: DEFAULT_TEMPLATE.to_string(),
            parse_error: None,
        }),
        Err(error) => Ok(PiModelsConfigReadResult {
            file: file_info(true),
            text: Some(text),
            template: DEFAULT_TEMPLATE.to_string(),
            providers: Vec::new(),
            parse_error: Some(error),
        }),
    }
}

pub async fn write_pi_models_config(text: &str, home_override: Option<&str>) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("[PI_MODELS_EMPTY] 配置内容不能为空；如需移除自定义供应商请保存空 providers：{ \"providers\": {} }".to_string());
    }
    // Validate first; on ANY failure the existing file stays byte-identical.
    validate_models_config_text(text)?;

    let path = resolve_pi_models_config_file(home_override);
    let parent = path
        .parent()
        .ok_or_else(|| "[PI_MODELS_WRITE] models.json 路径无父目录".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("[PI_MODELS_WRITE] 创建 {} 失败：{error}", parent.display()))?;

    let tmp = parent.join(format!(".models.json.tmp-{}", std::process::id()));
    let mut content = text.to_string();
    if !content.ends_with('\n') {
        content.push('\n');
    }

    let write_result = async {
        tokio::fs::write(&tmp, &content)
            .await
            .map_err(|error| format!("[PI_MODELS_WRITE] 写入临时文件失败：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                .await
                .map_err(|error| format!("[PI_MODELS_WRITE] 设置 0600 权限失败：{error}"))?;
        }
        tokio::fs::rename(&tmp, &path)
            .await
            .map_err(|error| format!("[PI_MODELS_WRITE] 原子替换 models.json 失败：{error}"))?;
        Ok::<(), String>(())
    }
    .await;

    if write_result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    write_result
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Read models.json: raw text + provider summaries + parse error tolerance.
#[tauri::command]
pub async fn pi_models_config_read(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "pi_models_config_read",
            serde_json::json!({}),
        )
        .await;
    }
    let config = state.engine_manager.get_engine_config(EngineType::Pi).await;
    let result =
        read_pi_models_config(config.as_ref().and_then(|item| item.home_dir.as_deref())).await?;
    serde_json::to_value(result).map_err(|error| error.to_string())
}

/// Write models.json after loose validation. Raw text is stored verbatim.
#[tauri::command]
pub async fn pi_models_config_write(
    text: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "pi_models_config_write",
            serde_json::json!({ "text": text }),
        )
        .await
        .map(|_| ());
    }
    let config = state.engine_manager.get_engine_config(EngineType::Pi).await;
    write_pi_models_config(
        &text,
        config.as_ref().and_then(|item| item.home_dir.as_deref()),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_agent_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mossx-pi-models-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn strip_comments_handles_line_block_and_strings() {
        let input = r#"{
  // line comment
  "a": "http://keep/me", /* block */ "b": 1
}"#;
        let stripped = strip_jsonc_comments(input);
        let value: Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(value["a"], "http://keep/me");
        assert_eq!(value["b"], 1);
    }

    #[test]
    fn strip_comments_ignores_comment_markers_inside_strings() {
        let input = r#"{"url": "https://x.ai/v1", "note": "a /* not comment */ b"}"#;
        let stripped = strip_jsonc_comments(input);
        let value: Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(value["note"], "a /* not comment */ b");
    }

    #[test]
    fn validation_accepts_unknown_fields_and_missing_providers() {
        let value = validate_models_config_text(
            r#"{"providers": {"x": {"baseUrl": "https://a", "futureField": 1, "models": [{"id": "m1", "compat": {"x": true}}]}}, "topLevelFuture": true}"#,
        );
        assert!(value.is_ok());
        // Empty / missing providers is fine.
        assert!(validate_models_config_text(r#"{"providers": {}}"#).is_ok());
        assert!(validate_models_config_text(r#"{}"#).is_ok());
    }

    #[test]
    fn validation_rejects_hard_errors() {
        assert!(validate_models_config_text("{ not json").is_err());
        assert!(validate_models_config_text(r#"[]"#).is_err());
        assert!(validate_models_config_text(r#"{"providers": []}"#).is_err());
        assert!(validate_models_config_text(r#"{"providers": {"x": []}}"#).is_err());
        assert!(validate_models_config_text(r#"{"providers": {"x": {"models": {}}}}"#).is_err());
        assert!(validate_models_config_text(
            r#"{"providers": {"x": {"models": [{"name": "no-id"}]}}}"#
        )
        .is_err());
    }

    #[test]
    fn runtime_entries_use_the_requested_profile_home() {
        let dir = temp_agent_dir("runtime-catalog");
        std::fs::write(
            dir.join("models.json"),
            r#"{
              "providers": {
                "cliproxy": {
                  "models": [
                    {"id": "gpt-custom", "name": "GPT Custom", "reasoning": true}
                  ]
                }
              }
            }"#,
        )
        .unwrap();

        let entries = load_custom_model_entries(dir.to_str());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "cliproxy");
        assert_eq!(entries[0].1["id"], "gpt-custom");
    }

    #[tokio::test]
    async fn read_missing_file_returns_template_and_no_providers() {
        let dir = temp_agent_dir("missing");
        let agent = dir.to_string_lossy().to_string();
        let result = read_pi_models_config(Some(&agent)).await.unwrap();
        assert!(!result.file.exists);
        assert!(result.text.is_none());
        assert!(result.template.contains("grok-4.6"));
        assert!(result.providers.is_empty());
        assert!(result.parse_error.is_none());
    }

    #[tokio::test]
    async fn write_then_read_roundtrip_preserves_raw_text() {
        let dir = temp_agent_dir("roundtrip");
        let agent = dir.to_string_lossy().to_string();
        let raw = "{\n  // 我的中转\n  \"providers\": {\n    \"my-relay\": {\n      \"baseUrl\": \"https://relay.example.com/v1\",\n      \"api\": \"openai-responses\",\n      \"apiKey\": \"$MY_RELAY_API_KEY\",\n      \"futureField\": {\"keep\": true},\n      \"models\": [{\"id\": \"grok-4.6\", \"reasoning\": true}]\n    }\n  }\n}\n";

        write_pi_models_config(raw, Some(&agent)).await.unwrap();

        // Raw text preserved byte-for-byte (comments, order, unknown fields).
        let on_disk = std::fs::read_to_string(dir.join("models.json")).unwrap();
        assert_eq!(on_disk, raw);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.join("models.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        let result = read_pi_models_config(Some(&agent)).await.unwrap();
        assert!(result.file.exists);
        assert_eq!(result.text.as_deref(), Some(raw));
        assert!(result.parse_error.is_none());
        assert_eq!(result.providers.len(), 1);
        let relay = &result.providers[0];
        assert_eq!(relay.id, "my-relay");
        assert_eq!(
            relay.base_url.as_deref(),
            Some("https://relay.example.com/v1")
        );
        assert_eq!(relay.api.as_deref(), Some("openai-responses"));
        assert_eq!(relay.model_count, 1);
        assert!(relay.has_api_key);
    }

    #[tokio::test]
    async fn invalid_write_leaves_existing_file_untouched() {
        let dir = temp_agent_dir("failclosed");
        let agent = dir.to_string_lossy().to_string();
        let file = dir.join("models.json");
        std::fs::write(&file, r#"{"providers": {"ok": {"models": [{"id": "m"}]}}}"#).unwrap();

        assert!(write_pi_models_config("{ broken", Some(&agent))
            .await
            .is_err());
        assert!(
            write_pi_models_config(r#"{"providers": {"x": {"models": [{}]}}}"#, Some(&agent))
                .await
                .is_err()
        );
        assert!(write_pi_models_config("   ", Some(&agent)).await.is_err());

        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            r#"{"providers": {"ok": {"models": [{"id": "m"}]}}}"#
        );
    }

    #[tokio::test]
    async fn corrupted_existing_file_surfaces_parse_error_but_stays_editable() {
        let dir = temp_agent_dir("corrupted");
        let agent = dir.to_string_lossy().to_string();
        let file = dir.join("models.json");
        std::fs::write(&file, "{ not json").unwrap();

        let result = read_pi_models_config(Some(&agent)).await.unwrap();
        assert!(result.file.exists);
        assert_eq!(result.text.as_deref(), Some("{ not json"));
        assert!(result.providers.is_empty());
        assert!(result
            .parse_error
            .unwrap()
            .contains("PI_MODELS_INVALID_JSON"));

        // User can fix in place: a valid write succeeds over the corrupted file.
        write_pi_models_config(r#"{"providers": {}}"#, Some(&agent))
            .await
            .unwrap();
        let fixed = read_pi_models_config(Some(&agent)).await.unwrap();
        assert!(fixed.parse_error.is_none());
    }

    #[test]
    fn resolve_prefers_home_override() {
        let path = resolve_pi_models_config_file(Some("/tmp/custom-agent"));
        assert_eq!(path, PathBuf::from("/tmp/custom-agent/models.json"));
    }
}
