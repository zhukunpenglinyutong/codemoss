use super::{content_text, parse_ts_ms_str, Message};
use serde_json::Value;
use std::io::BufRead;
use std::path::Path;

pub struct ParsedSession {
    pub messages: Vec<Message>,
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
}

/// Parse a native session file into the minimal message list. Bad lines are
/// skipped individually.
pub fn parse_session_file(engine: &str, path: &Path) -> Result<ParsedSession, String> {
    let reader = open_line_reader(engine, path)?;
    Ok(collect_session(reader, &extractor_for(engine, ImageMode::Collect)))
}

/// Everything the sidebar needs from a scan: title/preview/timestamps/count.
/// Derived in one streaming pass without materializing the message list or
/// any image data URLs.
pub struct ScanSummary {
    pub title: String,
    pub preview: String,
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
    pub message_count: i64,
}

/// The scan-time parse: same line walk as `parse_session_file`, but folds
/// each row into a bounded accumulator instead of a Vec<Message>. Image-only
/// user turns (whose data URLs are skipped here) fall out of the count —
/// the sidebar counts text, and the reader path stays authoritative.
pub fn scan_summary_file(engine: &str, path: &Path) -> Result<ScanSummary, String> {
    let reader = open_line_reader(engine, path)?;
    let mut acc = ScanAcc::default();
    walk_lines(reader, &extractor_for(engine, ImageMode::SkipDataUrls), |row| {
        acc.accept(row);
    });
    Ok(acc.finish())
}

/// dsh session files are zstd-compressed NDJSON; everything else is plain.
fn open_line_reader(engine: &str, path: &Path) -> Result<Box<dyn BufRead>, String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    if engine == "dsh" {
        let decoder = zstd::stream::read::Decoder::new(std::io::BufReader::new(file))
            .map_err(|e| format!("zstd {}: {e}", path.display()))?;
        Ok(Box::new(std::io::BufReader::new(decoder)))
    } else {
        Ok(Box::new(std::io::BufReader::new(file)))
    }
}

/// Image payloads: the reader renders them, the scanner must not build them.
#[derive(Clone, Copy, PartialEq)]
enum ImageMode {
    Collect,
    SkipDataUrls,
}

type LineExtractor<'a> = Box<dyn Fn(&Value) -> LineRows + 'a>;

fn extractor_for(engine: &str, images: ImageMode) -> LineExtractor<'static> {
    if engine == "dsh" {
        Box::new(extract_dsh_line)
    } else {
        let engine = engine.to_string();
        Box::new(move |value| extract_line_messages(&engine, value, images))
    }
}

/// Line-loop skeleton shared by the full parse and the scan summary: decode
/// one NDJSON line, extract rows, normalize, hand each to `consume`.
fn walk_lines(
    reader: impl BufRead,
    extract: &LineExtractor<'_>,
    mut consume: impl FnMut(LineRow),
) {
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.contains("\"type\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        for row in extract(&value) {
            let Some(row) = normalize_extracted_row(row) else {
                continue;
            };
            consume(row);
        }
    }
}

fn collect_session(reader: impl BufRead, extract: &LineExtractor<'_>) -> ParsedSession {
    let mut messages = Vec::<Message>::new();
    let mut seq = 0i64;
    walk_lines(reader, extract, |row| {
        // Usage-only marker (codex token_count): fold onto the last
        // assistant message instead of creating an empty row.
        if row.role == "__usage__" {
            if let Some(last) = messages.iter_mut().rev().find(|m| m.role == "assistant") {
                last.usage = row.usage;
            }
            return;
        }
        if row.text.trim().is_empty() && row.images.is_empty() {
            return;
        }
        seq += 1;
        messages.push(Message {
            seq,
            role: row.role,
            text: row.text,
            ts: row.ts,
            usage: row.usage,
            model: row.model,
            images: row.images,
        });
    });
    let (first_ts, last_ts) = session_ts_bounds(&messages);
    ParsedSession {
        messages,
        first_ts,
        last_ts,
    }
}

