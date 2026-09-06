use super::{images, safe_prompt_arg, BuiltCommand, Engine, EngineEvent, SendRequest};
use serde_json::Value;
use std::collections::HashMap;
use tokio::process::Command;

pub struct KimiEngine;

impl Engine for KimiEngine {
    fn id(&self) -> &'static str {
        "kimi"
    }

    fn supports_images(&self) -> bool {
        // build_command injects absolute image paths + a ReadMediaFile
        // instruction into the prompt; that IS the kimi image transport.
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
        cmd.arg("stream-json");
        if let Some(model) = req.model.as_deref() {
            cmd.arg("--model");
            cmd.arg(model);
        }
        if let Some(session_id) = req.session_id.as_deref() {
            cmd.arg("--session");
            cmd.arg(session_id);
        }
        let prompt_text = images::kimi_prompt_with_images(&req.prompt, &req.images, &req.workspace);
        cmd.arg("--prompt");
        cmd.arg(safe_prompt_arg(&prompt_text));
        Ok(BuiltCommand {
            command: cmd,
            stdin_payload: None,
            cleanup_files: Vec::new(),
            preassigned_session_id: None,
        })
    }

    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let role = value.get("role").and_then(Value::as_str).unwrap_or("");
        match role {
            "assistant" => {
                if let Some(content) = value.get("content") {
                    let text = crate::history::content_text(Some(content));
                    if !text.is_empty() {
                        out.push(EngineEvent::Message {
                            role: "assistant".to_string(),
                            text,
                        });
                    }
                }
                if let Some(tool_calls) = value.get("tool_calls").and_then(Value::as_array) {
                    for call in tool_calls {
                        let name = call
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        out.push(EngineEvent::Message {
                            role: "tool".to_string(),
                            text: name.to_string(),
                        });
                    }
                }
                if let Some(usage) = value.get("usage") {
                    out.push(EngineEvent::Usage(usage.clone()));
                }
            }
            "tool" => {
                if let Some(content) = value.get("content").and_then(Value::as_str) {
                    if !content.trim().is_empty() {
                        out.push(EngineEvent::Message {
                            role: "tool".to_string(),
                            text: content.trim().chars().take(200).collect(),
                        });
                    }
                }
            }
            "meta" => {
                if value.get("type").and_then(Value::as_str) == Some("session.resume_hint") {
                    if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                        if !id.trim().is_empty() {
                            out.push(EngineEvent::SessionId(id.trim().to_string()));
                        }
                    }
                }
            }
            _ => {}
        }
    }
}
