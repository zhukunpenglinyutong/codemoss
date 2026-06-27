export type WorkspaceSettings = {
  sidebarCollapsed: boolean;
  visibleThreadRootCount?: number | null;
  sortOrder?: number | null;
  groupId?: string | null;
  projectAlias?: string | null;
  gitRoot?: string | null;
  codexHome?: string | null;
  codexArgs?: string | null;
  launchScript?: string | null;
  launchScripts?: LaunchScriptEntry[] | null;
  worktreeSetupScript?: string | null;
};

export type LaunchScriptIconId =
  | "play"
  | "build"
  | "debug"
  | "wrench"
  | "terminal"
  | "code"
  | "server"
  | "database"
  | "package"
  | "test"
  | "lint"
  | "dev"
  | "git"
  | "config"
  | "logs";

export type LaunchScriptEntry = {
  id: string;
  script: string;
  icon: LaunchScriptIconId;
  label?: string | null;
};

export type WorkspaceGroup = {
  id: string;
  name: string;
  sortOrder?: number | null;
  copiesFolder?: string | null;
};

export type WorkspaceKind = "main" | "worktree";

export type WorktreeInfo = {
  branch: string;
  baseRef?: string | null;
  baseCommit?: string | null;
  tracking?: string | null;
  publishError?: string | null;
  publishRetryCommand?: string | null;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  connected: boolean;
  codex_bin?: string | null;
  kind?: WorkspaceKind;
  parentId?: string | null;
  worktree?: WorktreeInfo | null;
  settings: WorkspaceSettings;
};

