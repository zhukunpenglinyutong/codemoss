import { vi } from "vitest";
import type { ConversationItem, TurnPlan } from "../../../types";
import { localUsageStatistics } from "../../../services/tauri";
import type { GovernanceEvidenceState } from "../../governance/evidence/useGovernanceEvidence";

export const EMPTY_GOVERNANCE_EVIDENCE_STATE: GovernanceEvidenceState = {
  evidence: [],
  isLoading: false,
  error: null,
};

export const mockUseGovernanceEvidence = vi.fn(
  (_workspaceId: string | null, _enabled: boolean): GovernanceEvidenceState =>
    EMPTY_GOVERNANCE_EVIDENCE_STATE,
);

export const mockEditableDiffReviewSurface = vi.fn(
  (props: Record<string, unknown>) => (
    <div data-testid="checkpoint-diff-viewer">
      {JSON.stringify({
        selectedPath: props.selectedPath,
        workspaceId: props.workspaceId,
        diffStyle: props.diffStyle,
      })}
    </div>
  ),
);

export const mockLocalUsageStatistics = localUsageStatistics;

vi.mock("../../git/components/WorkspaceEditableDiffReviewSurface", () => ({
  WorkspaceEditableDiffReviewSurface: (props: Record<string, unknown>) =>
    mockEditableDiffReviewSurface(props),
}));

vi.mock("../../governance/evidence/useGovernanceEvidence", () => ({
  useGovernanceEvidence: (workspaceId: string | null, enabled: boolean) =>
    mockUseGovernanceEvidence(workspaceId, enabled),
}));

vi.mock("../../../services/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/tauri")>();
  return {
    ...actual,
    localUsageStatistics: vi.fn(),
  };
});

export function resetStatusPanelTestMocks() {
  mockEditableDiffReviewSurface.mockClear();
  mockUseGovernanceEvidence.mockClear();
  mockUseGovernanceEvidence.mockReturnValue(EMPTY_GOVERNANCE_EVIDENCE_STATE);
  vi.mocked(localUsageStatistics).mockReset();
  vi.mocked(localUsageStatistics).mockImplementation(
    () => new Promise(() => {}),
  );
}

export const editToolItem: Extract<ConversationItem, { kind: "tool" }> = {
  id: "tool-edit-1",
  kind: "tool",
  turnId: "turn-1",
  toolType: "edit",
  title: "Edit file",
  detail: '{"path":"README.md"}',
  status: "completed",
  changes: [
    { path: "README.md", kind: "modify" },
    { path: "docs/EXECUTION_PLAN.md", kind: "modify" },
  ],
};

export const rootScopedEditToolItem: Extract<ConversationItem, { kind: "tool" }> = {
  id: "tool-edit-root",
  kind: "tool",
  turnId: "turn-1",
  toolType: "fileChange",
  title: "File changes",
  detail: "{}",
  status: "completed",
  changes: [
    {
      path: "root/README.md",
      kind: "modified",
      diff: "@@ -1 +1 @@\n-old\n+new",
    },
  ],
};

export const childScopedEditToolItem: Extract<ConversationItem, { kind: "tool" }> = {
  id: "tool-edit-child",
  kind: "tool",
  turnId: "turn-1",
  toolType: "fileChange",
  title: "File changes",
  detail: "{}",
  status: "completed",
  changes: [
    {
      path: "child/App.tsx",
      kind: "modified",
      diff: "@@ -1 +1 @@\n-old\n+new",
    },
  ],
};

export const multiStatusEditToolItem: Extract<ConversationItem, { kind: "tool" }> = {
  id: "tool-edit-statuses",
  kind: "tool",
  turnId: "turn-1",
  toolType: "fileChange",
  title: "File changes",
  detail: "{}",
  status: "completed",
  changes: [
    {
      path: "src/Added.tsx",
      kind: "added",
      diff: "@@ -0,0 +1 @@\n+const added = true;",
    },
    {
      path: "src/Removed.tsx",
      kind: "deleted",
      diff: "@@ -1 +0,0 @@\n-const removed = true;",
    },
    {
      path: "src/Renamed.tsx",
      kind: "renamed",
      diff: "@@ -1 +1 @@\n-oldName\n+newName",
    },
    {
      path: "src/Modified.tsx",
      kind: "modified",
      diff: "@@ -1 +1 @@\n-old\n+new",
    },
  ],
};

export const taskToolItem: Extract<ConversationItem, { kind: "tool" }> = {
  id: "tool-task-1",
  kind: "tool",
  turnId: "turn-1",
  toolType: "task",
  title: "Tool: task",
  detail: '{"description":"review plan"}',
  status: "completed",
  output: "done",
};

export const todoWriteToolItem: Extract<ConversationItem, { kind: "tool" }> = {
  id: "tool-todo-1",
  kind: "tool",
  turnId: "turn-1",
  toolType: "unknown",
  title: "Tool: TodoWrite",
  detail: JSON.stringify({
    todos: [{ content: "review plan", status: "completed" }],
  }),
  status: "completed",
};

export const claudeAgentToolItem: Extract<ConversationItem, { kind: "tool" }> = {
  id: "call_fa8bd06e774141c4a7f29a79",
  kind: "tool",
  turnId: "turn-1",
  toolType: "agent",
  title: "Tool: Agent",
  detail:
    '{"description":"Bug诊断与性能安全审查","subagent_type":"java-performance-engineer","taskId":"af452b1b615f93a9e"}',
  status: "completed",
  output: "done",
};

export const collabSpawnToolItem: Extract<ConversationItem, { kind: "tool" }> = {
  id: "spawn-1",
  kind: "tool",
  turnId: "turn-1",
  toolType: "collabToolCall",
  title: "Collab: spawn_agent",
  detail: "From thread-root → agent-7",
  status: "completed",
  output: "Audit current panel",
  receiverThreadIds: ["agent-7"],
};

export const collabWaitToolItem: Extract<ConversationItem, { kind: "tool" }> = {
  id: "wait-1",
  kind: "tool",
  turnId: "turn-1",
  toolType: "collabToolCall",
  title: "Collab: wait",
  detail: "From thread-root → agent-7",
  status: "completed",
  output: "Audit current panel\n\nagent-7: completed",
  receiverThreadIds: ["agent-7"],
  agentStatus: {
    "agent-7": { status: "completed" },
  },
};

export const planSample: TurnPlan = {
  turnId: "turn-1",
  explanation: "plan",
  steps: [
    { step: "step 1", status: "completed" },
    { step: "step 2", status: "pending" },
  ],
};

export const inProgressPlan: TurnPlan = {
  turnId: "turn-2",
  explanation: "plan",
  steps: [{ step: "step in progress", status: "inProgress" }],
};

export const latestUserMessageItems: ConversationItem[] = [
  {
    id: "u1",
    kind: "message",
    role: "user",
    text: "第一条消息\n第二行\n第三行\n第四行\n第五行",
    images: ["diagram.png", "bug.png"],
  },
  {
    id: "a1",
    kind: "message",
    role: "assistant",
    text: "assistant",
  },
  {
    id: "u2",
    kind: "message",
    role: "user",
    text: "第二条用户消息",
  },
];
