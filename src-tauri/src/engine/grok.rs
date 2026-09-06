use super::{images, safe_prompt_arg, BuiltCommand, Engine, EngineEvent, SendRequest};
use serde_json::Value;
use std::collections::HashMap;
use tokio::process::Command;

pub struct GrokEngine;

impl Engine for GrokEngine {
    fn id(&self) -> &'static str {
        "grok"
    }

    fn supports_images(&self) -> bool {
        true
    }

    fn build_command(
        &self,
        req: &SendRequest,
        _env: &HashMap<String, String>,
        bin: &str,
    ) -> Result<BuiltCommand, String> {
        let mut cmd = Command::new(bin);
        cmd.arg("--output-format");
        cmd.arg("streaming-json");
        cmd.arg("--always-approve");
        if let Some(model) = req.model.as_deref() {
            cmd.arg("-m");
            cmd.arg(model);
        }
        // `-s` creates a NEW session with a caller-chosen UUID and errors if it
        // already exists; `-r` resumes. Never both.
        let preassigned = match req.session_id.as_deref() {
            Some(existing) => {
                cmd.arg("-r");
                cmd.arg(existing);
                Some(existing.to_string())
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                cmd.arg("-s");
                cmd.arg(&id);
                Some(id)
            }
        };

        let mut cleanup_files = Vec::new();
        match images::grok_prompt_json(&req.prompt, &req.images, &req.workspace)? {
            Some(prompt_json) => {
                // Staging file so base64 payloads never hit ARG_MAX.
                let dir = crate::paths::app_home().join("grok-staging");
                std::fs::create_dir_all(&dir)
                    .map_err(|e| format!("create grok staging dir: {e}"))?;
                let path = dir.join(format!("grok-prompt-{}.json", uuid::Uuid::new_v4()));
                std::fs::write(&path, prompt_json)
                    .map_err(|e| format!("write grok prompt file: {e}"))?;
                cmd.arg("--prompt-file");
                cmd.arg(&path);
                cleanup_files.push(path);
            }
            None => {
                cmd.arg("-p");
                cmd.arg(safe_prompt_arg(&req.prompt));
            }
        }
        // Grok 0.2.x has no --no-auto-update flag; disable via env.
        cmd.env("GROK_DISABLE_AUTOUPDATER", "1");
        Ok(BuiltCommand {
            command: cmd,
            stdin_payload: None,
            cleanup_files,
            preassigned_session_id: preassigned,
        })
    }

    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "text" => {
                if let Some(text) = value.get("data").and_then(Value::as_str) {
                    if !text.is_empty() {
                        out.push(EngineEvent::Delta(text.to_string()));
                    }
                }
            }
            "thought" => {
                if let Some(text) = value.get("data").and_then(Value::as_str) {
                    if !text.is_empty() {
                        out.push(EngineEvent::Thinking(text.to_string()));
                    }
                }
            }
            "end" => {
                let session_id = value
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let usage = value.get("usage").cloned();
                out.push(EngineEvent::Done { session_id, usage });
            }
            "error" => {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("grok error")
                    .to_string();
                out.push(EngineEvent::Error(message));
            }
            _ => {}
        }
    }
}
