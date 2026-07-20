import type { EngineType } from "./engine";

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

/**
 * Durable "last used" composer preferences, remembered per engine so a brand-new
 * conversation reopens with the same model / reasoning effort / permission / plan
 * mode the user last chose (survives app restart via AppSettings persistence).
 */
export type ComposerEnginePrefs = {
  modelId: string | null;
  effort: string | null;
  accessMode: AccessMode | null;
  collaborationModeId: string | null;
};

export type QueuedMessage = {
  id: string;
  text: string;
  createdAt: number;
  images?: string[];
  sendOptions?: MessageSendOptions;
  eagerOptimisticUserId?: string;
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
  eagerOptimisticUserId?: string;
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
