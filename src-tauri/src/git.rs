use git2::{Repository, StatusOptions};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted" | "renamed" | "typechange"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub staged: Vec<GitFileEntry>,
    pub unstaged: Vec<GitFileEntry>,
    pub untracked: Vec<GitFileEntry>,
}

fn open_repo(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|_| "NOT_A_REPO".to_string())
}

fn status_label(status: git2::Status) -> &'static str {
    if status.contains(git2::Status::WT_DELETED) || status.contains(git2::Status::INDEX_DELETED) {
        "deleted"
    } else if status.contains(git2::Status::WT_RENAMED) || status.contains(git2::Status::INDEX_RENAMED) {
        "renamed"
    } else if status.contains(git2::Status::WT_NEW) || status.contains(git2::Status::INDEX_NEW) {
        "added"
    } else if status.contains(git2::Status::WT_TYPECHANGE) || status.contains(git2::Status::INDEX_TYPECHANGE) {
        "typechange"
    } else {
        "modified"
    }
}

/// Aggregate per-file (+additions, -deletions) from one diff. Binary deltas
/// emit no line callbacks, so they stay at the (0, 0) seeded by the delta cb.
fn diff_line_counts(diff: &mut git2::Diff) -> HashMap<String, (usize, usize)> {
    use std::cell::RefCell;
    let counts = RefCell::new(HashMap::<String, (usize, usize)>::new());
    let file = RefCell::new(String::new());
    if let Err(e) = diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            counts.borrow_mut().entry(path.clone()).or_insert((0, 0));
            *file.borrow_mut() = path;
            true
        },
        None,
        None,
        Some(&mut |_, _, line| {
            let mut counts = counts.borrow_mut();
            let Some(entry) = counts.get_mut(file.borrow().as_str()) else {
                return true;
            };
            match line.origin() {
                '+' => entry.0 += 1,
                '-' => entry.1 += 1,
                _ => {}
            }
            true
        }),
    ) {
        eprintln!("[git] diff line-count walk failed: {e}");
    }
    counts.into_inner()
}

/// (+lines, 0) for an untracked file. Chunked reads, capped at 100k lines:
/// the count only feeds a stats badge, so a huge file must not be slurped.
fn count_untracked_lines(repo: &Repository, file: &str) -> Option<(usize, usize)> {
    use std::io::Read;
    const MAX_COUNTED: usize = 100_000;
    let full = repo.workdir()?.join(file);
    let mut reader = std::io::BufReader::new(std::fs::File::open(full).ok()?);
    let mut lines = 0usize;
    let mut last_byte: Option<u8> = None;
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                lines += chunk[..n].iter().filter(|b| **b == b'\n').count();
                last_byte = chunk.get(n.wrapping_sub(1)).copied();
                if lines >= MAX_COUNTED {
                    lines = MAX_COUNTED;
                    break;
                }
            }
            Err(_) => return None,
        }
    }
    // BufRead::lines also yields a final line without a trailing newline.
    if lines < MAX_COUNTED && last_byte.is_some_and(|b| b != b'\n') {
        lines += 1;
    }
    Some((lines, 0))
}

/// Bucket status entries into staged/unstaged/untracked file lists.
fn collect_status_entries(
    statuses: &git2::Statuses,
) -> (Vec<GitFileEntry>, Vec<GitFileEntry>, Vec<GitFileEntry>) {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        if path.is_empty() {
            continue;
        }
        let status = entry.status();
        if status.contains(git2::Status::WT_NEW) && !status.intersects(git2::Status::INDEX_NEW) {
            untracked.push(GitFileEntry {
                path,
                status: "added".to_string(),
                additions: None,
                deletions: None,
            });
            continue;
        }
        if status.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        ) {
            staged.push(GitFileEntry {
                path: path.clone(),
                status: status_label(status).to_string(),
                additions: None,
                deletions: None,
            });
        }
        if status.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_TYPECHANGE
                | git2::Status::WT_RENAMED,
        ) {
            unstaged.push(GitFileEntry {
                path,
                status: status_label(status).to_string(),
                additions: None,
                deletions: None,
            });
        }
    }
    (staged, unstaged, untracked)
}

/// Fill per-file (+/-) stats from one staged + one unstaged diff, and line
/// counts for untracked files straight off disk.
fn fill_line_stats(
    repo: &Repository,
    staged: &mut [GitFileEntry],
    unstaged: &mut [GitFileEntry],
    untracked: &mut [GitFileEntry],
) {
    let head_tree = repo.head().and_then(|h| h.peel_to_tree()).ok();
    let staged_counts = repo
        .diff_tree_to_index(head_tree.as_ref(), None, None)
        .map(|mut d| diff_line_counts(&mut d))
        .unwrap_or_default();
    let unstaged_counts = repo
        .diff_index_to_workdir(None, None)
        .map(|mut d| diff_line_counts(&mut d))
        .unwrap_or_default();
    for entry in staged.iter_mut() {
        if let Some(&(a, d)) = staged_counts.get(&entry.path) {
            entry.additions = Some(a);
            entry.deletions = Some(d);
        }
    }
    for entry in unstaged.iter_mut() {
        if let Some(&(a, d)) = unstaged_counts.get(&entry.path) {
            entry.additions = Some(a);
            entry.deletions = Some(d);
        }
    }
    for entry in untracked.iter_mut() {
        if let Some((a, d)) = count_untracked_lines(repo, &entry.path) {
            entry.additions = Some(a);
            entry.deletions = Some(d);
        }
    }
}

