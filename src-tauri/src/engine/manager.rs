//! Engine manager
//!
//! Unified management of multiple engine types, handling engine switching,
//! session management, and configuration.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, RwLock};

use super::adapter_registry::{EngineAdapterRegistry, EngineId};
use super::agent_event_bus::AgentEventBus;
use super::claude::{ClaudeSession, ClaudeSessionManager};
use super::gemini::GeminiSession;
use super::grok::GrokSession;
use super::kimi::KimiSession;
use super::opencode::OpenCodeSession;
use super::pi::PiSession;
use super::qoder::QoderSession;
use super::qoder_provider_profile::{QoderDistributionSettings, QoderProviderLaunchProfile};
use super::status::{
    detect_all_engines_scoped, detect_claude_status, detect_codex_status, detect_grok_status,
    detect_kimi_status, detect_opencode_status_with_options, detect_qoder_status_with_options,
};
use super::status::EngineStatusEventSink;
use super::{disabled_engine_status, AuthState, EngineConfig, EngineStatus, EngineType};

/// Unified engine manager
pub struct EngineManager {
    /// Private domain-event fan-out. Producers publish without waiting for sinks.
    pub(crate) agent_event_bus: AgentEventBus,
    adapter_registry: EngineAdapterRegistry,
    /// Currently active engine type (global default)
    active_engine: RwLock<EngineType>,

    /// Cached engine statuses
    engine_statuses: RwLock<HashMap<EngineType, EngineStatus>>,

    /// 检测簿记（refactor-engine-detection-pipeline B3）：上次全量检测时间、
    /// 检测上下文（gemini gate + 黑名单集合，变化即缓存失效）、per-engine
    /// 检测时间与 last-good 落盘加载状态。
    detect_bookkeeping: StdMutex<DetectBookkeeping>,
    /// SWR 后台 revalidate 单飞标记。
    detect_revalidate_inflight: Arc<AtomicBool>,
    /// 逐引擎事件 detectRunId 单调计数（B4）。
    detect_run_counter: Arc<AtomicU64>,

    /// Claude session manager. Wrapped in `Arc` so the in-process AskUserQuestion
    /// MCP server can hold a shared handle for session lookup (see `askuser_mcp`).
    pub claude_manager: Arc<ClaudeSessionManager>,

    /// OpenCode sessions per workspace/provider runtime.
    opencode_sessions: Mutex<HashMap<String, OpenCodeSessionEntry>>,

    /// Gemini sessions per workspace
    gemini_sessions: Mutex<GeminiSessionRegistry>,

    /// Kimi sessions per workspace/provider runtime.
    kimi_sessions: Mutex<HashMap<String, KimiSessionEntry>>,

    /// Grok sessions per workspace/provider runtime.
    grok_sessions: Mutex<HashMap<String, GrokSessionEntry>>,

    /// PI sessions per workspace/provider runtime.
    pi_sessions: Mutex<HashMap<String, PiSessionEntry>>,

    /// Qoder sessions per workspace/provider runtime.
    qoder_sessions: Mutex<HashMap<String, QoderSessionEntry>>,

    /// Qoder is one engine with two immutable distribution identities. Keep
    /// their launch settings beside the manager so history/index paths that
    /// only receive an EngineManager do not silently collapse to Global.
    qoder_distribution_settings: RwLock<QoderDistributionSettings>,

    /// Engine configurations
    engine_configs: RwLock<HashMap<EngineType, EngineConfig>>,
}

#[derive(Default)]
struct GeminiSessionRegistry {
    sessions: HashMap<String, Arc<GeminiSession>>,
    // Workspace ID 是非复用 UUID；持久 tombstone 阻止旧请求在删除后重新取得 process owner。
    removed_workspaces: HashSet<String>,
    shutting_down: bool,
}

struct KimiSessionEntry {
    workspace_id: String,
    session: Arc<KimiSession>,
}

struct GrokSessionEntry {
    workspace_id: String,
    session: Arc<GrokSession>,
}

struct OpenCodeSessionEntry {
    workspace_id: String,
    session: Arc<OpenCodeSession>,
}

struct PiSessionEntry {
    workspace_id: String,
    session: Arc<PiSession>,
}

struct QoderSessionEntry {
    workspace_id: String,
    session: Arc<QoderSession>,
}

fn kimi_engine_config_with_home(
    mut config: Option<EngineConfig>,
    home_dir: Option<&Path>,
) -> Option<EngineConfig> {
    if let Some(home_dir) = home_dir {
        config.get_or_insert_with(EngineConfig::default).home_dir =
            Some(home_dir.to_string_lossy().to_string());
    }
    config
}

fn grok_engine_config_with_home(
    mut config: Option<EngineConfig>,
    home_dir: Option<&Path>,
) -> Option<EngineConfig> {
    if let Some(home_dir) = home_dir {
        config.get_or_insert_with(EngineConfig::default).home_dir =
            Some(home_dir.to_string_lossy().to_string());
    }
    config
}

fn pi_engine_config_with_home(
    mut config: Option<EngineConfig>,
    home_dir: Option<&Path>,
) -> Option<EngineConfig> {
    if let Some(home_dir) = home_dir {
        config.get_or_insert_with(EngineConfig::default).home_dir =
            Some(home_dir.to_string_lossy().to_string());
    }
    config
}

fn qoder_engine_config_with_launch_profile(
    mut config: Option<EngineConfig>,
    launch_profile: &QoderProviderLaunchProfile,
) -> Option<EngineConfig> {
    {
        let config_ref = config.get_or_insert_with(EngineConfig::default);
        config_ref.bin_path = launch_profile.bin_path.clone();
        config_ref.home_dir = launch_profile
            .home_dir
            .as_ref()
            .map(|home_dir| home_dir.to_string_lossy().to_string());
    }
    config
}

/// 检测缓存簿记（B3）。`last_context` 变化（黑名单 / gemini gate 变化）即视为
/// 缓存失效，下一轮检测按新上下文执行。
#[derive(Default)]
struct DetectBookkeeping {
    last_full_detect_at: Option<Instant>,
    last_context: Option<(bool, Vec<EngineType>)>,
    per_engine_detected_at: HashMap<EngineType, Instant>,
    last_good_loaded: bool,
}

/// last-good 落盘文件条目（`~/.ccgui/engine-status-last-good.json`）。
#[derive(serde::Serialize, serde::Deserialize)]
struct EngineStatusLastGoodEntry {
    status: EngineStatus,
    detected_at_ms: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct EngineStatusLastGoodFile {
    entries: HashMap<String, EngineStatusLastGoodEntry>,
}

/// TTL 内返回缓存；60s 与前端菜单打开 fire-and-forget 频率解耦。
const DETECT_CACHE_TTL: Duration = Duration::from_secs(60);
/// last-good 落盘保留期：超龄条目按「无该引擎 last-good」处理。
const LAST_GOOD_MAX_AGE_MS: u64 = 7 * 24 * 3600 * 1000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
static LAST_GOOD_PATH_OVERRIDE: OnceLock<StdMutex<Option<PathBuf>>> = OnceLock::new();

fn last_good_file_path() -> Option<PathBuf> {
    #[cfg(test)]
    {
        if let Some(lock) = LAST_GOOD_PATH_OVERRIDE.get() {
            if let Ok(guard) = lock.lock() {
                if let Some(path) = guard.as_ref() {
                    return Some(path.clone());
                }
            }
        }
    }
    crate::app_paths::app_home_dir()
        .ok()
        .map(|home| home.join("engine-status-last-good.json"))
}

/// SWR revalidate 单飞标记的 panic 安全复位。
struct DetectInflightReset(Arc<AtomicBool>);

impl Drop for DetectInflightReset {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// per-engine 探测「失败」判定：仅限探测自身故障（panic 隔离标注 / 探测超时），
/// 合法的 not-installed（如 ENOENT，用户外部卸载 CLI）不算失败，
/// MUST 正常更新缓存让卸载状态传播（D9 外部变化识别）。
fn is_probe_failure_error(error: Option<&str>) -> bool {
    error
        .map(|error| {
            error.contains("engine detection task failed")
                || error.contains("timed out")
                || error.contains("Timed out")
        })
        .unwrap_or(false)
}

/// 防中毒合并（纯函数便于测试）：fresh 为探测失败且旧值为已安装时，
/// 保留旧 last-good 并合入 error 标注；否则采用 fresh。
fn merge_with_poison_guard(previous: Option<&EngineStatus>, fresh: EngineStatus) -> EngineStatus {
    let degraded_probe = is_probe_failure_error(fresh.error.as_deref());
    if degraded_probe {
        if let Some(prev) = previous.filter(|prev| prev.installed) {
            let mut merged = prev.clone();
            if merged.error.is_none() {
                merged.error = fresh.error.clone();
            }
            return merged;
        }
    }
    fresh
}

impl EngineManager {
    /// Create a new engine manager
    pub fn new() -> Self {
        Self {
            agent_event_bus: AgentEventBus::new(),
            adapter_registry: EngineAdapterRegistry::with_builtins(),
            active_engine: RwLock::new(EngineType::default()),
            engine_statuses: RwLock::new(HashMap::new()),
            detect_bookkeeping: StdMutex::new(DetectBookkeeping::default()),
            detect_revalidate_inflight: Arc::new(AtomicBool::new(false)),
            detect_run_counter: Arc::new(AtomicU64::new(1)),
            claude_manager: Arc::new(ClaudeSessionManager::new()),
            opencode_sessions: Mutex::new(HashMap::new()),
            gemini_sessions: Mutex::new(GeminiSessionRegistry::default()),
            kimi_sessions: Mutex::new(HashMap::new()),
            grok_sessions: Mutex::new(HashMap::new()),
            pi_sessions: Mutex::new(HashMap::new()),
            qoder_sessions: Mutex::new(HashMap::new()),
            qoder_distribution_settings: RwLock::new(QoderDistributionSettings::default()),
            engine_configs: RwLock::new(HashMap::new()),
        }
    }

