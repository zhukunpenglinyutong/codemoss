import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConversationItem,
  EngineType,
  MessageSendOptions,
  QueuedMessage,
  WorkspaceInfo,
} from "../../../types";
import { pushErrorToast } from "../../../services/toasts";
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraft,
} from "../../composer/hooks/composerDraftStore";
import { useComposerImages } from "../../composer/hooks/useComposerImages";
import { useQueuedSend } from "../../threads/hooks/useQueuedSend";

export function useComposerController({
  activeThreadId,
  activeItems,
  activeTurnId,
  activeContinuationPulse,
  activeTerminalPulse,
  activeWorkspaceId,
  activeWorkspace,
  isProcessing,
  isReviewing,
  hasPendingUserInput,
  steerEnabled,
  activeEngine,
  resolveCanonicalThreadId,
  connectWorkspace,
  startThreadForWorkspace,
  sendUserMessage,
  sendUserMessageToThread,
  handleFusionStalled,
  startFork,
  startReview,
  startResume,
  startMcp,
  startSpecRoot,
  startStatus,
  startContext,
  startExport,
  startImport,
  startLsp,
  startShare,
  startCompact,
  startFast,
  startMode,
  setCodexCollaborationMode,
  getCodexCollaborationMode,
  getCodexCollaborationPayload,
  interruptTurn,
}: {
  activeThreadId: string | null;
  activeItems?: ConversationItem[];
  activeTurnId?: string | null;
  activeContinuationPulse?: number;
  activeTerminalPulse?: number;
  activeWorkspaceId: string | null;
  activeWorkspace: WorkspaceInfo | null;
  isProcessing: boolean;
  isReviewing: boolean;
  hasPendingUserInput?: boolean;
  steerEnabled: boolean;
  activeEngine?: EngineType;
  resolveCanonicalThreadId: (threadId: string) => string;
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
  startThreadForWorkspace: (
    workspaceId: string,
    options?: { activate?: boolean; engine?: EngineType; folderId?: string | null },
  ) => Promise<string | null>;
  sendUserMessage: (
    text: string,
    images?: string[],
    options?: MessageSendOptions,
  ) => Promise<void>;
  sendUserMessageToThread: (
    workspace: WorkspaceInfo,
    threadId: string,
    text: string,
    images?: string[],
    options?: MessageSendOptions,
  ) => Promise<void>;
  handleFusionStalled?: (
    threadId: string,
    options?: { message?: string | null },
  ) => void;
  startFork: (text: string, options?: MessageSendOptions) => Promise<void>;
  startReview: (text: string) => Promise<void>;
  startResume: (text: string) => Promise<void>;
  startMcp: (text: string) => Promise<void>;
  startSpecRoot: (text: string) => Promise<void>;
  startStatus: (text: string) => Promise<void>;
  startContext: (text: string) => Promise<void>;
  startExport: (text: string) => Promise<void>;
  startImport: (text: string) => Promise<void>;
  startLsp: (text: string) => Promise<void>;
  startShare: (text: string) => Promise<void>;
  startCompact: (text: string) => Promise<void>;
  startFast: (text: string) => Promise<void>;
  startMode: (text: string) => Promise<void>;
  setCodexCollaborationMode?: (mode: "plan" | "code") => void;
  getCodexCollaborationMode?: () => "plan" | "code" | null;
  getCodexCollaborationPayload?: () => Record<string, unknown> | null;
  interruptTurn?: (options?: {
    reason?: "user-stop" | "queue-fusion";
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [prefillDraft, setPrefillDraft] = useState<QueuedMessage | null>(null);
  const [composerInsert, setComposerInsert] = useState<QueuedMessage | null>(
    null,
  );

  const {
    activeImages,
    attachImages,
    pickImages,
    removeImage,
    clearActiveImages,
    setImagesForThread,
    removeImagesForThread,
  } = useComposerImages({ activeThreadId, activeWorkspaceId });

  const {
    activeQueue,
    activeQueuedHandoffBubble,
    handleSend,
    queueMessage,
    removeQueuedMessage,
    fuseQueuedMessage,
    canFuseActiveQueue,
    activeFusingMessageId,
  } = useQueuedSend({
    activeThreadId,
    activeItems,
    activeTurnId,
    activeContinuationPulse,
    activeTerminalPulse,
    isProcessing,
    isReviewing,
    hasPendingUserInput,
    steerEnabled,
    activeWorkspace,
    activeEngine,
    resolveCanonicalThreadId,
    connectWorkspace,
    startThreadForWorkspace,
    sendUserMessage,
    sendUserMessageToThread,
    handleFusionStalled,
    startFork,
    startReview,
    startResume,
    startMcp,
    startSpecRoot,
    startStatus,
    startContext,
    startExport,
    startImport,
    startLsp,
    startShare,
    startCompact,
    startFast,
    startMode,
    setCodexCollaborationMode,
    getCodexCollaborationMode,
    getCodexCollaborationPayload,
    interruptTurn,
    clearActiveImages,
  });

  // 草稿活在模块级 composerDraftStore 里,这里只暴露读写入口。写入不经 React state,
  // 因此按键不会再从 app-shell 根引发全树重渲染;需要草稿"值"的组件自行订阅 store。
  const getActiveDraft = useCallback(
    () => getComposerDraft(activeThreadId),
    [activeThreadId],
  );

  const handleDraftChange = useCallback(
    (next: string) => {
      setComposerDraft(activeThreadId, next);
    },
    [activeThreadId],
  );

  const handleSendPrompt = useCallback(
    (text: string) => {
      if (!text.trim()) {
        return;
      }
      void handleSend(text, []);
    },
    [handleSend],
  );

  const handleEditQueued = useCallback(
    (item: QueuedMessage) => {
      if (!activeThreadId) {
        return;
      }
      removeQueuedMessage(activeThreadId, item.id);
      setImagesForThread(activeThreadId, item.images ?? []);
      setPrefillDraft(item);
    },
    [activeThreadId, removeQueuedMessage, setImagesForThread],
  );

  const handleDeleteQueued = useCallback(
    (id: string) => {
      if (!activeThreadId) {
        return;
      }
      removeQueuedMessage(activeThreadId, id);
    },
    [activeThreadId, removeQueuedMessage],
  );

  const handleFuseQueued = useCallback(
    async (id: string) => {
      if (!activeThreadId) {
        return;
      }
      try {
        await fuseQueuedMessage(activeThreadId, id);
      } catch (error) {
        pushErrorToast({
          title: t("chat.fuseQueuedMessageFailed"),
          message:
            error instanceof Error && error.message
              ? error.message
              : t("chat.fuseQueuedMessageFailedDetail"),
        });
      }
    },
    [activeThreadId, fuseQueuedMessage, t],
  );

  const clearDraftForThread = useCallback((threadId: string) => {
    clearComposerDraft(threadId);
  }, []);

  return {
    activeImages,
    attachImages,
    pickImages,
    removeImage,
    clearActiveImages,
    setImagesForThread,
    removeImagesForThread,
    activeQueue,
    activeQueuedHandoffBubble,
    handleSend,
    queueMessage,
    removeQueuedMessage,
    prefillDraft,
    setPrefillDraft,
    composerInsert,
    setComposerInsert,
    getActiveDraft,
    handleDraftChange,
    handleSendPrompt,
    handleEditQueued,
    handleDeleteQueued,
    handleFuseQueued,
    canFuseActiveQueue,
    activeFusingMessageId,
    clearDraftForThread,
  };
}
