use super::{safe_prompt_arg, BuiltCommand, Engine, EngineEvent, SendRequest};
use std::collections::HashMap;
use tokio::process::Command;

/// DeepSeek Harness (dsh) one-shot: `dsh --profile headless "<task>"`.
/// Headless profile prints the final assistant message as plain text and
/// exits — no streaming protocol, no resume flag (verified live).
pub struct DshEngine;

impl Engine for DshEngine {
    fn id(&self) -> &'static str {
        "dsh"
    }

    fn supports_images(&self) -> bool {
        false
    }

    fn build_command(
        &self,
        req: &SendRequest,
        _env: &HashMap<String, String>,
        bin: &str,
    ) -> Result<BuiltCommand, String> {
        let mut cmd = Command::new(bin);
        cmd.arg("--profile");
        cmd.arg("headless");
        cmd.arg(safe_prompt_arg(&req.prompt));
        Ok(BuiltCommand {
            command: cmd,
            stdin_payload: None,
            cleanup_files: Vec::new(),
            preassigned_session_id: None,
        })
    }

    /// Headless output is plain text (not NDJSON): every non-empty stdout
    /// line is streamed as a delta.
    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>) {
        if !line.trim().is_empty() {
            out.push(EngineEvent::Delta(format!("{line}\n")));
        }
    }
}
