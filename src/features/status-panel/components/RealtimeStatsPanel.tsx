import Bot from "lucide-react/dist/esm/icons/bot";
import Coins from "lucide-react/dist/esm/icons/coins";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import MessagesSquare from "lucide-react/dist/esm/icons/messages-square";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Zap from "lucide-react/dist/esm/icons/zap";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import type {
  ConversationItem,
  EngineType,
  LocalUsageSessionSummary,
  LocalUsageStatistics,
  LocalUsageUsageData,
  ThreadTokenUsage,
} from "../../../types";
import { localUsageStatistics } from "../../../services/tauri";

type RealtimeStatsPanelProps = {
  workspaceName?: string | null;
  workspacePath?: string | null;
  branchName?: string | null;
  activeThreadId?: string | null;
  activeTurnId?: string | null;
  selectedEngine?: EngineType | null;
  selectedModelId?: string | null;
  activeTokenUsage?: ThreadTokenUsage | null;
  items: ConversationItem[];
  isProcessing: boolean;
  processingStartedAt?: number | null;
  lastDurationMs?: number | null;
};

type UsageWindowId = "5h" | "24h" | "7d" | "30d";

type UsageWindowOption = {
  id: UsageWindowId;
  label: string;
  dateRange: "7d" | "30d";
  durationMs: number;
};

type UsageWindowSummary = {
  usage: LocalUsageUsageData;
  cost: number;
  sessions: number;
};

const USAGE_WINDOWS: readonly UsageWindowOption[] = [
  { id: "5h", label: "5h", dateRange: "7d", durationMs: 5 * 60 * 60 * 1000 },
  { id: "24h", label: "24h", dateRange: "7d", durationMs: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7d", dateRange: "7d", durationMs: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30d", dateRange: "30d", durationMs: 30 * 24 * 60 * 60 * 1000 },
];

const EMPTY_LOCAL_USAGE: LocalUsageUsageData = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
};

function formatNumber(value: number | null | undefined) {
  const safe = Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(safe);
}

function formatCompactNumber(value: number | null | undefined) {
  const safe = Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
  if (safe < 10_000) {
    return formatNumber(safe);
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(safe);
}

function formatCost(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const safe = Math.max(0, value);
  if (safe === 0) {
    return "$0.00";
  }
  if (safe < 0.01) {
    return "<$0.01";
  }
  return `$${safe.toFixed(2)}`;
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function formatPath(value: string | null | undefined) {
  if (!value) {
    return "--";
  }
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) {
    return value;
  }
  return `.../${parts.slice(-2).join("/")}`;
}

function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return "--";
  }
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function projectNameFromPath(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
}

function countMessages(items: ConversationItem[]) {
  return items.reduce(
    (total, item) => (item.kind === "message" ? total + 1 : total),
    0,
  );
}

function addUsage(left: LocalUsageUsageData, right: LocalUsageUsageData) {
  left.inputTokens += Math.max(0, right.inputTokens);
  left.outputTokens += Math.max(0, right.outputTokens);
  left.cacheWriteTokens += Math.max(0, right.cacheWriteTokens);
  left.cacheReadTokens += Math.max(0, right.cacheReadTokens);
  left.totalTokens += Math.max(0, right.totalTokens);
}

function buildWindowSummary(
  statistics: LocalUsageStatistics | null,
  usageWindow: UsageWindowOption,
): UsageWindowSummary {
  if (!statistics) {
    return {
      usage: { ...EMPTY_LOCAL_USAGE },
      cost: 0,
      sessions: 0,
    };
  }
  const cutoff = Date.now() - usageWindow.durationMs;
  const sessions = statistics.sessions.filter((session) => session.timestamp >= cutoff);
  const usage = { ...EMPTY_LOCAL_USAGE };
  let cost = 0;
  for (const session of sessions) {
    addUsage(usage, session.usage);
    cost += Number.isFinite(session.cost) ? Math.max(0, session.cost) : 0;
  }
  if (usage.totalTokens <= 0) {
    usage.totalTokens =
      usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  }
  return {
    usage,
    cost,
    sessions: sessions.length,
  };
}