export type AppServerEvent = {
  workspace_id: string;
  message: Record<string, unknown>;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type ClaudeDeferredImageLocator = {
  sessionId: string;
  lineIndex: number;
  blockIndex: number;
  messageId?: string | null;
  mediaType: string;
};

export type ClaudeDeferredImage = {
  locator: ClaudeDeferredImageLocator;
  mediaType: string;
  estimatedByteSize: number;
  reason: string;
  workspacePath?: string | null;
};

export type ClaudeHydratedImage = {
  locator: ClaudeDeferredImageLocator;
  src: string;
  mediaType: string;
  byteSize: number;
};

export type ConversationItem =
  | {
      id: string;
      kind: "message";
      role: "user" | "assistant";
      text: string;
      turnId?: string | null;
      engineSource?: EngineType;
      isFinal?: boolean;
      finalCompletedAt?: number;
      finalDurationMs?: number;
      recoveredFromLiveShadow?: boolean;
      recoveryStatus?: "interrupted" | "recovered";
      recoverySourceId?: string;
      images?: string[];
      deferredImages?: ClaudeDeferredImage[];
      collaborationMode?: "plan" | "code" | null;
      selectedAgentName?: string | null;
      selectedAgentIcon?: string | null;
      browserContextAttachment?: BrowserContextSendAttachment | null;
      intentCanvasContextAttachments?: IntentCanvasContextSendAttachment[];
    }
  | {
      id: string;
      kind: "reasoning";
      summary: string;
      content: string;
      engineSource?: EngineType;
    }
  | {
      id: string;
      kind: "diff";
      title: string;
      diff: string;
      status?: string;
      engineSource?: EngineType;
    }
  | {
      id: string;
      kind: "review";
      state: "started" | "completed";
      text: string;
      engineSource?: EngineType;
    }
  | {
      id: string;
      kind: "explore";
      status: "exploring" | "explored";
      engineSource?: EngineType;
      title?: string;
      collapsible?: boolean;
      mergeKey?: string;
      entries: {
        kind: "read" | "search" | "list" | "run";
        label: string;
        detail?: string;
      }[];
    }
  | {
      id: string;
      kind: "generatedImage";
      engineSource?: EngineType;
      status: "processing" | "completed" | "degraded";
      sourceToolName?: string;
      promptText?: string;
      fallbackText?: string;
      anchorUserMessageId?: string;
      images: {
        src: string;
        localPath?: string | null;
      }[];
    }
  | {
      id: string;
      kind: "tool";
      toolType: string;
      engineSource?: EngineType;
      turnId?: string;
      title: string;
      detail: string;
      status?: string;
      output?: string;
      durationMs?: number | null;
      changes?: { path: string; kind?: string; diff?: string }[];
      senderThreadId?: string;
      receiverThreadIds?: string[];
      agentStatus?: Record<string, { status?: string } | string>;
    };

export type AutoSessionVisibility = "hidden" | "system-auto" | "user-visible";

export type AutoSessionCreatedBy = "system" | "user";

export type AutoSessionMetadata = {
  sessionPurpose: string;
  visibility: AutoSessionVisibility;
  ownerFeature: string;
  autoArchive?: boolean | null;
  createdBy: AutoSessionCreatedBy;
};

export type ThreadSummary = {
  id: string;
  name: string;
  updatedAt: number;
  archivedAt?: number;
  threadKind?: "native" | "shared";
  sizeBytes?: number;
  engineSource?: "codex" | "claude" | "gemini" | "opencode";
  selectedEngine?: "codex" | "claude" | "gemini" | "opencode";
  source?: string;
  provider?: string;
  sourceLabel?: string;
  providerProfileId?: string;
  providerProfileSource?: "disk" | "managed" | string;
  providerProfileName?: string;
  providerAvailability?: "available" | "unavailable" | string;
  partialSource?: string;
  isDegraded?: boolean;
  degradedReason?: string;
  folderId?: string | null;
  autoSession?: AutoSessionMetadata | null;
  nativeThreadIds?: string[];
  parentThreadId?: string | null;
};

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

export type AccessMode = "default" | "read-only" | "current" | "full-access";
export type BackendMode = "local" | "remote";
export type WorkspaceSessionAttributionMode = "related" | "workspace-only";
export type ThemeAppearance = "light" | "dark";
export type ThemePreference = "system" | "light" | "dark" | "dim" | "custom";
export type LightThemePresetId =
  | "vscode-light-modern"
  | "vscode-light-plus"
  | "vscode-github-light"
  | "vscode-solarized-light"
  | "vscode-catppuccin-latte"
  | "vscode-tokyo-day"
  | "vscode-rose-pine-dawn"
  | "vscode-everforest-light"
  | "vscode-ayu-light";
export type DarkThemePresetId =
  | "vscode-dark-modern"
  | "vscode-dark-plus"
  | "vscode-github-dark"
  | "vscode-github-dark-dimmed"
  | "vscode-one-dark-pro"
  | "vscode-monokai"
  | "vscode-solarized-dark"
  | "vscode-dracula"
  | "vscode-nord"
  | "vscode-catppuccin-mocha"
  | "vscode-tokyo-night"
  | "vscode-rose-pine";
export type ThemePresetId = LightThemePresetId | DarkThemePresetId;
export type AppMode = "chat" | "kanban" | "gitHistory";

export type ComposerEditorPreset = "default" | "helpful" | "smart";
export type ComposerSendShortcut = "enter" | "cmdEnter";
export type CanvasWidthMode = "narrow" | "wide";
export type LayoutMode = "default" | "swapped";

export type ComposerEditorSettings = {
  preset: ComposerEditorPreset;
  expandFenceOnSpace: boolean;
  expandFenceOnEnter: boolean;
  fenceLanguageTags: boolean;
  fenceWrapSelection: boolean;
  autoWrapPasteMultiline: boolean;
  autoWrapPasteCodeLike: boolean;
  continueListOnShiftEnter: boolean;
};

export type OpenAppTarget = {
  id: string;
  label: string;
  kind: "app" | "command" | "finder";
  appName?: string | null;
  command?: string | null;
  args: string[];
};

export type CodexUnifiedExecPolicy =
  | "inherit"
  | "forceEnabled"
  | "forceDisabled";

export type CodexUnifiedExecExternalStatus = {
  configPath: string | null;
  hasExplicitUnifiedExec: boolean;
  explicitUnifiedExecValue: boolean | null;
  officialDefaultEnabled: boolean;
};

export type ComputerUseAvailabilityStatus =
  | "ready"
  | "blocked"
  | "unavailable"
  | "unsupported";

export type ComputerUseBlockedReason =
  | "platform_unsupported"
  | "codex_app_missing"
  | "plugin_missing"
  | "plugin_disabled"
  | "helper_missing"
  | "helper_bridge_unverified"
  | "permission_required"
  | "approval_required"
  | "unknown_prerequisite";

export type ComputerUseGuidanceCode =
  | "unsupported_platform"
  | "install_codex_app"
  | "install_official_plugin"
  | "enable_official_plugin"
  | "verify_helper_installation"
  | "verify_helper_bridge"
  | "grant_system_permissions"
  | "review_allowed_apps"
  | "inspect_official_codex_setup";

export type ComputerUseBridgeStatus = {
  featureEnabled: boolean;
  activationEnabled: boolean;
  status: ComputerUseAvailabilityStatus;
  platform: string;
  codexAppDetected: boolean;
  pluginDetected: boolean;
  pluginEnabled: boolean;
  blockedReasons: ComputerUseBlockedReason[];
  guidanceCodes: ComputerUseGuidanceCode[];
  codexConfigPath: string | null;
  pluginManifestPath: string | null;
  helperPath: string | null;
  helperDescriptorPath: string | null;
  marketplacePath: string | null;
  diagnosticMessage: string | null;
  authorizationContinuity: ComputerUseAuthorizationContinuityStatus;
};

export type ComputerUseAuthorizationBackendMode = "local" | "remote";

export type ComputerUseAuthorizationHostRole =
  | "foreground_app"
  | "daemon"
  | "debug_binary"
  | "unknown";

export type ComputerUseAuthorizationLaunchMode =
  | "packaged_app"
  | "daemon"
  | "debug"
  | "unknown";

export type ComputerUseAuthorizationContinuityKind =
  | "unknown"
  | "no_successful_host"
  | "matching_host"
  | "host_drift_detected"
  | "unsupported_context";

export type ComputerUseAuthorizationHostSnapshot = {
  displayName: string;
  executablePath: string;
  identifier: string | null;
  teamIdentifier: string | null;
  backendMode: ComputerUseAuthorizationBackendMode;
  hostRole: ComputerUseAuthorizationHostRole;
  launchMode: ComputerUseAuthorizationLaunchMode;
  signingSummary: string | null;
};

export type ComputerUseAuthorizationContinuityStatus = {
  kind: ComputerUseAuthorizationContinuityKind;
  diagnosticMessage: string | null;
  currentHost: ComputerUseAuthorizationHostSnapshot | null;
  lastSuccessfulHost: ComputerUseAuthorizationHostSnapshot | null;
  driftFields: string[];
};

export type ComputerUseActivationOutcome = "verified" | "blocked" | "failed";

export type ComputerUseActivationFailureKind =
  | "activation_disabled"
  | "unsupported_platform"
  | "ineligible_host"
  | "host_incompatible"
  | "already_running"
  | "remaining_blockers"
  | "timeout"
  | "launch_failed"
  | "non_zero_exit"
  | "unknown";

export type ComputerUseActivationResult = {
  outcome: ComputerUseActivationOutcome;
  failureKind: ComputerUseActivationFailureKind | null;
  bridgeStatus: ComputerUseBridgeStatus;
  durationMs: number;
  diagnosticMessage: string | null;
  stderrSnippet: string | null;
  exitCode: number | null;
};

export type ComputerUseHostContractDiagnosticsKind =
  | "requires_official_parent"
  | "handoff_unavailable"
  | "handoff_verified"
  | "manual_permission_required"
  | "unknown";

export type ComputerUseOfficialParentHandoffKind =
  | "handoff_candidate_found"
  | "handoff_unavailable"
  | "requires_official_parent"
  | "unknown";

export type ComputerUseOfficialParentHandoffMethod = {
  method: string;
  sourcePath: string | null;
  identifier: string;
  confidence: string;
  notes: string;
};

export type ComputerUseOfficialParentHandoffEvidence = {
  codexInfoPlistPath: string | null;
  serviceInfoPlistPath: string | null;
  helperInfoPlistPath: string | null;
  parentCodeRequirementPath: string | null;
  pluginManifestPath: string | null;
  mcpDescriptorPath: string | null;
  codexUrlSchemes: string[];
  serviceBundleIdentifier: string | null;
  helperBundleIdentifier: string | null;
  parentTeamIdentifier: string | null;
  applicationGroups: string[];
  xpcServiceIdentifiers: string[];
  durationMs: number;
  stdoutSnippet: string | null;
  stderrSnippet: string | null;
};

export type ComputerUseOfficialParentHandoffDiscovery = {
  kind: ComputerUseOfficialParentHandoffKind;
  methods: ComputerUseOfficialParentHandoffMethod[];
  evidence: ComputerUseOfficialParentHandoffEvidence;
  durationMs: number;
  diagnosticMessage: string;
};

export type ComputerUseHostContractEvidence = {
  helperPath: string | null;
  helperDescriptorPath: string | null;
  currentHostPath: string | null;
  handoffMethod: string;
  codesignSummary: string | null;
  spctlSummary: string | null;
  durationMs: number;
  stdoutSnippet: string | null;
  stderrSnippet: string | null;
  officialParentHandoff: ComputerUseOfficialParentHandoffDiscovery;
};

export type ComputerUseHostContractDiagnosticsResult = {
  kind: ComputerUseHostContractDiagnosticsKind;
  bridgeStatus: ComputerUseBridgeStatus;
  evidence: ComputerUseHostContractEvidence;
  durationMs: number;
  diagnosticMessage: string;
};

export type ComputerUseBrokerOutcome = "completed" | "blocked" | "failed";

export type ComputerUseBrokerFailureKind =
  | "unsupported_platform"
  | "bridge_unavailable"
  | "bridge_blocked"
  | "authorization_continuity_blocked"
  | "workspace_missing"
  | "codex_runtime_unavailable"
  | "already_running"
  | "invalid_instruction"
  | "permission_required"
  | "timeout"
  | "codex_error"
  | "unknown";

export type ComputerUseBrokerRequest = {
  workspaceId: string;
  instruction: string;
  model?: string | null;
  effort?: string | null;
};

export type ComputerUseBrokerResult = {
  outcome: ComputerUseBrokerOutcome;
  failureKind: ComputerUseBrokerFailureKind | null;
  bridgeStatus: ComputerUseBridgeStatus;
  text: string | null;
  diagnosticMessage: string | null;
  durationMs: number;
};

export type EmailSenderProvider = "126" | "163" | "qq" | "custom";

export type EmailSenderSecurity = "ssl_tls" | "start_tls" | "none";

export type EmailSenderSettings = {
  enabled: boolean;
  provider: EmailSenderProvider;
  senderEmail: string;
  senderName: string;
  smtpHost: string;
  smtpPort: number;
  security: EmailSenderSecurity;
  username: string;
  recipientEmail: string;
};

export type EmailInboundSecurity = "ssl_tls" | "start_tls" | "none";

export type EmailInboundSettings = {
  enabled: boolean;
  provider: EmailSenderProvider;
  imapHost: string;
  imapPort: number;
  security: EmailInboundSecurity;
  username: string;
  mailboxFolder: string;
  allowedSenders: string[];
  pollIntervalSeconds: number;
  readOnlyMode: boolean;
  actionWindowHours: number;
  debugStorageEnabled: boolean;
};

export type EmailSenderSettingsView = {
  settings: EmailSenderSettings;
  secretConfigured: boolean;
  secret: string | null;
};

export type UpdateEmailSenderSettingsRequest = {
  settings: EmailSenderSettings;
  secret?: string | null;
  clearSecret?: boolean;
};

export type SendTestEmailRequest = {
  recipient?: string | null;
};

export type SendConversationCompletionEmailRequest = {
  workspaceId: string;
  workspaceName?: string | null;
  threadId: string;
  threadName?: string | null;
  turnId: string;
  subject: string;
  textBody: string;
  sessionId?: string | null;
  mailDrivenSessionEnabled?: boolean;
  summary?: string | null;
  nextRecommendations?: string[];
  recipient?: string | null;
};

export type EmailInboundSettingsView = {
  settings: EmailInboundSettings;
  readOnlyEffective: boolean;
};

export type UpdateEmailInboundSettingsRequest = {
  settings: EmailInboundSettings;
};

export type EmailInboundListenerStatus = {
  enabled: boolean;
  readOnly: boolean;
  connectionState: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  acceptedCount: number;
  queuedCount: number;
  needsConfirmationCount: number;
  rejectedCount: number;
  ignoredCount: number;
  pollingIntervalSeconds: number;
};

export type EmailMailCommandAction = "next" | "change" | "pause" | "stop" | "status";

export type InboundCommandStatus =
  | "accepted"
  | "queued"
  | "running"
  | "done"
  | "needs_confirmation"
  | "duplicate"
  | "expired"
  | "rejected"
  | "ignored";

export type EmailMailSessionState = "enabled" | "paused" | "closed";

export type EmailMailSessionRow = {
  sessionId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  workspaceName: string | null;
  threadName: string | null;
  state: EmailMailSessionState;
  lastEventAt: string | null;
  latestAction: EmailMailCommandAction | null;
  latestStatus: InboundCommandStatus | null;
  latestRejectReason: string | null;
  outboundCount: number;
  inboundCount: number;
  queuedCount: number;
  needsConfirmationCount: number;
  latestSummary: string | null;
};

export type EmailMailTimelineEvent = {
  id: string;
  sessionId: string;
  direction: "outbound" | "inbound" | string;
  action: EmailMailCommandAction | null;
  status: string;
  subject: string | null;
  detail: string | null;
  rejectReason: string | null;
  occurredAt: string;
};

export type EmailMailSessionList = {
  listener: EmailInboundListenerStatus;
  sessions: EmailMailSessionRow[];
  timeline: EmailMailTimelineEvent[];
};

export type EmailInboundMessage = {
  uid?: string | null;
  messageId?: string | null;
  from: string;
  subject: string;
  textBody: string;
  inReplyTo?: string | null;
  references?: string[];
  headers?: Record<string, string>;
  autoSubmitted?: string | null;
  receivedAt?: string | null;
};

export type CheckEmailInboxRequest = {
  messages?: EmailInboundMessage[];
};

export type CheckEmailInboxResult = {
  checkedAt: string;
  readOnly: boolean;
  scannedCount: number;
  acceptedCount: number;
  queuedCount: number;
  needsConfirmationCount: number;
  rejectedCount: number;
  ignoredCount: number;
  duplicateCount: number;
};

export type InboundMailCommand = {
  id: string;
  mailMessageId: string;
  inReplyTo: string | null;
  linkedOutgoingMailId: string;
  sessionId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  replyTokenHash: string;
  fromHash: string;
  fromDisplay: string | null;
  receivedAt: string;
  action: EmailMailCommandAction;
  detail: string | null;
  bodyHash: string;
  status: InboundCommandStatus;
  rejectReason: string | null;
  subjectTag: string | null;
};

export type ClaimMailCommandResult = {
  command: InboundMailCommand | null;
};

export type MutateMailSessionRequest = {
  sessionId: string;
  action:
    | "enable"
    | "pause"
    | "resume"
    | "close"
    | "confirm"
    | "ignore"
    | "cleanup"
    | "delete_mail_records";
  commandId?: string | null;
};

export type CompleteMailCommandRequest = {
  commandId: string;
  status: InboundCommandStatus;
  rejectReason?: string | null;
};

export type EmailSendErrorCode =
  | "disabled"
  | "not_configured"
  | "missing_secret"
  | "invalid_sender"
  | "invalid_recipient"
  | "connect_failed"
  | "tls_failed"
  | "authentication_failed"
  | "send_rejected"
  | "timeout"
  | "secret_store_unavailable"
  | "unknown";

export type EmailSendError = {
  code: EmailSendErrorCode;
  retryable: boolean;
  userMessage: string;
  detail?: Record<string, string>;
};

export type EmailSendResult = {
  provider: EmailSenderProvider;
  acceptedRecipients: string[];
  durationMs: number;
};

export type AppSettings = {
  claudeBin: string | null;
  codexBin: string | null;
  codexArgs: string | null;
  terminalShellPath: string | null;
  geminiEnabled: boolean;
  opencodeEnabled: boolean;
  sessionAttributionMode?: WorkspaceSessionAttributionMode;
  backendMode: BackendMode;
  remoteBackendHost: string;
  remoteBackendToken: string | null;
  webServicePort: number;
  webServiceToken: string | null;
  systemProxyEnabled: boolean;
  systemProxyUrl: string | null;
  defaultAccessMode: AccessMode;
  composerModelShortcut: string | null;
  composerAccessShortcut: string | null;
  composerReasoningShortcut: string | null;
  composerCollaborationShortcut: string | null;
  interruptShortcut: string | null;
  openSettingsShortcut: string | null;
  newWindowShortcut: string | null;
  newAgentShortcut: string | null;
  newWorktreeAgentShortcut: string | null;
  newCloneAgentShortcut: string | null;
  archiveThreadShortcut: string | null;
  closeCurrentSessionShortcut: string | null;
  openChatShortcut: string | null;
  openKanbanShortcut: string | null;
  cycleOpenSessionPrevShortcut: string | null;
  cycleOpenSessionNextShortcut: string | null;
  toggleLeftConversationSidebarShortcut: string | null;
  toggleRightConversationSidebarShortcut: string | null;
  toggleProjectsSidebarShortcut: string | null;
  toggleGitSidebarShortcut: string | null;
  toggleGlobalSearchShortcut: string | null;
  toggleDebugPanelShortcut: string | null;
  toggleTerminalShortcut: string | null;
  toggleRuntimeConsoleShortcut: string | null;
  toggleFilesSurfaceShortcut: string | null;
  saveFileShortcut: string | null;
  findInFileShortcut: string | null;
  toggleGitDiffListViewShortcut: string | null;
  increaseUiScaleShortcut: string | null;
  decreaseUiScaleShortcut: string | null;
  resetUiScaleShortcut: string | null;
  cycleAgentNextShortcut: string | null;
  cycleAgentPrevShortcut: string | null;
  cycleWorkspaceNextShortcut: string | null;
  cycleWorkspacePrevShortcut: string | null;
  lastComposerModelId: string | null;
  lastComposerReasoningEffort: string | null;
  uiScale: number;
  theme: ThemePreference;
  lightThemePresetId?: LightThemePresetId;
  darkThemePresetId?: DarkThemePresetId;
  customThemePresetId?: ThemePresetId;
  customSkillDirectories?: string[];
  canvasWidthMode: CanvasWidthMode;
  layoutMode?: LayoutMode;
  userMsgColor: string;
  usageShowRemaining: boolean;
  showMessageAnchors: boolean;
  showSidebarProviderLabels: boolean;
  performanceCompatibilityModeEnabled: boolean;
  uiFontFamily: string;
  codeFontFamily: string;
  codeFontSize: number;
  notificationSoundsEnabled: boolean;
  notificationSoundId: string;
  notificationSoundCustomPath: string;
  systemNotificationEnabled: boolean;
  emailSender: EmailSenderSettings;
  emailInbound?: EmailInboundSettings;
  preloadGitDiffs: boolean;
  detachedExternalChangeAwarenessEnabled?: boolean;
  detachedExternalChangeWatcherEnabled?: boolean;
  experimentalCollabEnabled: boolean;
  experimentalCollaborationModesEnabled: boolean;
  codexModeEnforcementEnabled?: boolean;
  experimentalSteerEnabled: boolean;
  codexUnifiedExecPolicy: CodexUnifiedExecPolicy;
  experimentalUnifiedExecEnabled?: boolean | null;
  chatCanvasUseNormalizedRealtime: boolean;
  chatCanvasUseUnifiedHistoryLoader: boolean;
  chatCanvasUsePresentationProfile: boolean;
  dictationEnabled: boolean;
  dictationModelId: string;
  dictationPreferredLanguage: string | null;
  dictationHoldKey: string | null;
  composerEditorPreset: ComposerEditorPreset;
  composerSendShortcut: ComposerSendShortcut;
  composerFenceExpandOnSpace: boolean;
  composerFenceExpandOnEnter: boolean;
  composerFenceLanguageTags: boolean;
  composerFenceWrapSelection: boolean;
  composerFenceAutoWrapPasteMultiline: boolean;
  composerFenceAutoWrapPasteCodeLike: boolean;
  composerListContinuation: boolean;
  composerCodeBlockCopyUseModifier: boolean;
  workspaceGroups: WorkspaceGroup[];
  openAppTargets: OpenAppTarget[];
  selectedOpenAppId: string;
  runtimeRestoreThreadsOnlyOnLaunch: boolean;
  runtimeForceCleanupOnExit: boolean;
  runtimeOrphanSweepOnLaunch: boolean;
  codexMaxHotRuntimes: number;
  codexMaxWarmRuntimes: number;
  codexWarmTtlSeconds: number;
  codexAutoCompactionEnabled: boolean;
  codexAutoCompactionThresholdPercent: number;
  browserAgentEnabled: boolean;
  browserAgentPreferBuiltIn: boolean;
  browserAgentAllowExternalProviderFallback: boolean;
  streamingEnabled?: boolean;
  autoOpenFileEnabled?: boolean;
  diffExpandedByDefault?: boolean;
  commitPrompt?: string;
  sendShortcut?: "enter" | "cmdEnter";
  enabledCuratedSkillIds?: string[];
};

export type RuntimePoolState =
  | "starting"
  | "startup-pending"
  | "resume-pending"
  | "acquired"
  | "streaming"
  | "graceful-idle"
  | "evictable"
  | "stopping"
  | "failed"
  | "zombie-suspected";
export type RuntimeLifecycleState =
  | "idle"
  | "acquiring"
  | "active"
  | "replacing"
  | "stopping"
  | "recovering"
  | "quarantined"
  | "ended";
export type RuntimeUserAction =
  | "wait"
  | "retry"
  | "reconnect"
  | "recover-thread"
  | "start-fresh-thread"
  | "open-runtime-console"
  | "dismiss";

export type RuntimeProcessDiagnostics = {
  rootProcesses: number;
  totalProcesses: number;
  nodeProcesses: number;
  rootCommand: string | null;
  managedRuntimeProcesses: number;
  resumeHelperProcesses: number;
  orphanResidueProcesses: number;
};

export type RuntimePoolRow = {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  engine: string;
  state: RuntimePoolState;
  lifecycleState?: RuntimeLifecycleState;
  pid: number | null;
  runtimeGeneration?: string | null;
  wrapperKind: string | null;
  resolvedBin: string | null;
  startedAtMs: number | null;
  lastUsedAtMs: number;
  pinned: boolean;
  turnLeaseCount: number;
  streamLeaseCount: number;
  leaseSources: string[];
  activeWorkProtected: boolean;
  activeWorkReason?: string | null;
  activeWorkSinceMs?: number | null;
  activeWorkLastRenewedAtMs?: number | null;
  foregroundWorkState?: "startup-pending" | "resume-pending" | null;
  foregroundWorkSource?: "user-input-resume" | "queue-fusion-cutover" | null;
  foregroundWorkThreadId?: string | null;
  foregroundWorkTurnId?: string | null;
  foregroundWorkSinceMs?: number | null;
  foregroundWorkTimeoutAtMs?: number | null;
  foregroundWorkLastEventAtMs?: number | null;
  foregroundWorkTimedOut?: boolean;
  evictCandidate: boolean;
  evictionReason: string | null;
  error: string | null;
  lastExitReasonCode?: string | null;
  lastExitMessage?: string | null;
  lastExitAtMs?: number | null;
  lastExitCode?: number | null;
  lastExitSignal?: string | null;
  lastExitPendingRequestCount?: number;
  processDiagnostics?: RuntimeProcessDiagnostics | null;
  startupState?:
    | "starting"
    | "ready"
    | "suspect-stale"
    | "cooldown"
    | "quarantined"
    | null;
  lastRecoverySource?: string | null;
  lastGuardState?: string | null;
  lastReplaceReason?: string | null;
  lastProbeFailure?: string | null;
  lastProbeFailureSource?: string | null;
  reasonCode?: string | null;
  recoverySource?: string | null;
  retryable?: boolean;
  userAction?: RuntimeUserAction | string | null;
  hasStoppingPredecessor?: boolean;
  recentSpawnCount?: number;
  recentReplaceCount?: number;
  recentForceKillCount?: number;
};

export type RuntimeEngineObservability = {
  engine: string;
  sessionCount: number;
  trackedRootProcesses: number;
  trackedTotalProcesses: number;
  trackedNodeProcesses: number;
  hostManagedRootProcesses: number;
  hostUnmanagedRootProcesses: number;
  externalRootProcesses: number;
  hostUnmanagedTotalProcesses: number;
  externalTotalProcesses: number;
};

export type RuntimePoolSnapshot = {
  rows: RuntimePoolRow[];
  summary: {
    totalRuntimes: number;
    acquiredRuntimes: number;
    streamingRuntimes: number;
    gracefulIdleRuntimes: number;
    evictableRuntimes: number;
    activeWorkProtectedRuntimes: number;
    pinnedRuntimes: number;
    codexRuntimes: number;
    claudeRuntimes: number;
  };
  budgets: {
    maxHotCodex: number;
    maxWarmCodex: number;
    warmTtlSeconds: number;
    restoreThreadsOnlyOnLaunch: boolean;
    forceCleanupOnExit: boolean;
    orphanSweepOnLaunch: boolean;
  };
  diagnostics: {
    orphanEntriesFound: number;
    orphanEntriesCleaned: number;
    orphanEntriesFailed: number;
    forceKillCount: number;
    leaseBlockedEvictionCount: number;
    coordinatorAbortCount: number;
    startupManagedNodeProcesses: number;
    startupResumeHelperNodeProcesses: number;
    startupOrphanResidueProcesses: number;
    lastOrphanSweepAtMs: number | null;
    lastShutdownAtMs: number | null;
    runtimeEndDiagnosticsRecorded?: number;
    lastRuntimeEndReasonCode?: string | null;
    lastRuntimeEndMessage?: string | null;
    lastRuntimeEndAtMs?: number | null;
    lastRuntimeEndWorkspaceId?: string | null;
    lastRuntimeEndEngine?: string | null;
    claudeAskUserQuestionResumeAttemptCount?: number;
    claudeAskUserQuestionResumeSuccessCount?: number;
    claudeAskUserQuestionResumeFailureCount?: number;
    lastClaudeAskUserQuestionResumeAtMs?: number | null;
    lastClaudeAskUserQuestionResumeWorkspaceId?: string | null;
    lastClaudeAskUserQuestionResumeThreadId?: string | null;
    lastClaudeAskUserQuestionResumeTurnId?: string | null;
    lastClaudeAskUserQuestionResumeRequestId?: string | null;
    lastClaudeAskUserQuestionResumeStatus?: string | null;
    lastClaudeAskUserQuestionResumeError?: string | null;
  };
  engineObservability: RuntimeEngineObservability[];
};

export type TurnReconciliationRuntimeStatus =
  | "completed"
  | "running"
  | "failed"
  | "stalled"
  | "runtime-ended"
  | "unknown"
  | "query-failed";

export type TurnReconciliationStatusSource =
  | "runtime"
  | "runtime-end-context"
  | "backend-cache"
  | "session-summary"
  | "recovery-state";

export type TurnReconciliationStatusRequest = {
  workspaceId: string;
  engine: "claude" | "codex" | "gemini" | "opencode";
  threadId: string;
  turnId: string | null;
  runtimeSessionId: string | null;
  runtimeLeaseId: string | null;
  requestSource: "three-evidence-reconciliation";
  requestedAtMs: number;
};

export type TurnReconciliationStatusResponse = {
  workspaceId: string;
  engine: "claude" | "codex" | "gemini" | "opencode";
  threadId: string;
  turnId: string | null;
  runtimeSessionId: string | null;
  runtimeLeaseId: string | null;
  status: TurnReconciliationRuntimeStatus;
  statusSource: TurnReconciliationStatusSource;
  observedAtMs: number | null;
  boundedReason: string;
};

export type DiagnosticsBundleExportResult = {
  filePath: string;
  generatedAt: string;
};

export type CodexDoctorEnvironmentDiagnosis = {
  category: string;
  message?: string | null;
  configuredPath?: string | null;
  configuredPathMissing?: boolean;
  guiPathBinary?: string | null;
  fallbackBinary?: string | null;
  resolvedBinaryPath?: string | null;
  missedByGuiPath?: boolean;
};

export type CodexDoctorProxyDiagnosis = {
  category: string;
  primarySource?: string | null;
  configuredKeys?: string[];
  processEnv?: Record<string, string | null>;
  valuesRedacted?: boolean;
};

export type CodexDoctorNetworkDiagnosis = {
  category: string;
  proxy?: CodexDoctorProxyDiagnosis | null;
};

export type CodexDoctorResult = {
  ok: boolean;
  codexBin: string | null;
  version: string | null;
  appServerOk: boolean;
  appServerProbeStatus?: string | null;
  details: string | null;
  path: string | null;
  pathEnvUsed?: string | null;
  proxyEnvSnapshot?: Record<string, string | null>;
  nodeOk: boolean;
  nodeVersion: string | null;
  nodeDetails: string | null;
  resolvedBinaryPath?: string | null;
  wrapperKind?: string | null;
  fallbackRetried?: boolean;
  environmentDiagnosis?: CodexDoctorEnvironmentDiagnosis | null;
  proxyDiagnosis?: CodexDoctorProxyDiagnosis | null;
  networkDiagnosis?: CodexDoctorNetworkDiagnosis | null;
  debug?: {
    platform: string;
    arch: string;
    resolvedBinaryPath?: string | null;
    wrapperKind?: string | null;
    pathEnvUsed?: string | null;
    proxyEnvSnapshot?: Record<string, string | null>;
    proxyDiagnosis?: CodexDoctorProxyDiagnosis | null;
    envVars?: Record<string, string | null>;
    extraSearchPaths?: Array<{
      path: string;
      exists: boolean;
      isDir: boolean;
      hasCodexCmd?: boolean;
      hasClaudeCmd?: boolean;
    }>;
    claudeFound: string | null;
    codexFound: string | null;
    claudeStandardWhich: string | null;
    codexStandardWhich: string | null;
    customBin: string | null;
    combinedSearchPaths: string;
  };
};

export type CodexLaunchProfilePreview = {
  ok: boolean;
  scope: "global" | "workspace" | string;
  workspaceId: string | null;
  executableSource: string;
  argumentsSource: string;
  codexBin: string | null;
  codexArgs: string | null;
  resolvedExecutable: string;
  wrapperKind: string;
  userArguments: string[];
  injectedArguments: string[];
  launchArguments: string[];
  pathEnvUsed: string | null;
  warnings: string[];
  details: string | null;
  nextLaunchOnly: boolean;
};

export type CliInstallEngine = "codex" | "claude";
export type CliInstallAction = "installLatest" | "updateLatest";
export type CliInstallStrategy = "npmGlobal" | "cliSelfUpdate";
export type CliInstallBackend = "local" | "remote";
export type CliInstallPlatform = "macos" | "windows" | "linux" | "unknown";

export type CliInstallPlan = {
  engine: CliInstallEngine;
  action: CliInstallAction;
  strategy: CliInstallStrategy;
  backend: CliInstallBackend;
  platform: CliInstallPlatform;
  commandPreview: string[];
  canRun: boolean;
  blockers: string[];
  warnings: string[];
  manualFallback: string | null;
};

export type CliInstallResult = {
  ok: boolean;
  engine: CliInstallEngine;
  action: CliInstallAction;
  strategy: CliInstallStrategy;
  backend: CliInstallBackend;
  exitCode: number | null;
  stdoutSummary: string | null;
  stderrSummary: string | null;
  details: string | null;
  durationMs: number;
  doctorResult: CodexDoctorResult | null;
};

export type CliInstallProgressPhase =
  | "started"
  | "stdout"
  | "stderr"
  | "finished"
  | "error";
export type CliInstallOutputStream = "stdout" | "stderr";

export type CliInstallProgressEvent = {
  runId: string;
  engine: CliInstallEngine;
  action: CliInstallAction;
  strategy: CliInstallStrategy;
  backend: CliInstallBackend;
  phase: CliInstallProgressPhase;
  stream: CliInstallOutputStream | null;
  message: string | null;
  exitCode: number | null;
  durationMs: number | null;
};

export type ApprovalRequest = {
  workspace_id: string;
  request_id: number | string;
  method: string;
  params: Record<string, unknown>;
};

export type RequestUserInputOption = {
  label: string;
  description: string;
};

export type RequestUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  multiSelect?: boolean;
  options?: RequestUserInputOption[];
};

