use base64::Engine as _;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
/// Pasted clipboard images arrive as bytes with no path; every engine consumes
/// real files (codex `-i`, kimi path injection, pi/omp `@file`), so persist
/// them under app home and hand back the absolute path. Mirrors the 8MB cap
/// `load_image` enforces on read.
const MAX_PASTED_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const PASTED_IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

pub(crate) fn pasted_images_dir() -> PathBuf {
    crate::paths::app_home().join("pasted-images")
}

/// Reject obviously-oversized base64 before spending CPU on the decode:
/// 8MB of binary is ~11.2MB of base64.
fn base64_fits_limit(clean_len: usize) -> bool {
    clean_len <= MAX_PASTED_IMAGE_BYTES / 3 * 4 + 8
}

/// Persist validated image bytes under pasted-images with a UUID name.
fn store_image_bytes(bytes: &[u8], ext: &str) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("empty image payload".to_string());
    }
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err("pasted image exceeds 8MB".to_string());
    }
    let dir = pasted_images_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create pasted image dir: {e}"))?;
    let path = dir.join(format!("paste-{}.{}", uuid::Uuid::new_v4(), ext));
    std::fs::write(&path, bytes).map_err(|e| format!("write pasted image: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn save_pasted_image(data_base64: String, extension: String) -> Result<String, String> {
    let ext = extension.trim().to_ascii_lowercase();
    if !PASTED_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("unsupported image extension: {ext}"));
    }
    let clean: String = data_base64.chars().filter(|c| !c.is_whitespace()).collect();
    if !base64_fits_limit(clean.len()) {
        return Err("pasted image exceeds 8MB".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(clean.as_bytes())
        .map_err(|_| "invalid base64 payload".to_string())?;
    store_image_bytes(&bytes, &ext)
}

/// Images the user picked via the system open dialog arrive as arbitrary
/// absolute paths; that explicit choice IS the authorization, so the source
/// needs no workspace confinement — but only a copy inside the sandbox is
/// handed back, keeping every downstream consumer confined.
#[tauri::command]
pub fn import_attachments(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for raw in paths {
        let path = PathBuf::from(raw.trim());
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !PASTED_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            eprintln!("[images] import skipped (bad extension): {}", path.display());
            continue;
        }
        let result = std::fs::metadata(&path)
            .map_err(|e| format!("stat {}: {e}", path.display()))
            .and_then(|meta| {
                if meta.len() > MAX_PASTED_IMAGE_BYTES as u64 {
                    return Err(format!("{} exceeds 8MB", path.display()));
                }
                std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))
            })
            .and_then(|bytes| store_image_bytes(&bytes, &ext));
        match result {
            Ok(stored) => out.push(stored),
            Err(error) => eprintln!("[images] import skipped: {error}"),
        }
    }
    Ok(out)
}

