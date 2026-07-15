use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::remote_backend;
use crate::state::AppState;

const RUNTIME_TERMINAL_ID: &str = "runtime-console";
const DEFAULT_TERMINAL_COLS: u16 = 120;
const DEFAULT_TERMINAL_ROWS: u16 = 32;
const AUTO_DETECT_HELP_TEXT: &str = "No runnable profile detected. Expected one of: pom.xml/build.gradle*, package.json scripts(dev/start), manage.py/main.py/app.py, go.mod/main.go/cmd/*.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RuntimeSessionStatus {
    Idle,
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum RuntimeLauncherKind {
    MavenWrapper,
    MavenSystem,
    GradleWrapper,
    GradleSystem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RuntimeProfileId {
    JavaMaven,
    JavaGradle,
    NodeDev,
    NodeStart,
    PythonMain,
    GoRun,
}

impl RuntimeProfileId {
    fn as_str(&self) -> &'static str {
        match self {
            RuntimeProfileId::JavaMaven => "java-maven",
            RuntimeProfileId::JavaGradle => "java-gradle",
            RuntimeProfileId::NodeDev => "node-dev",
            RuntimeProfileId::NodeStart => "node-start",
            RuntimeProfileId::PythonMain => "python-main",
            RuntimeProfileId::GoRun => "go-run",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "java-maven" => Some(RuntimeProfileId::JavaMaven),
            "java-gradle" => Some(RuntimeProfileId::JavaGradle),
            "node-dev" => Some(RuntimeProfileId::NodeDev),
            "node-start" => Some(RuntimeProfileId::NodeStart),
            "python-main" => Some(RuntimeProfileId::PythonMain),
            "go-run" => Some(RuntimeProfileId::GoRun),
            _ => None,
        }
    }

    fn stack_name(&self) -> &'static str {
        match self {
            RuntimeProfileId::JavaMaven | RuntimeProfileId::JavaGradle => "java",
            RuntimeProfileId::NodeDev | RuntimeProfileId::NodeStart => "node",
            RuntimeProfileId::PythonMain => "python",
            RuntimeProfileId::GoRun => "go",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeProfileDescriptor {
    pub(crate) id: String,
    pub(crate) default_command: String,
    pub(crate) detected_stack: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeLaunchCommand {
    pub(crate) kind: RuntimeLauncherKind,
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeSessionRecord {
    pub(crate) workspace_id: String,
    pub(crate) terminal_id: String,
    pub(crate) status: RuntimeSessionStatus,
    pub(crate) command_preview: Option<String>,
    pub(crate) profile_id: Option<String>,
    pub(crate) detected_stack: Option<String>,
    pub(crate) started_at_ms: Option<u64>,
    pub(crate) stopped_at_ms: Option<u64>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSessionSnapshot {
    pub(crate) workspace_id: String,
    pub(crate) terminal_id: String,
    pub(crate) status: RuntimeSessionStatus,
    pub(crate) command_preview: Option<String>,
    pub(crate) profile_id: Option<String>,
    pub(crate) detected_stack: Option<String>,
    pub(crate) started_at_ms: Option<u64>,
    pub(crate) stopped_at_ms: Option<u64>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) error: Option<String>,
}

impl RuntimeSessionRecord {
    fn to_snapshot(&self) -> RuntimeSessionSnapshot {
        RuntimeSessionSnapshot {
            workspace_id: self.workspace_id.clone(),
            terminal_id: self.terminal_id.clone(),
            status: self.status.clone(),
            command_preview: self.command_preview.clone(),
            profile_id: self.profile_id.clone(),
            detected_stack: self.detected_stack.clone(),
            started_at_ms: self.started_at_ms,
            stopped_at_ms: self.stopped_at_ms,
            exit_code: self.exit_code,
            error: self.error.clone(),
        }
    }
}

fn has(entries: &HashSet<&str>, name: &str) -> bool {
    entries.contains(name)
}

fn has_entry(entries: &HashSet<String>, name: &str) -> bool {
    entries.contains(name)
}

pub(crate) fn detect_java_launcher(entries: &[String]) -> Option<RuntimeLaunchCommand> {
    let by_name: HashSet<&str> = entries
        .iter()
        .filter_map(|item| item.rsplit(['/', '\\']).next())
        .collect();

    #[cfg(windows)]
    if has(&by_name, "mvnw.cmd") && has(&by_name, "pom.xml") {
        return Some(RuntimeLaunchCommand {
            kind: RuntimeLauncherKind::MavenWrapper,
            program: "mvnw.cmd".to_string(),
            args: vec!["spring-boot:run".to_string()],
        });
    }

    #[cfg(not(windows))]
    if has(&by_name, "mvnw") && has(&by_name, "pom.xml") {
        return Some(RuntimeLaunchCommand {
            kind: RuntimeLauncherKind::MavenWrapper,
            program: "./mvnw".to_string(),
            args: vec!["spring-boot:run".to_string()],
        });
    }
    if has(&by_name, "pom.xml") {
        return Some(RuntimeLaunchCommand {
            kind: RuntimeLauncherKind::MavenSystem,
            program: "mvn".to_string(),
            args: vec!["spring-boot:run".to_string()],
        });
    }
    #[cfg(windows)]
    if has(&by_name, "gradlew.bat")
        && (has(&by_name, "build.gradle") || has(&by_name, "build.gradle.kts"))
    {
        return Some(RuntimeLaunchCommand {
            kind: RuntimeLauncherKind::GradleWrapper,
            program: "gradlew.bat".to_string(),
            args: vec!["bootRun".to_string()],
        });
    }
    #[cfg(not(windows))]
    if has(&by_name, "gradlew")
        && (has(&by_name, "build.gradle") || has(&by_name, "build.gradle.kts"))
    {
        return Some(RuntimeLaunchCommand {
            kind: RuntimeLauncherKind::GradleWrapper,
            program: "./gradlew".to_string(),
            args: vec!["bootRun".to_string()],
        });
    }
    if has(&by_name, "build.gradle") || has(&by_name, "build.gradle.kts") {
        return Some(RuntimeLaunchCommand {
            kind: RuntimeLauncherKind::GradleSystem,
            program: "gradle".to_string(),
            args: vec!["bootRun".to_string()],
        });
    }
    None
}

fn launcher_command_preview(launcher: &RuntimeLaunchCommand) -> String {
    if launcher.args.is_empty() {
        launcher.program.clone()
    } else {
        format!("{} {}", launcher.program, launcher.args.join(" "))
    }
}

fn make_profile(
    profile_id: RuntimeProfileId,
    default_command: impl Into<String>,
) -> RuntimeProfileDescriptor {
    RuntimeProfileDescriptor {
        id: profile_id.as_str().to_string(),
        default_command: default_command.into(),
        detected_stack: profile_id.stack_name().to_string(),
    }
}

fn detect_node_package_manager(entries: &HashSet<String>) -> &'static str {
    if has_entry(entries, "pnpm-lock.yaml") {
        return "pnpm";
    }
    if has_entry(entries, "yarn.lock") {
        return "yarn";
    }
    if has_entry(entries, "package-lock.json") {
        return "npm";
    }
    if has_entry(entries, "bun.lockb") {
        return "bun";
    }
    "npm"
}

fn read_package_script_names(workspace_root: &Path) -> HashSet<String> {
    let package_json_path = workspace_root.join("package.json");
    let Ok(raw_json) = std::fs::read_to_string(package_json_path) else {
        return HashSet::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw_json) else {
        return HashSet::new();
    };
    let Some(scripts) = parsed.get("scripts").and_then(Value::as_object) else {
        return HashSet::new();
    };
    scripts.keys().cloned().collect()
}

fn detect_python_default_command(entries: &HashSet<String>) -> Option<String> {
    if has_entry(entries, "manage.py") {
        return Some("python manage.py runserver".to_string());
    }
    if has_entry(entries, "main.py") {
        return Some("python main.py".to_string());
    }
    if has_entry(entries, "app.py") {
        return Some("python app.py".to_string());
    }
    if has_entry(entries, "pyproject.toml") || has_entry(entries, "requirements.txt") {
        return Some("python main.py".to_string());
    }
    None
}

fn list_go_cmd_targets(workspace_root: &Path) -> Vec<String> {
    let cmd_root = workspace_root.join("cmd");
    let Ok(reader) = std::fs::read_dir(cmd_root) else {
        return Vec::new();
    };
    let mut targets = Vec::new();
    for entry in reader.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if !path.join("main.go").exists() {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
            targets.push(format!("./cmd/{name}"));
        }
    }
    targets.sort();
    targets
}

fn detect_go_default_command(
    entries: &HashSet<String>,
    go_cmd_targets: &[String],
) -> Option<String> {
    if has_entry(entries, "main.go") || has_entry(entries, "go.mod") {
        if has_entry(entries, "main.go") {
            return Some("go run .".to_string());
        }
        if let Some(first_target) = go_cmd_targets.first() {
            return Some(format!("go run {first_target}"));
        }
        return Some("go run .".to_string());
    }
    if let Some(first_target) = go_cmd_targets.first() {
        return Some(format!("go run {first_target}"));
    }
    None
}

fn detect_runtime_profiles(
    workspace_root: &Path,
    root_entries: &[String],
) -> Vec<RuntimeProfileDescriptor> {
    let entry_set: HashSet<String> = root_entries
        .iter()
        .filter_map(|entry| entry.rsplit(['/', '\\']).next().map(ToString::to_string))
        .collect();
    let mut profiles = Vec::new();

    if let Some(java_launcher) = detect_java_launcher(root_entries) {
        let profile_id = match java_launcher.kind {
            RuntimeLauncherKind::MavenWrapper | RuntimeLauncherKind::MavenSystem => {
                RuntimeProfileId::JavaMaven
            }
            RuntimeLauncherKind::GradleWrapper | RuntimeLauncherKind::GradleSystem => {
                RuntimeProfileId::JavaGradle
            }
        };
        profiles.push(make_profile(
            profile_id,
            launcher_command_preview(&java_launcher),
        ));
    }

    if has_entry(&entry_set, "package.json") {
        let package_manager = detect_node_package_manager(&entry_set);
        let script_names = read_package_script_names(workspace_root);
        if script_names.contains("dev") {
            profiles.push(make_profile(
                RuntimeProfileId::NodeDev,
                format!("{package_manager} run dev"),
            ));
        }
        if script_names.contains("start") {
            profiles.push(make_profile(
                RuntimeProfileId::NodeStart,
                format!("{package_manager} run start"),
            ));
        }
    }

    if let Some(default_python_command) = detect_python_default_command(&entry_set) {
        profiles.push(make_profile(
            RuntimeProfileId::PythonMain,
            default_python_command,
        ));
    }

    let go_cmd_targets = list_go_cmd_targets(workspace_root);
    if let Some(default_go_command) = detect_go_default_command(&entry_set, &go_cmd_targets) {
        profiles.push(make_profile(RuntimeProfileId::GoRun, default_go_command));
    }

    profiles
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

async fn get_workspace_root(
    state: &State<'_, AppState>,
    workspace_id: &str,
) -> Result<PathBuf, String> {
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(workspace_id)
        .ok_or_else(|| format!("Workspace not found: {workspace_id}"))?;
    Ok(PathBuf::from(&entry.path))
}

fn list_workspace_root_entries(workspace_root: &Path) -> Result<Vec<String>, String> {
    let mut entries = Vec::new();
    let reader = std::fs::read_dir(workspace_root)
        .map_err(|error| format!("Failed to read workspace root: {error}"))?;
    for entry in reader.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            entries.push(name.to_string());
        }
    }
    Ok(entries)
}

#[cfg(not(windows))]
fn build_detected_run_script(launcher: &RuntimeLaunchCommand) -> String {
    let joined = if launcher.args.is_empty() {
        launcher.program.clone()
    } else {
        format!("{} {}", launcher.program, launcher.args.join(" "))
    };
    let mut lines = vec![
        "CCGUI_RUN_EXIT_CODE=0".to_string(),
        "if ! command -v java >/dev/null 2>&1; then".to_string(),
        "  echo \"[CodePort Run] Java not found. Install JDK and ensure java is on PATH.\""
            .to_string(),
        "  CCGUI_RUN_EXIT_CODE=127".to_string(),
        "else".to_string(),
    ];

    match launcher.kind {
        RuntimeLauncherKind::MavenWrapper => {
            lines.push("  if [ ! -x \"./mvnw\" ]; then".to_string());
            lines.push("    echo \"[CodePort Run] ./mvnw is missing execute permission. Run: chmod +x ./mvnw\"".to_string());
            lines.push("    CCGUI_RUN_EXIT_CODE=126".to_string());
            lines.push("  else".to_string());
            lines.push(format!("    echo \"[CodePort Run] Using: {joined}\""));
            lines.push(format!("    {joined}"));
            lines.push("    CCGUI_RUN_EXIT_CODE=$?".to_string());
            lines.push("  fi".to_string());
        }
        RuntimeLauncherKind::MavenSystem => {
            lines.push("  if ! command -v mvn >/dev/null 2>&1; then".to_string());
            lines.push("    echo \"[CodePort Run] Maven not found. Install Maven or add ./mvnw to project root.\"".to_string());
            lines.push("    CCGUI_RUN_EXIT_CODE=127".to_string());
            lines.push("  else".to_string());
            lines.push(format!("    echo \"[CodePort Run] Using: {joined}\""));
            lines.push(format!("    {joined}"));
            lines.push("    CCGUI_RUN_EXIT_CODE=$?".to_string());
            lines.push("  fi".to_string());
        }
        RuntimeLauncherKind::GradleWrapper => {
            lines.push("  if [ ! -x \"./gradlew\" ]; then".to_string());
            lines.push("    echo \"[CodePort Run] ./gradlew is missing execute permission. Run: chmod +x ./gradlew\"".to_string());
            lines.push("    CCGUI_RUN_EXIT_CODE=126".to_string());
            lines.push("  else".to_string());
            lines.push(format!("    echo \"[CodePort Run] Using: {joined}\""));
            lines.push(format!("    {joined}"));
            lines.push("    CCGUI_RUN_EXIT_CODE=$?".to_string());
            lines.push("  fi".to_string());
        }
        RuntimeLauncherKind::GradleSystem => {
            lines.push("  if ! command -v gradle >/dev/null 2>&1; then".to_string());
            lines.push("    echo \"[CodePort Run] Gradle not found. Install Gradle or add ./gradlew to project root.\"".to_string());
            lines.push("    CCGUI_RUN_EXIT_CODE=127".to_string());
            lines.push("  else".to_string());
            lines.push(format!("    echo \"[CodePort Run] Using: {joined}\""));
            lines.push(format!("    {joined}"));
            lines.push("    CCGUI_RUN_EXIT_CODE=$?".to_string());
            lines.push("  fi".to_string());
        }
    }
    lines.push("fi".to_string());
    lines.push("echo \"[CodePort Run] __EXIT__:${CCGUI_RUN_EXIT_CODE}\"".to_string());

    lines.join("\n")
}

#[cfg(windows)]
fn build_detected_run_script(launcher: &RuntimeLaunchCommand) -> String {
    let joined = if launcher.args.is_empty() {
        launcher.program.clone()
    } else {
        format!("{} {}", launcher.program, launcher.args.join(" "))
    };
    let mut lines = vec![
        "@echo off".to_string(),
        "setlocal EnableExtensions EnableDelayedExpansion".to_string(),
        "set \"CCGUI_RUN_EXIT_CODE=0\"".to_string(),
        "where java >nul 2>&1".to_string(),
        "if errorlevel 1 (".to_string(),
        "  echo [CodePort Run] Java not found. Install JDK and ensure java is on PATH.".to_string(),
        "  set \"CCGUI_RUN_EXIT_CODE=127\"".to_string(),
        ") else (".to_string(),
    ];

    match launcher.kind {
        RuntimeLauncherKind::MavenWrapper => {
            lines.push(format!("  if not exist \"{}\" (", launcher.program));
            lines.push(format!(
                "    echo [CodePort Run] {} not found in project root.",
                launcher.program
            ));
            lines.push("    set \"CCGUI_RUN_EXIT_CODE=126\"".to_string());
            lines.push("  ) else (".to_string());
            lines.push(format!("    echo [CodePort Run] Using: {joined}"));
            lines.push(format!("    call {joined}"));
            lines.push("    set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"".to_string());
            lines.push("  )".to_string());
        }
        RuntimeLauncherKind::MavenSystem => {
            lines.push("  where mvn >nul 2>&1".to_string());
            lines.push("  if errorlevel 1 (".to_string());
            lines.push("    echo [CodePort Run] Maven not found. Install Maven or add mvnw.cmd to project root.".to_string());
            lines.push("    set \"CCGUI_RUN_EXIT_CODE=127\"".to_string());
            lines.push("  ) else (".to_string());
            lines.push(format!("    echo [CodePort Run] Using: {joined}"));
            lines.push(format!("    call {joined}"));
            lines.push("    set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"".to_string());
            lines.push("  )".to_string());
        }
        RuntimeLauncherKind::GradleWrapper => {
            lines.push(format!("  if not exist \"{}\" (", launcher.program));
            lines.push(format!(
                "    echo [CodePort Run] {} not found in project root.",
                launcher.program
            ));
            lines.push("    set \"CCGUI_RUN_EXIT_CODE=126\"".to_string());
            lines.push("  ) else (".to_string());
            lines.push(format!("    echo [CodePort Run] Using: {joined}"));
            lines.push(format!("    call {joined}"));
            lines.push("    set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"".to_string());
            lines.push("  )".to_string());
        }
        RuntimeLauncherKind::GradleSystem => {
            lines.push("  where gradle >nul 2>&1".to_string());
            lines.push("  if errorlevel 1 (".to_string());
            lines.push("    echo [CodePort Run] Gradle not found. Install Gradle or add gradlew.bat to project root.".to_string());
            lines.push("    set \"CCGUI_RUN_EXIT_CODE=127\"".to_string());
            lines.push("  ) else (".to_string());
            lines.push(format!("    echo [CodePort Run] Using: {joined}"));
            lines.push(format!("    call {joined}"));
            lines.push("    set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"".to_string());
            lines.push("  )".to_string());
        }
    }
    lines.push(")".to_string());
    lines.push("echo [CodePort Run] __EXIT__:!CCGUI_RUN_EXIT_CODE!".to_string());
    lines.join("\r\n")
}

#[cfg(not(windows))]
fn build_shell_run_script(
    command: &str,
    source_label: &str,
    dependency_program: Option<&str>,
    dependency_hint: Option<&str>,
) -> String {
    let mut lines = vec!["CCGUI_RUN_EXIT_CODE=0".to_string()];
    if let Some(program) = dependency_program {
        lines.push(format!("if ! command -v {program} >/dev/null 2>&1; then"));
        lines.push(format!(
            "  echo \"[CodePort Run] {}\"",
            dependency_hint.unwrap_or("Required command is not available on PATH.")
        ));
        lines.push("  CCGUI_RUN_EXIT_CODE=127".to_string());
        lines.push("else".to_string());
        lines.push(format!(
            "  echo \"[CodePort Run] Using {source_label}: {command}\""
        ));
        lines.push(format!("  {command}"));
        lines.push("  CCGUI_RUN_EXIT_CODE=$?".to_string());
        lines.push("fi".to_string());
    } else {
        lines.push(format!(
            "echo \"[CodePort Run] Using {source_label}: {command}\""
        ));
        lines.push(command.to_string());
        lines.push("CCGUI_RUN_EXIT_CODE=$?".to_string());
    }
    lines.push("echo \"[CodePort Run] __EXIT__:${CCGUI_RUN_EXIT_CODE}\"".to_string());
    lines.join("\n")
}

#[cfg(not(windows))]
fn build_custom_run_script(command: &str) -> String {
    build_shell_run_script(command, "custom command from console", None, None)
}

#[cfg(windows)]
fn build_shell_run_script(
    command: &str,
    source_label: &str,
    dependency_program: Option<&str>,
    dependency_hint: Option<&str>,
) -> String {
    let mut lines = vec![
        "@echo off".to_string(),
        "setlocal EnableExtensions EnableDelayedExpansion".to_string(),
        "set \"CCGUI_RUN_EXIT_CODE=0\"".to_string(),
    ];
    if let Some(program) = dependency_program {
        lines.push(format!("where {program} >nul 2>&1"));
        lines.push("if errorlevel 1 (".to_string());
        lines.push(format!(
            "  echo [CodePort Run] {}",
            dependency_hint.unwrap_or("Required command is not available on PATH.")
        ));
        lines.push("  set \"CCGUI_RUN_EXIT_CODE=127\"".to_string());
        lines.push(") else (".to_string());
        lines.push(format!(
            "  echo [CodePort Run] Using {source_label}: {command}"
        ));
        lines.push(format!("  {command}"));
        lines.push("  set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"".to_string());
        lines.push(")".to_string());
    } else {
        lines.push(format!("echo [CodePort Run] Using {source_label}: {command}"));
        lines.push(command.to_string());
        lines.push("set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"".to_string());
    }
    lines.push("echo [CodePort Run] __EXIT__:!CCGUI_RUN_EXIT_CODE!".to_string());
    lines.join("\r\n")
}

#[cfg(windows)]
fn build_custom_run_script(command: &str) -> String {
    build_shell_run_script(command, "custom command from console", None, None)
}

fn resolve_profile_dependency_hint(profile_id: RuntimeProfileId) -> &'static str {
    match profile_id {
        RuntimeProfileId::NodeDev | RuntimeProfileId::NodeStart => {
            "Node package manager command not found. Install npm/pnpm/yarn/bun or edit the command."
        }
        RuntimeProfileId::PythonMain => {
            "Python not found. Install Python and ensure `python`/`python3`/`py` is available on PATH."
        }
        RuntimeProfileId::GoRun => "Go not found. Install Go and ensure `go` is available on PATH.",
        RuntimeProfileId::JavaMaven => {
            "Java/Maven launcher is missing. Install JDK & Maven or provide command override."
        }
        RuntimeProfileId::JavaGradle => {
            "Java/Gradle launcher is missing. Install JDK & Gradle or provide command override."
        }
    }
}

fn command_program(command: &str) -> Option<&str> {
    command.split_whitespace().next()
}

fn command_args(command: &str) -> String {
    command
        .split_whitespace()
        .skip(1)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(not(windows))]
fn build_python_profile_script(command: &str) -> String {
    let args = command_args(command);
    let executable_args = if args.is_empty() {
        "main.py".to_string()
    } else {
        args
    };
    [
        "CCGUI_RUN_EXIT_CODE=0".to_string(),
        "if command -v python3 >/dev/null 2>&1; then".to_string(),
        format!("  echo \"[CodePort Run] Using detected runtime profile: python3 {executable_args}\""),
        format!("  python3 {executable_args}"),
        "  CCGUI_RUN_EXIT_CODE=$?".to_string(),
        "elif command -v python >/dev/null 2>&1; then".to_string(),
        format!("  echo \"[CodePort Run] Using detected runtime profile: python {executable_args}\""),
        format!("  python {executable_args}"),
        "  CCGUI_RUN_EXIT_CODE=$?".to_string(),
        "else".to_string(),
        "  echo \"[CodePort Run] Python not found. Install Python and ensure `python` or `python3` is available on PATH.\"".to_string(),
        "  CCGUI_RUN_EXIT_CODE=127".to_string(),
        "fi".to_string(),
        "echo \"[CodePort Run] __EXIT__:${CCGUI_RUN_EXIT_CODE}\"".to_string(),
    ]
    .join("\n")
}

#[cfg(windows)]
fn build_python_profile_script(command: &str) -> String {
    let args = command_args(command);
    let executable_args = if args.is_empty() {
        "main.py".to_string()
    } else {
        args
    };
    [
        "@echo off".to_string(),
        "setlocal EnableExtensions EnableDelayedExpansion".to_string(),
        "set \"CCGUI_RUN_EXIT_CODE=0\"".to_string(),
        "where py >nul 2>&1".to_string(),
        "if not errorlevel 1 (".to_string(),
        format!("  echo [CodePort Run] Using detected runtime profile: py -3 {executable_args}"),
        format!("  call py -3 {executable_args}"),
        "  set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"".to_string(),
        ") else (".to_string(),
        "  where python >nul 2>&1".to_string(),
        "  if errorlevel 1 (".to_string(),
        "    echo [CodePort Run] Python not found. Install Python and ensure `py` or `python` is available on PATH.".to_string(),
        "    set \"CCGUI_RUN_EXIT_CODE=127\"".to_string(),
        "  ) else (".to_string(),
        format!("    echo [CodePort Run] Using detected runtime profile: python {executable_args}"),
        format!("    call python {executable_args}"),
        "    set \"CCGUI_RUN_EXIT_CODE=!ERRORLEVEL!\"".to_string(),
        "  )".to_string(),
        ")".to_string(),
        "echo [CodePort Run] __EXIT__:!CCGUI_RUN_EXIT_CODE!".to_string(),
    ]
    .join("\r\n")
}

fn resolve_requested_profile_id(
    raw_profile_id: Option<String>,
) -> Result<Option<RuntimeProfileId>, String> {
    let Some(value) = raw_profile_id else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    RuntimeProfileId::from_str(trimmed)
        .map(Some)
        .ok_or_else(|| format!("Unknown runtime profile id: {trimmed}"))
}

async fn update_runtime_session(
    state: &State<'_, AppState>,
    workspace_id: &str,
    updater: impl FnOnce(Option<RuntimeSessionRecord>) -> RuntimeSessionRecord,
) -> RuntimeSessionSnapshot {
    let mut sessions = state.runtime_log_sessions.lock().await;
    let current = sessions.get(workspace_id).cloned();
    let next = updater(current);
    sessions.insert(workspace_id.to_string(), next.clone());
    next.to_snapshot()
}

fn emit_runtime_status(app: &AppHandle, snapshot: &RuntimeSessionSnapshot) {
    let _ = app.emit("runtime-log:status-changed", snapshot);
}

fn emit_runtime_exited(app: &AppHandle, snapshot: &RuntimeSessionSnapshot) {
    let _ = app.emit("runtime-log:session-exited", snapshot);
}

#[tauri::command]
pub(crate) async fn runtime_log_detect_profiles(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<RuntimeProfileDescriptor>, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("runtime_log_detect_profiles is not supported in remote mode yet.".to_string());
    }
    let workspace_root = get_workspace_root(&state, &workspace_id).await?;
    let root_entries = list_workspace_root_entries(&workspace_root)?;
    Ok(detect_runtime_profiles(&workspace_root, &root_entries))
}

#[tauri::command]
pub(crate) async fn runtime_log_start(
    workspace_id: String,
    profile_id: Option<String>,
    command_override: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RuntimeSessionSnapshot, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("runtime_log_start is not supported in remote mode yet.".to_string());
    }

    let normalized_command_override = command_override.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    let mut resolved_profile: Option<RuntimeProfileDescriptor> = None;
    let mut resolved_java_launcher: Option<RuntimeLaunchCommand> = None;
    let requested_profile_id = resolve_requested_profile_id(profile_id)?;

    if normalized_command_override.is_none() {
        let workspace_root = get_workspace_root(&state, &workspace_id).await?;
        let root_entries = list_workspace_root_entries(&workspace_root)?;
        let detected_profiles = detect_runtime_profiles(&workspace_root, &root_entries);
        if detected_profiles.is_empty() {
            return Err(AUTO_DETECT_HELP_TEXT.to_string());
        }
        resolved_profile = if let Some(requested_id) = requested_profile_id {
            let requested_raw = requested_id.as_str();
            let available = detected_profiles
                .iter()
                .map(|profile| profile.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Some(
                detected_profiles
                    .iter()
                    .find(|profile| profile.id == requested_raw)
                    .cloned()
                    .ok_or_else(|| {
                        format!(
                            "Requested runtime profile `{requested_raw}` is not available. Detected: {available}."
                        )
                    })?,
            )
        } else {
            detected_profiles.first().cloned()
        };
        if let Some(profile) = resolved_profile.as_ref() {
            if matches!(
                RuntimeProfileId::from_str(&profile.id),
                Some(RuntimeProfileId::JavaMaven | RuntimeProfileId::JavaGradle)
            ) {
                resolved_java_launcher = detect_java_launcher(&root_entries);
            }
        }
    }

    let command_preview = if let Some(override_command) = normalized_command_override.as_ref() {
        override_command.clone()
    } else if let Some(profile) = resolved_profile.as_ref() {
        profile.default_command.clone()
    } else {
        return Err(AUTO_DETECT_HELP_TEXT.to_string());
    };

    let resolved_profile_id_str = resolved_profile.as_ref().map(|profile| profile.id.clone());
    let resolved_detected_stack = resolved_profile
        .as_ref()
        .map(|profile| profile.detected_stack.clone());

    let run_script = if let Some(override_command) = normalized_command_override.as_deref() {
        build_custom_run_script(override_command)
    } else if let Some(profile) = resolved_profile.as_ref() {
        let resolved_profile_id = RuntimeProfileId::from_str(&profile.id)
            .ok_or_else(|| format!("Unknown runtime profile id: {}", profile.id))?;
        match resolved_profile_id {
            RuntimeProfileId::JavaMaven | RuntimeProfileId::JavaGradle => {
                if let Some(launcher) = resolved_java_launcher.as_ref() {
                    build_detected_run_script(launcher)
                } else {
                    build_shell_run_script(
                        &profile.default_command,
                        "detected runtime profile",
                        None,
                        Some(resolve_profile_dependency_hint(resolved_profile_id)),
                    )
                }
            }
            RuntimeProfileId::NodeDev | RuntimeProfileId::NodeStart | RuntimeProfileId::GoRun => {
                let dependency_program = command_program(&profile.default_command)
                    .filter(|value| !value.contains('/') && !value.contains('\\'));
                build_shell_run_script(
                    &profile.default_command,
                    "detected runtime profile",
                    dependency_program,
                    Some(resolve_profile_dependency_hint(resolved_profile_id)),
                )
            }
            RuntimeProfileId::PythonMain => build_python_profile_script(&profile.default_command),
        }
    } else {
        return Err(AUTO_DETECT_HELP_TEXT.to_string());
    };
    let started_at_ms = now_ms();

    let starting_snapshot =
        update_runtime_session(&state, &workspace_id, |_| RuntimeSessionRecord {
            workspace_id: workspace_id.clone(),
            terminal_id: RUNTIME_TERMINAL_ID.to_string(),
            status: RuntimeSessionStatus::Starting,
            command_preview: Some(command_preview.clone()),
            profile_id: resolved_profile_id_str.clone(),
            detected_stack: resolved_detected_stack.clone(),
            started_at_ms: Some(started_at_ms),
            stopped_at_ms: None,
            exit_code: None,
            error: None,
        })
        .await;
    emit_runtime_status(&app, &starting_snapshot);

    let runtime_terminal_id = RUNTIME_TERMINAL_ID.to_string();
    let _ = crate::terminal::terminal_close(
        workspace_id.clone(),
        runtime_terminal_id.clone(),
        app.state::<AppState>(),
    )
    .await;

    let start_result = async {
        crate::terminal::terminal_open(
            workspace_id.clone(),
            runtime_terminal_id.clone(),
            DEFAULT_TERMINAL_COLS,
            DEFAULT_TERMINAL_ROWS,
            app.state::<AppState>(),
            app.clone(),
        )
        .await?;
        crate::terminal::terminal_write(
            workspace_id.clone(),
            runtime_terminal_id.clone(),
            format!("{}\n", run_script),
            app.state::<AppState>(),
        )
        .await?;
        Ok::<(), String>(())
    }
    .await;

    match start_result {
        Ok(()) => {
            let running_snapshot = update_runtime_session(&state, &workspace_id, |current| {
                let (previous_started, previous_profile_id, previous_detected_stack) =
                    match current.as_ref() {
                        Some(value) => (
                            value.started_at_ms,
                            value.profile_id.clone(),
                            value.detected_stack.clone(),
                        ),
                        None => (None, None, None),
                    };
                RuntimeSessionRecord {
                    workspace_id: workspace_id.clone(),
                    terminal_id: RUNTIME_TERMINAL_ID.to_string(),
                    status: RuntimeSessionStatus::Running,
                    command_preview: Some(command_preview),
                    profile_id: previous_profile_id.or_else(|| resolved_profile_id_str.clone()),
                    detected_stack: previous_detected_stack
                        .or_else(|| resolved_detected_stack.clone()),
                    started_at_ms: previous_started.or(Some(started_at_ms)),
                    stopped_at_ms: None,
                    exit_code: None,
                    error: None,
                }
            })
            .await;
            emit_runtime_status(&app, &running_snapshot);
            Ok(running_snapshot)
        }
        Err(error) => {
            let failed_snapshot = update_runtime_session(&state, &workspace_id, |current| {
                let (
                    previous_command,
                    previous_started,
                    previous_profile_id,
                    previous_detected_stack,
                ) = match current {
                    Some(value) => (
                        value.command_preview,
                        value.started_at_ms,
                        value.profile_id,
                        value.detected_stack,
                    ),
                    None => (None, None, None, None),
                };
                RuntimeSessionRecord {
                    workspace_id: workspace_id.clone(),
                    terminal_id: RUNTIME_TERMINAL_ID.to_string(),
                    status: RuntimeSessionStatus::Failed,
                    command_preview: previous_command.or(Some(command_preview)),
                    profile_id: previous_profile_id.or_else(|| resolved_profile_id_str.clone()),
                    detected_stack: previous_detected_stack
                        .or_else(|| resolved_detected_stack.clone()),
                    started_at_ms: previous_started.or(Some(started_at_ms)),
                    stopped_at_ms: Some(now_ms()),
                    exit_code: None,
                    error: Some(error.clone()),
                }
            })
            .await;
            emit_runtime_status(&app, &failed_snapshot);
            emit_runtime_exited(&app, &failed_snapshot);
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) async fn runtime_log_stop(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RuntimeSessionSnapshot, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("runtime_log_stop is not supported in remote mode yet.".to_string());
    }

    let stopping_snapshot = update_runtime_session(&state, &workspace_id, |current| {
        let now = now_ms();
        match current {
            Some(value) => RuntimeSessionRecord {
                status: RuntimeSessionStatus::Stopping,
                ..value
            },
            None => RuntimeSessionRecord {
                workspace_id: workspace_id.clone(),
                terminal_id: RUNTIME_TERMINAL_ID.to_string(),
                status: RuntimeSessionStatus::Stopping,
                command_preview: None,
                profile_id: None,
                detected_stack: None,
                started_at_ms: Some(now),
                stopped_at_ms: None,
                exit_code: None,
                error: None,
            },
        }
    })
    .await;
    emit_runtime_status(&app, &stopping_snapshot);

    let close_result = crate::terminal::terminal_close(
        workspace_id.clone(),
        RUNTIME_TERMINAL_ID.to_string(),
        app.state::<AppState>(),
    )
    .await;

    match close_result {
        Ok(()) => {
            let stopped_snapshot = update_runtime_session(&state, &workspace_id, |current| {
                let now = now_ms();
                let base = current.unwrap_or(RuntimeSessionRecord {
                    workspace_id: workspace_id.clone(),
                    terminal_id: RUNTIME_TERMINAL_ID.to_string(),
                    status: RuntimeSessionStatus::Stopped,
                    command_preview: None,
                    profile_id: None,
                    detected_stack: None,
                    started_at_ms: Some(now),
                    stopped_at_ms: None,
                    exit_code: None,
                    error: None,
                });
                RuntimeSessionRecord {
                    status: RuntimeSessionStatus::Stopped,
                    stopped_at_ms: Some(now),
                    exit_code: base.exit_code.or(Some(130)),
                    ..base
                }
            })
            .await;
            emit_runtime_status(&app, &stopped_snapshot);
            emit_runtime_exited(&app, &stopped_snapshot);
            Ok(stopped_snapshot)
        }
        Err(error) if error.contains("Terminal session not found") => {
            let stopped_snapshot = update_runtime_session(&state, &workspace_id, |current| {
                let now = now_ms();
                let base = current.unwrap_or(RuntimeSessionRecord {
                    workspace_id: workspace_id.clone(),
                    terminal_id: RUNTIME_TERMINAL_ID.to_string(),
                    status: RuntimeSessionStatus::Stopped,
                    command_preview: None,
                    profile_id: None,
                    detected_stack: None,
                    started_at_ms: Some(now),
                    stopped_at_ms: None,
                    exit_code: None,
                    error: None,
                });
                RuntimeSessionRecord {
                    status: RuntimeSessionStatus::Stopped,
                    stopped_at_ms: Some(now),
                    exit_code: base.exit_code.or(Some(130)),
                    error: None,
                    ..base
                }
            })
            .await;
            emit_runtime_status(&app, &stopped_snapshot);
            emit_runtime_exited(&app, &stopped_snapshot);
            Ok(stopped_snapshot)
        }
        Err(error) => {
            let failed_snapshot = update_runtime_session(&state, &workspace_id, |current| {
                let now = now_ms();
                let base = current.unwrap_or(RuntimeSessionRecord {
                    workspace_id: workspace_id.clone(),
                    terminal_id: RUNTIME_TERMINAL_ID.to_string(),
                    status: RuntimeSessionStatus::Failed,
                    command_preview: None,
                    profile_id: None,
                    detected_stack: None,
                    started_at_ms: Some(now),
                    stopped_at_ms: None,
                    exit_code: None,
                    error: None,
                });
                RuntimeSessionRecord {
                    status: RuntimeSessionStatus::Failed,
                    stopped_at_ms: Some(now),
                    error: Some(error.clone()),
                    ..base
                }
            })
            .await;
            emit_runtime_status(&app, &failed_snapshot);
            emit_runtime_exited(&app, &failed_snapshot);
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) async fn runtime_log_get_session(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Option<RuntimeSessionSnapshot>, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("runtime_log_get_session is not supported in remote mode yet.".to_string());
    }

    let sessions = state.runtime_log_sessions.lock().await;
    Ok(sessions
        .get(&workspace_id)
        .map(|record| record.to_snapshot()))
}

#[tauri::command]
pub(crate) async fn runtime_log_mark_exit(
    workspace_id: String,
    exit_code: i32,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RuntimeSessionSnapshot, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("runtime_log_mark_exit is not supported in remote mode yet.".to_string());
    }

    let _ = crate::terminal::terminal_close(
        workspace_id.clone(),
        RUNTIME_TERMINAL_ID.to_string(),
        app.state::<AppState>(),
    )
    .await;

    let snapshot = update_runtime_session(&state, &workspace_id, |current| {
        let now = now_ms();
        let base = current.unwrap_or(RuntimeSessionRecord {
            workspace_id: workspace_id.clone(),
            terminal_id: RUNTIME_TERMINAL_ID.to_string(),
            status: RuntimeSessionStatus::Stopped,
            command_preview: None,
            profile_id: None,
            detected_stack: None,
            started_at_ms: Some(now),
            stopped_at_ms: None,
            exit_code: None,
            error: None,
        });
        RuntimeSessionRecord {
            status: if exit_code == 0 {
                RuntimeSessionStatus::Stopped
            } else {
                RuntimeSessionStatus::Failed
            },
            stopped_at_ms: Some(now),
            exit_code: Some(exit_code),
            error: if exit_code == 0 {
                None
            } else {
                Some(format!("Process exited with code {exit_code}."))
            },
            ..base
        }
    })
    .await;

    emit_runtime_status(&app, &snapshot);
    emit_runtime_exited(&app, &snapshot);
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        build_custom_run_script, build_python_profile_script, detect_java_launcher,
        detect_runtime_profiles, RuntimeLauncherKind,
    };

    fn entries(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    fn make_temp_workspace(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be monotonic")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("codemoss-runtime-{name}-{unique}"));
        fs::create_dir_all(&path).expect("temp workspace should be created");
        path
    }

    fn maven_wrapper_file() -> &'static str {
        #[cfg(windows)]
        {
            "mvnw.cmd"
        }
        #[cfg(not(windows))]
        {
            "mvnw"
        }
    }

    fn maven_wrapper_program() -> &'static str {
        #[cfg(windows)]
        {
            "mvnw.cmd"
        }
        #[cfg(not(windows))]
        {
            "./mvnw"
        }
    }

    fn gradle_wrapper_file() -> &'static str {
        #[cfg(windows)]
        {
            "gradlew.bat"
        }
        #[cfg(not(windows))]
        {
            "gradlew"
        }
    }

    fn gradle_wrapper_program() -> &'static str {
        #[cfg(windows)]
        {
            "gradlew.bat"
        }
        #[cfg(not(windows))]
        {
            "./gradlew"
        }
    }

    #[test]
    fn prefers_maven_wrapper_over_other_launchers() {
        let launcher = detect_java_launcher(&entries(&[
            "pom.xml",
            maven_wrapper_file(),
            "build.gradle",
            gradle_wrapper_file(),
        ]))
        .expect("launcher should exist");

        assert_eq!(launcher.kind, RuntimeLauncherKind::MavenWrapper);
        assert_eq!(launcher.program, maven_wrapper_program());
        assert_eq!(launcher.args, vec!["spring-boot:run"]);
    }

    #[test]
    fn chooses_maven_system_when_only_pom_exists() {
        let launcher = detect_java_launcher(&entries(&["pom.xml"])).expect("launcher should exist");

        assert_eq!(launcher.kind, RuntimeLauncherKind::MavenSystem);
        assert_eq!(launcher.program, "mvn");
    }

    #[test]
    fn chooses_gradle_wrapper_when_build_script_and_wrapper_exist() {
        let launcher = detect_java_launcher(&entries(&[gradle_wrapper_file(), "build.gradle.kts"]))
            .expect("launcher should exist");

        assert_eq!(launcher.kind, RuntimeLauncherKind::GradleWrapper);
        assert_eq!(launcher.program, gradle_wrapper_program());
    }

    #[test]
    fn returns_none_when_no_java_build_files_exist() {
        let launcher = detect_java_launcher(&entries(&["README.md", "package.json"]));
        assert!(launcher.is_none());
    }

    #[test]
    fn custom_script_embeds_override_and_exit_marker() {
        let script = build_custom_run_script("mvn spring-boot:run -DskipTests");
        assert!(script.contains("Using custom command from console"));
        assert!(script.contains("mvn spring-boot:run -DskipTests"));
        assert!(script.contains("__EXIT__"));
    }

    #[test]
    fn python_profile_script_has_cross_platform_fallback() {
        let script = build_python_profile_script("python manage.py runserver");
        #[cfg(windows)]
        {
            assert!(script.contains("where py >nul 2>&1"));
            assert!(script.contains("call py -3 manage.py runserver"));
            assert!(script.contains("call python manage.py runserver"));
        }
        #[cfg(not(windows))]
        {
            assert!(script.contains("command -v python3 >/dev/null 2>&1"));
            assert!(script.contains("python3 manage.py runserver"));
            assert!(script.contains("python manage.py runserver"));
        }
        assert!(script.contains("__EXIT__"));
    }

    #[test]
    fn detects_node_profiles_with_lockfile_priority() {
        let workspace = make_temp_workspace("node");
        fs::write(
            workspace.join("package.json"),
            r#"{"name":"demo","scripts":{"dev":"vite","start":"vite preview"}}"#,
        )
        .expect("package.json should be written");
        fs::write(workspace.join("pnpm-lock.yaml"), "lockfileVersion: 9")
            .expect("lockfile should be written");

        let profiles =
            detect_runtime_profiles(&workspace, &entries(&["package.json", "pnpm-lock.yaml"]));
        let profile_ids = profiles
            .iter()
            .map(|profile| profile.id.as_str())
            .collect::<Vec<_>>();
        assert!(profile_ids.contains(&"node-dev"));
        assert!(profile_ids.contains(&"node-start"));
        let node_dev = profiles
            .iter()
            .find(|profile| profile.id == "node-dev")
            .expect("node-dev should be detected");
        assert_eq!(node_dev.default_command, "pnpm run dev");

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn detects_python_profile_from_manage_py() {
        let workspace = make_temp_workspace("python");
        fs::write(workspace.join("manage.py"), "print('ok')").expect("manage.py should be written");

        let profiles = detect_runtime_profiles(&workspace, &entries(&["manage.py"]));
        let python_profile = profiles
            .iter()
            .find(|profile| profile.id == "python-main")
            .expect("python-main should be detected");
        assert_eq!(python_profile.default_command, "python manage.py runserver");

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn detects_go_profile_from_cmd_entry() {
        let workspace = make_temp_workspace("go");
        let cmd_api = workspace.join("cmd").join("api");
        fs::create_dir_all(&cmd_api).expect("cmd/api should be created");
        fs::write(cmd_api.join("main.go"), "package main").expect("cmd main.go should be written");
        fs::write(workspace.join("go.mod"), "module example.com/demo")
            .expect("go.mod should be written");

        let profiles = detect_runtime_profiles(&workspace, &entries(&["go.mod", "cmd"]));
        let go_profile = profiles
            .iter()
            .find(|profile| profile.id == "go-run")
            .expect("go-run should be detected");
        assert_eq!(go_profile.default_command, "go run ./cmd/api");

        let _ = fs::remove_dir_all(workspace);
    }
}