/// Sync body of `git_status` — libgit2 walks can touch thousands of files,
/// far too heavy for the IPC main thread.
fn git_status_blocking(path: &str) -> Result<GitStatus, String> {
    let repo = open_repo(path)?;
    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_string))
        .unwrap_or_else(|| "HEAD".to_string());
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let (mut staged, mut unstaged, mut untracked) = collect_status_entries(&statuses);
    fill_line_stats(&repo, &mut staged, &mut unstaged, &mut untracked);
    Ok(GitStatus {
        branch,
        staged,
        unstaged,
        untracked,
    })
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_blocking(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn git_diff(path: String, file: String, staged: bool) -> Result<String, String> {
    let repo = open_repo(&path)?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(&file);
    let diff = if staged {
        let head_tree = repo
            .head()
            .and_then(|h| h.peel_to_tree())
            .ok();
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
    }
    .map_err(|e| e.to_string())?;
    let mut text = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            text.push(origin);
        }
        text.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        true
    })
    .map_err(|e| e.to_string())?;
    Ok(text)
}

#[tauri::command]
pub fn git_stage(path: String, files: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    for file in &files {
        let file_path = std::path::Path::new(file);
        if repo.workdir().map(|w| w.join(file_path)).map(|p| p.exists()).unwrap_or(false) {
            index.add_path(file_path).map_err(|e| e.to_string())?;
        } else {
            index.remove_path(file_path).map_err(|e| e.to_string())?;
        }
    }
    index.write().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&path)?;
    let head = repo.head().and_then(|h| h.peel_to_commit());
    let mut index = repo.index().map_err(|e| e.to_string())?;
    match head {
        Ok(commit) => {
            let tree = commit.tree().map_err(|e| e.to_string())?;
            for file in &files {
                let file_path = std::path::Path::new(file);
                match tree.get_path(file_path) {
                    Ok(entry) => {
                        index
                            .add(&git2::IndexEntry {
                                ctime: git2::IndexTime::new(0, 0),
                                mtime: git2::IndexTime::new(0, 0),
                                dev: 0,
                                ino: 0,
                                mode: entry.filemode() as u32,
                                uid: 0,
                                gid: 0,
                                file_size: 0,
                                id: entry.id(),
                                flags: 0,
                                flags_extended: 0,
                                path: file.as_bytes().to_vec(),
                            })
                            .map_err(|e| e.to_string())?;
                    }
                    Err(_) => {
                        // Not in HEAD: staged-new file -> remove from index.
                        let _ = index.remove_path(file_path);
                    }
                }
            }
        }
        Err(_) => {
            // No HEAD yet: clearing the index for these files un-stages them.
            for file in &files {
                let _ = index.remove_path(std::path::Path::new(file));
            }
        }
    }
    index.write().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_commit(path: String, message: String) -> Result<String, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("empty commit message".to_string());
    }
    let repo = open_repo(&path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let sig = repo.signature().map_err(|e| {
        format!("git identity not configured (user.name/user.email): {e}")
    })?;
    let parent = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .ok();
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, trimmed, &tree, &parents)
        .map_err(|e| e.to_string())?;
    Ok(oid.to_string())
}

/// Push/pull run over the network; credential failures should read as
/// actionable guidance, not a libgit2 error dump.
fn map_remote_error(e: git2::Error) -> String {
    let message = e.message().to_string();
    let lower = message.to_lowercase();
    if e.code() == git2::ErrorCode::Auth
        || lower.contains("auth")
        || lower.contains("permission denied")
        || lower.contains("publickey")
        || lower.contains("credentials")
    {
        return format!(
            "git authentication failed: check your credentials / SSH key configuration ({message})"
        );
    }
    message
}

