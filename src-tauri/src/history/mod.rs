mod extract;
pub mod reader;
pub mod scanner;

pub use extract::{parse_session_file, scan_summary_file, ParsedSession, ScanSummary};

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub seq: i64,
    pub role: String,
    pub text: String,
    pub ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Image attachments on user messages: data URLs (claude/pi/omp) or
    /// absolute paths (kimi/codex). Empty for every other row.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
    pub file_path: String,
    pub file_size: i64,
    pub file_mtime_ms: i64,
    pub title: String,
    pub preview: String,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub message_count: i64,
    pub pinned: bool,
    pub custom_title: Option<String>,
}

/// A native session file discovered on disk, matched to a workspace.
pub struct SessionFile {
    pub engine: &'static str,
    pub session_id: String,
    pub workspace_path: String,
    pub file_path: PathBuf,
}

pub fn stat_signature(path: &Path) -> Option<(i64, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some((meta.len() as i64, mtime_ms))
}

/// RFC3339 string or epoch millis/seconds -> epoch millis.
pub fn parse_ts_ms(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => {
            let raw = n.as_i64()?;
            // Heuristic: seconds vs millis.
            Some(if raw.abs() < 10_000_000_000 {
                raw * 1000
            } else {
                raw
            })
        }
        Value::String(s) => parse_ts_ms_str(s),
        _ => None,
    }
}

/// &str entry point: skips the `Value::String` wrapper allocation the
/// timestamp hot path used to pay per call.
pub fn parse_ts_ms_str(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(n) = trimmed.parse::<i64>() {
        return Some(if n.abs() < 10_000_000_000 { n * 1000 } else { n });
    }
    chrono_like_rfc3339_ms(trimmed)
}

/// Minimal RFC3339 parse without a chrono dependency: handles
/// `YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`.
fn chrono_like_rfc3339_ms(s: &str) -> Option<i64> {
    let (date_part, rest) = s.split_once('T')?;
    let mut it = date_part.split('-');
    let year: i64 = it.next()?.parse().ok()?;
    let month: i64 = it.next()?.parse().ok()?;
    let day: i64 = it.next()?.parse().ok()?;

    let (time_part, offset_part) = match rest.find(['Z', '+']) {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => match rest.rfind('-') {
            Some(idx) if idx > 0 => (&rest[..idx], &rest[idx..]),
            _ => (rest, "Z"),
        },
    };
    let time_clean = time_part.split('.').next()?;
    let mut ti = time_clean.split(':');
    let hour: i64 = ti.next()?.parse().ok()?;
    let minute: i64 = ti.next()?.parse().ok()?;
    let second: i64 = ti.next().unwrap_or("0").parse().ok()?;

    let offset_minutes: i64 = if offset_part.starts_with('Z') || offset_part.is_empty() {
        0
    } else {
        let sign = if offset_part.starts_with('-') { -1 } else { 1 };
        let body = &offset_part[1..];
        let mut oi = body.split(':');
        let oh: i64 = oi.next()?.parse().ok()?;
        let om: i64 = oi.next().unwrap_or("0").parse().ok()?;
        sign * (oh * 60 + om)
    };

    Some(civil_to_epoch_ms(year, month, day, hour, minute, second) - offset_minutes * 60_000)
}

/// Days-from-civil algorithm (Howard Hinnant), no external deps.
fn civil_to_epoch_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000
}

pub fn same_or_child(candidate: &Path, workspace: &Path) -> bool {
    candidate == workspace || candidate.starts_with(workspace)
}

/// Claude encodes a workspace path: all non-alphanumeric except '-' become '-'.
pub fn claude_encode_project_path(path: &str) -> String {
    path.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Extract display text from a message `content` value that may be a string
/// or an array of typed parts.
pub fn content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|p| {
                let t = p.get("type").and_then(Value::as_str);
                t == Some("text") || t.is_none()
            })
            .filter_map(|p| {
                p.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| p.as_str())
            })
            .collect::<Vec<_>>()
            .join(""),
        Some(Value::Object(map)) => {
            if let Some(parts) = map.get("parts").and_then(Value::as_array) {
                parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str).or_else(|| p.as_str()))
                    .collect::<Vec<_>>()
                    .join("")
            } else {
                map.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            }
        }
        _ => String::new(),
    }
}