    pub(crate) fn agent_event_bus(&self) -> AgentEventBus {
        self.agent_event_bus.clone()
    }

    /// Get the currently active engine type
    pub async fn get_active_engine(&self) -> EngineType {
        *self.active_engine.read().await
    }

    /// Set the active engine type
    pub async fn set_active_engine(&self, engine_type: EngineType) -> Result<(), String> {
        // Verify engine is installed
        let statuses = self.engine_statuses.read().await;
        if let Some(status) = statuses.get(&engine_type) {
            if !status.installed {
                return Err(format!(
                    "{} is not installed. Please install it first.",
                    engine_type.display_name()
                ));
            }
        } else {
            // Status not cached, check now
            drop(statuses);
            let status = self.detect_single_engine(engine_type).await;
            if !status.installed {
                return Err(format!(
                    "{} is not installed. Please install it first.",
                    engine_type.display_name()
                ));
            }
        }

        *self.active_engine.write().await = engine_type;
        Ok(())
    }

    /// Detect a single engine's status
    async fn detect_single_engine(&self, engine_type: EngineType) -> EngineStatus {
        self.detect_single_engine_with_gates(engine_type, true)
            .await
    }

    async fn detect_single_engine_with_gates(
        &self,
        engine_type: EngineType,
        _gemini_enabled: bool,
    ) -> EngineStatus {
        let engine_id = EngineId::builtin(engine_type);
        let registry_entry = self
            .adapter_registry
            .get(&engine_id)
            .expect("built-in engine must be registered before detection");
        let adapter = self
            .adapter_registry
            .adapter(&engine_id)
            .expect("built-in engine adapter must be registered");
        let protocol = self
            .adapter_registry
            .protocol(&engine_id)
            .expect("built-in engine protocol must be registered");
        debug_assert_eq!(adapter.engine_id(), &engine_id);
        debug_assert_eq!(
            adapter.declared_capability_profile(),
            registry_entry.capability_profile
        );
        debug_assert_eq!(protocol.family(), registry_entry.protocol_family);
        debug_assert_eq!(protocol.execution_model(), registry_entry.execution_model);
        let configs = self.engine_configs.read().await;
        let config = configs.get(&engine_type);
        let bin = config.and_then(|c| c.bin_path.as_deref());

        // B1/B3：单引擎重探走启动轻量分支（models 目录探测只在
        // get_engine_models 按需路径）。
        let status = match engine_type {
            EngineType::Claude => detect_claude_status(bin).await,
            EngineType::Codex => detect_codex_status(bin).await,
            EngineType::Gemini => disabled_engine_status(engine_type),
            EngineType::OpenCode => detect_opencode_status_with_options(bin, false).await,
            EngineType::Kimi => detect_kimi_status(bin).await,
            EngineType::Grok => detect_grok_status(bin).await,
            EngineType::Pi => {
                crate::engine::status::detect_pi_status_with_options_and_home(
                    bin,
                    false,
                    config.and_then(|item| item.home_dir.as_deref()),
                )
                .await
            }
            EngineType::Qoder => detect_qoder_status_with_options(bin, false).await,
            EngineType::Dsh => {
                crate::engine::dsh::detect_dsh_status(
                    &crate::engine::dsh::runtime_settings_from_engine_config(config),
                )
                .await
            }
        };

        // Cache the result
        let mut statuses = self.engine_statuses.write().await;
        statuses.insert(engine_type, status.clone());

        status
    }

    /// Force-refresh a single engine status while honoring CLI validation gates.
    pub async fn refresh_engine_status_with_gates(
        &self,
        engine_type: EngineType,
        gemini_enabled: bool,
    ) -> EngineStatus {
        self.detect_single_engine_with_gates(engine_type, gemini_enabled)
            .await
    }

    pub async fn detect_engines_with_gates(
        &self,
        gemini_enabled: bool,
        disabled_engines: &[EngineType],
        on_status: Option<EngineStatusEventSink>,
    ) -> Vec<EngineStatus> {
        let gemini_enabled = gemini_enabled && crate::engine_policy::GEMINI_RUNTIME_ENABLED;
        let detect_run_id = self.detect_run_counter.fetch_add(1, Ordering::SeqCst);
        let (
            claude_bin,
            codex_bin,
            gemini_bin,
            opencode_bin,
            kimi_bin,
            grok_bin,
            pi_bin,
            qoder_bin,
            dsh_settings,
        ) = {
            let configs = self.engine_configs.read().await;
            (
                configs
                    .get(&EngineType::Claude)
                    .and_then(|c| c.bin_path.clone()),
                configs
                    .get(&EngineType::Codex)
                    .and_then(|c| c.bin_path.clone()),
                configs
                    .get(&EngineType::Gemini)
                    .and_then(|c| c.bin_path.clone()),
                configs
                    .get(&EngineType::OpenCode)
                    .and_then(|c| c.bin_path.clone()),
                configs
                    .get(&EngineType::Kimi)
                    .and_then(|c| c.bin_path.clone()),
                configs
                    .get(&EngineType::Grok)
                    .and_then(|c| c.bin_path.clone()),
                configs
                    .get(&EngineType::Pi)
                    .and_then(|c| c.bin_path.clone()),
                configs
                    .get(&EngineType::Qoder)
                    .and_then(|c| c.bin_path.clone()),
                crate::engine::dsh::runtime_settings_from_engine_config(
                    configs.get(&EngineType::Dsh),
                ),
            )
        };

        let statuses = detect_all_engines_scoped(
            claude_bin.as_deref(),
            codex_bin.as_deref(),
            gemini_bin.as_deref(),
            opencode_bin.as_deref(),
            kimi_bin.as_deref(),
            grok_bin.as_deref(),
            pi_bin.as_deref(),
            qoder_bin.as_deref(),
            &dsh_settings,
            gemini_enabled,
            disabled_engines,
            detect_run_id,
            on_status,
        )
        .await;

        let statuses = statuses
            .into_iter()
            .map(|status| match status.engine_type {
                EngineType::Gemini if !gemini_enabled => disabled_engine_status(EngineType::Gemini),
                _ => status,
            })
            .collect::<Vec<_>>();

        // Cache results with per-engine poison guard（B3）：探测自身失败
        // （panic 隔离 / 超时）不得覆盖旧 last-good。
        let now = Instant::now();
        let mut persisted = Vec::with_capacity(statuses.len());
        {
            let mut cached = self.engine_statuses.write().await;
            let mut bk = self.detect_bookkeeping.lock().expect("detect bookkeeping");
            bk.last_full_detect_at = Some(now);
            bk.last_context = Some((
                gemini_enabled,
                disabled_engines.iter().copied().collect::<Vec<_>>(),
            ));
            for status in &statuses {
                let merged =
                    merge_with_poison_guard(cached.get(&status.engine_type), status.clone());
                bk.per_engine_detected_at.insert(merged.engine_type, now);
                cached.insert(merged.engine_type, merged.clone());
                persisted.push(merged);
            }
        }
        self.persist_last_good_snapshot(&persisted).await;

        statuses
    }

