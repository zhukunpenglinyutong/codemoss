# Codex Provider-Scoped Runtime Contract

## Scenario: Codex provider-scoped runtime and thread binding

### 1. Scope / Trigger

- Trigger: 修改 `src-tauri/src/codex/**`、`src-tauri/src/shared/codex_core.rs`、`src-tauri/src/backend/app_server.rs` 的 Codex app-server launch / thread routing / fork / send path，或修改 `src-tauri/src/session_management*` 的 Codex provider binding metadata。
- 目标：Codex provider selection 是 conversation launch decision，不是全局 active provider；thread-bound operation 必须回到 persisted provider runtime。
- 当前代码事实：disk profile 保留 legacy workspace runtime key；managed profile 使用 `codex::<workspaceId>::<providerProfileId>` runtime key 与 provider-scoped `CODEX_HOME`。

### 2. Signatures

- `CODEX_DISK_PROVIDER_PROFILE_ID: "__disk__"`
- `CODEX_DISK_PROVIDER_PROFILE_NAME: "codex-tui/default-config"`
- `CodexProviderProfile::{Disk, Managed { id, name, config_toml, auth_json }}`
- `CodexProviderBinding { providerProfileId, providerProfileSource, providerProfileName, providerAvailability }`
- `resolve_codex_provider_profile(provider_profile_id: Option<&str>) -> Result<CodexProviderProfile, String>`
- `materialize_codex_provider_profile(profile: CodexProviderProfile) -> Result<MaterializedCodexProviderProfile, String>`
- `codex_runtime_key(workspace_id: &str, provider_profile_id: &str) -> String`
- `legacy_codex_runtime_key(workspace_id: &str) -> String`
- `ensure_codex_session_for_provider(workspace_id, provider_profile_id, state, app) -> Result<(), String>`
- Tauri commands: `start_thread(workspaceId, autoSession?, providerProfileId?)`, `fork_thread(workspaceId, threadId, messageId?, providerProfileId?, targetUserTurnIndex?, targetUserMessageText?, targetUserMessageOccurrence?, localUserMessageCount?)`, `send_user_message(...)`, `resume_thread(...)`, `thread_compact(...)`, `turn_interrupt(...)`, `start_review(...)`。
- Metadata storage: `session-management/workspaces/<workspaceId>.json.codexProviderBindingBySessionId`。

### 3. Contracts