export type RequestUserInputParams = {
  thread_id: string;
  turn_id: string;
  item_id: string;
  questions: RequestUserInputQuestion[];
  completed?: boolean;
};

export type RequestUserInputRequest = {
  workspace_id: string;
  request_id: number | string;
  params: RequestUserInputParams;
};

export type CollaborationModeBlockedParams = {
  thread_id: string;
  blocked_method: string;
  effective_mode: string;
  reason_code?: string;
  reason: string;
  suggestion?: string;
  request_id?: number | string | null;
};

export type CollaborationModeBlockedRequest = {
  workspace_id: string;
  params: CollaborationModeBlockedParams;
};

export type CollaborationModeResolvedParams = {
  thread_id: string;
  selected_ui_mode: "plan" | "default";
  effective_runtime_mode: "plan" | "code";
  effective_ui_mode: "plan" | "default";
  fallback_reason?: string | null;
};

export type CollaborationModeResolvedRequest = {
  workspace_id: string;
  params: CollaborationModeResolvedParams;
};

export type RequestUserInputAnswer = {
  answers: string[];
};

export type RequestUserInputResponse = {
  answers: Record<string, RequestUserInputAnswer>;
  skippedQuestionIds?: string[];
};

export type RequestUserInputSettlementOptions = {
  staleSettlementHint?: "timeout";
};

