//! Smoke: run the history scanner against the real native session files on
//! this machine, using a temp app home so the user's ~/.ccgui-next is untouched.
//!
//!   cargo run --example scan_smoke -- /path/to/workspace [/another ...]

use ccgui_next_lib::db::Db;
use ccgui_next_lib::history::parse_session_file;
use std::time::Instant;

fn main() {
    let tmp = std::env::temp_dir().join(format!("ccgui-scan-smoke-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).expect("create temp home");

    let workspaces: Vec<String> = std::env::args().skip(1).collect();
    if workspaces.is_empty() {
        eprintln!("usage: scan_smoke <workspace> [more...]");
        std::process::exit(2);
    }

    let db = Db::open_at(&tmp.join("app.db")).expect("open db");
    {
        let conn = db.0.lock().unwrap();
        for (i, w) in workspaces.iter().enumerate() {
            conn.execute(
                "INSERT INTO workspaces(id, path, name) VALUES(?1, ?2, ?3)",
                rusqlite::params![format!("w{i}"), w, w],
            )
            .unwrap();
        }
    }

    // First full scan.
    let start = Instant::now();
    let report = ccgui_next_lib::history::scanner::scan_with(&db, || {}).expect("scan");
    println!(
        "full scan: scanned={} reparsed={} reused={} in {:?}",
        report.scanned,
        report.reparsed,
        report.reused,
        start.elapsed()
    );

    // Second scan must reuse everything (stat-keyed cache).
    let start = Instant::now();
    let report2 = ccgui_next_lib::history::scanner::scan_with(&db, || {}).expect("rescan");
    println!(
        "cache scan: scanned={} reparsed={} reused={} in {:?}",
        report2.scanned,
        report2.reparsed,
        report2.reused,
        start.elapsed()
    );

    // Per-engine session counts the scan attributed to each workspace.
    {
        let conn = db.0.lock().unwrap();
        for w in &workspaces {
            let mut stmt = conn
                .prepare("SELECT engine, COUNT(*) FROM sessions WHERE workspace_path=?1 GROUP BY engine")
                .unwrap();
            let counts: Vec<(String, i64)> = stmt
                .query_map(rusqlite::params![w], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                })
                .unwrap()
                .flatten()
                .collect();
            println!("workspace {w}: {counts:?}");
        }
    }

    // Sample: parse the largest scanned file end-to-end (reader path).
    // Sidebar sanity: the most recent session titles as the app shows them.
    {
        let conn = db.0.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT title FROM sessions ORDER BY COALESCE(updated_at, 0) DESC LIMIT 12")
            .unwrap();
        let titles: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .flatten()
            .collect();
        for t in titles {
            println!("title: {}", t.replace('\n', " "));
        }
    }

    let biggest = {
        let conn = db.0.lock().unwrap();
        conn.query_row(
            "SELECT engine, file_path, file_size FROM sessions ORDER BY file_size DESC LIMIT 1",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .ok()
    };
    if let Some((engine, path, size)) = biggest {
        let start = Instant::now();
        let parsed = parse_session_file(&engine, std::path::Path::new(&path)).expect("parse biggest");
        println!(
            "reader: {engine} {} bytes -> {} messages in {:?} ({})",
            size,
            parsed.messages.len(),
            start.elapsed(),
            path
        );
        if let Some(first_user) = parsed.messages.iter().find(|m| m.role == "user") {
            println!("first user msg: {:.80}", first_user.text.replace('\n', " "));
        }
    }

    let _ = std::fs::remove_dir_all(&tmp);
}