pub fn truncate_chars(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    trimmed.chars().take(max).collect()
}
/// Sidebar title: the first user message's typed body. Engine file/image
/// injection wraps attachments as `<file name="…">…</file>` and pastes as
/// `[Image #N, WxH]` — noise as a title. Grok (and similar CLIs) also wrap
/// the typed body in `<user_query>` after a `<user_info>` context turn.
/// Strip all of those and fall through to the next user message when only
/// noise remains.
pub fn session_title(messages: &[Message]) -> String {
    for m in messages.iter().filter(|m| m.role == "user") {
        let body = strip_title_noise(&m.text);
        if !body.is_empty() {
            return truncate_chars(&body, 80);
        }
    }
    // Attachment-only sessions have no typed body; keep the raw text so
    // the sidebar still shows something recognizable.
    messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| truncate_chars(&m.text, 80))
        .unwrap_or_default()
}

/// Injected runtime-context turns, not typed input. Shared across engines so
/// a new CLI that reuses these envelopes does not need a per-engine title patch.
pub(crate) fn is_injected_user_context(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<user_info>")
        || t.starts_with("<system-reminder>")
        || t.starts_with("<ide_selection>")
        || t.starts_with("<opened_file>")
        || t.starts_with("<workspace_path>")
}

/// Prefer the `<user_query>` body when the turn is a Grok-style envelope.
/// Only the prefix is an envelope — a typed body that *mentions*
/// `<user_query>` must stay intact.
pub(crate) fn unwrap_user_turn(text: &str) -> String {
    const OPEN: &str = "<user_query>";
    const CLOSE: &str = "</user_query>";
    let source = if text.trim_start().starts_with("<image_files>") {
        strip_leading_named_block(text, "image_files")
    } else {
        text.trim_start()
    };
    if let Some(inner) = source.strip_prefix(OPEN) {
        let body = match inner.find(CLOSE) {
            Some(end) => &inner[..end],
            None => inner,
        };
        return body.trim().to_string();
    }
    source.trim().to_string()
}

/// Strip one leading `<tag>…</tag>`. An unterminated block is left intact
/// so a following `<user_query>` is not swallowed.
fn strip_leading_named_block<'a>(text: &'a str, tag: &str) -> &'a str {
    let trimmed = text.trim_start();
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let Some(inner) = trimmed.strip_prefix(&open) else {
        return trimmed;
    };
    match inner.find(&close) {
        Some(end) => inner[end + close.len()..].trim_start(),
        None => trimmed,
    }
}
/// Codex-style first-turn injections: the CLI prepends its instructions,
/// environment context, and skill envelopes to (or ahead of) the typed
/// body. Stripped from the front of a user turn; a typed tail after the
/// last block is real user text and stays.
const INJECTED_LEADING_TAGS: &[&str] = &[
    "INSTRUCTIONS",
    "environment_context",
    "agents-instructions",
    "user_instructions",
    "skill",
];

/// Clean a user turn down to the typed body: drop leading injected blocks
/// (codex instructions / environment / skills), then unwrap the Grok-style
/// `<user_query>` envelope. Noise-only turns come back empty.
pub(crate) fn clean_user_turn(text: &str) -> String {
    let mut rest = text.trim_start();
    // The `# AGENTS.md instructions` heading precedes the `<INSTRUCTIONS>`
    // block; drop it only when that block actually follows.
    if let Some(after) = rest.strip_prefix("# AGENTS.md instructions") {
        let after = after.trim_start();
        if after.starts_with("<INSTRUCTIONS>") {
            rest = after;
        }
    }
    loop {
        let prev_len = rest.len();
        for tag in INJECTED_LEADING_TAGS {
            let open = format!("<{tag}>");
            if rest.starts_with(&open) {
                rest = strip_leading_named_block(rest, tag);
            }
        }
        if rest.len() == prev_len {
            break;
        }
    }
    unwrap_user_turn(rest)
}