    /// 检测缓存是否新鲜（TTL 内且检测上下文一致：黑名单 / gemini gate 变化即失效）。
    fn full_detect_cache_fresh(&self, gemini_enabled: bool, disabled: &[EngineType]) -> bool {
        let bk = self.detect_bookkeeping.lock().expect("detect bookkeeping");
        let fresh = bk
            .last_full_detect_at
            .map(|at| at.elapsed() < DETECT_CACHE_TTL)
            .unwrap_or(false);
        if !fresh {
            return false;
        }
        match bk.last_context.as_ref() {
            Some((last_gemini, last_disabled)) => {
                *last_gemini == gemini_enabled
                    && last_disabled.len() == disabled.len()
                    && disabled
                        .iter()
                        .all(|engine_type| last_disabled.contains(engine_type))
            }
            None => false,
        }
    }

    /// 冷启动一次性加载 last-good 落盘（容忍损坏；超龄条目按无 last-good 处理；
    /// 不覆盖内存中已更新的条目）。
    async fn ensure_last_good_loaded(&self) {
        let already_loaded = {
            let mut bk = self.detect_bookkeeping.lock().expect("detect bookkeeping");
            if bk.last_good_loaded {
                true
            } else {
                bk.last_good_loaded = true;
                false
            }
        };
        if already_loaded {
            return;
        }
        let Some(path) = last_good_file_path() else {
            return;
        };
        let Ok(text) = std::fs::read_to_string(&path) else {
            return;
        };
        let Ok(mut file) = serde_json::from_str::<EngineStatusLastGoodFile>(&text) else {
            return;
        };
        let now = now_ms();
        let mut statuses = self.engine_statuses.write().await;
        let mut bk = self.detect_bookkeeping.lock().expect("detect bookkeeping");
        for (engine_name, entry) in std::mem::take(&mut file.entries) {
            let Ok(engine_type) =
                serde_json::from_value::<EngineType>(serde_json::Value::String(engine_name))
            else {
                continue;
            };
            if now.saturating_sub(entry.detected_at_ms) > LAST_GOOD_MAX_AGE_MS {
                continue;
            }
            statuses.entry(engine_type).or_insert(entry.status);
            bk.per_engine_detected_at
                .entry(engine_type)
                .or_insert(Instant::now());
        }
    }

    /// last-good 落盘（原子写：temp + rename；失败静默——纯缓存文件）。
    async fn persist_last_good_snapshot(&self, statuses: &[EngineStatus]) {
        let Some(path) = last_good_file_path() else {
            return;
        };
        let bk = self.detect_bookkeeping.lock().expect("detect bookkeeping");
        let mut entries = HashMap::new();
        for status in statuses {
            let detected_at_ms = bk
                .per_engine_detected_at
                .get(&status.engine_type)
                .map(|at| now_ms().saturating_sub(at.elapsed().as_millis() as u64))
                .unwrap_or_else(now_ms);
            let Ok(name) = serde_json::to_string(&status.engine_type) else {
                continue;
            };
            entries.insert(
                name.trim_matches('"').to_string(),
                EngineStatusLastGoodEntry {
                    status: status.clone(),
                    detected_at_ms,
                },
            );
        }
        drop(bk);
        let Ok(json) = serde_json::to_string(&EngineStatusLastGoodFile { entries }) else {
            return;
        };
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    /// SWR 后台 revalidate（单飞）：立即返回 stale 快照后异步全量重探，
    /// 结果经 merge 写回缓存与落盘（B4 起逐引擎 emit 事件）。
    fn spawn_revalidate_if_idle(
        self: &Arc<Self>,
        gemini_enabled: bool,
        disabled: &[EngineType],
        on_status: Option<EngineStatusEventSink>,
    ) {
        if self
            .detect_revalidate_inflight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let manager = Arc::clone(self);
        let disabled = disabled.to_vec();
        tokio::spawn(async move {
            let _reset = DetectInflightReset(Arc::clone(&manager.detect_revalidate_inflight));
            manager
                .detect_engines_with_gates(gemini_enabled, &disabled, on_status)
                .await;
        });
    }

    /// B6/D6 登录态二段式 phase 2：detect 返回后异步 spawn 登录探测（仅 Qoder），
    /// 完成后覆写缓存并以新 runId emit 事件；探测失败保持 Unknown 不覆盖。
    fn spawn_qoder_login_phase_two(self: &Arc<Self>, on_status: Option<EngineStatusEventSink>) {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let Some(cached) = manager.get_engine_status(EngineType::Qoder).await else {
                return;
            };
            if !cached.installed || cached.auth_state != AuthState::Unknown {
                return;
            }
            let Some(logged_in) = crate::engine::status::detect_qoder_login_state_phase_two().await
            else {
                return;
            };
            let auth_state = if logged_in {
                AuthState::Authenticated
            } else {
                AuthState::RequiresLogin
            };
            let mut updated = cached;
            updated.auth_state = auth_state;
            if auth_state == AuthState::RequiresLogin && updated.error.is_none() {
                updated.error = Some("Qoder CLI 未登录：请先运行 qodercli login".to_string());
            }
            let run_id = manager.detect_run_counter.fetch_add(1, Ordering::SeqCst);
            manager.cache_engine_status(updated.clone()).await;
            if let Some(on_status) = on_status.as_ref() {
                on_status(run_id, updated);
            }
        });
    }

    #[cfg(test)]
    fn test_mark_detect_cache_fresh(&self, gemini_enabled: bool, disabled: &[EngineType]) {
        let mut bk = self.detect_bookkeeping.lock().expect("detect bookkeeping");
        bk.last_full_detect_at = Some(Instant::now());
        bk.last_context = Some((gemini_enabled, disabled.to_vec()));
        bk.last_good_loaded = true;
    }

    /// B3 缓存优先检测入口（app 命令与 daemon 共用）：
    /// - `force=false && engines=None`：TTL 内直接返回缓存（0 spawn）；
    ///   过期/上下文变化时返回 last-good（stale-while-revalidate）并后台单飞重探；
    ///   冷启动无 last-good 才同步全量探测。
    /// - `engines=Some(list)`：仅轻量重探列表内引擎并与缓存 merge（force 语义）。
    /// - `force=true`：全量重探。
    pub async fn detect_engines_cached(
        self: &Arc<Self>,
        force: bool,
        engines: Option<&[EngineType]>,
        gemini_enabled: bool,
        disabled: &[EngineType],
        on_status: Option<EngineStatusEventSink>,
    ) -> Vec<EngineStatus> {
        if !force && engines.is_none() {
            // 快照 MUST 按当前黑名单过滤：检测上下文变化（新禁用引擎）后，
            // 旧缓存里的该引擎不得再透出（D9）。
            let filter_disabled = |statuses: Vec<EngineStatus>| -> Vec<EngineStatus> {
                statuses
                    .into_iter()
                    .filter(|status| !disabled.contains(&status.engine_type))
                    .collect()
            };
            if self.full_detect_cache_fresh(gemini_enabled, disabled) {
                return filter_disabled(self.get_all_statuses().await);
            }
            self.ensure_last_good_loaded().await;
            let snapshot = self.get_all_statuses().await;
            if !snapshot.is_empty() {
                self.spawn_revalidate_if_idle(gemini_enabled, disabled, on_status.clone());
                self.spawn_qoder_login_phase_two(on_status);
                return filter_disabled(snapshot);
            }
            return self
                .detect_engines_with_gates(gemini_enabled, disabled, on_status)
                .await;
        }
        if let Some(list) = engines {
            let detect_run_id = self.detect_run_counter.fetch_add(1, Ordering::SeqCst);
            for engine_type in list {
                if disabled.contains(engine_type) {
                    continue;
                }
                let fresh = self
                    .detect_single_engine_with_gates(*engine_type, gemini_enabled)
                    .await;
                let merged = {
                    let cached = self.engine_statuses.read().await;
                    merge_with_poison_guard(cached.get(engine_type), fresh)
                };
                let now = Instant::now();
                {
                    let mut bk = self.detect_bookkeeping.lock().expect("detect bookkeeping");
                    bk.per_engine_detected_at.insert(merged.engine_type, now);
                }
                if let Some(on_status) = on_status.as_ref() {
                    on_status(detect_run_id, merged.clone());
                }
                self.cache_engine_status(merged).await;
                if *engine_type == EngineType::Qoder {
                    self.spawn_qoder_login_phase_two(on_status.clone());
                }
            }
            return self.get_all_statuses().await;
        }
        let statuses = self
            .detect_engines_with_gates(gemini_enabled, disabled, on_status.clone())
            .await;
        self.spawn_qoder_login_phase_two(on_status);
        statuses
    }