export type RequestUserInputSettlementResult = {
  settlement: "accepted" | "stale";
};

export type GitFileStatus = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  isDiffOnlyFallback?: boolean;
  mutationDisabled?: boolean;
};

export type GitFileDiff = {
  path: string;
  status?: string;
  diff: string;
  isBinary?: boolean;
  isImage?: boolean;
  isDiffOnlyFallback?: boolean;
  oldImageData?: string | null;
  newImageData?: string | null;
  oldImageMime?: string | null;
  newImageMime?: string | null;
};

export type GitCommitDiff = {
  path: string;
  status: string;
  diff: string;
  isBinary?: boolean;
  isImage?: boolean;
  oldImageData?: string | null;
  newImageData?: string | null;
  oldImageMime?: string | null;
  newImageMime?: string | null;
};

export type GitLogEntry = {
  sha: string;
  summary: string;
  author: string;
  timestamp: number;
};

export type BridgePayloadBudgetMetadata = {
  command: string;
  surfaceId: string;
  itemCount: number;
  estimatedBytes: number;
  partial: boolean;
  truncated: boolean;
  cacheState: "hit" | "miss" | "invalidated" | "unsupported";
  evidenceClass: "measured" | "proxy" | "unsupported" | string;
};

export type GitLogResponse = {
  total: number;
  entries: GitLogEntry[];
  ahead: number;
  behind: number;
  aheadEntries: GitLogEntry[];
  behindEntries: GitLogEntry[];
  upstream: string | null;
  payloadBudget?: BridgePayloadBudgetMetadata | null;
};

