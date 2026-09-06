use rusqlite::Connection;
use std::sync::Mutex;

/// Folded into the scanner's stat signature so a schema/derivation change
/// still invalidates cached parse results.
pub const CACHE_VERSION: &str = "2";

pub struct Db(pub Mutex<Connection>);

impl Db {
    pub fn open() -> rusqlite::Result<Self> {
        Self::open_at(&crate::paths::db_path())
    }
    pub fn open_at(path: &std::path::Path) -> rusqlite::Result<Self> {
        // The db sits next to config.json (provider API keys): owner-only.
        // Touch the file first so the permission lands before sqlite's own
        // lazy creation can pick a looser umask default.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .open(path);
            if let Err(e) =
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            {
                eprintln!("[db] chmod 0600 {}: {e}", path.display());
            }
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        migrate(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    /// All registered workspace roots (session attribution + path confinement).
    pub fn workspace_paths(&self) -> Result<Vec<String>, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT path FROM workspaces")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            match row {
                Ok(path) => out.push(path),
                Err(e) => eprintln!("[db] skipping undecodable workspace row: {e}"),
            }
        }
        Ok(out)
    }
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS workspaces(
            id TEXT PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            last_opened_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS sessions(
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            workspace_path TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            file_mtime_ms INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            preview TEXT NOT NULL DEFAULT '',
            created_at INTEGER,
            updated_at INTEGER,
            message_count INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            custom_title TEXT,
            PRIMARY KEY(engine, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
        CREATE TABLE IF NOT EXISTS meta(
            key TEXT PRIMARY KEY,
            value TEXT
        );
        ",
    )?;
    // NB: no `cache_version` meta row — it was written but never read; cache
    // freshness is carried by the scanner's stat signature (see CACHE_VERSION).
    // Additive migration: user-defined workspace order (drag reorder).
    let has_sort_order = conn
        .prepare("PRAGMA table_info(workspaces)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .flatten()
        .any(|name| name == "sort_order");
    if !has_sort_order {
        conn.execute("ALTER TABLE workspaces ADD COLUMN sort_order INTEGER", [])?;
    }
    Ok(())
}
