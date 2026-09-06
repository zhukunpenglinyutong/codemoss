import type { ComponentType, ReactNode } from "react";
import { cx } from "@/utils/cx";

/**
 * Shared row chrome for the settings modal pages (Figma "Settings/Profile"
 * node 4081:13943 and "Settings/General" node 4079:13037).
 *
 * Every settings group is the same recipe:
 *   card   bg background/secondary, radius/2xl (16px), pl 12 — the left
 *          padding lives on the card so each row's bottom border stops
 *          12px short of the left edge, exactly like Figma.
 *   row    py 10 pr 10, min-height 52, 1px border/button/default under
 *          every row except the last, label left / control right.
 *   label  Body 1/Regular text/primary, optional Body 2/Regular
 *          text/secondary description underneath.
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/** Grouped card — rows divide themselves with borders that respect pl-12. */
export function SettingsCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        "flex w-full flex-col rounded-2xl bg-background-secondary-default pl-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Muted 13px section heading above a card ("Pull Requests", "Notifications"). */
export function SettingsSectionLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p className={cx("w-full px-3 text-body-2-medium text-text-secondary", className)}>{children}</p>
  );
}

/** One label + control row. Rows separate themselves; the last has no border. */
export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex min-h-[52px] w-full items-center justify-between gap-4 py-2.5 pr-2.5",
        "border-b border-separator-border last:border-b-0",
      )}
    >
      <div className="flex min-w-0 flex-col">
        <p className="text-body-regular text-text-primary">{label}</p>
        {description && (
          <p className="text-body-2-regular text-text-secondary">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * The grey read-only value field (Figma "Input" instances — bg
 * background/tertiary, h 32, radius/2lg, 202px wide). Not an editable input
 * in the design: it presents the stored value.
 */
export function SettingsValueField({
  icon: Icon,
  children,
  muted = false,
  className,
}: {
  icon?: IconComponent;
  children: ReactNode;
  /** Secondary text color (e.g. the truncated Device ID). */
  muted?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex h-8 w-[202px] shrink-0 items-center gap-0.5 rounded-2lg bg-background-tertiary-default px-1.5",
        className,
      )}
    >
      {Icon && <Icon className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />}
      <span
        className={cx(
          "truncate pl-1 text-body-regular",
          muted ? "text-text-secondary" : "text-text-primary",
        )}
      >
        {children}
      </span>
    </div>
  );
}
