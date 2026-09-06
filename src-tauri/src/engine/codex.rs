use super::{images, safe_prompt_arg, BuiltCommand, Engine, EngineEvent, SendRequest};
use serde_json::Value;
use std::collections::HashMap;
use tokio::process::Command;

/// Codex one-shot: `codex exec --json` (verified against codex CLI live).
/// The legacy app used the persistent app-server JSON-RPC; exec mode gives
/// the same session files and item.completed messages without a daemon.
pub struct CodexEngine;

impl Engine for CodexEngine {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn supports_images(&self) -> bool {
        true // -i/--image FILE
    }

    fn build_command(
        &self,
        req: &SendRequest,
        _env: &HashMap<String, String>,
        bin: &str,
    ) -> Result<BuiltCommand, String> {
        let mut cmd = Command::new(bin);
        cmd.arg("exec");
        let mut preassigned = None;
        if let Some(session_id) = req.session_id.as_deref() {
            // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`
            cmd.arg("resume");
            cmd.arg("--json");
            cmd.arg(session_id);
            preassigned = Some(session_id.to_string());
        } else {
            cmd.arg("--json");
        }
        cmd.arg("--skip-git-repo-check");
        cmd.arg("--dangerously-bypass-approvals-and-sandbox");
        if let Some(model) = req.model.as_deref() {
            cmd.arg("-m");
            cmd.arg(model);
        }
        // Reasoning effort maps onto codex's config key (TOML value, so the string needs
        // quotes). Codex tops out at "xhigh"; clamp "max" onto it.
        if let Some(effort) = req.effort.as_deref() {
            let effort = if effort == "max" { "xhigh" } else { effort };
            cmd.arg("-c");
            cmd.arg(format!("model_reasoning_effort=\"{effort}\""));
        }
        for raw in &req.images {
            if let Some(path) = images::absolutize_image_path(raw, &req.workspace) {
                cmd.arg("-i");
                cmd.arg(path);
            }
        }
        // Prompt as positional arg.
        cmd.arg(safe_prompt_arg(&req.prompt));
        Ok(BuiltCommand {
            command: cmd,
            stdin_payload: None,
            cleanup_files: Vec::new(),
            preassigned_session_id: preassigned,
        })
    }

    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "thread.started" => {
                if let Some(id) = value.get("thread_id").and_then(Value::as_str) {
                    if !id.trim().is_empty() {
                        out.push(EngineEvent::SessionId(id.trim().to_string()));
                    }
                }
            }
            "item.completed" => {
                let Some(item) = value.get("item") else { return };
                match item.get("type").and_then(Value::as_str) {
                    Some("agent_message") => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                out.push(EngineEvent::Message {
                                    role: "assistant".to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    Some("reasoning") => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                out.push(EngineEvent::Thinking(text.to_string()));
                            }
                        }
                    }
                    // codex exec has no delta events; tool calls surface as
                    // command_execution items.
                    Some("command_execution") => {
                        let name = item
                            .get("command")
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        out.push(EngineEvent::Message {
                            role: "tool".to_string(),
                            text: name.chars().take(120).collect(),
                        });
                    }
                    _ => {}
                }
            }
            "turn.completed" => {
                let usage = value.get("usage").cloned();
                out.push(EngineEvent::Done {
                    session_id: None,
                    usage,
                });
            }
            "turn.failed" | "error" => {
                let message = value
                    .get("error")
                    .and_then(|e| e.get("message").or(Some(e)).and_then(Value::as_str))
                    .or_else(|| value.get("message").and_then(Value::as_str))
                    .unwrap_or("codex turn failed")
                    .to_string();
                out.push(EngineEvent::Error(message));
            }
            _ => {}
        }
    }
}
