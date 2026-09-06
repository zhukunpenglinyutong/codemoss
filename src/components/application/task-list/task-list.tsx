"use client";

import type { ReactNode } from "react";
import { LogRow, ShimmerText } from "@/components/application/agent-log/agent-log";
import { cx } from "@/utils/cx";

/**
 * Task List — step rows for the agent's working transcript.
 *
 * Only the step-row layer lives on: the animated top-level `TaskList` (timed
 * reveal, collapsing task headers) had no production caller and was removed.
 * `StepRow` is what MessageTimeline renders for each historical step; the
 * reveal, the clipping edge and the curved guide all come from Agent Log.
 */

/* ----------------------------------------------------------------- types */

export interface TaskListChip {
  /** Chip label, e.g. a file name. */
  label: string;
  /** Optional leading glyph — a file-type or product mark. */
  icon?: ReactNode;
}

export interface TaskListStep {
  /** The line of text, e.g. `Scanning 52 files`. */
  label: string;
  /** Resource chips rendered inline after the label. */
  chips?: TaskListChip[];
}

/* ------------------------------------------------------------- internals */

function Chip({ chip }: { chip: TaskListChip }) {
  return (
    <span
      className={cx(
        "mr-0.5 ml-[3px] inline-flex max-w-full -translate-y-px items-center gap-1 rounded-md border py-0.5 pr-1.5 align-middle",
        // Quiet at rest so a row of chips does not out-shout the step text,
        // then the border and surface firm up together under the cursor so the
        // chip reads as something you can act on.
        "border-border-button-default/50 bg-background-secondary-default",
        "transition-colors duration-150 ease hover:border-border-button-hover hover:bg-background-tertiary-default",
        chip.icon ? "pl-1" : "pl-1.5",
      )}
    >
      {chip.icon ? (
        <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
          {chip.icon}
        </span>
      ) : null}
      <span className="truncate text-caption-2-medium text-text-primary">{chip.label}</span>
    </span>
  );
}

export function StepRow({
  step,
  active,
  first,
  last,
  reduce,
}: {
  step: TaskListStep;
  active: boolean;
  first: boolean;
  last: boolean;
  reduce: boolean;
}) {
  return (
    <LogRow first={first} last={last} reduce={reduce}>
      <span className="block py-1 break-words text-body-regular text-text-secondary">
        {active ? <ShimmerText>{step.label}</ShimmerText> : step.label}
        {step.chips?.map((chip, index) => (
          <Chip key={`${chip.label}-${index}`} chip={chip} />
        ))}
      </span>
    </LogRow>
  );
}