function getUsageSegments(usage: LocalUsageUsageData) {
  const rawSegments = [
    { id: "input", label: "输入", value: usage.inputTokens },
    { id: "output", label: "输出", value: usage.outputTokens },
    { id: "cache-write", label: "缓存写入", value: usage.cacheWriteTokens },
    { id: "cache-read", label: "缓存读取", value: usage.cacheReadTokens },
  ];
  const total = rawSegments.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  return rawSegments.map((segment) => ({
    ...segment,
    share: total > 0 ? (Math.max(0, segment.value) / total) * 100 : 0,
  }));
}

function inferEngineLabel(
  selectedEngine: EngineType | null | undefined,
  session: LocalUsageSessionSummary | null,
) {
  if (selectedEngine) {
    return selectedEngine === "codex"
      ? "Codex"
      : selectedEngine === "claude"
        ? "Claude Code"
        : selectedEngine === "gemini"
          ? "Gemini"
          : selectedEngine === "opencode"
            ? "OpenCode"
            : selectedEngine;
  }
  const hint = `${session?.model ?? ""} ${session?.provider ?? ""} ${session?.source ?? ""}`
    .toLowerCase()
    .trim();
  if (hint.includes("claude") || hint.includes("anthropic")) {
    return "Claude Code";
  }
  if (hint.includes("gemini") || hint.includes("google")) {
    return "Gemini";
  }
  if (hint.includes("opencode")) {
    return "OpenCode";
  }
  if (hint.includes("gpt") || hint.includes("codex") || hint.includes("openai")) {
    return "Codex";
  }
  return "Runtime";
}

function RealtimeMetricCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "cyan" | "green" | "blue" | "yellow" | "purple";
}) {
  return (
    <div className={`sp-realtime-metric is-${accent}`}>
      <span className="sp-realtime-dot" />
      <span className="sp-realtime-metric-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function RealtimeStatsPanel({
  workspaceName,
  workspacePath,
  branchName,
  activeThreadId,
  activeTurnId,
  selectedEngine,
  selectedModelId,
  activeTokenUsage,
  items,
  isProcessing,
  processingStartedAt = null,
  lastDurationMs = null,
}: RealtimeStatsPanelProps) {
  const [usageWindowId, setUsageWindowId] = useState<UsageWindowId>("5h");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [usageState, setUsageState] = useState<{
    statistics: LocalUsageStatistics | null;
    loading: boolean;
    error: string | null;
  }>({
    statistics: null,
    loading: true,
    error: null,
  });

  const usageWindow =
    USAGE_WINDOWS.find((option) => option.id === usageWindowId) ?? USAGE_WINDOWS[0];

  useEffect(() => {
    if (!isProcessing) {
      return;
    }
    setClockNow(Date.now());
    const interval = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isProcessing]);

  useEffect(() => {
    let cancelled = false;

    async function loadUsage() {
      setUsageState((current) => ({ ...current, loading: true, error: null }));
      try {
        const statistics = await localUsageStatistics({
          scope: "all",
          provider: "all",
          dateRange: usageWindow.dateRange,
          workspacePath: null,
        });
        if (!cancelled) {
          setUsageState({
            statistics,
            loading: false,
            error: null,
          });
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setUsageState((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    }

    void loadUsage();
    const interval = window.setInterval(() => void loadUsage(), 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [usageWindow.dateRange]);

  const usageSummary = useMemo(
    () => buildWindowSummary(usageState.statistics, usageWindow),
    [usageState.statistics, usageWindow],
  );
  const latestUsageSession = usageState.statistics?.sessions[0] ?? null;
  const tokenSegments = getUsageSegments(usageSummary.usage);
  const tokenTotal = Math.max(0, usageSummary.usage.totalTokens);
  const cacheTotal =
    Math.max(0, usageSummary.usage.cacheWriteTokens) +
    Math.max(0, usageSummary.usage.cacheReadTokens);
  const cachePercent = tokenTotal > 0 ? (cacheTotal / tokenTotal) * 100 : null;
  const contextUsed = activeTokenUsage?.contextUsedTokens ?? null;
  const contextWindow = activeTokenUsage?.modelContextWindow ?? null;
  const contextPercent =
    activeTokenUsage?.contextUsedPercent ??
    (contextUsed !== null && contextWindow && contextWindow > 0
      ? (contextUsed / contextWindow) * 100
      : null);
  const engineLabel = inferEngineLabel(selectedEngine, latestUsageSession);
  const messageCount = countMessages(items);
  const userMessageCount = items.filter(
    (item) => item.kind === "message" && item.role === "user",
  ).length;
  const assistantMessageCount = items.filter(
    (item) => item.kind === "message" && item.role === "assistant",
  ).length;
  const toolCount = items.filter((item) => item.kind === "tool").length;
  const sessionDurationMs =
    isProcessing && processingStartedAt
      ? Math.max(0, clockNow - processingStartedAt)
      : lastDurationMs;
  const sessionDurationLabel =
    formatDuration(sessionDurationMs) !== "--"
      ? formatDuration(sessionDurationMs)
      : isProcessing
        ? "运行中"
        : "--";
  const displayPath = workspacePath || latestUsageSession?.cwd || null;
  const displayProjectName =
    workspaceName || projectNameFromPath(displayPath) || "未选择项目";
  const displayModel = selectedModelId || latestUsageSession?.model || "--";
  const displayBranch = branchName?.trim() || "--";
  const activityLabel = isProcessing
    ? "运行中"
    : activeThreadId || activeTurnId
      ? "已暂停"
      : "待命";
  const usageStatusLabel = usageState.loading
    ? "刷新中"
    : usageState.error
      ? "暂无数据"
      : "已更新";

  return (
    <section className="sp-realtime" aria-label="实时统计">
      <div className="sp-realtime-status">
        <span className={`sp-realtime-live-dot${isProcessing ? " is-live" : ""}`} />
        <strong>实时统计</strong>
        <span className="sp-realtime-engine-pill">
          <Zap size={13} aria-hidden />
          {engineLabel}
        </span>
        <span className="sp-realtime-now">{activityLabel}</span>
      </div>

      <div className="sp-realtime-card sp-realtime-session">
        <div className="sp-realtime-card-icon">
          <MessagesSquare size={18} aria-hidden />
        </div>
        <div className="sp-realtime-session-main">
          <div className="sp-realtime-card-title">
            <span>会话</span>
            <span className="sp-realtime-engine-pill is-muted">{engineLabel}</span>
          </div>
          <dl className="sp-realtime-facts">
            <div>
              <dt>项目</dt>
              <dd>{displayProjectName}</dd>
            </div>
            <div>
              <dt>路径</dt>
              <dd title={displayPath ?? undefined}>{formatPath(displayPath)}</dd>
            </div>
            <div>
              <dt>分支</dt>
              <dd className="is-accent">
                <GitBranch size={12} aria-hidden />
                {displayBranch}
              </dd>
            </div>
          </dl>
          <div className="sp-realtime-metric-grid">
            <RealtimeMetricCard
              accent="cyan"
              label="消息数"
              value={formatNumber(messageCount)}
            />
            <RealtimeMetricCard
              accent="green"
              label="会话时长"
              value={sessionDurationLabel}
            />
          </div>
          <div className="sp-realtime-message-row">
            <span>用户 {formatNumber(userMessageCount)}</span>
            <span>助手 {formatNumber(assistantMessageCount)}</span>
            <span>工具 {formatNumber(toolCount)}</span>
          </div>
        </div>
      </div>

      <div className="sp-realtime-card">
        <div className="sp-realtime-section-heading">
          <div className="sp-realtime-card-icon is-token">
            <Coins size={18} aria-hidden />
          </div>
          <h3>Token 用量</h3>
          <span className="sp-realtime-badge">{formatCompactNumber(tokenTotal)}</span>
        </div>
        <div className="sp-realtime-window-tabs" role="tablist" aria-label="Token 用量时间段">
          {USAGE_WINDOWS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={usageWindowId === option.id}
              className={usageWindowId === option.id ? "is-active" : ""}
              onClick={() => setUsageWindowId(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="sp-realtime-token-body">
          <div
            className="sp-realtime-token-ring"
            style={
              {
                "--token-progress": `${Math.min(100, Math.max(0, cachePercent ?? 0))}%`,
              } as CSSProperties
            }
          >
            <strong>{usageState.loading ? "--" : formatCompactNumber(tokenTotal)}</strong>
          </div>
          <div className="sp-realtime-token-grid">
            <RealtimeMetricCard
              accent="green"
              label="输入"
              value={usageState.loading ? "--" : formatCompactNumber(usageSummary.usage.inputTokens)}
            />
            <RealtimeMetricCard
              accent="yellow"
              label="输出"
              value={usageState.loading ? "--" : formatCompactNumber(usageSummary.usage.outputTokens)}
            />
            <RealtimeMetricCard
              accent="purple"
              label="缓存写入"
              value={
                usageState.loading ? "--" : formatCompactNumber(usageSummary.usage.cacheWriteTokens)
              }
            />
            <RealtimeMetricCard
              accent="blue"
              label="缓存读取"
              value={
                usageState.loading ? "--" : formatCompactNumber(usageSummary.usage.cacheReadTokens)
              }
            />
          </div>
        </div>
        <div className="sp-realtime-segment-bar" aria-hidden>
          {tokenSegments.map((segment) => (
            <span
              key={segment.id}
              className={`is-${segment.id}`}
              style={{ width: `${Math.max(segment.share, tokenTotal > 0 ? 4 : 25)}%` }}
            />
          ))}
        </div>
        <div className="sp-realtime-cost-row">
          <span>估算费用</span>
          <strong>{usageState.loading ? "--" : formatCost(usageSummary.cost)}</strong>
        </div>
        <div className="sp-realtime-usage-meta">
          <span>全部终端</span>
          <span>{formatNumber(usageSummary.sessions)} sessions</span>
          <span>缓存 {cachePercent === null ? "--" : formatPercent(cachePercent)}</span>
          <span
            className={usageState.error ? "is-muted" : ""}
            title={usageState.error ?? undefined}
          >
            {usageStatusLabel}
          </span>
          {usageState.loading ? <RefreshCw size={12} aria-hidden /> : null}
        </div>
      </div>

      <div className="sp-realtime-card">
        <div className="sp-realtime-section-heading">
          <div className="sp-realtime-card-icon is-model">
            <Bot size={18} aria-hidden />
          </div>
          <h3>模型与上下文</h3>
        </div>
        <dl className="sp-realtime-model-list">
          <div>
            <dt>模型</dt>
            <dd>{displayModel}</dd>
          </div>
          <div>
            <dt>当前上下文</dt>
            <dd>{contextUsed !== null ? formatCompactNumber(contextUsed) : "--"}</dd>
          </div>
          <div>
            <dt>上下文上限</dt>
            <dd>{contextWindow ? formatCompactNumber(contextWindow) : "--"}</dd>
          </div>
          <div>
            <dt>剩余空间</dt>
            <dd>{formatPercent(activeTokenUsage?.contextRemainingPercent)}</dd>
          </div>
        </dl>
        <div className="sp-realtime-context-track">
          <span style={{ width: `${Math.min(100, Math.max(0, contextPercent ?? 0))}%` }} />
        </div>
      </div>
    </section>
  );
}