export type GitHistoryCommit = {
  sha: string;
  shortSha: string;
  summary: string;
  message: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  parents: string[];
  refs: string[];
};

export type GitHistoryResponse = {
  snapshotId: string;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  commits: GitHistoryCommit[];
};

export type GitPushPreviewResponse = {
  sourceBranch: string;
  targetRemote: string;
  targetBranch: string;
  targetRef: string;
  targetFound: boolean;
  hasMore: boolean;
  commits: GitHistoryCommit[];
};

export type GitBranchCompareCommitSets = {
  targetOnlyCommits: GitHistoryCommit[];
  currentOnlyCommits: GitHistoryCommit[];
};

export type GitPrWorkflowDefaults = {
  upstreamRepo: string;
  baseBranch: string;
  headOwner: string;
  headBranch: string;
  title: string;
  body: string;
  commentBody: string;
  canCreate: boolean;
  disabledReason?: string | null;
};

export type GitPrWorkflowStageStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped";

export type GitPrWorkflowStage = {
  key: string;
  status: GitPrWorkflowStageStatus | string;
  detail: string;
  command?: string | null;
  stdout?: string | null;
  stderr?: string | null;
};

export type GitPrExistingPullRequest = {
  number: number;
  title: string;
  url: string;
  state: string;
  headRefName: string;
  baseRefName: string;
};

