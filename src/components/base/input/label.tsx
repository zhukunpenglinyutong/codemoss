"use client";

import type { ReactNode, Ref } from "react";
import Info from "lucide-react/dist/esm/icons/info";
import type { LabelProps as AriaLabelProps } from "react-aria-components";
import { Label as AriaLabel } from "react-aria-components";
import { cx } from "@/utils/cx";

/**
 * Field label. Wraps `react-aria-components`' Label so the parent `TextField`
 * automatically wires `htmlFor` / `aria-labelledby`.
 *
 * Visuals come from Figma:
 *   - Inter Medium 14/20, color text/primary
 *   - 2px gap between label + required asterisk + info icon
 *   - asterisk is text/error-primary (red/500)
 *   - info icon is 16×16 in foreground/icon/quaternary
 *
 * Pass `isRequired` to show the asterisk. Pass `tooltip` to show the info
 * icon (currently a static glyph — when the Tooltip component lands it'll
 * wire up here).
 */

export interface LabelProps extends AriaLabelProps {
  children: ReactNode;
  isRequired?: boolean;
  /** Reserved for invalid-aware styling (asterisk color, etc.) once we need it. */
  isInvalid?: boolean;
  /** Show the info icon next to the label. */
  tooltip?: boolean | string;
  ref?: Ref<HTMLLabelElement>;
}

export function Label({
  isRequired = false,
  isInvalid: _isInvalid,
  tooltip,
  className,
  children,
  ...props
}: LabelProps) {
  void _isInvalid;
  return (
    <AriaLabel
      data-label="true"
      {...props}
      className={cx(
        "flex cursor-default items-center gap-0.5",
        "text-body-medium text-text-primary",
        className,
      )}
    >
      {children}
      {isRequired && (
        <span
          aria-hidden="true"
          className="text-body-medium text-text-error-primary"
        >
          *
        </span>
      )}
      {tooltip && (
        <Info
          className="size-4 shrink-0 text-foreground-icon-quaternary"
          aria-hidden
        />
      )}
    </AriaLabel>
  );
}
