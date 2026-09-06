import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  Composer,
  StatusBar,
  type ComposerInputHandle,
} from "@/components/application/ai-chat/ai-chat-composer";
import { mentionToken } from "@/components/application/ai-chat/file-tags";
import { MessageQueue } from "@/components/application/ai-chat/message-queue";
import { AddMenu } from "@/components/application/ai-chat/add-menu";
import {
  CliMenu,
  type EffortLevel,
  type ModelOption,
} from "@/components/application/ai-chat/cli-menu";
import type { ContextSegment } from "@/components/application/agent-limits/agent-limits-card";
import { useChatStore, sessionKey, type ActiveSession, type QueuedMessage } from "../store";
import { parseUsage } from "../usage";
import { MessageTimeline } from "./MessageTimeline";
import { ImageLightbox } from "./MessageImages";
import { useGitStore } from "@/features/git/store";
import { ipc, type CliConfig, type EngineCatalog, type EngineInfo, type Workspace } from "@/lib/ipc";
import { isPseudoProvider, providerModel, type EngineId } from "@/features/settings/providers";
import { EmptyState } from "@/components/base/empty-state";

const EMPTY_QUEUE: QueuedMessage[] = [];

/** Assumed context window when the engine does not report one. */
const CONTEXT_WINDOW_TOKENS = 200_000;

type UsagePartKind = "input" | "output" | "cacheRead" | "cacheWrite" | "total";

const USAGE_PART_LABEL_KEYS: Record<UsagePartKind, string> = {
  input: "chat.usageInput",
  output: "chat.usageOutput",
  cacheRead: "chat.usageCacheRead",
  cacheWrite: "chat.usageCacheWrite",
  total: "chat.usageTokens",
};

interface UsageBreakdown {
  pct: number;
  parts: { kind: UsagePartKind; tokens: number }[];
}

function usageBreakdown(usage: unknown): UsageBreakdown | null {
  const u = parseUsage(usage);
  if (!u) return null;
  const parts = [
    { kind: "input" as const, tokens: u.input },
    { kind: "output" as const, tokens: u.output },
    { kind: "cacheRead" as const, tokens: u.cacheRead },
    { kind: "cacheWrite" as const, tokens: u.cacheWrite },
  ].filter((p) => p.tokens > 0);
  return {
    pct: Math.min(100, Math.round((u.total / CONTEXT_WINDOW_TOKENS) * 100)),
    parts: parts.length ? parts : [{ kind: "total", tokens: u.total }],
  };
}

/** Workspace path → trailing folder name for the status bar. */
function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Message list with its own bySession subscription: stream flushes swap the
 * messages array once per animation frame, and this boundary keeps that
 * high-frequency re-render from reaching the composer/status bar above. */
const SessionTimeline = memo(function SessionTimeline({
  sessionKey: key,
  workspacePath,
  onLoadEarlier,
}: {
  sessionKey: string;
  workspacePath: string;
  onLoadEarlier: () => void;
}) {
  const session = useChatStore((s) => s.bySession[key]);
  if (!session) return null;
  return (
    <MessageTimeline
      key={key}
      session={session}
      streaming={session.streaming}
      onLoadEarlier={onLoadEarlier}
      workspacePath={workspacePath}
    />
  );
});

/** Conversation column: timeline, message queue, composer, status bar. The
 * high-frequency session/draft subscriptions live here so streaming deltas
 * (one store write per animation frame) re-render only this subtree — never
 * the sidebar, tab strip, or side panel. */
