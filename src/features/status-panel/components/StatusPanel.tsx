import {
  memo,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3";
import Bot from "lucide-react/dist/esm/icons/bot";
import FileEdit from "lucide-react/dist/esm/icons/file-edit";
import ListChecks from "lucide-react/dist/esm/icons/list-checks";
import ListTodo from "lucide-react/dist/esm/icons/list-todo";
import MessageSquareQuote from "lucide-react/dist/esm/icons/message-square-quote";
import type { LucideIcon } from "lucide-react";
import type { ConversationItem, GitFileStatus, TurnPlan } from "../../../types";
import type { EngineType, ThreadTokenUsage } from "../../../types";
import { isEngineCapabilityAvailable } from "../../engine/engineCapabilityMatrix";
import { useStatusPanelData } from "../hooks/useStatusPanelData";
import {
  createFrozenGovernanceEvidenceSnapshot,
  createHarnessGovernanceEvidence,
} from "../../governance/evidence";
import { useGovernanceEvidence } from "../../governance/evidence/useGovernanceEvidence";
import type { FileChangeSummary, SubagentInfo, TabType } from "../types";
import {
  buildCheckpointViewModel,
  resolveCheckpointGeneratedSummary,
} from "../utils/checkpoint";
import { resolvePlanStepStatusForDisplay } from "../../threads/utils/threadNormalize";
import { CheckpointPanel } from "./CheckpointPanel";
import type { CodeAnnotationBridgeProps } from "../../code-annotations/types";
import { PlanList } from "./PlanList";
import { SubagentList } from "./SubagentList";
import { TodoList } from "./TodoList";
import { UserConversationTimelinePanel } from "./UserConversationTimelinePanel";
import { resolveUserConversationTimeline } from "../utils/userConversationTimeline";
import { CostBudgetSection } from "./CostBudgetSection";
import { GovernanceEvidenceSection } from "./GovernanceEvidenceSection";
import { projectCostRecord } from "../../context-ledger/cost-budget";
import { EngineTaskOutputInspector } from "../../engine-task-output/components/EngineTaskOutputInspector";
import { useEngineTaskOutputSnapshot } from "../../engine-task-output/hooks/useEngineTaskOutputSnapshot";
import type { EngineTaskOutputSnapshot } from "../../engine-task-output/types";
import { buildEngineTaskOutputSnapshot } from "../../engine-task-output/utils/engineTaskOutputProjection";
import { RealtimeStatsPanel } from "./RealtimeStatsPanel";

interface StatusPanelProps extends CodeAnnotationBridgeProps {
  workspaceId?: string | null;
  workspaceName?: string | null;
  workspacePath?: string | null;
  branchName?: string | null;
  items: ConversationItem[];
  isProcessing: boolean;
  expanded?: boolean;
  plan?: TurnPlan | null;
  isPlanMode?: boolean;
  isCodexEngine?: boolean;
  activeThreadId?: string | null;
  activeTurnId?: string | null;
  selectedEngine?: EngineType | null;
  selectedModelId?: string | null;
  activeTokenUsage?: ThreadTokenUsage | null;
  processingStartedAt?: number | null;
  lastDurationMs?: number | null;
  workspaceGitFiles?: GitFileStatus[];
  workspaceGitStagedFiles?: GitFileStatus[];
  workspaceGitUnstagedFiles?: GitFileStatus[];
  workspaceGitTotals?: {
    additions: number;
    deletions: number;
  } | null;
  workspaceGitDiffs?: Array<{
    path: string;
    status: string;
    diff: string;
  }>;
  itemsByThread?: Record<string, ConversationItem[]>;
  threadParentById?: Record<string, string>;
  threadStatusById?: Record<string, { isProcessing?: boolean } | undefined>;
  onOpenDiffPath?: (path: string) => void;
  onOpenFilePath?: (path: string) => void;
  onSelectSubagent?: (agent: SubagentInfo) => void;
  onJumpToConversationMessage?: (messageId: string) => void;
  variant?: "popover" | "dock";
  visibleDockTabs?: Partial<Record<TabType, boolean>>;
  onRefreshGitStatus?: (() => void) | null;
  commitMessage?: string;
  commitMessageLoading?: boolean;
  commitMessageError?: string | null;
  onCommitMessageChange?: (value: string) => void;
  onGenerateCommitMessage?: (
    language?: "zh" | "en",
    engine?: "codex" | "claude" | "gemini" | "opencode",
    selectedPaths?: string[],
  ) => void | Promise<void>;
  onCommit?: (selectedPaths?: string[]) => void | Promise<void>;
  commitLoading?: boolean;
  commitError?: string | null;
  preferredDockTab?: TabType | null;
  preferredDockTabRequestKey?: number;
  dockCollapsed?: boolean;
  onCollapseDock?: () => void;
  onExpandDock?: () => void;
  onExpandToDock?: () => void;
}

type StatusPanelTabDefinition = {
  tab: TabType;
  labelKey: string;
  icon: LucideIcon;
  visible: boolean;
  badge?: ReactNode;
  loading?: boolean;
};

const DOCK_TAB_ORDER: readonly TabType[] = [
  "realtimeStats",
  "checkpoint",
  "latestUserMessage",
  "todo",
  "subagent",
  "plan",
];

const POPOVER_TAB_ORDER: readonly TabType[] = [
  "todo",
  "subagent",
  "checkpoint",
  "plan",
];

function resolvePreferredTab(
  variant: "popover" | "dock",
  showPlanTab: boolean,
  visibleDockTabs?: Partial<Record<TabType, boolean>>,
  dockTabAvailability?: Partial<Record<TabType, boolean>>,
): TabType | null {
  if (variant === "dock") {
    const isVisible = (tab: TabType) =>
      isDockTabVisible(
        variant,
        tab,
        showPlanTab,
        visibleDockTabs,
        dockTabAvailability,
      );

    for (const tab of DOCK_TAB_ORDER) {
      if (isVisible(tab)) {
        return tab;
      }
    }
  }
  return null;
}

function hasTabData(completed: number, total: number) {
  return completed > 0 || total > 0;
}

function isDockTabVisible(
  variant: "popover" | "dock",
  tab: TabType,
  showPlanTab: boolean,
  visibleDockTabs?: Partial<Record<TabType, boolean>>,
  dockTabAvailability?: Partial<Record<TabType, boolean>>,
): boolean {
  if (variant !== "dock") {
    return true;
  }
  if (tab === "plan" && !showPlanTab) {
    return false;
  }
  if (visibleDockTabs?.[tab] === false) {
    return false;
  }
  return dockTabAvailability?.[tab] !== false;
}

export const StatusPanel = memo(function StatusPanel({
  workspaceId = null,
  workspaceName = null,
  workspacePath = null,
  branchName = null,
  items,
  isProcessing,
  expanded = true,
  plan = null,
  isPlanMode = false,
  isCodexEngine = false,
  activeThreadId = null,
  activeTurnId = null,
  selectedEngine = null,
  selectedModelId = null,
  activeTokenUsage = null,
  processingStartedAt = null,
  lastDurationMs = null,
  workspaceGitFiles,
  workspaceGitStagedFiles = [],
  workspaceGitUnstagedFiles = [],
  workspaceGitTotals = null,
  workspaceGitDiffs = [],
  itemsByThread,
  threadParentById,
  threadStatusById,
  onOpenDiffPath,
  onOpenFilePath,
  onSelectSubagent,
  onJumpToConversationMessage,
  variant = "popover",
  visibleDockTabs,
  onRefreshGitStatus = null,
  commitMessage = "",
  commitMessageLoading = false,
  commitMessageError = null,
  onCommitMessageChange,
  onGenerateCommitMessage,
  onCommit,
  commitLoading = false,
  commitError = null,
  preferredDockTab = null,
  preferredDockTabRequestKey = 0,
  dockCollapsed = false,
  onCollapseDock,
  onExpandDock,
  onExpandToDock,
  onCreateCodeAnnotation,
  onRemoveCodeAnnotation,
  codeAnnotations,
}: StatusPanelProps) {
  const { t } = useTranslation();
  const deferredItems = useDeferredValue(items);
  const effectiveItems = isProcessing ? deferredItems : items;
  const {
    commands,
    fileChanges,
    subagents,
    todoCompleted,
    todoTotal,
    todos,
    hasInProgressTodo,
    subagentCompleted,
    subagentTotal,
    hasRunningSubagent,
    totalAdditions,
    totalDeletions,
  } = useStatusPanelData(effectiveItems, {
    isCodexEngine,
    activeThreadId,
    activeTurnId,
    itemsByThread,
    threadParentById,
    threadStatusById,
  });

  const hasPlanData = isPlanMode || Boolean(plan);
  const statusPanelEngine = selectedEngine ?? (isCodexEngine ? "codex" : null);
  const supportsCollaborationMode =
    statusPanelEngine !== null &&
    isEngineCapabilityAvailable(statusPanelEngine, "collaboration.mode");
  const usePlanAsTaskList = isCodexEngine && supportsCollaborationMode;
  const showPlanTab = hasPlanData && !usePlanAsTaskList;
  const panelRef = useRef<HTMLDivElement>(null);
  const planTotal = plan?.steps.length ?? 0;
  const planCompleted =
    plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const codexTaskItems = useMemo(() => {
    if (usePlanAsTaskList && plan && plan.steps.length > 0) {
      return plan.steps.map((step) => {
        const statusForDisplay = resolvePlanStepStatusForDisplay(
          step.status,
          isProcessing,
        );
        return {
          content: step.step,
          status:
            statusForDisplay === "completed"
              ? ("completed" as const)
              : statusForDisplay === "inProgress"
                ? ("in_progress" as const)
                : ("pending" as const),
        };
      });
    }
    return todos;
  }, [isProcessing, plan, todos, usePlanAsTaskList]);
  const codexTaskCompleted = useMemo(
    () => codexTaskItems.filter((item) => item.status === "completed").length,
    [codexTaskItems],
  );
  const codexTaskTotal = codexTaskItems.length;
  const codexTaskInProgress = codexTaskItems.some(
    (item) => item.status === "in_progress",
  );
  const userConversationTimeline = useMemo(
    () =>
      resolveUserConversationTimeline(effectiveItems, {
        enableCollaborationBadge: isCodexEngine,
      }),
    [effectiveItems, isCodexEngine],
  );
  const workspaceFileChanges = useMemo<FileChangeSummary[]>(() => {
    const diffByPath = new Map(
      (workspaceGitDiffs ?? []).map((entry) => [entry.path, entry.diff]),
    );
    return (workspaceGitFiles ?? []).map((entry) => ({
      filePath: entry.path,
      fileName: entry.path.split(/[\\/]/).pop() ?? entry.path,
      status:
        entry.status === "A" || entry.status === "D" || entry.status === "R"
          ? entry.status
          : "M",
      additions: entry.additions,
      deletions: entry.deletions,
      diff: diffByPath.get(entry.path),
    }));
  }, [workspaceGitDiffs, workspaceGitFiles]);
  const canonicalCheckpointFileFacts =
    workspaceGitFiles !== undefined ? workspaceFileChanges : null;
  const displayedFileChanges =
    workspaceGitFiles !== undefined ? workspaceFileChanges : fileChanges;
  const displayedTotalAdditions =
    workspaceGitFiles !== undefined
      ? (workspaceGitTotals?.additions ??
        workspaceFileChanges.reduce((sum, entry) => sum + entry.additions, 0))
      : totalAdditions;
  const displayedTotalDeletions =
    workspaceGitFiles !== undefined
      ? (workspaceGitTotals?.deletions ??
        workspaceFileChanges.reduce((sum, entry) => sum + entry.deletions, 0))
      : totalDeletions;
  const shouldShowTodoTab = usePlanAsTaskList
    ? hasTabData(codexTaskCompleted, codexTaskTotal)
    : hasTabData(todoCompleted, todoTotal);
  const shouldShowSubagentTab = hasTabData(subagentCompleted, subagentTotal);
  const shouldShowPlanTab = showPlanTab && hasTabData(planCompleted, planTotal);
  const dockTabAvailability = useMemo<Partial<Record<TabType, boolean>>>(
    () => ({
      realtimeStats: true,
      latestUserMessage: true,
      todo: shouldShowTodoTab,
      subagent: shouldShowSubagentTab,
      checkpoint: true,
      plan: shouldShowPlanTab,
    }),
    [shouldShowPlanTab, shouldShowSubagentTab, shouldShowTodoTab],
  );
  const [openTab, setOpenTab] = useState<TabType | null>(() =>
    resolvePreferredTab(
      variant,
      showPlanTab,
      visibleDockTabs,
      dockTabAvailability,
    ),
  );
  const [inspectedTaskOutput, setInspectedTaskOutput] =
    useState<EngineTaskOutputSnapshot | null>(null);
  const inspectedTaskOutputState = useEngineTaskOutputSnapshot({
    workspaceId,
    snapshot: inspectedTaskOutput,
  });

  useEffect(() => {
    if (variant !== "popover" || !openTab) return;
    function handleClickOutside(event: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node)
      ) {
        setOpenTab(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openTab, variant]);

  useEffect(() => {
    if (variant !== "popover" || !openTab) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenTab(null);
      }
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [openTab, variant]);

  const preferredTab = resolvePreferredTab(
    variant,
    showPlanTab,
    visibleDockTabs,
    dockTabAvailability,
  );
  const resolvedPreferredDockTab =
    variant === "dock" &&
    preferredDockTab &&
    isDockTabVisible(
      variant,
      preferredDockTab,
      showPlanTab,
      visibleDockTabs,
      dockTabAvailability,
    )
      ? preferredDockTab
      : null;

  useEffect(() => {
    if (!resolvedPreferredDockTab) {
      return;
    }
    setOpenTab(resolvedPreferredDockTab);
  }, [preferredDockTabRequestKey, resolvedPreferredDockTab]);

  useEffect(() => {
    if (variant === "dock") {
      if (
        !openTab ||
        !isDockTabVisible(
          variant,
          openTab,
          showPlanTab,
          visibleDockTabs,
          dockTabAvailability,
        )
      ) {
        setOpenTab(preferredTab);
      }
      return;
    }
    if (openTab === "plan" && !showPlanTab) {
      setOpenTab(preferredTab);
    }
  }, [
    dockTabAvailability,
    openTab,
    preferredTab,
    showPlanTab,
    variant,
    visibleDockTabs,
  ]);

  const handleTabClick = useCallback(
    (tab: TabType) => {
      setOpenTab((previous) => {
        if (variant === "dock") {
          return tab;
        }
        return previous === tab ? null : tab;
      });
      if (variant === "dock" && dockCollapsed) {
        onExpandDock?.();
      }
    },
    [dockCollapsed, onExpandDock, variant],
  );

  const activeTab =
    variant === "dock"
      ? openTab &&
        isDockTabVisible(
          variant,
          openTab,
          showPlanTab,
          visibleDockTabs,
          dockTabAvailability,
        )
        ? openTab
        : preferredTab
      : openTab;
  const governanceEvidenceState = useGovernanceEvidence(
    workspaceId,
    variant === "dock" && activeTab === "checkpoint" && Boolean(workspaceId),
  );
  const costGovernanceEvidence = useMemo(() => {
    if (!selectedEngine || !activeTokenUsage) {
      return [];
    }
    const costRecord = projectCostRecord({
      engine: selectedEngine,
      model: selectedModelId,
      usage: activeTokenUsage,
      scope: "session",
    });
    const evidence = [];
    if (costRecord.degradationReason === "pricing-unavailable") {
      evidence.push(
        createHarnessGovernanceEvidence({
          id: `cost-budget:pricing:${selectedEngine}:${selectedModelId ?? "unknown"}`,
          source: "cost-budget",
          status: "unknown",
          degraded: true,
          degradationReason: "pricing-unavailable",
          title: "Pricing unavailable",
          summary: `${selectedEngine}/${selectedModelId ?? "unknown model"} has usage but no traceable pricing source.`,
          provenance: {
            sourceType: "runtime",
            sourceId: activeThreadId ?? "active-thread",
            observedAt: new Date(0).toISOString(),
            qualifier: "token-only-cost-mode",
          },
        }),
      );
    }
    if (!costRecord.degraded && costRecord.amountUsd != null) {
      evidence.push(
        createHarnessGovernanceEvidence({
          id: `cost-budget:unconfigured:${activeThreadId ?? "active-thread"}`,
          source: "cost-budget",
          status: "warn",
          degraded: false,
          title: "Budget unconfigured",
          summary:
            "Cost can be projected, but no session budget is configured.",
          provenance: {
            sourceType: "runtime",
            sourceId: activeThreadId ?? "active-thread",
            observedAt: new Date(0).toISOString(),
            qualifier: "budget-unconfigured",
          },
        }),
      );
    }
    return evidence;
  }, [activeThreadId, activeTokenUsage, selectedEngine, selectedModelId]);
  const governanceSnapshot = useMemo(
    () =>
      governanceEvidenceState.evidence.length + costGovernanceEvidence.length >
      0
        ? createFrozenGovernanceEvidenceSnapshot({
            evidence: [
              ...governanceEvidenceState.evidence,
              ...costGovernanceEvidence,
            ],
          })
        : null,
    [costGovernanceEvidence, governanceEvidenceState.evidence],
  );
  const checkpoint = useMemo(
    () =>
      buildCheckpointViewModel({
        todos: usePlanAsTaskList ? codexTaskItems : todos,
        subagents,
        fileChanges,
        commands,
        isProcessing,
        generatedSummary: resolveCheckpointGeneratedSummary(effectiveItems),
        canonicalFileFacts: canonicalCheckpointFileFacts,
        governanceSnapshot,
      }),
    [
      canonicalCheckpointFileFacts,
      commands,
      codexTaskItems,
      effectiveItems,
      fileChanges,
      governanceSnapshot,
      isProcessing,
      subagents,
      todos,
      usePlanAsTaskList,
    ],
  );

  const tabDefinitions = useMemo<Record<TabType, StatusPanelTabDefinition>>(
    () => ({
      realtimeStats: {
        tab: "realtimeStats",
        labelKey: "statusPanel.tabRealtimeStats",
        icon: BarChart3,
        visible:
          variant === "dock" &&
          isDockTabVisible(
            variant,
            "realtimeStats",
            showPlanTab,
            visibleDockTabs,
            dockTabAvailability,
          ),
        badge: isProcessing ? <span className="sp-tab-loading" /> : null,
      },
      latestUserMessage: {
        tab: "latestUserMessage",
        labelKey: "statusPanel.tabLatestUserMessage",
        icon: MessageSquareQuote,
        visible:
          variant === "dock" &&
          isDockTabVisible(
            variant,
            "latestUserMessage",
            showPlanTab,
            visibleDockTabs,
            dockTabAvailability,
          ),
        badge: (
          <span className="sp-tab-count">
            {userConversationTimeline.items.length}
          </span>
        ),
      },
      todo: {
        tab: "todo",
        labelKey: "statusPanel.tabTodos",
        icon: ListChecks,
        visible:
          variant === "dock"
            ? isDockTabVisible(
                variant,
                "todo",
                showPlanTab,
                visibleDockTabs,
                dockTabAvailability,
              )
            : shouldShowTodoTab,
        badge: (
          <span className="sp-tab-count">
            {usePlanAsTaskList
              ? `${codexTaskCompleted}/${codexTaskTotal}`
              : `${todoCompleted}/${todoTotal}`}
          </span>
        ),
        loading:
          isProcessing &&
          (usePlanAsTaskList ? codexTaskInProgress : hasInProgressTodo),
      },
      subagent: {
        tab: "subagent",
        labelKey: isCodexEngine
          ? "statusPanel.tabAgents"
          : "statusPanel.tabSubagents",
        icon: Bot,
        visible:
          variant === "dock"
            ? isDockTabVisible(
                variant,
                "subagent",
                showPlanTab,
                visibleDockTabs,
                dockTabAvailability,
              )
            : shouldShowSubagentTab,
        badge: (
          <span className="sp-tab-count">
            {subagentCompleted}/{subagentTotal}
          </span>
        ),
        loading: isProcessing && hasRunningSubagent,
      },
      checkpoint: {
        tab: "checkpoint",
        labelKey: "statusPanel.tabCheckpoint",
        icon: FileEdit,
        visible:
          variant === "dock"
            ? isDockTabVisible(
                variant,
                "checkpoint",
                showPlanTab,
                visibleDockTabs,
                dockTabAvailability,
              )
            : true,
        badge: (
          <span className="sp-tab-count">
            {t(`statusPanel.checkpoint.verdict.${checkpoint.verdict}`)}
          </span>
        ),
      },
      plan: {
        tab: "plan",
        labelKey: "statusPanel.tabPlan",
        icon: ListTodo,
        visible:
          variant === "dock"
            ? isDockTabVisible(
                variant,
                "plan",
                showPlanTab,
                visibleDockTabs,
                dockTabAvailability,
              )
            : shouldShowPlanTab,
        badge: (
          <span className="sp-tab-count">
            {planCompleted}/{planTotal}
          </span>
        ),
        loading: isProcessing && isPlanMode,
      },
      command: {
        tab: "command",
        labelKey: "statusPanel.tabCommands",
        icon: FileEdit,
        visible: false,
      },
    }),
    [
      checkpoint.verdict,
      codexTaskCompleted,
      codexTaskInProgress,
      codexTaskTotal,
      dockTabAvailability,
      hasInProgressTodo,
      hasRunningSubagent,
      isCodexEngine,
      isProcessing,
      isPlanMode,
      planCompleted,
      planTotal,
      shouldShowPlanTab,
      shouldShowSubagentTab,
      shouldShowTodoTab,
      showPlanTab,
      subagentCompleted,
      subagentTotal,
      t,
      todoCompleted,
      todoTotal,
      userConversationTimeline.items.length,
      usePlanAsTaskList,
      variant,
      visibleDockTabs,
    ],
  );

  if (!expanded) return null;

  if (variant === "dock" && !preferredTab) {
    return null;
  }

  const contentNode = (
    <>
      {activeTab === "realtimeStats" && (
        <RealtimeStatsPanel
          workspaceName={workspaceName}
          workspacePath={workspacePath}
          branchName={branchName}
          activeThreadId={activeThreadId}
          activeTurnId={activeTurnId}
          selectedEngine={selectedEngine}
          selectedModelId={selectedModelId}
          activeTokenUsage={activeTokenUsage}
          items={effectiveItems}
          isProcessing={isProcessing}
          processingStartedAt={processingStartedAt}
          lastDurationMs={lastDurationMs}
        />
      )}
      {activeTab === "todo" && (
        <TodoList todos={usePlanAsTaskList ? codexTaskItems : todos} />
      )}
      {activeTab === "subagent" && (
        <>
          <SubagentList
            subagents={subagents}
            onSelectSubagent={(agent) => {
              onSelectSubagent?.(agent);
              if (variant !== "dock") {
                setOpenTab(null);
              }
            }}
            onInspectSubagent={(agent) => {
              if (!agent.taskOutput) {
                return;
              }
              setInspectedTaskOutput(
                buildEngineTaskOutputSnapshot(agent.taskOutput, activeTokenUsage),
              );
            }}
          />
          {inspectedTaskOutput ? (
            <div className="sp-subagent-output">
              <EngineTaskOutputInspector
                snapshot={inspectedTaskOutputState.snapshot ?? inspectedTaskOutput}
                refreshState={inspectedTaskOutputState.refreshState}
                onRefresh={inspectedTaskOutputState.refresh}
                onClose={() => setInspectedTaskOutput(null)}
              />
            </div>
          ) : null}
        </>
      )}
      {activeTab === "checkpoint" && (
        <>
          {variant === "dock" ? (
            <GovernanceEvidenceSection
              evidence={[
                ...governanceEvidenceState.evidence,
                ...costGovernanceEvidence,
              ]}
              isLoading={governanceEvidenceState.isLoading}
            />
          ) : null}
          <CostBudgetSection
            compact={variant !== "dock"}
            engine={selectedEngine}
            model={selectedModelId}
            usage={activeTokenUsage}
            sessionId={activeThreadId}
          />
          <CheckpointPanel
            checkpoint={checkpoint}
            compact={variant !== "dock"}
            fileChanges={displayedFileChanges}
            totalAdditions={displayedTotalAdditions}
            totalDeletions={displayedTotalDeletions}
            onOpenDiffPath={onOpenDiffPath}
            onOpenFilePath={onOpenFilePath}
            workspaceId={workspaceId}
            workspacePath={workspacePath}
            onRefreshGitStatus={onRefreshGitStatus}
            commitMessage={commitMessage}
            commitMessageLoading={commitMessageLoading}
            commitMessageError={commitMessageError}
            onCommitMessageChange={onCommitMessageChange}
            onGenerateCommitMessage={onGenerateCommitMessage}
            onCommit={onCommit}
            commitLoading={commitLoading}
            commitError={commitError}
            stagedFiles={workspaceGitStagedFiles}
            unstagedFiles={workspaceGitUnstagedFiles}
            onCreateCodeAnnotation={onCreateCodeAnnotation}
            onRemoveCodeAnnotation={onRemoveCodeAnnotation}
            codeAnnotations={codeAnnotations}
            onExpandToDock={
              onExpandToDock
                ? () => {
                    onExpandToDock();
                    if (variant !== "dock") {
                      setOpenTab(null);
                    }
                  }
                : undefined
            }
            onAfterSelect={() => {
              if (variant !== "dock") {
                setOpenTab(null);
              }
            }}
          />
        </>
      )}
      {activeTab === "latestUserMessage" && variant === "dock" && (
        <UserConversationTimelinePanel
          timeline={userConversationTimeline}
          onJumpToMessage={onJumpToConversationMessage}
        />
      )}
      {activeTab === "plan" && (
        <PlanList
          plan={plan}
          isPlanMode={isPlanMode}
          isProcessing={isProcessing}
          isCodexEngine={isCodexEngine}
        />
      )}
    </>
  );

  const orderedTabs = variant === "dock" ? DOCK_TAB_ORDER : POPOVER_TAB_ORDER;

  return (
    <div
      className={`sp-root${variant === "dock" ? " sp-root--dock" : ""}${
        variant === "dock" && dockCollapsed ? " sp-root--dock-collapsed" : ""
      }`}
      ref={panelRef}
    >
      {variant === "dock" ? (
        <>
          <div className="sp-tabs sp-tabs--dock">
            {onCollapseDock || onExpandDock ? (
              <button
	                type="button"
	                className="sp-dock-panel-toggle"
	                onClick={dockCollapsed ? onExpandDock : onCollapseDock}
	                aria-label={
                  dockCollapsed ? "Show status panel" : "Hide status panel"
                }
                title={dockCollapsed ? "Show status panel" : "Hide status panel"}
              >
                <span
                  className={`codicon ${
                    dockCollapsed
                      ? "codicon-chevron-up"
                      : "codicon-chevron-down"
                  }`}
                  aria-hidden
                />
              </button>
            ) : null}
            {orderedTabs
              .map((tab) => tabDefinitions[tab])
              .filter((definition) => definition.visible)
              .map((definition) => {
                const Icon = definition.icon;
                return (
                  <button
                    key={definition.tab}
                    type="button"
                    className={`sp-tab${activeTab === definition.tab ? " sp-tab-active" : ""}`}
                    onClick={() => handleTabClick(definition.tab)}
                    aria-expanded={activeTab === definition.tab}
                  >
                    <Icon size={14} className="sp-tab-icon" />
                    <span className="sp-tab-label">
                      {t(definition.labelKey)}
                    </span>
                    {definition.badge}
                    {definition.loading ? (
                      <span className="sp-tab-loading" />
                    ) : null}
                  </button>
                );
              })}
          </div>
          {!dockCollapsed ? (
            <div className="sp-dock-shell">
              <div className="sp-popover-content sp-dock-content">
                {contentNode}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {openTab ? (
            <div className="sp-popover">
              <div className="sp-popover-content">{contentNode}</div>
            </div>
          ) : null}
          <div className="sp-tabs">
            {orderedTabs
              .map((tab) => tabDefinitions[tab])
              .filter((definition) => definition.visible)
              .map((definition) => {
                const Icon = definition.icon;
                return (
                  <button
                    key={definition.tab}
                    type="button"
                    className={`sp-tab${activeTab === definition.tab ? " sp-tab-active" : ""}`}
                    onClick={() => handleTabClick(definition.tab)}
                    aria-expanded={activeTab === definition.tab}
                  >
                    <Icon size={14} className="sp-tab-icon" />
                    <span className="sp-tab-label">
                      {t(definition.labelKey)}
                    </span>
                    {definition.badge}
                    {definition.loading ? (
                      <span className="sp-tab-loading" />
                    ) : null}
                  </button>
                );
              })}
          </div>
        </>
      )}
    </div>
  );
});