/// Bounded scan accumulator: keeps only what the sessions table stores.
#[derive(Default)]
struct ScanAcc {
    count: i64,
    first_ts: Option<String>,
    last_ts: Option<String>,
    title: Option<String>,
    first_user_text: Option<String>,
    last_assistant_text: Option<String>,
}

impl ScanAcc {
    fn accept(&mut self, row: LineRow) {
        if row.role == "__usage__" {
            return;
        }
        if row.text.trim().is_empty() && row.images.is_empty() {
            return;
        }
        if self.count == 0 {
            self.first_ts = row.ts.clone();
        }
        self.count += 1;
        self.last_ts = row.ts.clone();
        match row.role.as_str() {
            "user" => {
                // Mirrors session_title: first non-noise user body wins, the
                // first user row (even noise) is the fallback.
                if self.title.is_none() {
                    let body = super::strip_title_noise(&row.text);
                    if !body.is_empty() {
                        self.title = Some(super::truncate_chars(&body, 80));
                    }
                }
                if self.first_user_text.is_none() {
                    self.first_user_text = Some(row.text);
                }
            }
            "assistant" => self.last_assistant_text = Some(row.text),
            _ => {}
        }
    }

    fn finish(self) -> ScanSummary {
        let title = self
            .title
            .or_else(|| self.first_user_text.map(|t| super::truncate_chars(&t, 80)))
            .unwrap_or_default();
        ScanSummary {
            title,
            preview: self
                .last_assistant_text
                .map(|t| super::truncate_chars(&t, 120))
                .unwrap_or_default(),
            first_ts: self.first_ts.as_deref().and_then(parse_ts_ms_str),
            last_ts: self.last_ts.as_deref().and_then(parse_ts_ms_str),
            message_count: self.count,
        }
    }
}

fn extract_dsh_line(value: &Value) -> LineRows {
    let line_type = type_str(value);
    let ts = value.get("time").and_then(Value::as_i64).map(|ms| ms.to_string());
    match line_type {
        "user/message" => {
            let text = content_text(value.get("data").and_then(|d| d.get("content")));
            // Skip injected runtime context / system reminders — not user text.
            let trimmed = text.trim();
            if trimmed.starts_with("<system-reminder>")
                || trimmed.starts_with("Current runtime context")
            {
                return Vec::new();
            }
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![LineRow::new("user", text, ts)]
            }
        }
        "assistant/message" => {
            let content = value
                .get("data")
                .and_then(|d| d.get("message"))
                .and_then(|m| m.get("content"));
            let text = match content {
                Some(Value::Array(parts)) => text_of_parts(parts, true, ""),
                other => content_text(other),
            };
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![LineRow::new("assistant", text, ts)]
            }
        }
        _ => Vec::new(),
    }
}

/// Paths embedded by `kimi_prompt_with_images` after the marker block, one
/// `<image path="...">` tag per attachment.
fn kimi_image_paths(block: &str) -> Vec<String> {
    const TAG: &str = "<image path=\"";
    let mut out = Vec::new();
    let mut rest = block;
    while let Some(start) = rest.find(TAG) {
        rest = &rest[start + TAG.len()..];
        match rest.find('"') {
            Some(end) => {
                out.push(rest[..end].to_string());
                rest = &rest[end..];
            }
            None => break,
        }
    }
    out
}

/// Claude image content block -> data URL for direct WebView rendering.
fn claude_image_data_url(block: &Value) -> Option<String> {
    let source = block.get("source")?;
    let data = source.get("data").and_then(Value::as_str)?;
    if data.is_empty() {
        return None;
    }
    let mime = source
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    Some(format!("data:{mime};base64,{data}"))
}

/// pi/omp image content part (`{type:"image", data, mimeType}`) -> data URL.
fn pi_image_part(part: &Value) -> Option<String> {
    if part.get("type").and_then(Value::as_str) != Some("image") {
        return None;
    }
    let data = part.get("data").and_then(Value::as_str)?;
    if data.is_empty() {
        return None;
    }
    let mime = part
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    Some(format!("data:{mime};base64,{data}"))
}

