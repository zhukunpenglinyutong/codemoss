use base64::Engine as _;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_READ_BYTES: usize = 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_SEARCH_RESULTS: usize = 200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub kind: String, // "text" | "image" | "binary"
    pub text: Option<String>,
    pub data_url: Option<String>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub text: String,
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Canonicalize an existing path; for a not-yet-created file, canonicalize
/// its parent and re-append the file name (one level covers write/rename
/// targets, whose parent directories exist in practice).
pub(crate) fn canonicalize_lenient(path: &Path) -> Result<PathBuf, String> {
    if let Ok(resolved) = std::fs::canonicalize(path) {
        return Ok(resolved);
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("cannot resolve {}", path.display()))?;
    let base = std::fs::canonicalize(parent)
        .map_err(|e| format!("cannot resolve {}: {e}", parent.display()))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("cannot resolve {}", path.display()))?;
    Ok(base.join(name))
}

/// Workspace roots + the pasted-images sandbox are the only trees the file
/// commands may touch: `path` comes over IPC and would otherwise be an
/// arbitrary-filesystem primitive.
fn allowed_roots(db: &crate::db::Db) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = db
        .workspace_paths()
        .unwrap_or_default()
        .iter()
        .filter_map(|w| canonicalize_lenient(Path::new(w)).ok())
        .collect();
    let pasted = crate::engine::images::pasted_images_dir();
    if let Ok(resolved) = canonicalize_lenient(&pasted) {
        roots.push(resolved);
    }
    roots
}

pub(crate) fn ensure_allowed(path: &str, db: &crate::db::Db) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".to_string());
    }
    let resolved = canonicalize_lenient(Path::new(trimmed))?;
    let roots = allowed_roots(db);
    if roots.iter().any(|root| resolved.starts_with(root)) {
        Ok(resolved)
    } else {
        Err(format!(
            "path is outside the registered workspaces: {trimmed}"
        ))
    }
}

#[tauri::command]
pub fn list_dir(db: tauri::State<'_, Arc<crate::db::Db>>, path: String) -> Result<Vec<DirEntry>, String> {
    let dir = ensure_allowed(&path, &db)?;
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
    let mut out: Vec<DirEntry> = entries
        .flatten()
        .map(|entry| {
            let meta = entry.metadata().ok();
            DirEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                mtime_ms: meta.as_ref().map(mtime_ms).unwrap_or(0),
            }
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

fn is_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico"
    )
}

fn image_mime(path: &Path) -> &'static str {
    match path
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
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "image/png",
    }
}

/// Sync body of `read_file`; the command wrapper runs it off the main
/// thread via spawn_blocking (a 1MB read must not stall IPC).
fn read_file_blocking(db: &crate::db::Db, path: &str) -> Result<FileContent, String> {
    let file = ensure_allowed(path, db)?;
    let meta = std::fs::metadata(&file).map_err(|e| format!("stat {}: {e}", file.display()))?;
    if is_image(&file) {
        if meta.len() > MAX_IMAGE_BYTES as u64 {
            return Err("image exceeds 5MB preview limit".to_string());
        }
        let bytes = std::fs::read(&file).map_err(|e| format!("read {}: {e}", file.display()))?;
        let data_url = format!(
            "data:{};base64,{}",
            image_mime(&file),
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        return Ok(FileContent {
            kind: "image".to_string(),
            text: None,
            data_url: Some(data_url),
            truncated: false,
        });
    }
    let mut bytes = Vec::new();
    {
        use std::io::Read;
        let f = std::fs::File::open(&file).map_err(|e| format!("open {}: {e}", file.display()))?;
        let mut limited = f.take((MAX_READ_BYTES + 1) as u64);
        limited
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read {}: {e}", file.display()))?;
    }
    let truncated = bytes.len() > MAX_READ_BYTES;
    if truncated {
        bytes.truncate(MAX_READ_BYTES);
    }
    // Binary detection: NUL in the first 8KB.
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Ok(FileContent {
            kind: "binary".to_string(),
            text: None,
            data_url: None,
            truncated: false,
        });
    }
    Ok(FileContent {
        kind: "text".to_string(),
        text: Some(String::from_utf8_lossy(&bytes).to_string()),
        data_url: None,
        truncated,
    })
}

#[tauri::command]
pub async fn read_file(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    path: String,
) -> Result<FileContent, String> {
    let db = Arc::clone(db.inner());
    tauri::async_runtime::spawn_blocking(move || read_file_blocking(&db, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn write_file(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    path: String,
    content: String,
) -> Result<(), String> {
    let file = ensure_allowed(&path, &db)?;
    std::fs::write(&file, content).map_err(|e| format!("write {}: {e}", file.display()))
}

#[tauri::command]
pub fn create_dir(db: tauri::State<'_, Arc<crate::db::Db>>, path: String) -> Result<(), String> {
    let dir = ensure_allowed(&path, &db)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))
}

#[tauri::command]
pub fn rename_item(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    from: String,
    to: String,
) -> Result<(), String> {
    let src = ensure_allowed(&from, &db)?;
    let dst = ensure_allowed(&to, &db)?;
    std::fs::rename(&src, &dst)
        .map_err(|e| format!("rename {} -> {}: {e}", src.display(), dst.display()))
}

#[tauri::command]
pub fn trash_item(db: tauri::State<'_, Arc<crate::db::Db>>, path: String) -> Result<(), String> {
    let target = ensure_allowed(&path, &db)?;
    trash::delete(&target).map_err(|e| format!("trash {}: {e}", target.display()))
}

/// Case-insensitive substring check. ASCII haystack+needle take an
/// allocation-free fast path; Unicode input falls back to `to_lowercase`
/// to preserve the old case-folding semantics exactly.
fn contains_case_insensitive(line: &str, needle_lower: &str) -> bool {
    if line.is_ascii() && needle_lower.is_ascii() {
        line.as_bytes()
            .windows(needle_lower.len())
            .any(|w| w.eq_ignore_ascii_case(needle_lower.as_bytes()))
    } else {
        line.to_lowercase().contains(needle_lower)
    }
}

/// Sync body of `search_text` (recursive grep is far too heavy for the main
/// thread on large trees).
fn search_text_blocking(
    db: &crate::db::Db,
    path: &str,
    query: &str,
) -> Result<Vec<SearchHit>, String> {
    use std::io::BufRead;
    let root = ensure_allowed(path, db)?;
    let needle = query.trim().to_string();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let needle_lower = needle.to_lowercase();
    let mut hits = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        if hits.len() >= MAX_SEARCH_RESULTS {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if hits.len() >= MAX_SEARCH_RESULTS {
                break;
            }
            let p = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(p);
                continue;
            }
            if meta.len() > MAX_READ_BYTES as u64 * 4 {
                continue;
            }
            let Ok(file) = std::fs::File::open(&p) else {
                continue;
            };
            let reader = std::io::BufReader::new(file);
            for (index, line) in reader.lines().enumerate() {
                let Ok(line) = line else { break };
                if contains_case_insensitive(&line, &needle_lower) {
                    hits.push(SearchHit {
                        path: p.to_string_lossy().to_string(),
                        line: index + 1,
                        text: line.trim().chars().take(200).collect(),
                    });
                    if hits.len() >= MAX_SEARCH_RESULTS {
                        break;
                    }
                }
            }
        }
    }
    Ok(hits)
}

#[tauri::command]
pub async fn search_text(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    path: String,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    let db = Arc::clone(db.inner());
    tauri::async_runtime::spawn_blocking(move || search_text_blocking(&db, &path, &query))
        .await
        .map_err(|e| e.to_string())?
}
