import type { PolicyDecision } from "./utils/policies";
import type { EngineTaskOutputSource } from "../engine-task-output/types";

export type SubagentNavigationTarget =
  | {
      kind: "thread";
      threadId: string;
    }
  | {
      kind: "claude-task";
      taskId?: string | null;
      toolUseId?: string | null;
    };

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface SubagentInfo {
  id: string;
  type: string;
  description: string;
  status: "running" | "completed" | "error";
  navigationTarget?: SubagentNavigationTarget | null;
  taskOutput?: EngineTaskOutputSource | null;
}

export interface FileChangeSummary {
  filePath: string;
  fileName: string;
  status: "A" | "D" | "R" | "M";
  additions: number;
  deletions: number;
  diff?: string;
}

export interface CommandSummary {
  id: string;
  command: string;
  status: "running" | "completed" | "error";
}

export type TabType =
  | "realtimeStats"
  | "todo"
  | "subagent"
  | "checkpoint"
  | "plan"
  | "command"
  | "latestUserMessage";

export type CheckpointVerdict = "running" | "blocked" | "needs_review" | "ready";

export type CheckpointValidationKind =
  | "lint"
  | "typecheck"
  | "tests"
  | "build"
  | "custom";

export type CheckpointValidationStatus =
  | "pass"
  | "fail"
  | "running"
  | "not_run"
  | "not_observed";

export type CheckpointActionType =
  | "review_diff"
  | "commit";

export type CheckpointMessageToken =
  | {
      key: string;
      params?: Record<string, number | string>;
    }
  | {
      text: string;
    };

export interface CheckpointValidationEvidence {
  kind: CheckpointValidationKind;
  status: CheckpointValidationStatus;
  sourceId: string | null;
}

export interface CheckpointRisk {
  code:
    | "command_failed"
    | "validation_failed"
    | "validation_missing"
    | "subagent_error"
    | "manual_review";
  severity: "high" | "medium" | "low";
  message: CheckpointMessageToken;
  sourceId: string | null;
}

export interface CheckpointAction {
  type: CheckpointActionType;
  label: CheckpointMessageToken;
  enabled: boolean;
}

export interface CheckpointKeyChange {
  id: string;
  label: CheckpointMessageToken;
  summary: CheckpointMessageToken;
  fileCount: number | null;
}

export interface CheckpointViewModel {
  verdict: CheckpointVerdict;
  headline: CheckpointMessageToken;
  summary: CheckpointMessageToken | null;
  policyAudit: readonly PolicyDecision[];
  evidence: {
    changedFiles: number | null;
    additions: number | null;
    deletions: number | null;
    validations: CheckpointValidationEvidence[];
    commands: CommandSummary[];
    todos:
      | {
          completed: number;
          total: number;
          hasInProgress: boolean;
        }
      | null;
    subagents:
      | {
          completed: number;
          total: number;
          hasRunning: boolean;
        }
      | null;
  };
  keyChanges: CheckpointKeyChange[];
  risks: CheckpointRisk[];
  nextActions: CheckpointAction[];
  sources: Array<{
    kind: "file_change" | "command" | "validation" | "task" | "summary";
    sourceId: string;
  }>;
}