export type GitPrWorkflowResult = {
  ok: boolean;
  status: "success" | "failed" | "existing";
  message: string;
  errorCategory?: string | null;
  nextActionHint?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  existingPr?: GitPrExistingPullRequest | null;
  retryCommand?: string | null;
  stages: GitPrWorkflowStage[];
};

export type GitCommitFileChange = {
  path: string;
  oldPath?: string | null;
  status: string;
  additions: number;
  deletions: number;
  isBinary?: boolean;
  isImage?: boolean;
  diff: string;
  lineCount: number;
  truncated: boolean;
};

export type GitCommitDetails = {
  sha: string;
  summary: string;
  message: string;
  author: string;
  authorEmail: string;
  committer: string;
  committerEmail: string;
  authorTime: number;
  commitTime: number;
  parents: string[];
  files: GitCommitFileChange[];
  totalAdditions: number;
  totalDeletions: number;
};

export type GitBranchListItem = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  remote?: string | null;
  upstream?: string | null;
  lastCommit: number;
  headSha?: string | null;
  ahead: number;
  behind: number;
};

export type GitBranchListResponse = {
  branches: BranchInfo[];
  localBranches?: GitBranchListItem[];
  remoteBranches?: GitBranchListItem[];
  currentBranch?: string | null;
  repositoryState?: GitBranchListRepositoryState;
  diagnostic?: GitBranchListDiagnostic | null;
};

export type GitBranchListRepositoryState =
  | "git_repository"
  | "not_git_repository"
  | "unknown";

export type GitBranchListDiagnostic = {
  kind: string;
  reason?: string | null;
  message?: string | null;
  workspaceId?: string | null;
  pathKind?: string | null;
};

export type GitBranchUpdateStatus = "success" | "no-op" | "blocked";

export type GitBranchUpdateReason =
  | "already_up_to_date"
  | "ahead_only"
  | "no_upstream"
  | "diverged"
  | "occupied_worktree"
  | "stale_ref";

export type GitBranchUpdateResult = {
  branch: string;
  status: GitBranchUpdateStatus;
  reason?: GitBranchUpdateReason | null;
  message: string;
  worktreePath?: string | null;
};

export type GitHubIssue = {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
};

export type GitHubIssuesResponse = {
  total: number;
  issues: GitHubIssue[];
};

export type GitHubUser = {
  login: string;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  createdAt: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  author: GitHubUser | null;
};

export type GitHubPullRequestsResponse = {
  total: number;
  pullRequests: GitHubPullRequest[];
};

export type GitHubPullRequestDiff = {
  path: string;
  status: string;
  diff: string;
};