fn strip_title_noise(text: &str) -> String {
    // Remove every `<file …>…</file>` envelope; an unterminated one loses
    // just its opening tag (truncated content is still user-visible text).
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<file ") {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        if let Some(end) = after.find("</file>") {
            rest = &after[end + "</file>".len()..];
        } else if let Some(gt) = after.find('>') {
            rest = &after[gt + 1..];
        } else {
            rest = "";
        }
    }
    out.push_str(rest);
    // Drop `[Image #N, WxH]` placeholders wherever they appear — they sit
    // inline before the typed body. A `[Image #` run whose bracket body is
    // not digits/`, `/`x` is user text and stays.
    let mut cleaned = String::with_capacity(out.len());
    let mut rest = out.as_str();
    const MARK: &str = "[Image #";
    while let Some(start) = rest.find(MARK) {
        let after = &rest[start + MARK.len()..];
        let placeholder = after
            .find(']')
            .map(|e| {
                after[..e]
                    .chars()
                    .all(|c| c.is_ascii_digit() || matches!(c, ',' | ' ' | 'x'))
            })
            .unwrap_or(false);
        if placeholder {
            cleaned.push_str(&rest[..start]);
            rest = &after[after.find(']').unwrap() + 1..];
        } else {
            cleaned.push_str(&rest[..start + MARK.len()]);
            rest = after;
        }
    }
    cleaned.push_str(rest);
    let unwrapped = clean_user_turn(&cleaned);
    if is_injected_user_context(&unwrapped) {
        return String::new();
    }
    unwrapped
}
#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str) -> Message {
        Message {
            seq: 0,
            role: "user".into(),
            text: text.into(),
            ts: None,
            usage: None,
            model: None,
            images: Vec::new(),
        }
    }

    #[test]
    fn title_strips_file_envelope() {
        let msgs = vec![user(
            "<file name=\"/Users/x/README.md\"># readme body</file>\nMD渲染有点问题",
        )];
        assert_eq!(session_title(&msgs), "MD渲染有点问题");
    }

    #[test]
    fn title_strips_inline_image_placeholder() {
        let msgs = vec![user("[Image #1, 1222x848] 历史记录怎么对应不上?")];
        assert_eq!(session_title(&msgs), "历史记录怎么对应不上?");
    }

    #[test]
    fn title_falls_through_noise_only_message() {
        let msgs = vec![
            user("<file name=\"/a/b.ts\">code</file>"),
            user("真正的问题"),
        ];
        assert_eq!(session_title(&msgs), "真正的问题");
    }

    #[test]
    fn title_keeps_raw_when_everything_is_noise() {
        let msgs = vec![user("[Image #1, 1568x637]")];
        assert_eq!(session_title(&msgs), "[Image #1, 1568x637]");
    }

    #[test]
    fn title_tolerates_unterminated_envelope() {
        let msgs = vec![user("<file name=\"/a/b.ts\">code without close\n后续正文")];
        assert_eq!(session_title(&msgs), "code without close\n后续正文");
    }

    #[test]
    fn title_skips_injected_user_info_for_next_body() {
        let msgs = vec![
            user("<user_info>\nOS Version: macos\nShell: /bin/zsh\n</user_info>"),
            user("<user_query>Grok CLI 的历史记录怎么没出现？</user_query>"),
        ];
        assert_eq!(session_title(&msgs), "Grok CLI 的历史记录怎么没出现？");
    }

    #[test]
    fn title_uses_user_query_after_image_files() {
        let msgs = vec![user(
            "<image_files>\n1. /tmp/a.png\n</image_files>\n\n<user_query>这个鼠标移动上去，有小手的样式</user_query>",
        )];
        assert_eq!(session_title(&msgs), "这个鼠标移动上去，有小手的样式");
    }

    #[test]
    fn unwrap_keeps_literal_user_query_in_typed_body() {
        let text = "Review the typed `<user_query>` body. Grok injects context.";
        assert_eq!(unwrap_user_turn(text), text);
    }

    #[test]
    fn unwrap_is_idempotent_after_envelope() {
        let once = unwrap_user_turn(
            "<image_files>\n1. /tmp/a.png\n</image_files>\n\n<user_query>正文里也可以写 <user_query> 标签</user_query>",
        );
        assert_eq!(once, "正文里也可以写 <user_query> 标签");
        assert_eq!(unwrap_user_turn(&once), once);
    }
    #[test]
    fn clean_drops_codex_instructions_and_environment_turn() {
        let text = "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nYOU ARE AN AUTONOMOUS AGENT\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>/tmp/ws</cwd>\n</environment_context>";
        assert_eq!(clean_user_turn(text), "");
    }

    #[test]
    fn clean_keeps_typed_tail_after_agents_instructions() {
        let text = "<agents-instructions>\n# Global Instructions\n</agents-instructions>\n\n你好啊";
        assert_eq!(clean_user_turn(text), "你好啊");
    }

    #[test]
    fn clean_drops_skill_envelope() {
        let text = "<skill>\n<name>plan</name>\n<body>…</body>\n</skill>";
        assert_eq!(clean_user_turn(text), "");
    }

    #[test]
    fn clean_leaves_unterminated_environment_context_intact() {
        let text = "<environment_context>\n  <cwd>/tmp/ws</cwd>";
        assert_eq!(clean_user_turn(text), text);
    }

    #[test]
    fn title_skips_codex_injections_for_typed_body() {
        let msgs = vec![
            user("# AGENTS.md instructions\n\n<INSTRUCTIONS>\n…\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>/tmp/ws</cwd>\n</environment_context>"),
            user("<skill>\n<name>plan</name>\n</skill>"),
            user("隐藏 gpt 系统提示词 展示"),
        ];
        assert_eq!(session_title(&msgs), "隐藏 gpt 系统提示词 展示");
    }
}