    /// Get cached engine status
    pub async fn get_engine_status(&self, engine_type: EngineType) -> Option<EngineStatus> {
        let statuses = self.engine_statuses.read().await;
        statuses.get(&engine_type).cloned()
    }

    /// Insert or replace the cached status for an engine.
    /// Used by cache-first catalog resolution to write back fresh probe
    /// results, and by tests to seed the cache.
    pub async fn cache_engine_status(&self, status: EngineStatus) {
        let mut statuses = self.engine_statuses.write().await;
        statuses.insert(status.engine_type, status);
    }

    /// Drop the cached model catalog for an engine, keeping the status entry
    /// itself（installed / version / auth_state 原样保留）。凭证写入路径
    /// （PI auth.json 写入/删除）用：目录随凭证实时变化，而 models 消费路径的
    /// 内存缓存无 TTL，不清则 picker 继续展示已变更 provider 的模型。
    /// MUST NOT 整条删除状态：detect TTL 命中路径直接透出 get_all_statuses()，
    /// 缺条目会让引擎菜单在窗口期漏掉该引擎；「条目在 + models 空」等价
    /// 轻量检测常态，全部消费方均已按需回填设计。
    pub async fn invalidate_engine_models(&self, engine_type: EngineType) {
        let mut statuses = self.engine_statuses.write().await;
        if let Some(status) = statuses.get_mut(&engine_type) {
            status.models = Vec::new();
            status.default_model = None;
        }
    }

    /// Get all cached engine statuses
    pub async fn get_all_statuses(&self) -> Vec<EngineStatus> {
        let statuses = self.engine_statuses.read().await;
        statuses.values().cloned().collect()
    }

    /// Set engine configuration
    pub async fn set_engine_config(&self, engine_type: EngineType, config: EngineConfig) {
        let mut configs = self.engine_configs.write().await;
        configs.insert(engine_type, config.clone());

        // Update Claude manager if it's Claude config
        if engine_type == EngineType::Claude {
            self.claude_manager.set_config(config).await;
        }
    }

    /// Get engine configuration
    pub async fn get_engine_config(&self, engine_type: EngineType) -> Option<EngineConfig> {
        let configs = self.engine_configs.read().await;
        configs.get(&engine_type).cloned()
    }

    pub(crate) async fn set_qoder_distribution_settings(
        &self,
        settings: QoderDistributionSettings,
    ) {
        *self.qoder_distribution_settings.write().await = settings;
    }

    pub(crate) async fn qoder_distribution_settings(&self) -> QoderDistributionSettings {
        self.qoder_distribution_settings.read().await.clone()
    }

    // ==================== Claude Session Management ====================