#[tauri::command]
pub async fn git_push(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open_repo(&path)?;
        let branch = current_branch_name(&repo)?;
        let mut remote = repo
            .find_remote("origin")
            .map_err(|e| format!("no origin remote: {e}"))?;
        remote
            .push(&[format!("refs/heads/{branch}:refs/heads/{branch}")], None)
            .map_err(map_remote_error)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Files the fast-forward would touch that also carry local modifications —
/// the conflict list for a safe (non-force) checkout failure.
fn ff_conflicting_files(repo: &Repository, target: git2::Oid) -> Vec<String> {
    let Ok(head_tree) = repo.head().and_then(|h| h.peel_to_tree()) else {
        return Vec::new();
    };
    let Ok(target_commit) = repo.find_commit(target) else {
        return Vec::new();
    };
    let Ok(target_tree) = target_commit.tree() else {
        return Vec::new();
    };
    let Ok(touched) = repo.diff_tree_to_tree(Some(&head_tree), Some(&target_tree), None) else {
        return Vec::new();
    };
    let mut touched_paths = std::collections::HashSet::new();
    let _ = touched.foreach(
        &mut |delta, _| {
            if let Some(p) = delta.new_file().path() {
                touched_paths.insert(p.to_string_lossy().into_owned());
            }
            true
        },
        None,
        None,
        None,
    );
    let mut opts = StatusOptions::new();
    opts.include_untracked(false);
    let Ok(statuses) = repo.statuses(Some(&mut opts)) else {
        return Vec::new();
    };
    statuses
        .iter()
        .filter(|s| {
            s.status().intersects(
                git2::Status::WT_MODIFIED | git2::Status::WT_DELETED | git2::Status::WT_TYPECHANGE,
            )
        })
        .filter_map(|s| s.path().map(str::to_string))
        .filter(|p| touched_paths.contains(p))
        .collect()
}

/// Sync body of `git_pull` (network fetch + merge analysis).
fn git_pull_blocking(path: &str) -> Result<(), String> {
    let repo = open_repo(path)?;
    let branch = current_branch_name(&repo)?;
    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| format!("no origin remote: {e}"))?;
    remote
        .fetch(std::slice::from_ref(&branch), None, None)
        .map_err(map_remote_error)?;
    let fetch_head = repo.find_reference("FETCH_HEAD").map_err(|e| e.to_string())?;
    let fetch_commit = repo
        .reference_to_annotated_commit(&fetch_head)
        .map_err(|e| e.to_string())?;
    let (analysis, _) = repo
        .merge_analysis(&[&fetch_commit])
        .map_err(|e| e.to_string())?;
    if analysis.is_up_to_date() {
        return Ok(());
    }
    if analysis.is_fast_forward() {
        let refname = format!("refs/heads/{branch}");
        let mut reference = repo.find_reference(&refname).map_err(|e| e.to_string())?;
        reference
            .set_target(fetch_commit.id(), "fast-forward")
            .map_err(|e| e.to_string())?;
        repo.set_head(&refname).map_err(|e| e.to_string())?;
        // Safe checkout (no force): a fast-forward must never clobber
        // uncommitted local edits — report the conflicting files instead.
        if let Err(e) = repo.checkout_head(None) {
            let conflicts = ff_conflicting_files(&repo, fetch_commit.id());
            return Err(if conflicts.is_empty() {
                format!("fast-forward checkout failed: {e}")
            } else {
                format!(
                    "pull would overwrite uncommitted changes in: {}",
                    conflicts.join(", ")
                )
            });
        }
        return Ok(());
    }
    Err("pull requires a merge; not supported in v1".to_string())
}

#[tauri::command]
pub async fn git_pull(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git_pull_blocking(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn current_branch_name(repo: &Repository) -> Result<String, String> {
    repo.head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(str::to_string))
        .ok_or_else(|| "detached HEAD".to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
}

#[tauri::command]
pub fn git_branches(path: String) -> Result<Vec<BranchInfo>, String> {
    let repo = open_repo(&path)?;
    let current = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_string))
        .unwrap_or_default();
    let mut out = Vec::new();
    let branches = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|e| e.to_string())?;
    for branch in branches.flatten() {
        let (b, _) = branch;
        if let Ok(Some(name)) = b.name() {
            out.push(BranchInfo {
                name: name.to_string(),
                is_current: name == current,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn git_checkout(path: String, branch: String) -> Result<(), String> {
    let repo = open_repo(&path)?;
    let (object, reference) = repo
        .revparse_ext(&branch)
        .map_err(|e| format!("unknown branch {branch}: {e}"))?;
    repo.checkout_tree(&object, None).map_err(|e| e.to_string())?;
    match reference {
        Some(r) => repo
            .set_head(r.name().ok_or("invalid ref name")?)
            .map_err(|e| e.to_string()),
        None => repo.set_head_detached(object.id()).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub fn git_create_branch(path: String, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("empty branch name".to_string());
    }
    let repo = open_repo(&path)?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.to_string())?;
    let branch = repo.branch(trimmed, &head, false).map_err(|e| e.to_string())?;
    let refname = format!("refs/heads/{}", branch.name().map_err(|e| e.to_string())?.unwrap_or(trimmed));
    let object = head.as_object().clone();
    repo.checkout_tree(&object, None).map_err(|e| e.to_string())?;
    repo.set_head(&refname).map_err(|e| e.to_string())
}