export const ChatConversation = memo(function ChatConversation({
  active,
  engines,
  workspaces,
  startNewChat,
  composerInputRef,
}: {
  active: ActiveSession | null;
  engines: EngineInfo[];
  workspaces: Workspace[];
  startNewChat: (workspacePath: string) => void;
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
}) {
  const { t } = useTranslation();
  const key = active ? sessionKey(active.engine, active.sessionId, active.workspacePath) : "";
  // Key-scoped, LOW-frequency slices only: streaming flips at turn start/end,
  // queue/error/usage change on discrete actions. The per-flush messages
  // array is subscribed inside SessionTimeline so stream deltas re-render
  // only that subtree — never the composer, queue bar, or status bar here.
  const streaming = useChatStore((s) => (key ? (s.bySession[key]?.streaming ?? false) : false));
  const sessionError = useChatStore((s) => (key ? (s.bySession[key]?.error ?? null) : null));
  const queue = useChatStore((s) => (key ? (s.bySession[key]?.queue ?? EMPTY_QUEUE) : EMPTY_QUEUE));
  const sessionUsage = useChatStore((s) => (key ? s.bySession[key]?.usage : undefined));
  const hasSession = useChatStore((s) => key in s.bySession);
  const draft = useChatStore((s) => s.drafts[key] ?? "");
  const sendShortcut = useChatStore((s) => s.sendShortcut);
  const pendingMention = useChatStore((s) => s.pendingMention);
  // Engine/effort/model prefs: low-frequency, grouped into one shallow watch.
  const { activeEngine, efforts, models } = useChatStore(
    useShallow((s) => ({
      activeEngine: s.activeEngine,
      efforts: s.efforts,
      models: s.models,
    })),
  );
  const {
    setActiveEngine,
    setEffort,
    setModel,
    pinModels,
    setDraft,
    clearPendingMention,
    loadEarlier,
    send,
    queueMessage,
    removeQueued,
    interrupt,
  } = useChatStore(
    useShallow((s) => ({
      setActiveEngine: s.setActiveEngine,
      setEffort: s.setEffort,
      setModel: s.setModel,
      pinModels: s.pinModels,
      setDraft: s.setDraft,
      clearPendingMention: s.clearPendingMention,
      loadEarlier: s.loadEarlier,
      send: s.send,
      queueMessage: s.queueMessage,
      removeQueued: s.removeQueued,
      interrupt: s.interrupt,
    })),
  );
  const branch = useGitStore((s) =>
    active ? s.statusByWorkspace[active.workspacePath]?.branch : undefined,
  );

  const [images, setImages] = useState<string[]>([]);
  /** Composer attachment chip lightbox: preview URL + display name. */
  const [zoomImage, setZoomImage] = useState<{ src: string; name: string } | null>(null);
  /** path → { preview-url, display name } for attachment chip thumbnails.
   * URLs are data URLs from the backend's readFile — the asset protocol scope
   * denies ~/.ccgui-next (app home holds secrets), so asset:// thumbnails of
   * pasted images would be blocked. Same pipeline MessageImages uses. */
  const [previews, setPreviews] = useState<Record<string, { url: string; name: string }>>({});
  const [imageError, setImageError] = useState<string | null>(null);
  /** Drop one attachment and its preview. */
  const removeImage = useCallback((path: string) => {
    setImages((prev) => prev.filter((p) => p !== path));
    setPreviews((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);
  /** Clear all attachments (on submit). */
  const clearImages = useCallback(() => {
    setImages([]);
    setPreviews((prev) => (Object.keys(prev).length > 0 ? {} : prev));
  }, []);
  /** Resolve one attachment's chip thumbnail through readFile (data URL).
   * Unreadable/oversized files simply get no thumbnail — the chip falls back
   * to a plain filename. */
  const loadPreview = useCallback((path: string, name: string) => {
    ipc
      .readFile(path)
      .then((content) => {
        if (content.kind !== "image" || !content.dataUrl) return;
        const url = content.dataUrl;
        setPreviews((prev) => ({ ...prev, [path]: { url, name } }));
      })
      .catch(() => {});
  }, []);
  const [cliConfig, setCliConfig] = useState<CliConfig | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, EngineCatalog>>({});

  // Provider configs feed the model picker's per-engine model lists.
  useEffect(() => {
    ipc.getCliConfig().then(setCliConfig).catch(() => {});
  }, []);
  // Model catalogs for every engine (pi/omp probe their CLI; others return
  // empty and fall back to provider-config models below). The CLI menu's
  // per-engine model flyouts all read from this map.
  useEffect(() => {
    let cancelled = false;
    for (const engine of engines) {
      if (engine.id in catalogs) continue;
      ipc
        .listEngineModels(engine.id)
        .then((list) => {
          if (!cancelled) setCatalogs((prev) => ({ ...prev, [engine.id]: list }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [engines, catalogs]);

  const usage = useMemo(() => usageBreakdown(sessionUsage), [sessionUsage]);
  const engineInfo = engines.find((e) => e.id === activeEngine);
  const supportsImages = engineInfo?.supportsImages ?? false;
  // Per-engine model lists for the CLI menu flyouts: the backend catalog
  // plus, for channel-driven engines, the current provider channel's
  // configured model (both describe the channel the engine would actually
  // launch with), with the current override appended so the selection never
  // vanishes. Claude is exempt: it runs on the CLI's own configuration
  // (~/.claude/settings.json), so app channels contribute nothing.
  const modelsByEngine = useMemo(() => {
    const result: Record<string, ModelOption[]> = {};
    for (const engine of engines) {
      const section = cliConfig?.[engine.id as EngineId];
      const currentId = section?.current ?? "";
      const currentRaw =
        engine.id !== "claude" && currentId && !isPseudoProvider(currentId)
          ? section?.providers?.[currentId]
          : undefined;
      const configured = currentRaw
        ? providerModel(engine.id as EngineId, currentRaw).trim()
        : "";
      const providerModels = configured ? [configured] : [];
      const current = models[engine.id]?.trim();
      const catalog = catalogs[engine.id]?.models ?? [];
      // A channel's configured model leads (it is what the CLI would run
      // unprompted); backend catalogs put the CLI default first.
      const known = [
        ...new Set([...providerModels, ...catalog.map((m) => m.id), ...(current ? [current] : [])]),
      ];
      const nameById = new Map(catalog.map((m) => [m.id, m.name]));
      result[engine.id] = known.map((m) => ({ id: m, label: nameById.get(m) || m }));
    }
    return result;
  }, [engines, cliConfig, catalogs, models]);
  // Selectable ids WITHOUT the current-override append: what the channel
  // plus the backend catalog can actually serve.
  const knownIdsByEngine = useMemo(() => {
    const result: Record<string, Set<string>> = {};
    for (const engine of engines) {
      const section = cliConfig?.[engine.id as EngineId];
      const currentId = section?.current ?? "";
      const currentRaw =
        engine.id !== "claude" && currentId && !isPseudoProvider(currentId)
          ? section?.providers?.[currentId]
          : undefined;
      const configured = currentRaw
        ? providerModel(engine.id as EngineId, currentRaw).trim()
        : "";
      const ids = new Set((catalogs[engine.id]?.models ?? []).map((m) => m.id));
      if (configured) ids.add(configured);
      result[engine.id] = ids;
    }
    return result;
  }, [engines, cliConfig, catalogs]);
  // No "default" pseudo entry: an unset selection would hide which model
  // actually runs. Pin it to the first entry — the CLI's effective default.
  // An authoritative catalog also invalidates stale stored picks (leftovers
  // from older, broader catalogs) that the CLI's model flag cannot resolve.
  // All engines' pins are computed first and written in ONE store action:
  // per-engine setModel would mean one settings persist round-trip each.
  useEffect(() => {
    const updates: Record<string, string> = {};
    for (const engine of engines) {
      const first = modelsByEngine[engine.id]?.[0];
      if (!first) continue;
      const stored = models[engine.id]?.trim();
      if (!stored) {
        updates[engine.id] = first.id;
        continue;
      }
      const catalog = catalogs[engine.id];
      if (
        catalog?.authoritative &&
        catalog.models.length > 0 &&
        !knownIdsByEngine[engine.id]?.has(stored)
      ) {
        updates[engine.id] = first.id;
      }
    }
    if (Object.keys(updates).length > 0) void pinModels(updates);
  }, [engines, models, modelsByEngine, catalogs, knownIdsByEngine, pinModels]);

  // The catalog's context window beats the 200k assumption when the
  // selected model reports one.
  const contextMax =
    (catalogs[activeEngine]?.models ?? []).find((m) => m.id === models[activeEngine])
      ?.contextWindow || CONTEXT_WINDOW_TOKENS;

  const contextSegments: ContextSegment[] | undefined = useMemo(
    () =>
      usage?.parts.map((p) => ({
        label: t(USAGE_PART_LABEL_KEYS[p.kind]),
        tokens: p.tokens,
      })),
    [usage, t],
  );

  // Clipboard images are blobs without a path: persist them via the backend
  // so they flow through the same path-based pipeline every engine consumes
  // (codex -i, kimi path injection, pi/omp @file, claude/grok base64).
  const pasteImages = useCallback(
    (files: File[]) => {
      setImageError(null);
      for (const file of files) {
        const ext = file.type.split("/")[1]?.toLowerCase() ?? "png";
        if (!["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) continue;
        const name = file.name || `pasted-image.${ext}`;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = typeof reader.result === "string" ? reader.result : "";
          const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          if (!base64) return;
          ipc
            .savePastedImage(base64, ext)
            .then((path) => {
              setImages((prev) => [...prev, path]);
              loadPreview(path, name);
            })
            .catch((err) => {
              setImageError(t("chat.imagePasteFailed", { message: String(err) }));
            });
        };
        reader.readAsDataURL(file);
      }
    },
    [t, loadPreview],
  );

  const handleLoadEarlier = useCallback(() => void loadEarlier(), [loadEarlier]);

  const submit = useCallback(
    (value: string) => {
      if (!active || (!value.trim() && images.length === 0)) return;
      setDraft(key, "");
      clearImages();
      // A turn is in flight: park the message in the session's queue; the
      // store drains it FIFO when the turn ends.
      if (streaming) {
        queueMessage(value, images);
        return;
      }
      void send(value, images);
    },
    [active, images, streaming, key, setDraft, clearImages, send, queueMessage],
  );

  // File-tree "+" asks the composer to insert an @path mention at the caret.
  useEffect(() => {
    if (!pendingMention) return;
    clearPendingMention();
    const input = composerInputRef.current;
    if (!input) return;
    input.focus();
    input.insertText(`${mentionToken(pendingMention.path)} `);
  }, [pendingMention, clearPendingMention, composerInputRef]);

  const handleDraftChange = useCallback((v: string) => setDraft(key, v), [key, setDraft]);
  const handleStop = useCallback(() => void interrupt(), [interrupt]);
  const cliOptions = useMemo(
    () =>
      engines.map((e) => ({
        id: e.id,
        label: t(`settings.engines.${e.id}`),
        available: e.available,
        disabled: !e.available,
        disabledReason: t("chat.engineNotInstalled"),
      })),
    [engines, t],
  );
  const handleModelChange = useCallback(
    (engine: string, m: string) => void setModel(engine, m),
    [setModel],
  );
  const handleEffortChange = useCallback(
    (engine: string, level: EffortLevel) => void setEffort(engine, level),
    [setEffort],
  );
  const statusFolders = useMemo(() => workspaces.map((w) => folderName(w.path)), [workspaces]);
  const handleFolderSelect = useCallback(
    (name: string) => {
      const target = workspaces.find((w) => folderName(w.path) === name);
      if (target) startNewChat(target.path);
    },
    [workspaces, startNewChat],
  );

  const addMenu = useMemo(
    () => (
      <AddMenu
        disabled={!supportsImages}
        disabledReason={t("chat.imagesUnsupported")}
      />
    ),
    [supportsImages, t],
  );
  const cliMenu = useMemo(
    () => (
      <CliMenu
        options={cliOptions}
        value={activeEngine}
        onChange={setActiveEngine}
        modelsByEngine={modelsByEngine}
        models={models}
        onModelChange={handleModelChange}
        efforts={efforts}
        onEffortChange={handleEffortChange}
      />
    ),
    [
      cliOptions,
      activeEngine,
      setActiveEngine,
      modelsByEngine,
      models,
      handleModelChange,
      efforts,
      handleEffortChange,
    ],
  );

  return (
    <>
      {active && hasSession ? (
        <>
          {sessionError && (
            <div className="mx-4 mt-3 rounded-lg border border-border-error-default bg-background-tertiary-error px-3 py-2 text-body-regular text-text-error-primary">
              {sessionError}
            </div>
          )}
          <SessionTimeline
            sessionKey={key}
            workspacePath={active.workspacePath}
            onLoadEarlier={handleLoadEarlier}
          />
        </>
      ) : (
        <EmptyState className="text-body-medium">{t("chat.selectSession")}</EmptyState>
      )}

      <div className="flex w-full flex-col gap-2.5 bg-background-primary-default px-4 pt-2.5 pb-2">
        <MessageQueue queue={queue} onRemove={removeQueued} />
        {imageError && (
          <div className="rounded-lg border border-border-error-default bg-background-tertiary-error px-3 py-2 text-body-regular text-text-error-primary">
            {imageError}
          </div>
        )}
        {images.length > 0 && (
          <div className="mx-auto w-full max-w-3xl">
            <div className="flex flex-wrap gap-1.5">
              {images.map((path) => {
                const preview = previews[path];
                return (
                  <span
                    key={path}
                    className="inline-flex items-center rounded-full bg-background-tertiary-default text-caption-1-medium text-text-secondary"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        preview &&
                        setZoomImage({ src: preview.url, name: preview.name })
                      }
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-l-full py-0.5 pl-0.5"
                      aria-label={preview?.name ?? path.split("/").pop()}
                    >
                      {preview && (
                        <img
                          src={preview.url}
                          alt=""
                          className="size-6 shrink-0 rounded-full object-cover"
                        />
                      )}
                      <span className="max-w-48 truncate">
                        {preview?.name ?? path.split("/").pop()}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={t("common.close")}
                      onClick={() => removeImage(path)}
                      className="cursor-pointer rounded-r-full py-0.5 pr-2 pl-1 hover:text-text-primary"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        )}
        <Composer
          className="mx-auto max-w-3xl"
          value={draft}
          onValueChange={handleDraftChange}
          onSubmit={submit}
          sendShortcut={sendShortcut === "cmdEnter" ? "cmdEnter" : "enter"}
          onStop={handleStop}
          streaming={streaming}
          disabled={!active || (!draft.trim() && images.length === 0)}
          inputRef={composerInputRef}
          addMenu={addMenu}
          cliMenu={cliMenu}
          onPasteImages={supportsImages ? pasteImages : undefined}
        />
        <div className="mx-auto w-full max-w-3xl">
          <StatusBar
            branch={branch}
            folders={statusFolders}
            selectedFolder={active ? folderName(active.workspacePath) : undefined}
            onFolderSelect={handleFolderSelect}
            usagePct={usage?.pct}
            contextMax={contextMax}
            contextSegments={contextSegments}
          />
        </div>
      </div>
      {zoomImage && (
        <ImageLightbox
          src={zoomImage.src}
          name={zoomImage.name}
          onClose={() => setZoomImage(null)}
        />
      )}
    </>
  );
});