    /// Get or create a Claude session for a workspace
    pub async fn get_claude_session(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Arc<ClaudeSession> {
        self.claude_manager
            .get_or_create_session(workspace_id, workspace_path)
            .await
    }

    pub async fn get_claude_session_for_provider(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        provider_profile_id: Option<&str>,
    ) -> Arc<ClaudeSession> {
        self.claude_manager
            .get_or_create_session_for_provider(workspace_id, workspace_path, provider_profile_id)
            .await
    }

    /// Remove a Claude session
    pub async fn remove_claude_session(&self, workspace_id: &str) {
        for (runtime_key, session) in self
            .claude_manager
            .runtime_sessions_for_workspace(workspace_id)
            .await
        {
            if let Err(error) = session.interrupt().await {
                log::warn!(
                    "[engine_manager] failed to interrupt claude session during remove (workspace={}): {}",
                    workspace_id,
                    error
                );
                continue;
            }
            session.mark_disposed();
            self.claude_manager
                .remove_runtime_session(&runtime_key)
                .await;
        }
    }

    /// The GUI runtime no longer tracks Codex adapters locally. Keep cleanup callers stable.
    pub async fn remove_codex_adapter(&self, _workspace_id: &str) {}

    // ==================== OpenCode Session Management ====================

    /// Get or create an OpenCode session for a workspace
    pub async fn get_or_create_opencode_session(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Arc<OpenCodeSession> {
        self.get_or_create_opencode_session_for_runtime(
            workspace_id,
            workspace_path,
            workspace_id,
            None,
        )
        .await
    }

    /// Get or create an OpenCode session isolated by provider runtime key.
    pub async fn get_or_create_opencode_session_for_runtime(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        runtime_key: &str,
        provider_config_content: Option<String>,
    ) -> Arc<OpenCodeSession> {
        {
            let sessions = self.opencode_sessions.lock().await;
            if let Some(entry) = sessions.get(runtime_key) {
                return entry.session.clone();
            }
        }

        let config = self.get_engine_config(EngineType::OpenCode).await;
        let session = Arc::new(OpenCodeSession::new(
            workspace_id.to_string(),
            workspace_path.to_path_buf(),
            config,
            provider_config_content,
        ));
        let mut sessions = self.opencode_sessions.lock().await;
        if let Some(entry) = sessions.get(runtime_key) {
            return entry.session.clone();
        }
        sessions.insert(
            runtime_key.to_string(),
            OpenCodeSessionEntry {
                workspace_id: workspace_id.to_string(),
                session: session.clone(),
            },
        );
        session
    }

    /// Get OpenCode session by workspace
    pub async fn get_opencode_session(&self, workspace_id: &str) -> Option<Arc<OpenCodeSession>> {
        let sessions = self.opencode_sessions.lock().await;
        sessions
            .values()
            .find(|entry| entry.workspace_id == workspace_id)
            .map(|entry| entry.session.clone())
    }

    pub async fn get_opencode_session_for_runtime(
        &self,
        runtime_key: &str,
    ) -> Option<Arc<OpenCodeSession>> {
        self.opencode_sessions
            .lock()
            .await
            .get(runtime_key)
            .map(|entry| entry.session.clone())
    }

    /// Snapshot all OpenCode sessions owned by a workspace.
    pub async fn get_opencode_sessions(&self, workspace_id: &str) -> Vec<Arc<OpenCodeSession>> {
        let sessions = self.opencode_sessions.lock().await;
        sessions
            .values()
            .filter(|entry| entry.workspace_id == workspace_id)
            .map(|entry| entry.session.clone())
            .collect()
    }

    /// Interrupt all provider-scoped OpenCode runtimes owned by a workspace.
    pub async fn interrupt_opencode_sessions(
        &self,
        workspace_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), String> {
        let sessions = self.get_opencode_sessions(workspace_id).await;
        let mut errors = Vec::new();
        for session in sessions {
            let result = match turn_id {
                Some(turn_id) => session.interrupt_turn(turn_id).await,
                None => session.interrupt().await,
            };
            if let Err(error) = result {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "failed to interrupt {} OpenCode runtime(s): {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }

    /// Stop and remove all OpenCode runtimes for a workspace (best effort).
    pub async fn remove_opencode_session(&self, workspace_id: &str) {
        let candidates = {
            let sessions = self.opencode_sessions.lock().await;
            sessions
                .iter()
                .filter(|(_, entry)| entry.workspace_id == workspace_id)
                .map(|(runtime_key, entry)| (runtime_key.clone(), entry.session.clone()))
                .collect::<Vec<_>>()
        };
        let mut completed = Vec::new();
        for (runtime_key, session) in candidates {
            match session.interrupt().await {
                Ok(()) => completed.push(runtime_key),
                Err(error) => {
                    log::warn!(
                        "[engine_manager] failed to stop OpenCode runtime {} for workspace {}: {}",
                        runtime_key,
                        workspace_id,
                        error
                    );
                }
            }
        }
        let mut sessions = self.opencode_sessions.lock().await;
        for runtime_key in completed {
            sessions.remove(&runtime_key);
        }
    }

    // ==================== Gemini Session Management ====================

    /// Get or create a Gemini session for a workspace
    pub async fn get_or_create_gemini_session(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Result<Arc<GeminiSession>, String> {
        {
            let registry = self.gemini_sessions.lock().await;
            if registry.shutting_down {
                return Err("Gemini session manager is shutting down".to_string());
            }
            if registry.removed_workspaces.contains(workspace_id) {
                return Err(format!(
                    "Gemini session owner is unavailable for removed workspace: {workspace_id}"
                ));
            }
            if let Some(session) = registry.sessions.get(workspace_id) {
                return Ok(session.clone());
            }
        }

        let config = self.get_engine_config(EngineType::Gemini).await;
        let mut registry = self.gemini_sessions.lock().await;
        if registry.shutting_down {
            return Err("Gemini session manager is shutting down".to_string());
        }
        if registry.removed_workspaces.contains(workspace_id) {
            return Err(format!(
                "Gemini session owner is unavailable for removed workspace: {workspace_id}"
            ));
        }
        if let Some(session) = registry.sessions.get(workspace_id) {
            return Ok(session.clone());
        }
        let session = Arc::new(GeminiSession::new(
            workspace_id.to_string(),
            workspace_path.to_path_buf(),
            config,
        ));
        registry
            .sessions
            .insert(workspace_id.to_string(), session.clone());
        Ok(session)
    }

    /// Get Gemini session by workspace
    pub async fn get_gemini_session(&self, workspace_id: &str) -> Option<Arc<GeminiSession>> {
        let registry = self.gemini_sessions.lock().await;
        registry.sessions.get(workspace_id).cloned()
    }

    /// Snapshot all tracked OpenCode sessions.
    pub async fn list_opencode_sessions(&self) -> Vec<(String, Arc<OpenCodeSession>)> {
        let sessions = self.opencode_sessions.lock().await;
        sessions
            .values()
            .map(|entry| (entry.workspace_id.clone(), entry.session.clone()))
            .collect()
    }

    /// Snapshot all tracked Gemini sessions.
    pub async fn list_gemini_sessions(&self) -> Vec<(String, Arc<GeminiSession>)> {
        let registry = self.gemini_sessions.lock().await;
        registry
            .sessions
            .iter()
            .map(|(workspace_id, session)| (workspace_id.clone(), session.clone()))
            .collect()
    }
    /// Remove a Gemini session
    pub async fn remove_gemini_session(&self, workspace_id: &str) -> Result<(), String> {
        let session = {
            let mut registry = self.gemini_sessions.lock().await;
            if registry.shutting_down {
                return Err("Gemini session manager is shutting down".to_string());
            }
            registry.removed_workspaces.insert(workspace_id.into());
            registry.sessions.get(workspace_id).cloned()
        };
        let Some(session) = session else {
            return Ok(());
        };
        session.close().await.map_err(|error| {
            format!("failed to close Gemini session for workspace {workspace_id}: {error}")
        })?;

        let mut registry = self.gemini_sessions.lock().await;
        let should_remove = registry
            .sessions
            .get(workspace_id)
            .is_some_and(|current| Arc::ptr_eq(current, &session));
        if should_remove {
            registry.sessions.remove(workspace_id);
        }
        Ok(())
    }

    /// Drain and terminate all Gemini sessions during host shutdown.
    pub async fn shutdown_gemini_sessions(&self) -> Result<(), String> {
        let sessions = {
            let mut registry = self.gemini_sessions.lock().await;
            registry.shutting_down = true;
            registry
                .sessions
                .iter()
                .map(|(workspace_id, session)| (workspace_id.clone(), Arc::clone(session)))
                .collect::<Vec<_>>()
        };
        let mut cleanup_errors = Vec::new();
        for (workspace_id, session) in sessions {
            if let Err(error) = session.close().await {
                cleanup_errors.push(format!("{workspace_id}: {error}"));
                continue;
            }
            let mut registry = self.gemini_sessions.lock().await;
            let should_remove = registry
                .sessions
                .get(&workspace_id)
                .is_some_and(|current| Arc::ptr_eq(current, &session));
            if should_remove {
                registry.sessions.remove(&workspace_id);
            }
        }
        if cleanup_errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "failed to close {} Gemini session(s): {}",
                cleanup_errors.len(),
                cleanup_errors.join("; ")
            ))
        }
    }

    // ==================== Kimi Session Management ====================

    /// Get or create a Kimi session for a workspace
    pub async fn get_or_create_kimi_session(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Arc<KimiSession> {
        self.get_or_create_kimi_session_for_runtime(
            workspace_id,
            workspace_path,
            workspace_id,
            None,
        )
        .await
    }

    /// Get or create a Kimi session isolated by provider runtime key.
    pub async fn get_or_create_kimi_session_for_runtime(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        runtime_key: &str,
        home_dir: Option<&Path>,
    ) -> Arc<KimiSession> {
        {
            let sessions = self.kimi_sessions.lock().await;
            if let Some(entry) = sessions.get(runtime_key) {
                return entry.session.clone();
            }
        }

        let config =
            kimi_engine_config_with_home(self.get_engine_config(EngineType::Kimi).await, home_dir);
        let session = Arc::new(KimiSession::new(
            workspace_id.to_string(),
            workspace_path.to_path_buf(),
            config,
        ));
        let mut sessions = self.kimi_sessions.lock().await;
        if let Some(entry) = sessions.get(runtime_key) {
            return entry.session.clone();
        }
        sessions.insert(
            runtime_key.to_string(),
            KimiSessionEntry {
                workspace_id: workspace_id.to_string(),
                session: session.clone(),
            },
        );
        session
    }

    /// Get Kimi session by workspace
    pub async fn get_kimi_session(&self, workspace_id: &str) -> Option<Arc<KimiSession>> {
        let sessions = self.kimi_sessions.lock().await;
        sessions
            .values()
            .find(|entry| entry.workspace_id == workspace_id)
            .map(|entry| entry.session.clone())
    }

    pub async fn get_kimi_session_for_runtime(
        &self,
        runtime_key: &str,
    ) -> Option<Arc<KimiSession>> {
        self.kimi_sessions
            .lock()
            .await
            .get(runtime_key)
            .map(|entry| entry.session.clone())
    }

    /// Snapshot all Kimi sessions owned by a workspace.
    pub async fn get_kimi_sessions(&self, workspace_id: &str) -> Vec<Arc<KimiSession>> {
        let sessions = self.kimi_sessions.lock().await;
        sessions
            .values()
            .filter(|entry| entry.workspace_id == workspace_id)
            .map(|entry| entry.session.clone())
            .collect()
    }

    /// Interrupt all provider-scoped Kimi runtimes owned by a workspace.
    pub async fn interrupt_kimi_sessions(
        &self,
        workspace_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), String> {
        let sessions = self.get_kimi_sessions(workspace_id).await;
        let mut errors = Vec::new();
        for session in sessions {
            let result = match turn_id {
                Some(turn_id) => session.interrupt_turn(turn_id).await,
                None => session.interrupt().await,
            };
            if let Err(error) = result {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "failed to interrupt {} Kimi runtime(s): {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }

    pub async fn get_or_create_pi_session_for_runtime(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        runtime_key: &str,
        home_dir: Option<&Path>,
    ) -> Arc<PiSession> {
        {
            let sessions = self.pi_sessions.lock().await;
            if let Some(entry) = sessions.get(runtime_key) {
                return entry.session.clone();
            }
        }
        let config =
            pi_engine_config_with_home(self.get_engine_config(EngineType::Pi).await, home_dir);
        let session = Arc::new(PiSession::new(
            workspace_id.to_string(),
            workspace_path.to_path_buf(),
            config,
        ));
        let mut sessions = self.pi_sessions.lock().await;
        if let Some(entry) = sessions.get(runtime_key) {
            return entry.session.clone();
        }
        sessions.insert(
            runtime_key.to_string(),
            PiSessionEntry {
                workspace_id: workspace_id.to_string(),
                session: session.clone(),
            },
        );
        session
    }

    pub async fn get_pi_session(&self, workspace_id: &str) -> Option<Arc<PiSession>> {
        let sessions = self.pi_sessions.lock().await;
        sessions
            .values()
            .find(|entry| entry.workspace_id == workspace_id)
            .map(|entry| entry.session.clone())
    }

    pub async fn get_pi_session_for_runtime(&self, runtime_key: &str) -> Option<Arc<PiSession>> {
        self.pi_sessions
            .lock()
            .await
            .get(runtime_key)
            .map(|entry| entry.session.clone())
    }

    pub async fn get_pi_sessions(&self, workspace_id: &str) -> Vec<Arc<PiSession>> {
        let sessions = self.pi_sessions.lock().await;
        sessions
            .values()
            .filter(|entry| entry.workspace_id == workspace_id)
            .map(|entry| entry.session.clone())
            .collect()
    }

    pub async fn interrupt_pi_sessions(
        &self,
        workspace_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), String> {
        let sessions = self.get_pi_sessions(workspace_id).await;
        let mut errors = Vec::new();
        for session in sessions {
            let result = match turn_id {
                Some(turn_id) => session.interrupt_turn(turn_id).await,
                None => session.interrupt().await,
            };
            if let Err(error) = result {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "failed to interrupt {} PI runtime(s): {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }

    pub async fn drop_pi_resident_by_session_id(&self, session_id: &str) {
        let sessions = self.pi_sessions.lock().await;
        for entry in sessions.values() {
            entry.session.drop_resident(session_id).await;
        }
    }

    pub async fn get_or_create_qoder_session_for_runtime(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        launch_profile: &QoderProviderLaunchProfile,
    ) -> Arc<QoderSession> {
        {
            let sessions = self.qoder_sessions.lock().await;
            if let Some(entry) = sessions.get(&launch_profile.runtime_key) {
                return entry.session.clone();
            }
        }
        let config = qoder_engine_config_with_launch_profile(
            self.get_engine_config(EngineType::Qoder).await,
            launch_profile,
        );
        let session = Arc::new(QoderSession::new_with_distribution(
            workspace_id.to_string(),
            workspace_path.to_path_buf(),
            config,
            launch_profile.distribution,
        ));
        let mut sessions = self.qoder_sessions.lock().await;
        if let Some(entry) = sessions.get(&launch_profile.runtime_key) {
            return entry.session.clone();
        }
        sessions.insert(
            launch_profile.runtime_key.clone(),
            QoderSessionEntry {
                workspace_id: workspace_id.to_string(),
                session: session.clone(),
            },
        );
        session
    }

    #[allow(dead_code)]
    pub async fn get_qoder_session(&self, workspace_id: &str) -> Option<Arc<QoderSession>> {
        let sessions = self.qoder_sessions.lock().await;
        sessions
            .values()
            .find(|entry| entry.workspace_id == workspace_id)
            .map(|entry| entry.session.clone())
    }

    pub async fn get_qoder_session_for_runtime(
        &self,
        runtime_key: &str,
    ) -> Option<Arc<QoderSession>> {
        self.qoder_sessions
            .lock()
            .await
            .get(runtime_key)
            .map(|entry| entry.session.clone())
    }

    pub async fn get_qoder_sessions(&self, workspace_id: &str) -> Vec<Arc<QoderSession>> {
        let sessions = self.qoder_sessions.lock().await;
        sessions
            .values()
            .filter(|entry| entry.workspace_id == workspace_id)
            .map(|entry| entry.session.clone())
            .collect()
    }

    pub async fn interrupt_qoder_sessions(
        &self,
        workspace_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), String> {
        let sessions = self.get_qoder_sessions(workspace_id).await;
        let mut errors = Vec::new();
        for session in sessions {
            let result = match turn_id {
                Some(turn_id) => session.interrupt_turn(turn_id).await,
                None => session.interrupt().await,
            };
            if let Err(error) = result {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "failed to interrupt {} Qoder runtime(s): {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }

    /// Interrupt only one Qoder distribution runtime. `provider_profile_id`
    /// may be legacy/empty (which resolves to Global), but never falls through
    /// to the sibling CN/Global session.
    pub async fn interrupt_qoder_session_for_profile(
        &self,
        workspace_id: &str,
        provider_profile_id: Option<&str>,
        turn_id: Option<&str>,
    ) -> Result<(), String> {
        let runtime_key = crate::engine::qoder_provider_profile::qoder_runtime_key(
            workspace_id,
            provider_profile_id,
        )?;
        let Some(session) = self.get_qoder_session_for_runtime(&runtime_key).await else {
            return Ok(());
        };
        match turn_id {
            Some(turn_id) => session.interrupt_turn(turn_id).await,
            None => session.interrupt().await,
        }
    }

    /// Snapshot all tracked Kimi sessions.
    pub async fn list_kimi_sessions(&self) -> Vec<(String, Arc<KimiSession>)> {
        let sessions = self.kimi_sessions.lock().await;
        sessions
            .values()
            .map(|entry| (entry.workspace_id.clone(), entry.session.clone()))
            .collect()
    }

    /// Stop and remove all Kimi runtimes for a workspace. Failed owners stay tracked.
    pub async fn remove_kimi_session(&self, workspace_id: &str) -> Result<(), String> {
        let candidates = {
            let sessions = self.kimi_sessions.lock().await;
            sessions
                .iter()
                .filter(|(_, entry)| entry.workspace_id == workspace_id)
                .map(|(runtime_key, entry)| (runtime_key.clone(), entry.session.clone()))
                .collect::<Vec<_>>()
        };
        let mut completed = Vec::new();
        let mut errors = Vec::new();
        for (runtime_key, session) in candidates {
            match session.interrupt().await {
                Ok(()) => completed.push(runtime_key),
                Err(error) => errors.push(error),
            }
        }
        let mut sessions = self.kimi_sessions.lock().await;
        for runtime_key in completed {
            sessions.remove(&runtime_key);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "failed to close {} Kimi runtime(s): {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }

    /// Stop all provider-scoped Kimi runtimes during host shutdown.
    pub async fn shutdown_kimi_sessions(&self) -> Result<(), String> {
        let workspace_ids = {
            let sessions = self.kimi_sessions.lock().await;
            sessions
                .values()
                .map(|entry| entry.workspace_id.clone())
                .collect::<HashSet<_>>()
        };
        let mut errors = Vec::new();
        for workspace_id in workspace_ids {
            if let Err(error) = self.remove_kimi_session(&workspace_id).await {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    // ==================== Grok Session Management ====================

    /// Get or create a Grok session for a workspace
    pub async fn get_or_create_grok_session(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Arc<GrokSession> {
        self.get_or_create_grok_session_for_runtime(
            workspace_id,
            workspace_path,
            workspace_id,
            None,
        )
        .await
    }

    /// Get or create a Grok session isolated by provider runtime key.
    pub async fn get_or_create_grok_session_for_runtime(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        runtime_key: &str,
        home_dir: Option<&Path>,
    ) -> Arc<GrokSession> {
        {
            let sessions = self.grok_sessions.lock().await;
            if let Some(entry) = sessions.get(runtime_key) {
                return entry.session.clone();
            }
        }

        let config =
            grok_engine_config_with_home(self.get_engine_config(EngineType::Grok).await, home_dir);
        let session = Arc::new(GrokSession::new(
            workspace_id.to_string(),
            workspace_path.to_path_buf(),
            config,
        ));
        let mut sessions = self.grok_sessions.lock().await;
        if let Some(entry) = sessions.get(runtime_key) {
            return entry.session.clone();
        }
        sessions.insert(
            runtime_key.to_string(),
            GrokSessionEntry {
                workspace_id: workspace_id.to_string(),
                session: session.clone(),
            },
        );
        session
    }

    /// Get Grok session by workspace
    pub async fn get_grok_session(&self, workspace_id: &str) -> Option<Arc<GrokSession>> {
        let sessions = self.grok_sessions.lock().await;
        sessions
            .values()
            .find(|entry| entry.workspace_id == workspace_id)
            .map(|entry| entry.session.clone())
    }

    pub async fn get_grok_session_for_runtime(
        &self,
        runtime_key: &str,
    ) -> Option<Arc<GrokSession>> {
        self.grok_sessions
            .lock()
            .await
            .get(runtime_key)
            .map(|entry| entry.session.clone())
    }

    /// Snapshot all Grok sessions owned by a workspace.
    pub async fn get_grok_sessions(&self, workspace_id: &str) -> Vec<Arc<GrokSession>> {
        let sessions = self.grok_sessions.lock().await;
        sessions
            .values()
            .filter(|entry| entry.workspace_id == workspace_id)
            .map(|entry| entry.session.clone())
            .collect()
    }

    /// Interrupt all provider-scoped Grok runtimes owned by a workspace.
    pub async fn interrupt_grok_sessions(
        &self,
        workspace_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), String> {
        let sessions = self.get_grok_sessions(workspace_id).await;
        let mut errors = Vec::new();
        for session in sessions {
            let result = match turn_id {
                Some(turn_id) => session.interrupt_turn(turn_id).await,
                None => session.interrupt().await,
            };
            if let Err(error) = result {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "failed to interrupt {} Grok runtime(s): {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }

    /// Snapshot all tracked Grok sessions.
    pub async fn list_grok_sessions(&self) -> Vec<(String, Arc<GrokSession>)> {
        let sessions = self.grok_sessions.lock().await;
        sessions
            .values()
            .map(|entry| (entry.workspace_id.clone(), entry.session.clone()))
            .collect()
    }

    /// Stop and remove all Grok runtimes for a workspace. Failed owners stay tracked.
    pub async fn remove_grok_session(&self, workspace_id: &str) -> Result<(), String> {
        let candidates = {
            let sessions = self.grok_sessions.lock().await;
            sessions
                .iter()
                .filter(|(_, entry)| entry.workspace_id == workspace_id)
                .map(|(runtime_key, entry)| (runtime_key.clone(), entry.session.clone()))
                .collect::<Vec<_>>()
        };
        let mut completed = Vec::new();
        let mut errors = Vec::new();
        for (runtime_key, session) in candidates {
            match session.interrupt().await {
                Ok(()) => completed.push(runtime_key),
                Err(error) => errors.push(error),
            }
        }
        let mut sessions = self.grok_sessions.lock().await;
        for runtime_key in completed {
            sessions.remove(&runtime_key);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "failed to close {} Grok runtime(s): {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }

    /// Stop all provider-scoped Grok runtimes during host shutdown.
    pub async fn shutdown_grok_sessions(&self) -> Result<(), String> {
        let workspace_ids = {
            let sessions = self.grok_sessions.lock().await;
            sessions
                .values()
                .map(|entry| entry.workspace_id.clone())
                .collect::<HashSet<_>>()
        };
        let mut errors = Vec::new();
        for workspace_id in workspace_ids {
            if let Err(error) = self.remove_grok_session(&workspace_id).await {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    // ==================== Utility Methods ====================

    /// Check if an engine is available (installed and ready)
    pub async fn is_engine_available(&self, engine_type: EngineType) -> bool {
        if let Some(status) = self.get_engine_status(engine_type).await {
            status.installed
        } else {
            let status = self.detect_single_engine(engine_type).await;
            status.installed
        }
    }

    /// Get list of available (installed) engines
    pub async fn get_available_engines(&self) -> Vec<EngineType> {
        let statuses = self.engine_statuses.read().await;
        statuses
            .iter()
            .filter(|(_, status)| status.installed)
            .map(|(engine_type, _)| *engine_type)
            .collect()
    }
}

impl Default for EngineManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn default_engine_is_claude() {
        let manager = EngineManager::new();
        assert_eq!(manager.get_active_engine().await, EngineType::Claude);
    }

    #[tokio::test]
    async fn engine_config_storage() {
        let manager = EngineManager::new();

        let config = EngineConfig {
            bin_path: Some("/custom/claude".to_string()),
            ..Default::default()
        };

        manager
            .set_engine_config(EngineType::Claude, config.clone())
            .await;

        let retrieved = manager.get_engine_config(EngineType::Claude).await;
        assert!(retrieved.is_some());
        assert_eq!(
            retrieved.unwrap().bin_path,
            Some("/custom/claude".to_string())
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_gemini_creation_returns_single_owned_session() {
        const CALLER_COUNT: usize = 32;

        let manager = Arc::new(EngineManager::new());
        let workspace_path = Arc::new(std::env::temp_dir().join(format!(
            "ccgui-concurrent-gemini-session-{}",
            std::process::id()
        )));
        let start = Arc::new(tokio::sync::Barrier::new(CALLER_COUNT + 1));
        let config_guard = manager.engine_configs.write().await;
        let mut callers = Vec::with_capacity(CALLER_COUNT);

        for _ in 0..CALLER_COUNT {
            let manager = Arc::clone(&manager);
            let workspace_path = Arc::clone(&workspace_path);
            let start = Arc::clone(&start);
            callers.push(tokio::spawn(async move {
                start.wait().await;
                manager
                    .get_or_create_gemini_session("shared-workspace", workspace_path.as_path())
                    .await
                    .expect("concurrent Gemini creation should stay available")
            }));
        }

        start.wait().await;
        for _ in 0..CALLER_COUNT {
            tokio::task::yield_now().await;
        }
        drop(config_guard);

        let mut returned_sessions = Vec::with_capacity(CALLER_COUNT);
        for caller in callers {
            returned_sessions.push(caller.await.expect("Gemini session caller should join"));
        }
        let first = returned_sessions
            .first()
            .expect("at least one Gemini session");
        assert!(returned_sessions
            .iter()
            .all(|session| Arc::ptr_eq(first, session)));

        let tracked = manager
            .get_gemini_session("shared-workspace")
            .await
            .expect("manager should track the shared Gemini session");
        assert!(Arc::ptr_eq(first, &tracked));
        assert_eq!(manager.list_gemini_sessions().await.len(), 1);
    }

    #[tokio::test]
    async fn repeated_remove_retries_session_retained_behind_tombstone() {
        let manager = EngineManager::new();
        let workspace_path =
            std::env::temp_dir().join(format!("ccgui-gemini-remove-retry-{}", std::process::id()));
        manager
            .get_or_create_gemini_session("remove-retry", &workspace_path)
            .await
            .expect("create initial Gemini session");
        manager
            .remove_gemini_session("remove-retry")
            .await
            .expect("remove initial Gemini session");

        let retained_session = Arc::new(GeminiSession::new(
            "remove-retry".to_string(),
            workspace_path.clone(),
            None,
        ));
        manager
            .gemini_sessions
            .lock()
            .await
            .sessions
            .insert("remove-retry".to_string(), retained_session);

        manager
            .remove_gemini_session("remove-retry")
            .await
            .expect("retry retained Gemini session removal");

        assert!(manager.get_gemini_session("remove-retry").await.is_none());
        assert!(manager
            .get_or_create_gemini_session("remove-retry", &workspace_path)
            .await
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_enabled_bulk_detection_does_not_spawn_configured_gemini_cli() {
        use std::os::unix::fs::PermissionsExt;

        let manager = EngineManager::new();
        let test_dir = std::env::temp_dir().join(format!(
            "ccgui-gemini-detection-policy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&test_dir).expect("create detection policy test directory");
        let script_path = test_dir.join("fake-gemini");
        let marker_path = test_dir.join("spawned");
        std::fs::write(
            &script_path,
            format!("#!/bin/sh\nprintf spawned > '{}'\n", marker_path.display()),
        )
        .expect("write fake Gemini CLI");
        let mut permissions = std::fs::metadata(&script_path)
            .expect("read fake Gemini CLI metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script_path, permissions)
            .expect("make fake Gemini CLI executable");
        manager
            .set_engine_config(
                EngineType::Gemini,
                EngineConfig {
                    bin_path: Some(script_path.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await;

        let statuses = manager.detect_engines_with_gates(true, &[], None).await;
        let status = statuses
            .iter()
            .find(|status| status.engine_type == EngineType::Gemini)
            .expect("bulk detection should include disabled Gemini status");

        assert!(!status.installed);
        assert_eq!(
            status.error.as_deref(),
            Some(crate::engine_policy::GEMINI_DISABLED_DIAGNOSTIC)
        );
        assert!(
            !marker_path.exists(),
            "disabled Gemini detection must not spawn"
        );
        let _ = std::fs::remove_dir_all(test_dir);
    }

    #[tokio::test]
    async fn gated_refresh_returns_disabled_status_for_disabled_optional_engine() {
        let manager = EngineManager::new();

        let status = manager
            .refresh_engine_status_with_gates(EngineType::Gemini, false)
            .await;

        assert_eq!(status.engine_type, EngineType::Gemini);
        assert!(!status.installed);
        assert_eq!(
            status.error.as_deref(),
            Some(crate::engine_policy::GEMINI_DISABLED_DIAGNOSTIC)
        );

        let cached = manager
            .get_engine_status(EngineType::Gemini)
            .await
            .expect("status should be cached");
        assert_eq!(
            cached.error.as_deref(),
            Some(crate::engine_policy::GEMINI_DISABLED_DIAGNOSTIC)
        );
    }

    #[tokio::test]
    async fn kimi_sessions_are_reused_per_runtime_and_isolated_between_providers() {
        let manager = EngineManager::new();
        let workspace_path = std::env::temp_dir().join("mossx-kimi-runtime-isolation");
        let first = manager
            .get_or_create_kimi_session_for_runtime(
                "workspace-1",
                &workspace_path,
                "kimi::workspace-1::provider-a",
                Some(&workspace_path.join("provider-a")),
            )
            .await;
        let reused = manager
            .get_or_create_kimi_session_for_runtime(
                "workspace-1",
                &workspace_path,
                "kimi::workspace-1::provider-a",
                Some(&workspace_path.join("provider-a")),
            )
            .await;
        let isolated = manager
            .get_or_create_kimi_session_for_runtime(
                "workspace-1",
                &workspace_path,
                "kimi::workspace-1::provider-b",
                Some(&workspace_path.join("provider-b")),
            )
            .await;

        assert!(Arc::ptr_eq(&first, &reused));
        assert!(!Arc::ptr_eq(&first, &isolated));
        assert_eq!(manager.get_kimi_sessions("workspace-1").await.len(), 2);
        manager
            .remove_kimi_session("workspace-1")
            .await
            .expect("remove Kimi runtimes");
        assert!(manager.get_kimi_sessions("workspace-1").await.is_empty());
    }

    #[test]
    fn kimi_provider_home_flows_into_engine_config() {
        let home = Path::new("/tmp/mossx-kimi-provider-a");
        let config = kimi_engine_config_with_home(None, Some(home)).expect("Kimi config");
        assert_eq!(
            config.home_dir.as_deref(),
            Some(home.to_string_lossy().as_ref())
        );
    }

    #[tokio::test]
    async fn grok_sessions_are_reused_per_runtime_and_isolated_between_providers() {
        let manager = EngineManager::new();
        let workspace_path = std::env::temp_dir().join("ccgui-grok-runtime-isolation");
        let first = manager
            .get_or_create_grok_session_for_runtime(
                "workspace-1",
                &workspace_path,
                "grok::workspace-1::provider-a",
                Some(&workspace_path.join("provider-a")),
            )
            .await;
        let reused = manager
            .get_or_create_grok_session_for_runtime(
                "workspace-1",
                &workspace_path,
                "grok::workspace-1::provider-a",
                Some(&workspace_path.join("provider-a")),
            )
            .await;
        let isolated = manager
            .get_or_create_grok_session_for_runtime(
                "workspace-1",
                &workspace_path,
                "grok::workspace-1::provider-b",
                Some(&workspace_path.join("provider-b")),
            )
            .await;

        assert!(Arc::ptr_eq(&first, &reused));
        assert!(!Arc::ptr_eq(&first, &isolated));
        assert_eq!(manager.get_grok_sessions("workspace-1").await.len(), 2);
        manager
            .remove_grok_session("workspace-1")
            .await
            .expect("remove Grok runtimes");
        assert!(manager.get_grok_sessions("workspace-1").await.is_empty());
    }

    #[test]
    fn grok_provider_home_flows_into_engine_config() {
        let home = Path::new("/tmp/ccgui-grok-provider-a");
        let config = grok_engine_config_with_home(None, Some(home)).expect("Grok config");
        assert_eq!(
            config.home_dir.as_deref(),
            Some(home.to_string_lossy().as_ref())
        );
    }
    // ==================== B3 检测缓存与 last-good ====================

    fn b3_status(engine_type: EngineType, installed: bool, version: Option<&str>) -> EngineStatus {
        let mut status = disabled_engine_status(engine_type);
        status.installed = installed;
        status.version = version.map(str::to_string);
        status
    }

    #[test]
    fn poison_guard_preserves_installed_last_good_on_probe_failure() {
        let previous = b3_status(EngineType::Kimi, true, Some("1.0.0"));
        let mut fresh = b3_status(EngineType::Kimi, false, None);
        fresh.error = Some("engine detection task failed: panicked".to_string());

        let merged = merge_with_poison_guard(Some(&previous), fresh);
        assert!(
            merged.installed,
            "probe failure must not overwrite installed last-good"
        );
        assert_eq!(merged.version.as_deref(), Some("1.0.0"));
        assert!(
            merged
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("engine detection task failed"),
            "failure annotation must be merged in"
        );
    }

    #[test]
    fn poison_guard_propagates_legitimate_uninstall() {
        let previous = b3_status(EngineType::Kimi, true, Some("1.0.0"));
        let mut fresh = b3_status(EngineType::Kimi, false, None);
        fresh.error = Some("No such file or directory (os error 2)".to_string());

        let merged = merge_with_poison_guard(Some(&previous), fresh);
        assert!(
            !merged.installed,
            "legitimate not-installed (external uninstall) must propagate"
        );
    }

    #[test]
    fn poison_guard_adopts_healthy_fresh_result() {
        let previous = b3_status(EngineType::Kimi, true, Some("0.9.0"));
        let fresh = b3_status(EngineType::Kimi, true, Some("1.2.0"));
        let merged = merge_with_poison_guard(Some(&previous), fresh);
        assert_eq!(merged.version.as_deref(), Some("1.2.0"));
    }

    #[test]
    fn engine_status_last_good_entry_round_trips() {
        let entry = EngineStatusLastGoodEntry {
            status: b3_status(EngineType::Kimi, true, Some("3.1.4")),
            detected_at_ms: 1_000,
        };
        let json = serde_json::to_string(&entry).expect("serialize entry");
        let parsed: EngineStatusLastGoodEntry =
            serde_json::from_str(&json).expect("deserialize entry");
        assert_eq!(parsed.status.version.as_deref(), Some("3.1.4"));
        assert!(parsed.status.installed);
    }

    #[tokio::test]
    async fn invalidate_engine_models_clears_catalog_keeps_entry() {
        let manager = Arc::new(EngineManager::new());
        let mut seeded = b3_status(EngineType::Pi, true, Some("1.0.0"));
        seeded.models = vec![
            crate::engine::ModelInfo::new("pi-model-a", "PI Model A"),
            crate::engine::ModelInfo::new("pi-model-b", "PI Model B"),
        ];
        seeded.default_model = Some("pi-model-a".to_string());
        manager.cache_engine_status(seeded).await;
        assert!(!manager
            .get_engine_status(EngineType::Pi)
            .await
            .unwrap()
            .models
            .is_empty());

        // 凭证写入路径依赖本失效：models 必须清空（下次目录请求强制重探），
        // 但状态条目必须保留——detect TTL 命中路径透出全量 statuses，
        // 缺条目会让引擎菜单在窗口期漏掉该引擎。
        manager.invalidate_engine_models(EngineType::Pi).await;
        let status = manager.get_engine_status(EngineType::Pi).await.unwrap();
        assert!(status.models.is_empty());
        assert!(status.default_model.is_none());
        assert_eq!(status.version.as_deref(), Some("1.0.0"));
        assert!(status.installed);
    }

    #[tokio::test]
    async fn cached_detection_serves_fresh_cache_within_ttl() {
        let manager = Arc::new(EngineManager::new());
        let seeded = b3_status(EngineType::Kimi, true, Some("2.0.0"));
        manager.cache_engine_status(seeded.clone()).await;
        manager.test_mark_detect_cache_fresh(false, &[]);

        let statuses = manager
            .detect_engines_cached(false, None, false, &[], None)
            .await;
        let kimi = statuses
            .iter()
            .find(|status| status.engine_type == EngineType::Kimi)
            .expect("kimi cached status must be served");
        assert_eq!(kimi.version.as_deref(), Some("2.0.0"));
    }

    #[tokio::test]
    async fn cached_detection_context_change_invalidates_cache() {
        let manager = Arc::new(EngineManager::new());
        manager
            .cache_engine_status(b3_status(EngineType::Kimi, true, Some("2.0.0")))
            .await;
        manager.test_mark_detect_cache_fresh(false, &[]);

        // 黑名单变化（禁用 kimi）→ 缓存上下文失配 → 不得命中 TTL 缓存分支；
        // 走 SWR/重探路径后 kimi 不应出现在结果中。
        let statuses = manager
            .detect_engines_cached(false, None, false, &[EngineType::Kimi], None)
            .await;
        assert!(
            statuses
                .iter()
                .all(|status| status.engine_type != EngineType::Kimi),
            "disabled engine must not be served from a stale cache entry"
        );
    }

    #[tokio::test]
    async fn cached_detection_serves_last_good_from_disk_before_revalidate() {
        let dir = std::env::temp_dir().join(format!(
            "ccgui-b3-last-good-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let file_path = dir.join("engine-status-last-good.json");
        let entry = EngineStatusLastGoodEntry {
            status: b3_status(EngineType::Kimi, true, Some("3.1.4")),
            detected_at_ms: crate::engine::manager::now_ms(),
        };
        let mut entries = HashMap::new();
        entries.insert("kimi".to_string(), entry);
        let file = EngineStatusLastGoodFile { entries };
        std::fs::write(
            &file_path,
            serde_json::to_string(&file).expect("serialize last good"),
        )
        .expect("write last good file");
        LAST_GOOD_PATH_OVERRIDE
            .get_or_init(|| StdMutex::new(None))
            .lock()
            .expect("lock")
            .replace(file_path.clone());

        let manager = Arc::new(EngineManager::new());
        let statuses = manager
            .detect_engines_cached(false, None, false, &[], None)
            .await;
        let kimi = statuses
            .iter()
            .find(|status| status.engine_type == EngineType::Kimi)
            .expect("last-good entry must be served immediately (SWR)");
        assert_eq!(kimi.version.as_deref(), Some("3.1.4"));
        assert!(
            kimi.installed,
            "last-good snapshot must be served before background revalidate lands"
        );

        LAST_GOOD_PATH_OVERRIDE
            .get()
            .map(|lock| lock.lock().expect("lock").take());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