/// Queued messages hold pasted-image paths, but the queue lives in memory
/// only, so nothing references these files after a restart: sweep the dir at
/// startup to keep app home from growing without bound.
pub fn sweep_pasted_images() {
    let dir = pasted_images_dir();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    // 1x1 red PNG.
    const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn round_trips_png_to_pasted_images_dir() {
        let path = save_pasted_image(PNG_B64.to_string(), "png".to_string()).unwrap();
        let written = std::fs::read(&path).unwrap();
        assert_eq!(
            written,
            base64::engine::general_purpose::STANDARD.decode(PNG_B64).unwrap()
        );
        assert!(path.contains("pasted-images"));
        assert!(path.ends_with(".png"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_unknown_extension() {
        assert!(save_pasted_image(PNG_B64.to_string(), "exe".to_string()).is_err());
    }

    #[test]
    fn rejects_garbage_base64_and_empty_payload() {
        assert!(save_pasted_image("!!!not-base64!!!".to_string(), "png".to_string()).is_err());
        assert!(save_pasted_image(String::new(), "png".to_string()).is_err());
    }
}

/// Normalize an image reference to an absolute local path: trims, skips
/// `data:` URLs and empty refs (no file to reference), strips a `file://`
/// prefix, and joins relative paths onto the workspace.
pub(crate) fn absolutize_image_path(raw: &str, workspace: &Path) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with("data:") {
        return None;
    }
    let path = PathBuf::from(trimmed.trim_start_matches("file://"));
    Some(if path.is_absolute() {
        path
    } else {
        workspace.join(path)
    })
}

/// Resolve an image reference (data URL, absolute path, or workspace-relative
/// path) to a local file path plus its base64 payload and mime type.
pub fn load_image(
    raw: &str,
    workspace: &Path,
) -> Result<(String /*mime*/, String /*base64*/), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty image reference".to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("data:") {
        let (meta, payload) = rest
            .split_once(',')
            .ok_or_else(|| "malformed data url".to_string())?;
        let mime = meta.strip_suffix(";base64").unwrap_or("image/png");
        let clean: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
        if clean.is_empty() {
            return Err("empty data url payload".to_string());
        }
        // Cheap gate before a multi-MB decode: validity only (the payload is
        // forwarded, not stored).
        if !base64_fits_limit(clean.len()) {
            return Err("image data url exceeds 8MB".to_string());
        }
        base64::engine::general_purpose::STANDARD
            .decode(clean.as_bytes())
            .map_err(|_| "invalid base64 payload".to_string())?;
        return Ok((mime.to_string(), clean));
    }
    let Some(path) = absolutize_image_path(trimmed, workspace) else {
        return Err("empty image reference".to_string());
    };
    // Confinement: only workspace files and sandboxed pasted images may be
    // read into a prompt — the refs arrive over IPC.
    let resolved = crate::files::canonicalize_lenient(&path)?;
    let workspace_ok = crate::files::canonicalize_lenient(workspace)
        .map(|root| resolved.starts_with(root))
        .unwrap_or(false);
    let pasted_ok = crate::files::canonicalize_lenient(&pasted_images_dir())
        .map(|root| resolved.starts_with(root))
        .unwrap_or(false);
    if !workspace_ok && !pasted_ok {
        return Err(format!(
            "image is outside the workspace and pasted-images sandbox: {}",
            path.display()
        ));
    }
    let meta = std::fs::metadata(&resolved)
        .map_err(|e| format!("stat image {}: {e}", resolved.display()))?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err(format!("image {} exceeds 8MB", resolved.display()));
    }
    let bytes = std::fs::read(&resolved)
        .map_err(|e| format!("read image {}: {e}", resolved.display()))?;
    let mime = match resolved
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };
    Ok((
        mime.to_string(),
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ))
}

/// Claude stream-json stdin user message with image + text content blocks.
pub fn claude_stdin_message(
    prompt: &str,
    images: &[String],
    workspace: &Path,
) -> Result<String, String> {
    let mut content: Vec<Value> = Vec::new();
    for raw in images {
        let (mime, data) = load_image(raw, workspace)?;
        content.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": mime, "data": data }
        }));
    }
    if !prompt.trim().is_empty() {
        content.push(json!({ "type": "text", "text": prompt }));
    }
    let message = json!({
        "type": "user",
        "message": { "role": "user", "content": content }
    });
    serde_json::to_string(&message).map_err(|e| e.to_string())
}

/// Kimi image injection: absolute path tags the CLI reads via ReadMediaFile.
/// Marker lets history parsing strip the instruction block.
pub const KIMI_IMAGE_MARKER: &str = "\n\n<!-- ccgui:kimi-image-attachments -->\n";

pub fn kimi_prompt_with_images(prompt: &str, images: &[String], workspace: &Path) -> String {
    let paths: Vec<PathBuf> = images
        .iter()
        .filter_map(|raw| absolutize_image_path(raw, workspace))
        .collect();
    if paths.is_empty() {
        return prompt.to_string();
    }
    let mut out = prompt.trim_end().to_string();
    out.push_str(KIMI_IMAGE_MARKER);
    out.push_str("The user attached the following image file(s). ");
    out.push_str("You MUST call ReadMediaFile on each path below before answering any question about visual content.\n");
    for (index, path) in paths.iter().enumerate() {
        out.push_str(&format!("{}. {}\n", index + 1, path.display()));
        out.push_str(&format!("<image path=\"{}\"></image>\n", path.display()));
    }
    out
}

/// Grok ACP content blocks for `--prompt-file`; None when no images.
pub fn grok_prompt_json(
    prompt: &str,
    images: &[String],
    workspace: &Path,
) -> Result<Option<String>, String> {
    if images.iter().all(|i| i.trim().is_empty()) {
        return Ok(None);
    }
    let mut blocks: Vec<Value> = Vec::new();
    if !prompt.trim().is_empty() {
        blocks.push(json!({ "type": "text", "text": prompt }));
    }
    for raw in images {
        if raw.trim().is_empty() {
            continue;
        }
        let (mime, data) = load_image(raw, workspace)?;
        blocks.push(json!({ "type": "image", "mimeType": mime, "data": data }));
    }
    if blocks
        .iter()
        .all(|b| b.get("type").and_then(Value::as_str) != Some("text"))
    {
        blocks.insert(0, json!({ "type": "text", "text": "Please analyze the attached image(s)." }));
    }
    serde_json::to_string(&blocks)
        .map(Some)
        .map_err(|e| e.to_string())
}