export type GitHubPullRequestComment = {
  id: number;
  body: string;
  createdAt: string;
  url: string;
  author: GitHubUser | null;
};

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
  contextUsageSource?: string | null;
  contextUsageFreshness?:
    | "live"
    | "restored"
    | "estimated"
    | "pending"
    | string
    | null;
  contextUsedTokens?: number | null;
  contextUsedPercent?: number | null;
  contextRemainingPercent?: number | null;
  contextToolUsages?: Array<{
    name: string;
    server?: string | null;
    tokens: number;
  }> | null;
  contextToolUsagesTruncated?: boolean | null;
  contextCategoryUsages?: Array<{
    name: string;
    tokens: number;
    percent?: number | null;
  }> | null;
};

export type LocalUsageDay = {
  day: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  agentTimeMs: number;
  agentRuns: number;
};

export type LocalUsageTotals = {
  last7DaysTokens: number;
  last30DaysTokens: number;
  averageDailyTokens: number;
  cacheHitRatePercent: number;
  peakDay: string | null;
  peakDayTokens: number;
};

export type LocalUsageModel = {
  model: string;
  tokens: number;
  sharePercent: number;
};

export type LocalUsageSnapshot = {
  updatedAt: number;
  days: LocalUsageDay[];
  totals: LocalUsageTotals;
  topModels: LocalUsageModel[];
};

export type LocalUsageUsageData = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
};

export type LocalUsageSessionSummary = {
  sessionId: string;
  sessionIdAliases?: string[];
  timestamp: number;
  cwd?: string | null;
  model: string;
  usage: LocalUsageUsageData;
  cost: number;
  summary?: string | null;
  source?: string | null;
  provider?: string | null;
  providerProfileId?: string | null;
  providerProfileSource?: string | null;
  providerProfileName?: string | null;
  providerAvailability?: string | null;
  physicalPath?: string | null;
  fileSizeBytes?: number;
  modifiedLines?: number;
};

export type LocalUsageDailyUsage = {
  date: string;
  sessions: number;
  usage: LocalUsageUsageData;
  cost: number;
  modelsUsed: string[];
};

export type LocalUsageModelUsage = {
  model: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  sessionCount: number;
};

export type LocalUsageEngineUsage = {
  engine: string;
  count: number;
};

export type LocalUsageDailyCodeChange = {
  date: string;
  modifiedLines: number;
};

export type LocalUsageWeekData = {
  sessions: number;
  cost: number;
  tokens: number;
};

export type LocalUsageTrends = {
  sessions: number;
  cost: number;
  tokens: number;
};

export type LocalUsageWeeklyComparison = {
  currentWeek: LocalUsageWeekData;
  lastWeek: LocalUsageWeekData;
  trends: LocalUsageTrends;
};

export type LocalUsageStatistics = {
  projectPath: string;
  projectName: string;
  totalSessions: number;
  totalUsage: LocalUsageUsageData;
  estimatedCost: number;
  sessions: LocalUsageSessionSummary[];
  dailyUsage: LocalUsageDailyUsage[];
  weeklyComparison: LocalUsageWeeklyComparison;
  byModel: LocalUsageModelUsage[];
  totalEngineUsageCount: number;
  engineUsage: LocalUsageEngineUsage[];
  aiCodeModifiedLines: number;
  dailyCodeChanges: LocalUsageDailyCodeChange[];
  lastUpdated: number;
};

export type TurnPlanStepStatus = "pending" | "inProgress" | "completed";

export type TurnPlanStep = {
  step: string;
  status: TurnPlanStepStatus;
};

export type TurnPlan = {
  turnId: string;
  explanation: string | null;
  steps: TurnPlanStep[];
};

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CreditsSnapshot = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

export type RateLimitSnapshot = {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  planType: string | null;
};

export type AccountSnapshot = {
  type: "chatgpt" | "apikey" | "unknown";
  email: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean | null;
};

export type QueuedMessage = {
  id: string;
  text: string;
  createdAt: number;
  images?: string[];
  sendOptions?: MessageSendOptions;
};

export type IntentCanvasContextCount = {
  total: number;
  sent: number;
  omitted: number;
};

export type IntentCanvasContextSendAttachment = {
  kind: "intent_canvas_context";
  attachmentId: string;
  canvasId: string;
  title: string;
  mode: string;
  compressionMode: string;
  truncated: boolean;
  payloadCharacters: number;
  rawPayload: string;
  semanticNodes: IntentCanvasContextCount;
  semanticEdges: IntentCanvasContextCount;
  evidence: IntentCanvasContextCount;
  visualTextBlocks: IntentCanvasContextCount;
};

export type MemoryContextInjectionMode = "summary" | "detail";

export type BrowserContextSendAttachment = {
  kind: "browser_snapshot";
  attachmentId: string;
  browserSessionId: string;
  snapshotId: string;
  workspaceId: string;
  title: string | null;
  url: string;
  capturedAt: number;
  stale: boolean;
  freshness?: "fresh" | "stale" | "expired" | "degraded";
  summary: string;
  visibleTextExcerpt?: string;
  pageType?: "article" | "issue" | "docs" | "form" | "dashboard" | "spa" | "unknown";
  primaryContent?: string;
  readableBlocks?: Array<{
    blockId: string;
    role:
      | "article"
      | "issue_body"
      | "docs_section"
      | "form"
      | "dashboard_panel"
      | "paragraph"
      | "code"
      | "other";
    text: string;
    score: number;
    truncated: boolean;
  }>;
  noiseDiagnostics?: Array<{
    diagnosticId: string;
    kind:
      | "navigation_noise"
      | "link_dense_region"
      | "control_dense_region"
      | "auth_wall"
      | "spa_shell"
      | "low_readability";
    severity: "info" | "warning";
    message: string;
    score: number;
  }>;
  visualEvidence?: Array<{
    evidenceId: string;
    kind: "image" | "figure" | "attachment" | "video";
    label: string;
    altText?: string | null;
    srcOrigin?: string | null;
    nearbyText?: string | null;
    visible: boolean;
    sensitive: boolean;
  }>;
  screenshotRefs?: Array<{
    refId: string;
    browserSessionId: string;
    snapshotId: string;
    capturedAt: number;
    kind: "thumbnail_reference";
    storage: "metadata_only" | "ephemeral_ref";
    modelPayloadAllowed: boolean;
  }>;
  ocrTextSupplements?: Array<{
    refId: string;
    screenshotRefId: string;
    text: string;
    capturedAt: number;
    charBudget: number;
    truncated: boolean;
    redactedKinds: string[];
    modelPayloadAllowed: boolean;
  }>;
  elementCounts?: {
    headings: number;
    links: number;
    buttons: number;
    forms: number;
    landmarks: number;
    codeCandidates: number;
    readableBlocks?: number;
    visualEvidence?: number;
    annotations?: number;
  };
  diagnostics?: Array<{
    diagnosticId: string;
    kind: string;
    severity: "info" | "warning" | "error";
    message: string;
    source?: string | null;
    redacted: boolean;
  }>;
  budget?: {
    charLimit: number;
    visibleTextLimit: number;
    elementLimit: number;
    formFieldLimit: number;
    diagnosticLimit: number;
    tokenEstimate?: number | null;
    truncated?: boolean;
    omittedElementCount?: number;
  };
  codeCandidates?: Array<{
    candidateId: string;
    filePath: string;
    symbolName?: string | null;
    reason:
      | "route_match"
      | "file_name_match"
      | "visible_text_match"
      | "heading_match"
      | "button_label_match"
      | "form_label_match"
      | "aria_label_match"
      | "test_id_match"
      | "component_symbol_match"
      | "manual_hint";
    confidence: "high" | "medium" | "low";
    matchedText?: string | null;
    sourceEvidence?: string[];
    explanation?: string;
    openAction?: {
      kind: "open_file";
      filePath: string;
    } | null;
  }>;
  privacy: {
    redactionApplied: boolean;
    redactedKinds: string[];
    omittedKinds: string[];
  };
};

