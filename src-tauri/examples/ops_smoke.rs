//! Smoke: exercise git commands against a temp repo, and config import/env
//! resolution against a temp legacy config.
//!
//!   cargo run --example ops_smoke

use ccgui_next_lib::git;

fn main() {
    // git_status/push/pull are async (spawn_blocking under the hood), so the
    // smoke installs its own current-thread runtime as tauri's async runtime.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    tauri::async_runtime::set(runtime.handle().clone());
    runtime.block_on(git_smoke());
}

async fn git_smoke() {
    let dir = std::env::temp_dir().join(format!("ccgui-git-smoke-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.to_string_lossy().to_string();

    // init repo with one commit
    let repo = git2::Repository::init(&dir).unwrap();
    std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
    {
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("smoke", "smoke@test").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
    }
    // git identity for our commands comes from repo config; set it.
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "smoke").unwrap();
    config.set_str("user.email", "smoke@test").unwrap();
    drop(config);
    drop(repo);

    // untracked + modified
    std::fs::write(dir.join("b.txt"), "new file\n").unwrap();
    std::fs::write(dir.join("a.txt"), "hello\nworld\n").unwrap();

    let status = git::git_status(path.clone()).await.unwrap();
    println!(
        "status: branch={} staged={} unstaged={} untracked={}",
        status.branch,
        status.staged.len(),
        status.unstaged.len(),
        status.untracked.len()
    );
    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(status.untracked.len(), 1);

    let diff = git::git_diff(path.clone(), "a.txt".into(), false).unwrap();
    assert!(diff.contains("+world"), "diff shows added line: {diff}");
    println!("diff: ok ({} bytes)", diff.len());

    git::git_stage(path.clone(), vec!["a.txt".into(), "b.txt".into()]).unwrap();
    let status = git::git_status(path.clone()).await.unwrap();
    assert_eq!(status.staged.len(), 2, "two staged after stage: {status:?}");
    println!("stage: ok");

    git::git_unstage(path.clone(), vec!["b.txt".into()]).unwrap();
    let status = git::git_status(path.clone()).await.unwrap();
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.untracked.len(), 1, "b.txt back to untracked: {status:?}");
    println!("unstage: ok");

    let oid = git::git_commit(path.clone(), "second commit".into()).unwrap();
    println!("commit: ok ({oid})");
    let status = git::git_status(path.clone()).await.unwrap();
    assert_eq!(status.staged.len(), 0);

    git::git_create_branch(path.clone(), "feature-x".into()).unwrap();
    let status = git::git_status(path.clone()).await.unwrap();
    assert_eq!(status.branch, "feature-x");
    println!("create_branch+checkout: ok");

    git::git_checkout(path.clone(), "master".into())
        .or_else(|_| git::git_checkout(path.clone(), "main".into()))
        .unwrap();
    let branches = git::git_branches(path.clone()).unwrap();
    assert!(branches.iter().any(|b| b.name == "feature-x"));
    println!("branches: {:?}", branches.iter().map(|b| &b.name).collect::<Vec<_>>());

    let not_repo = git::git_status("/tmp".into()).await.unwrap_err();
    assert_eq!(not_repo, "NOT_A_REPO");
    println!("not-a-repo error: ok");

    let _ = std::fs::remove_dir_all(&dir);
    println!("GIT SMOKE PASSED");
}
