use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// Process-local metrics for the status bar's performance indicator.
/// A single System instance is reused across polls: CPU% is the delta
/// between consecutive refreshes, so each poll reports the load since the
/// previous one.
pub struct MetricsState {
    system: Mutex<System>,
    pid: Pid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMetrics {
    /// Resident memory of this process, bytes.
    pub memory_bytes: u64,
    /// CPU usage since the previous poll, percent of one core (can exceed
    /// 100 across cores).
    pub cpu_percent: f32,
}

impl MetricsState {
    pub fn new() -> Self {
        Self {
            system: Mutex::new(System::new()),
            pid: Pid::from_u32(std::process::id()),
        }
    }
}

#[tauri::command]
pub fn app_metrics(state: tauri::State<'_, MetricsState>) -> Result<AppMetrics, String> {
    let mut system = state.system.lock().map_err(|e| e.to_string())?;
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[state.pid]),
        true,
        ProcessRefreshKind::nothing().with_memory().with_cpu(),
    );
    let process = system
        .process(state.pid)
        .ok_or_else(|| "process not found".to_string())?;
    Ok(AppMetrics {
        memory_bytes: process.memory(),
        cpu_percent: process.cpu_usage(),
    })
}