export type MessageSendOptions = {
  selectedMemoryIds?: string[];
  selectedMemoryInjectionMode?: MemoryContextInjectionMode;
  memoryReferenceEnabled?: boolean;
  selectedNoteCardIds?: string[];
  selectedAgent?: SelectedAgentOption | null;
  model?: string | null;
  effort?: string | null;
  collaborationMode?: Record<string, unknown> | null;
  accessMode?: AccessMode;
  resumeSource?: "queue-fusion-cutover" | null;
  resumeTurnId?: string | null;
  skipOptimisticUserBubble?: boolean;
  suppressUserMessageRender?: boolean;
  autoSession?: AutoSessionMetadata | null;
  browserContextAttachment?: BrowserContextSendAttachment | null;
  intentCanvasContextAttachments?: IntentCanvasContextSendAttachment[];
};

export type SelectedAgentOption = {
  id: string;
  name: string;
  prompt?: string | null;
  icon?: string | null;
};

export type AgentConfig = {
  id: string;
  name: string;
  prompt?: string | null;
  icon?: string | null;
  createdAt?: number | null;
};

export type AgentImportPreviewItem = {
  data: AgentConfig;
  status: "new" | "update";
  conflict: boolean;
};

export type AgentImportPreviewResult = {
  items: AgentImportPreviewItem[];
  summary: {
    total: number;
    newCount: number;
    updateCount: number;
  };
};

export type AgentImportApplyResult = {
  success: boolean;
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
};

export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  source: string;
  providerProfileId?: string | null;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string | null;
  isDefault: boolean;
};

export type CollaborationModeOption = {
  id: string;
  label: string;
  mode: string;
  model: string;
  reasoningEffort: string | null;
  developerInstructions: string | null;
  value: Record<string, unknown>;
};

export type SkillOption = {
  name: string;
  path: string;
  description?: string;
  source?: string;
  /**
   * Whether the user has enabled this skill. Defaults to `true` for the
   * 12 source buckets that existed before v0.5.14; curated skills use
   * this field to expose their on/off state to the UI.
   */
  enabled?: boolean;
};

/**
 * One curated skill bundled with the client (v0.5.14+). Sourced from
 * `src-tauri/resources/curated-skills/<id>/` and gated by
 * `skills-lock.json` `kind: "curated"`. Frontend fetches the full list
 * via the `get_curated_skills` IPC and the live `enabled` flag separately
 * via `get_enabled_curated_skill_ids`.
 */
export type CuratedSkillOption = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  icon: string;
  category: "code-style" | "ui-design" | "review" | "debug";
  tokenEstimate: number;
  source: string;
  /**
   * Optional absolute URL pointing at the upstream source
   * repository. Present when the curated skill is a copy of an
   * existing public skill (e.g. `lazy-senior-dev` → the
   * `DietrichGebert/ponytail` repo). The Settings UI surfaces this
   * as an inline "View on GitHub" link. `undefined` (not `null`)
   * keeps the field consistent with optional fields elsewhere in
   * the bundle.
   */
  sourceUrl?: string;
  license: string;
  enabled: boolean;
};

export type CustomPromptOption = {
  name: string;
  path: string;
  description?: string;
  argumentHint?: string;
  content: string;
  scope?: "workspace" | "global";
};

export type CustomCommandOption = {
  name: string;
  path: string;
  description?: string;
  argumentHint?: string;
  content: string;
  source?: string;
};

export type OpenCodeAgentOption = {
  id: string;
  description?: string;
  isPrimary: boolean;
};

export type BranchInfo = {
  name: string;
  lastCommit: number;
};

export type DebugEntry = {
  id: string;
  timestamp: number;
  source: "client" | "server" | "event" | "stderr" | "error";
  label: string;
  payload?: unknown;
};

export type TerminalStatus = "idle" | "connecting" | "ready" | "error";

export type DictationModelState = "missing" | "downloading" | "ready" | "error";

export type DictationDownloadProgress = {
  totalBytes?: number | null;
  downloadedBytes: number;
};

export type DictationModelStatus = {
  state: DictationModelState;
  modelId: string;
  progress?: DictationDownloadProgress | null;
  error?: string | null;
  path?: string | null;
};

export type DictationSessionState = "idle" | "listening" | "processing";

export type DictationEvent =
  | { type: "state"; state: DictationSessionState }
  | { type: "level"; value: number }
  | { type: "transcript"; text: string }
  | { type: "error"; message: string }
  | { type: "canceled"; message: string };

export type DictationTranscript = {
  id: string;
  text: string;
};

// ==================== Engine Types ====================

/**
 * Supported AI coding CLI engine types
 */
export type EngineType = "claude" | "codex" | "gemini" | "opencode";

/**
 * Feature capabilities for each engine
 */
export type EngineFeatures = {
  streaming: boolean;
  reasoning: boolean;
  toolUse: boolean;
  imageInput: boolean;
  sessionContinuation: boolean;
};

/**
 * Model information for an engine
 */
export type EngineModelInfo = {
  id: string;
  model?: string;
  displayName: string;
  description: string;
  source?: string;
  isDefault: boolean;
};

/**
 * Engine installation and availability status
 */
export type EngineStatus = {
  engineType: EngineType;
  installed: boolean;
  version: string | null;
  binPath: string | null;
  features: EngineFeatures;
  models: EngineModelInfo[];
  error: string | null;
};

/**
 * Engine configuration options
 */
export type EngineConfig = {
  binPath: string | null;
  homeDir: string | null;
  customArgs: string | null;
};

/**
 * Parameters for sending a message to an engine
 */
export type EngineSendMessageParams = {
  text: string;
  model: string | null;
  images: string[] | null;
  continueSession: boolean;
  sessionId: string | null;
  forkSessionId?: string | null;
  accessMode: string | null;
  agent?: string | null;
  variant?: string | null;
};

/**
 * Unified engine event types for streaming
 */
export type EngineEvent =
  | {
      type: "sessionStarted";
      workspaceId: string;
      sessionId: string;
      engine: EngineType;
    }
  | {
      type: "turnStarted";
      workspaceId: string;
      turnId: string;
    }
  | {
      type: "textDelta";
      workspaceId: string;
      text: string;
    }
  | {
      type: "reasoningDelta";
      workspaceId: string;
      text: string;
    }
  | {
      type: "toolStarted";
      workspaceId: string;
      toolId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "toolCompleted";
      workspaceId: string;
      toolId: string;
      output: unknown;
      error: string | null;
    }
  | {
      type: "approvalRequest";
      workspaceId: string;
      requestId: unknown;
      toolName: string;
      input: unknown;
      message: string | null;
    }
  | {
      type: "turnCompleted";
      workspaceId: string;
      result: unknown;
    }
  | {
      type: "turnError";
      workspaceId: string;
      error: string;
      code: string | null;
    }
  | {
      type: "sessionEnded";
      workspaceId: string;
      sessionId: string;
    }
  | {
      type: "usageUpdate";
      workspaceId: string;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedTokens: number | null;
    }
  | {
      type: "raw";
      workspaceId: string;
      engine: EngineType;
      data: unknown;
    };
