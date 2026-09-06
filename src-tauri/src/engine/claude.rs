use super::{images, BuiltCommand, Engine, EngineEvent, SendRequest};
use serde_json::Value;
use std::collections::HashMap;
use tokio::process::Command;

pub struct ClaudeEngine;

impl Engine for ClaudeEngine {
    fn id(&self) -> &'static str {
        "claude"
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
        cmd.arg("-p");
        cmd.arg("--input-format");
        cmd.arg("stream-json");
        cmd.arg("--output-format");
        cmd.arg("stream-json");
        cmd.arg("--verbose");
        cmd.arg("--include-partial-messages");
        cmd.arg("--dangerously-skip-permissions");
        if let Some(model) = req.model.as_deref() {
            cmd.arg("--model");
            cmd.arg(model);
        }
        // Claude Code has no effort flag; the thinking budget env var is the
        // effort knob. "low" stays at the CLI default (no forced thinking).
        match req.effort.as_deref() {
            Some("medium") => {
                cmd.env("MAX_THINKING_TOKENS", "16384");
            }
            Some("high") => {
                cmd.env("MAX_THINKING_TOKENS", "65536");
            }
            Some("xhigh") => {
                cmd.env("MAX_THINKING_TOKENS", "131072");
            }
            Some("max") => {
                cmd.env("MAX_THINKING_TOKENS", "262144");
            }
            _ => {}
        }
        if let Some(session_id) = req.session_id.as_deref() {
            cmd.arg("--resume");
            cmd.arg(session_id);
        }
        let stdin_payload = images::claude_stdin_message(&req.prompt, &req.images, &req.workspace)?;
        Ok(BuiltCommand {
            command: cmd,
            stdin_payload: Some(stdin_payload),
            cleanup_files: Vec::new(),
            preassigned_session_id: None,
        })
    }

    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "system" => {
                if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                    if !id.trim().is_empty() {
                        out.push(EngineEvent::SessionId(id.trim().to_string()));
                    }
                }
            }
            "stream_event" => parse_stream_event(&value, out),
            "assistant" => {
                // Full message snapshot; only used as session-id source when
                // partial deltas are active (frontend renders the delta tail).
                if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                    if !id.trim().is_empty() {
                        out.push(EngineEvent::SessionId(id.trim().to_string()));
                    }
                }
            }
            "result" => {
                let session_id = value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let usage = value.get("usage").cloned();
                let is_error = value
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
                if is_error || subtype.starts_with("error") {
                    let message = value
                        .get("result")
                        .and_then(Value::as_str)
                        .unwrap_or("claude turn failed")
                        .to_string();
                    out.push(EngineEvent::Error(message));
                } else {
                    out.push(EngineEvent::Done { session_id, usage });
                }
            }
            _ => {}
        }
    }
}

/// Anthropic SSE wrapped events (requires --include-partial-messages).
fn parse_stream_event(value: &Value, out: &mut Vec<EngineEvent>) {
    let Some(event) = value.get("event") else {
        return;
    };
    match event.get("type").and_then(Value::as_str) {
        Some("content_block_delta") => parse_content_block_delta(event, out),
        // Tool calls surface at block start; the label mirrors history
        // parsing (tool name only). The "assistant" snapshots also carry
        // tool_use blocks, but with partial messages active they would
        // duplicate every call.
        Some("content_block_start") => parse_content_block_start(event, out),
        _ => {}
    }
}

fn parse_content_block_delta(event: &Value, out: &mut Vec<EngineEvent>) {
    let Some(delta) = event.get("delta") else {
        return;
    };
    let (key, is_thinking) = match delta.get("type").and_then(Value::as_str) {
        Some("text_delta") => ("text", false),
        Some("thinking_delta") => ("thinking", true),
        _ => return,
    };
    let Some(text) = delta.get(key).and_then(Value::as_str) else {
        return;
    };
    if text.is_empty() {
        return;
    }
    if is_thinking {
        out.push(EngineEvent::Thinking(text.to_string()));
    } else {
        out.push(EngineEvent::Delta(text.to_string()));
    }
}

fn parse_content_block_start(event: &Value, out: &mut Vec<EngineEvent>) {
    let Some(block) = event.get("content_block") else {
        return;
    };
    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        return;
    }
    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
    out.push(EngineEvent::Message {
        role: "tool".to_string(),
        text: name.to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_use_block_start_emits_tool_message() {
        let line = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 1,
                "content_block": { "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {} }
            }
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine.parse_line(&line, &mut out);
        assert_eq!(out.len(), 1);
        match &out[0] {
            EngineEvent::Message { role, text } => {
                assert_eq!(role, "tool");
                assert_eq!(text, "Bash");
            }
            _ => panic!("expected tool message"),
        }
    }

    #[test]
    fn text_block_start_emits_nothing() {
        let line = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "" }
            }
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine.parse_line(&line, &mut out);
        assert!(out.is_empty());
    }
}