/// Codex `input_image` content part -> its `image_url` (data URL or path).
fn codex_image_part(part: &Value) -> Option<String> {
    if part.get("type").and_then(Value::as_str) != Some("input_image") {
        return None;
    }
    let url = part.get("image_url").and_then(Value::as_str)?;
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

/// `value["type"]` as a string slice, empty when absent.
fn type_str(value: &Value) -> &str {
    value.get("type").and_then(Value::as_str).unwrap_or("")
}

/// First string-valued timestamp among `keys` (engines disagree on the
/// field name; grok alone has used three).
fn ts_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| value.get(k).and_then(Value::as_str))
        .map(str::to_string)
}

/// (first, last) message timestamps parsed to epoch millis.
fn session_ts_bounds(messages: &[Message]) -> (Option<i64>, Option<i64>) {
    let parse = |message: Option<&Message>| {
        message
            .and_then(|m| m.ts.as_deref())
            .and_then(parse_ts_ms_str)
    };
    (parse(messages.first()), parse(messages.last()))
}

/// Join the `text` payloads of content parts; `typed_only` keeps only
/// `type == "text"` parts.
fn text_of_parts(parts: &[Value], typed_only: bool, sep: &str) -> String {
    parts
        .iter()
        .filter(|p| !typed_only || type_str(p) == "text")
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(sep)
}

/// One extracted row from a native session line.
struct LineRow {
    role: String,
    text: String,
    ts: Option<String>,
    usage: Option<Value>,
    model: Option<String>,
    images: Vec<String>,
}

impl LineRow {
    /// A plain row without usage/model metadata.
    fn new(role: &str, text: String, ts: Option<String>) -> Self {
        Self {
            role: role.to_string(),
            text,
            ts,
            usage: None,
            model: None,
            images: Vec::new(),
        }
    }
}

type LineRows = Vec<LineRow>;

/// Drop injected context turns and unwrap `<user_query>` so every engine's
/// message list (and therefore titles) share one envelope cleaner.
fn normalize_extracted_row(mut row: LineRow) -> Option<LineRow> {
    if row.role != "user" {
        return Some(row);
    }
    let text = super::clean_user_turn(&row.text);
    if super::is_injected_user_context(&text) {
        return None;
    }
    if text.trim().is_empty() && row.images.is_empty() {
        return None;
    }
    row.text = text;
    Some(row)
}

/// Per-engine NDJSON line -> zero or more (role, text, ts, usage, model) tuples.
fn extract_line_messages(engine: &str, value: &Value, images: ImageMode) -> LineRows {
    match engine {
        "claude" => extract_claude_line(value, images),
        "kimi" => extract_kimi_line(value),
        "grok" => extract_grok_line(value),
        "codex" => extract_codex_line(value, images),
        "pi" | "omp" => extract_pi_family_line(value, images),
        _ => Vec::new(),
    }
}