- Missing or blank provider profile id normalizes to `__disk__` only at explicit launch/default boundaries and historical metadata migration boundaries.
- Disk profile MUST use `legacy_codex_runtime_key(workspace_id)` so existing `.codex` / `CODEX_HOME` behavior remains compatible.
- Managed profile MUST be resolved from app config `codex.providers[providerProfileId]`; missing provider or empty `configToml` returns an error and MUST NOT fall back to disk.
- Managed provider home MUST be app-local under `codex-provider-homes/<providerId>/`; provider id path segment rejects empty, `.`, `..`, `/`, and `\`.
- Managed materialization MUST write `config.toml`; if `authJson` exists, it MUST JSON-validate and write `auth.json`. On Unix, written files MUST use owner-only `0600` permissions.
- Managed materialization MUST extract top-level `model`, `model_provider`, `approval_policy`, and `sandbox_mode` from `configToml` into `codex_args_override` as `-c key=value` pairs so project `.codex/config.toml` cannot silently override launch-critical settings.
- `start_thread` MUST normalize selected provider id, ensure that provider runtime, call `thread/start`, and record `CodexProviderBinding` only after a thread id is returned.
- Thread-bound commands MUST call `resolve_thread_provider_profile_id` from metadata before ensuring/sending to a runtime. Missing metadata MAY default to disk for legacy threads; unavailable managed provider MUST surface a provider error from provider resolution.
- `resolve_thread_provider_profile_id` MUST prefer the catalog canonical key `codex:<workspaceId>:<threadId>` before compatibility keys such as `codex::<workspaceId>::<threadId>`, bare `threadId`, or `codex:<threadId>`. Blank `threadId` MUST NOT produce lookup keys. This prevents a stale legacy disk binding from overriding a canonical managed-provider binding.
- Provider-selected fork defaults to parent provider when `providerProfileId` is blank. Cross-provider fork MUST validate/ensure selected provider first, then native-fork in the parent provider runtime, copy the native child history into the selected provider home when homes differ, then record child binding.
- Stale `turn/start` recovery stays inside the same `WorkspaceSession`: classify `thread not found` / `thread_not_found`, clear foreground work, send bounded `thread/resume`, then use short bounded readiness backoff before retrying the original `turn/start`; if the retry still reports missing thread, it may retry once more and MUST clear foreground work if recovery fails.
- Daemon adapter currently supports only disk Codex runtime. It MUST parse `providerProfileId`; `None`, blank, and `__disk__` are allowed; managed provider ids return an explicit unsupported provider-scoped runtime error.
- Daemon's `codex::provider_profile` compatibility module MUST expose the same `CodexProviderProfile` and `resolve_codex_provider_profile` surface consumed by `shared/codex_core.rs`; its resolver returns `Disk` for `None`/blank/`__disk__` and rejects managed ids without constructing a managed runtime.
- Codex app-server launch MUST set `initialize.clientInfo.name/title` to `codex-tui`, resolve `clientInfo.version` from `codex --version`, fallback to `0.137.0`, and set terminal env hints `TERM_PROGRAM` / `TERM_PROGRAM_VERSION` while preserving existing env values when present.

### 4. Validation & Error Matrix

| 场景 | 必须行为 | 禁止行为 |
|---|---|---|
| 新建会话无 `providerProfileId` | 创建 disk profile thread 并记录 disk binding | 猜测最近使用的 managed provider |
| 新建 managed provider 会话 | materialize provider home，启动 provider-scoped runtime，记录 managed binding | 写入全局 `~/.codex` 或复用 disk runtime |
| provider 缺失/删除后继续发送 | 返回 provider not found / unavailable 类错误 | 静默按 `__disk__` 发送 |
| thread metadata 缺失的旧会话 | 作为 legacy disk thread 处理 | 标记为 managed provider |
| canonical 和 legacy binding 同时存在 | 优先使用 canonical workspace key | 因 legacy 裸 id / `codex:<threadId>` 把 managed thread 路由回 disk |
| cross-provider fork | parent runtime native fork -> copy child history -> record selected provider binding | transcript seed turn 或隐藏/改写 parent thread |
| `turn/start` stale thread | same runtime `thread/resume` + short bounded readiness retry | 重新路由到 disk、无限 retry 或立即把 cold-start race 当成用户恢复卡 |
| daemon 收到 managed provider id | 显式 unsupported error | 丢弃 `providerProfileId` 后创建 disk thread |
| Codex launch identity | `codex-tui` client info + terminal fallback env | 影响 Claude/Gemini/OpenCode launch |

### 5. Good / Base / Bad Cases

- Good: `send_user_message` 先 `resolve_thread_provider_profile_id`，再 `ensure_codex_session_for_provider`，最后把 `Some(provider_profile_id)` 传入 `send_user_message_core`。
- Good: `fork_thread` 对 cross-provider fork 只在 parent provider runtime 调 `thread/fork`，`copy_native_fork_history_to_selected_provider` 成功后才 `record_codex_provider_binding`。
- Base: 旧历史 thread 没有 metadata，默认 `__disk__`，使用 workspace-only legacy runtime key。
- Bad: managed provider 找不到时 `unwrap_or(__disk__)`。
- Bad: daemon/web adapter 解析到 `providerProfileId` 后不使用也不报错。
- Bad: `thread not found` 后重新 `start_thread` 或新建 disk thread 替代原 thread。

### 6. Tests Required

- Rust tests for `codex_runtime_key`, disk legacy key behavior, provider id sanitization, managed materialization, auth JSON validation, owner-only permissions where platform supports it, and launch-critical override extraction.
- Rust tests must compile the `cc_gui_daemon` target and assert its provider-profile compatibility resolver accepts disk aliases and rejects managed ids.
- Rust tests for thread binding metadata read/write and catalog projection fields `providerProfileId/source/name/availability`.
- Rust tests for provider binding lookup key order: canonical `codex:<workspaceId>:<threadId>`, legacy double-colon, bare id, `codex:<threadId>`, trimmed inputs, blank thread id.
- Rust tests for fork response enrichment and cross-provider history copy failure diagnostics.
- Rust tests for stale thread classifier and same-runtime retry behavior; at minimum classifier tests must cover both response error shapes and unrelated errors.
- Rust tests for `codex-tui` version parsing and GUI control-plane classification for `codex-tui + experimentalApi`.
- Contract validation: `npm run check:runtime-contracts`, `cargo test --manifest-path src-tauri/Cargo.toml --no-run`, and `openspec validate add-codex-provider-scoped-session-launch --strict --no-interactive` after cross-layer routing changes.

### 7. Wrong vs Correct

#### Wrong

```rust
let provider_profile_id = requested_provider.unwrap_or("__disk__".to_string());
let session_key = workspace_id.clone();
// managed provider errors now silently use disk runtime
```

#### Correct

```rust
let provider_profile_id = resolve_thread_provider_profile_id(&state, &workspace_id, &thread_id).await;
ensure_codex_session_for_provider(&workspace_id, &provider_profile_id, &state, &app).await?;
codex_core::send_user_message_core(
    &state.sessions,
    workspace_id,
    Some(provider_profile_id),
    thread_id,
    text,
    model,
    effort,
    access_mode,
    images,
    collaboration_mode,
    preferred_language,
    custom_spec_root,
    mode_enforcement_enabled,
).await
```

#### Wrong

```rust
if is_thread_not_found(error) {
    start_thread_core(&sessions, workspace_id, None, None).await?;
}
```

#### Correct

```rust
if is_thread_not_found_error_message(&error) {
    retry_turn_start_after_thread_resume(
        &session,
        &workspace_id,
        &thread_id,
        &params,
        timeout_duration,
        &error,
    ).await?;
}
```

## Scenario: Codex stale recovery cookbook

### 1. Scope / Trigger

- Trigger: 修改 `src/features/threads/hooks/useCodexMessageRecovery.ts`、`src/features/threads/utils/codexConversationLiveness.ts`、`src/features/threads/utils/stabilityDiagnostics.ts`、`send_user_message` stale-thread recovery、或未来为 `GEMINI` / `CLAUDE` 增加 stale session recovery hook。
- 目标：把 stale thread/session 恢复拆成可诊断、可复用、可回滚的 attempt-oriented contract；不能把空白 first-turn draft、durable stale conversation、runtime reconnect 混成同一种“重试”。
- Backlinks:
  - OpenSpec `codex-message-recovery-hook`：定义 `useCodexMessageRecovery()` 顶层 hook + `createRecoveryAttempt(deps)` 子 attempt 接口。
  - OpenSpec `codex-stale-thread-binding-recovery`：定义 empty first-turn Codex draft、same-id rebind、durable stale thread 的恢复边界。

### 2. Diagnostic Field Semantics

`staleRecoveryClassification` 是 UI/runtime recovery 的诊断 payload，不是 backend 私有 error type。字段进入 debug event、runtime notice 或用户恢复卡前必须保持稳定语义。

| Field | Accepted values | Trigger / Meaning |
|---|---|---|
| `reasonCode` | `malformed-thread-id` | 当前 thread id 无法作为 provider thread/session id 使用，例如 review/command 路径传入非法 id；只允许 disposable first-turn draft 走 fresh continuation。 |
| `reasonCode` | `missing-thread-binding` | frontend/local state 有当前用户意图，但没有可验证 provider binding 或 backend/session catalog 找不到对应 binding；可先尝试 verified rebind，first-turn empty draft 可 fresh continuation。 |
| `reasonCode` | `stale-thread-binding` | thread/session id 曾经有效，但 provider runtime 返回 `thread not found` / `session not found`；durable conversation 必须先 rebind/fork，不能 silent replacement。 |
| `staleReason` | `user-edited-prompt-after-send` | 用户在 send/recovery 窗口内继续编辑或替换 prompt，旧 optimistic intent 不能被无提示重放。 |
| `staleReason` | `concurrent-thread-recreated` | 同一 workspace/thread identity 被另一路刷新、fork、rebind 或 session catalog update 替换。 |
| `staleReason` | `app-server-restart` | app-server / provider runtime restart 后内存态 thread handle 丢失，但磁盘或 catalog 可能仍可恢复。 |
| `userAction` | `fresh-continuation` | 创建新 provider thread/session，并把当前 disposable optimistic user intent 移到新 thread 后重发；用户应看到新的 thread identity。 |
| `userAction` | `fork-and-retry` | 从旧 thread/message fork 出可继续的 thread，再迁移 optimistic intent 并重发；适用于 old id 不可继续但仍有 parent/history anchor。 |
| `userAction` | `rebind-and-retry` | 已找到 verified replacement/rebound thread id，切换 active thread 后在该 id 上重试；不得重试刚失败的 same id。 |

Existing runtime reconnect diagnostics may still use legacy values such as `broken-pipe`, `runtime-ended`, `workspace-not-connected`, `recover-thread`, or `start-fresh-thread` in `src/features/threads/utils/stabilityDiagnostics.ts`. Those values are reconnect/card compatibility fields. New provider-specific stale recovery cookbook entries SHOULD map them into the attempt-oriented values above before deciding recovery behavior.

### 3. Recovery Failure Playbook

| Failure class | Required evidence | Preferred action | Hard stop |
|---|---|---|---|
| Disposable first-turn draft missing | accepted-turn fact is `empty-draft`, no durable items, local optimistic user intent exists | `fresh-continuation` before fork fallback | Do not show a manual stale-thread card for an empty draft if fresh continuation succeeds. |
| Same-id rebind after missing thread | refresh/rebind returns the same `threadId` that just failed | Treat as unverified; continue to `fresh-continuation` or explicit failure | Do not retry the same missing id and call it recovered. |
| Durable stale conversation | accepted turn exists, assistant output exists, persisted session/history exists, or durable activity is unknown | `rebind-and-retry`; if impossible, `fork-and-retry` or visible recovery card | Do not silently create a fresh thread that hides prior durable history. |
| Provider runtime restart | provider runtime/app-server restarted while catalog still has session metadata | same-runtime readiness/rebind first, then `rebind-and-retry` | Do not route managed provider work to `__disk__` as fallback. |
| User intent changed during recovery | composer draft or optimistic user item no longer matches failed send intent | visible failure/retry prompt | Do not replay stale text into a new thread. |

Implementation rules:

- `useCodexMessageRecovery()` MUST stay a top-level React hook. Dynamic per-send dependencies belong in `createRecoveryAttempt(deps)`.
- Each recovery attempt MUST be single-shot for fresh continuation. Repeated calls in the same send attempt must return `false` without creating another thread.
- `tryFreshDraftReplacement()` MUST require both a recoverable classification and current optimistic user intent.
- `tryForkFromMessage()` MUST not run when a verified rebound thread id already differs from the failed id; that path belongs to `rebind-and-retry`.
- Debug events SHOULD include `{ stage, outcome, reasonCode, staleReason, userAction }` so a later perf/evidence producer can distinguish measured recovery from proxy inference.

### 4. GEMINI / CLAUDE Provider Recovery Template

Future `GEMINI` / `CLAUDE` recovery hooks SHOULD reuse the Codex attempt shape and replace only provider-specific classifiers and APIs:

```ts
type ProviderRecoveryAttemptDeps = {
  provider: "gemini" | "claude";
  workspaceId: string;
  threadId: string;
  reboundThreadId: string | null;
  staleRecoveryClassification: {
    reasonCode: "malformed-thread-id" | "missing-thread-binding" | "stale-thread-binding";
    staleReason?: "user-edited-prompt-after-send" | "concurrent-thread-recreated" | "app-server-restart";
    userAction: "fresh-continuation" | "fork-and-retry" | "rebind-and-retry";
  } | null;
  startProviderSession: () => Promise<string | null>;
  forkProviderSession: () => Promise<string | null>;
  retrySendOnSession: (sessionId: string) => Promise<void>;
};
```

Provider-specific substitutions:

| Provider | Classifier source | Fresh start API | Fork API | Notes |
|---|---|---|---|---|
| `GEMINI` | Gemini CLI session missing / session JSON not found / process restart evidence | `startThreadForMessageSend(workspace, "gemini")` or provider-specific session starter | `forkGeminiSession` equivalent only after history anchor exists | Do not infer measured recovery unless Gemini source artifact proves session id replacement. |
| `CLAUDE` | Claude Code JSONL missing / `claude-pending-*` draft missing / history loader cannot hydrate id | `startThreadForMessageSend(workspace, "claude")` or Claude session starter | `forkClaudeSessionFromMessage` when message anchor exists | Respect `CLAUDE_HOME` / configured Claude home from `claude-context-usage-contract.md`; do not mix histories across homes. |

Template constraints:

- The provider hook SHOULD expose `createRecoveryAttempt(deps)` rather than accepting dynamic deps in the hook call.
- The provider hook MUST keep durable-history protection: accepted or persisted history requires verified rebind/fork before fresh continuation.
- The provider hook MUST emit the same diagnostic field names so UI notices and perf evidence do not need provider-specific parsing.
- Provider-specific fallback MUST stay inside that provider's runtime/home. No recovery path may silently switch to Codex disk runtime or another provider.

### 5. Validation & Error Matrix

| Scenario | Required behavior | Forbidden behavior |
|---|---|---|
| malformed first-turn draft id | classify `malformed-thread-id`, then fresh continuation if optimistic intent exists | fork or retry the malformed id |
| missing binding for empty draft | classify `missing-thread-binding`, create fresh thread once, move optimistic intent, retry | create multiple fresh threads for one send attempt |
| durable stale thread | classify `stale-thread-binding`, attempt rebind/fork or show visible recovery | silent fresh replacement |
| app-server restart | preserve provider runtime identity while recovering | fallback managed provider to disk |
| future Gemini/Claude recovery | reuse `createRecoveryAttempt(deps)` and diagnostic fields | build a provider-specific ad hoc recovery payload |

### 6. Tests Required

- Hook tests for `useCodexMessageRecovery`: fresh continuation, fork retry, same-id rebind rejection, no optimistic item, and idempotent repeated attempt.
- Classifier tests for `staleRecoveryClassification`: `malformed-thread-id`, `missing-thread-binding`, `stale-thread-binding`, and unrelated errors.
- Provider template implementations MUST add provider-focused tests before enabling runtime behavior.
- Contract validation after behavior changes: `npm run check:runtime-contracts`, focused Vitest hook tests, and relevant OpenSpec strict validate.