/// Codex rollout lines: {timestamp, type, payload}. Messages are
/// response_item payloads of type "message".
fn extract_codex_line(value: &Value, images: ImageMode) -> LineRows {
    let line_type = type_str(value);
    let ts = ts_string(value, &["timestamp"]);
    match line_type {
        "response_item" => {
            let Some(payload) = value.get("payload") else {
                return Vec::new();
            };
            // Reasoning items persist the visible summary; encrypted
            // content is skipped.
            if payload.get("type").and_then(Value::as_str) == Some("reasoning") {
                let text = match payload.get("summary") {
                    Some(Value::Array(parts)) => text_of_parts(parts, false, "\n"),
                    _ => String::new(),
                };
                return if text.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![LineRow::new("thinking", text, ts)]
                };
            }
            if payload.get("type").and_then(Value::as_str) != Some("message") {
                return Vec::new();
            }
            let role = payload
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if role != "user" && role != "assistant" {
                return Vec::new();
            }
            // content blocks: input_text / output_text
            let content = payload.get("content");
            let text = match content {
                Some(Value::Array(parts)) => text_of_parts(parts, false, ""),
                other => content_text(other),
            };
            let collected = match (images, content) {
                (ImageMode::Collect, Some(Value::Array(parts))) => {
                    parts.iter().filter_map(codex_image_part).collect()
                }
                _ => Vec::new(),
            };
            if text.trim().is_empty() && collected.is_empty() {
                Vec::new()
            } else {
                vec![LineRow {
                    images: collected,
                    ..LineRow::new(&role, text, ts)
                }]
            }
        }
        "event_msg" => {
            let Some(payload) = value.get("payload") else {
                return Vec::new();
            };
            if payload.get("type").and_then(Value::as_str) == Some("token_count") {
                if let Some(usage) = payload
                    .get("info")
                    .and_then(|i| i.get("total_token_usage"))
                {
                    return vec![LineRow {
                        usage: Some(usage.clone()),
                        ..LineRow::new("__usage__", String::new(), ts)
                    }];
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// Flush buffered assistant text ahead of a toolCall/thinking part so the
/// timeline keeps calls where they actually happened.
fn pi_flush_text(out: &mut LineRows, text: &mut String, ts: &Option<String>) {
    if !text.trim().is_empty() {
        out.push(LineRow::new("assistant", std::mem::take(text), ts.clone()));
    }
}

/// One pi/omp assistant content part -> rows appended to `out`, with plain
/// text accumulating into `text`.
fn pi_assistant_part(part: &Value, out: &mut LineRows, text: &mut String, ts: &Option<String>) {
    match part.get("type").and_then(Value::as_str) {
        Some("text") => {
            if let Some(t) = part.get("text").and_then(Value::as_str) {
                text.push_str(t);
            }
        }
        Some("toolCall") => {
            pi_flush_text(out, text, ts);
            let name = part.get("name").and_then(Value::as_str).unwrap_or("tool");
            let intent = part.get("intent").and_then(Value::as_str);
            out.push(LineRow::new(
                "tool",
                crate::engine::pi_family::tool_label(name, intent),
                ts.clone(),
            ));
        }
        Some("thinking") => {
            pi_flush_text(out, text, ts);
            if let Some(t) = part.get("thinking").and_then(Value::as_str) {
                out.push(LineRow::new("thinking", t.to_string(), ts.clone()));
            }
        }
        _ => {}
    }
}

/// pi/omp session lines: {type:"message", timestamp, message:{role, content, usage?}}
fn extract_pi_family_line(value: &Value, images: ImageMode) -> LineRows {
    if value.get("type").and_then(Value::as_str) != Some("message") {
        return Vec::new();
    }
    let ts = ts_string(value, &["timestamp"]);
    let Some(message) = value.get("message") else {
        return Vec::new();
    };
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    let usage = message.get("usage").cloned();
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    match role {
        "user" => {
            let content = message.get("content");
            let text = match content {
                Some(Value::Array(parts)) => text_of_parts(parts, true, ""),
                other => content_text(other),
            };
            let collected = match (images, content) {
                (ImageMode::Collect, Some(Value::Array(parts))) => {
                    parts.iter().filter_map(pi_image_part).collect()
                }
                _ => Vec::new(),
            };
            if text.trim().is_empty() && collected.is_empty() {
                Vec::new()
            } else {
                vec![LineRow {
                    usage,
                    images: collected,
                    ..LineRow::new("user", text, ts)
                }]
            }
        }
        // Assistant content interleaves text and toolCall parts; walk it in
        // order so the timeline shows tool calls where they actually happened.
        "assistant" => match message.get("content") {
            Some(Value::Array(parts)) => {
                let mut out: LineRows = Vec::new();
                let mut text = String::new();
                for part in parts {
                    pi_assistant_part(part, &mut out, &mut text, &ts);
                }
                if !text.trim().is_empty() {
                    out.push(LineRow {
                        usage,
                        model,
                        ..LineRow::new("assistant", text, ts)
                    });
                }
                out
            }
            other => {
                let text = content_text(other);
                if text.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![LineRow {
                        usage,
                        model,
                        ..LineRow::new("assistant", text, ts)
                    }]
                }
            }
        },
        "toolResult" => Vec::new(),
        _ => Vec::new(),
    }
}

/// Flush buffered claude text as a row carrying the line's usage/model.
fn claude_flush_text(
    out: &mut LineRows,
    text: &mut String,
    role: &str,
    ts: &Option<String>,
    usage: &Option<Value>,
    model: &Option<String>,
) {
    if !text.trim().is_empty() {
        out.push(LineRow {
            usage: usage.clone(),
            model: model.clone(),
            ..LineRow::new(role, std::mem::take(text), ts.clone())
        });
    }
}

/// One claude content block; text accumulates, thinking/tool_use flush it.
fn claude_block_rows(
    block: &Value,
    images: ImageMode,
    out: &mut LineRows,
    text: &mut String,
    collected_images: &mut Vec<String>,
    role: &str,
    ts: &Option<String>,
    usage: &Option<Value>,
    model: &Option<String>,
) {
    match block.get("type").and_then(Value::as_str) {
        Some("thinking") => {
            claude_flush_text(out, text, role, ts, usage, model);
            if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                out.push(LineRow::new("thinking", t.to_string(), ts.clone()));
            }
        }
        Some("tool_use") => {
            claude_flush_text(out, text, role, ts, usage, model);
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            out.push(LineRow::new("tool", name, ts.clone()));
        }
        Some("image") => {
            if images == ImageMode::Collect {
                if let Some(url) = claude_image_data_url(block) {
                    collected_images.push(url);
                }
            }
        }
        _ => {
            if let Some(t) = block.get("text").and_then(Value::as_str) {
                text.push_str(t);
            }
        }
    }
}

fn extract_claude_line(value: &Value, images: ImageMode) -> LineRows {
    let line_type = type_str(value);
    if line_type != "user" && line_type != "assistant" {
        return Vec::new();
    }
    let Some(message) = value.get("message") else {
        return Vec::new();
    };
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or(line_type)
        .to_string();
    let ts = ts_string(value, &["timestamp"]);
    let usage = message.get("usage").cloned();
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let content = message.get("content");
    let mut out = Vec::new();
    match content {
        Some(Value::Array(blocks)) => {
            // Walk content blocks in order so thinking and tool calls land
            // where they actually happened relative to the text.
            let mut text = String::new();
            let mut collected: Vec<String> = Vec::new();
            for block in blocks {
                claude_block_rows(
                    block, images, &mut out, &mut text, &mut collected, &role, &ts, &usage,
                    &model,
                );
            }
            if !text.trim().is_empty() {
                out.push(LineRow {
                    usage,
                    model,
                    images: collected,
                    ..LineRow::new(&role, text, ts)
                });
            } else if !collected.is_empty() {
                out.push(LineRow {
                    images: collected,
                    ..LineRow::new(&role, String::new(), ts)
                });
            }
        }
        _ => {
            let text = content_text(content);
            if !text.trim().is_empty() {
                out.push(LineRow {
                    usage,
                    model,
                    ..LineRow::new(&role, text, ts)
                });
            }
        }
    }
    out
}

fn extract_kimi_line(value: &Value) -> LineRows {
    let line_type = type_str(value);
    let ts = value
        .get("time")
        .and_then(Value::as_i64)
        .map(|ms| ms.to_string());
    match line_type {
        "turn.prompt" => {
            let text = content_text(value.get("input"));
            // Strip our image-injection marker block.
            let (display, images) = match text.find(crate::engine::images::KIMI_IMAGE_MARKER) {
                Some(idx) => (
                    text[..idx].trim_end().to_string(),
                    kimi_image_paths(&text[idx..]),
                ),
                None => (text, Vec::new()),
            };
            if display.trim().is_empty() && images.is_empty() {
                Vec::new()
            } else {
                vec![LineRow {
                    images,
                    ..LineRow::new("user", display, ts)
                }]
            }
        }
        "context.append_loop_event" => {
            let Some(event) = value.get("event") else {
                return Vec::new();
            };
            if event.get("type").and_then(Value::as_str) != Some("content.part") {
                return Vec::new();
            }
            let Some(part) = event.get("part") else {
                return Vec::new();
            };
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if text.trim().is_empty() {
                        Vec::new()
                    } else {
                        vec![LineRow::new("assistant", text, ts)]
                    }
                }
                Some("tool_call") => {
                    let name = part
                        .get("name")
                        .or_else(|| part.get("tool_name"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    vec![LineRow::new("tool", name, ts)]
                }
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

fn extract_grok_line(value: &Value) -> LineRows {
    let line_type = type_str(value);
    let ts = ts_string(value, &["timestamp", "created_at", "createdAt"]);
    match line_type {
        "user" => {
            // Envelope stripping (`<user_info>` / `<user_query>`) lives in
            // `normalize_extracted_row` so it is shared across engines.
            if value.get("synthetic_reason").is_some() {
                return Vec::new();
            }
            let text = content_text(value.get("content"));
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![LineRow::new("user", text, ts)]
            }
        }
        "reasoning" => {
            let text = match value.get("summary") {
                Some(Value::Array(parts)) => text_of_parts(parts, false, "\n"),
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            };
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![LineRow::new("thinking", text, ts)]
            }
        }
        "assistant" => {
            let mut out = Vec::new();
            let text = content_text(value.get("content"));
            if !text.trim().is_empty() {
                let usage = value.get("usage").cloned();
                out.push(LineRow {
                    usage,
                    ..LineRow::new("assistant", text, ts.clone())
                });
            }
            if let Some(calls) = value.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let name = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .or_else(|| call.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    out.push(LineRow::new("tool", name, ts.clone()));
                }
            }
            out
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_family_line_extracts_thinking_in_order() {
        let line: Value = serde_json::json!({
            "type": "message",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "first thought", "thinkingSignature": "sig"},
                    {"type": "text", "text": "answer one"},
                    {"type": "toolCall", "name": "read", "intent": "Listing root"},
                    {"type": "text", "text": "answer two"}
                ]
            }
        });
        let rows = extract_pi_family_line(&line, ImageMode::Collect);
        let roles: Vec<&str> = rows.iter().map(|r| r.role.as_str()).collect();
        assert_eq!(roles, ["thinking", "assistant", "tool", "assistant"]);
        assert_eq!(rows[0].text, "first thought");
        assert_eq!(rows[1].text, "answer one");
        assert_eq!(rows[2].text, "read · Listing root");
        assert_eq!(rows[3].text, "answer two");
    }

    #[test]
    fn claude_line_extracts_thinking_and_tool_in_order() {
        let line: Value = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "ponder", "signature": "sig"},
                    {"type": "text", "text": "reply"},
                    {"type": "tool_use", "name": "Bash"}
                ]
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        let roles: Vec<&str> = rows.iter().map(|r| r.role.as_str()).collect();
        assert_eq!(roles, ["thinking", "assistant", "tool"]);
        assert_eq!(rows[0].text, "ponder");
        assert_eq!(rows[1].text, "reply");
        assert_eq!(rows[2].text, "Bash");
    }

    #[test]
    fn codex_reasoning_item_becomes_thinking_row() {
        let line: Value = serde_json::json!({
            "type": "response_item",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "payload": {
                "type": "reasoning",
                "summary": [
                    {"type": "summary_text", "text": "plan step one"},
                    {"type": "summary_text", "text": "plan step two"}
                ]
            }
        });
        let rows = extract_codex_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "thinking");
        assert_eq!(rows[0].text, "plan step one\nplan step two");

        // Encrypted reasoning carries no visible summary -> no row.
        let encrypted: Value = serde_json::json!({
            "type": "response_item",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "payload": {"type": "reasoning", "summary": [], "content": [{"type": "reasoning_text", "text": "hidden"}]}
        });
        assert!(extract_codex_line(&encrypted, ImageMode::Collect).is_empty());
    }
    #[test]
    fn kimi_prompt_row_recovers_image_paths() {
        let prompt = crate::engine::images::kimi_prompt_with_images(
            "what is this",
            &["/tmp/a.png".to_string(), "b.jpg".to_string()],
            Path::new("/tmp"),
        );
        let line: Value = serde_json::json!({
            "type": "turn.prompt",
            "time": 1757493136000i64,
            "input": prompt,
        });
        let rows = extract_kimi_line(&line);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "user");
        assert_eq!(rows[0].text, "what is this");
        assert_eq!(rows[0].images, ["/tmp/a.png", "/tmp/b.jpg"]);
    }

    #[test]
    fn claude_user_image_block_becomes_data_url() {
        let line: Value = serde_json::json!({
            "type": "user",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGk="}},
                    {"type": "text", "text": "这是什么?"}
                ]
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "这是什么?");
        assert_eq!(rows[0].images, ["data:image/png;base64,aGk="]);

        // Image-only message still yields a row.
        let image_only: Value = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "eGk="}}
                ]
            }
        });
        let rows = extract_claude_line(&image_only, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].images, ["data:image/jpeg;base64,eGk="]);
    }

    #[test]
    fn pi_user_image_part_becomes_data_url() {
        let line: Value = serde_json::json!({
            "type": "message",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "user",
                "content": [
                    {"type": "image", "data": "aGk=", "mimeType": "image/webp"},
                    {"type": "text", "text": "look"}
                ]
            }
        });
        let rows = extract_pi_family_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "look");
        assert_eq!(rows[0].images, ["data:image/webp;base64,aGk="]);
    }

    #[test]
    fn codex_input_image_part_is_collected() {
        let line: Value = serde_json::json!({
            "type": "response_item",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_image", "image_url": "data:image/png;base64,aGk="},
                    {"type": "input_text", "text": "see this"}
                ]
            }
        });
        let rows = extract_codex_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "see this");
        assert_eq!(rows[0].images, ["data:image/png;base64,aGk="]);
    }

    #[test]
    fn grok_skips_synthetic_reason_and_leaves_envelope_to_normalize() {
        let reminder: Value = serde_json::json!({
            "type": "user",
            "synthetic_reason": "system_reminder",
            "content": [{"type": "text", "text": "<system-reminder>skills</system-reminder>"}]
        });
        assert!(extract_grok_line(&reminder).is_empty());

        let context: Value = serde_json::json!({
            "type": "user",
            "content": [{"type": "text", "text": "<user_info>\nOS Version: macos\n</user_info>"}]
        });
        let context_rows = extract_grok_line(&context);
        assert_eq!(context_rows.len(), 1);
        assert!(normalize_extracted_row(context_rows.into_iter().next().unwrap()).is_none());

        let query: Value = serde_json::json!({
            "type": "user",
            "prompt_index": 0,
            "content": [{
                "type": "text",
                "text": "<image_files>\n1. /tmp/a.png\n</image_files>\n\n<user_query>Grok CLI 的历史记录怎么没出现？</user_query>"
            }]
        });
        let rows = extract_grok_line(&query);
        assert_eq!(rows.len(), 1);
        let normalized = normalize_extracted_row(rows.into_iter().next().unwrap()).unwrap();
        assert_eq!(normalized.role, "user");
        assert_eq!(normalized.text, "Grok CLI 的历史记录怎么没出现？");

        let mentioned = LineRow::new(
            "user",
            "please look at <user_info> in grok logs, not the typed <user_query>".into(),
            None,
        );
        let kept = normalize_extracted_row(mentioned).unwrap();
        assert_eq!(
            kept.text,
            "please look at <user_info> in grok logs, not the typed <user_query>"
        );
    }

    #[test]
    fn grok_reasoning_summary_becomes_thinking() {
        let line: Value = serde_json::json!({
            "type": "reasoning",
            "summary": [
                {"type": "summary_text", "text": "first thought"},
                {"type": "summary_text", "text": "second thought"}
            ]
        });
        let rows = extract_grok_line(&line);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "thinking");
        assert_eq!(rows[0].text, "first thought\nsecond thought");
    }
}
