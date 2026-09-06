"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Search from "lucide-react/dist/esm/icons/search";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
  Slider as AriaSlider,
  SliderThumb as AriaSliderThumb,
  SliderTrack as AriaSliderTrack,
} from "react-aria-components";
import { AnimatePresence, motion } from "motion/react";
import { menuPopoverSurface } from "@/components/base/dropdown/menu-styles";
import { CLI_DISPLAY_NAMES, EngineIcon, inferModelEngine } from "@/components/foundations/icons/engine-icon";
import { cx } from "@/utils/cx";
import { usePopoverState } from "@/utils/use-dismiss-on-outside-press";
import { FlameOverlay } from "./effort-flame";

/**
 * Board UI → "ai_chat" dropdowns (nodes 4035:6313 / 4035:6925), adapted to
 * live data. Same react-aria non-modal popover recipe as the template;
 * contents are props-driven:
 * - CliMenu — CLI + model switcher opened from the composer's engine
 *   button: each engine row flies out a model + effort panel to the right
 *   (search field over a "Models" radio group over the effort slider,
 *   Board UI node 4035:6925). */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** CLI picker panel: shadcn-style menu (reference: desktop-cc-gui's
 *  ModelSelect) — 8px radius, 4px padding, hairline separators between rows,
 *  no header label. Distinct from the other ai_chat popovers above. */
const CLI_POPOVER_CLASSES = menuPopoverSurface({
  width: "w-64",
  origin: "origin-bottom-left",
  radius: "rounded-lg",
  padding: "p-1",
});

/* ------------------------------------------------------------- engine picker */

export interface MenuOption {
  id: string;
  label: string;
  /** Engine is installed and spawnable — drives the status dot. */
  available?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

const EFFORT_LABEL_KEYS: Record<EffortLevel, string> = {
  low: "chat.effortLow",
  medium: "chat.effortMedium",
  high: "chat.effortHigh",
  xhigh: "chat.effortXhigh",
  max: "chat.effortMax",
};

/** Fresh random impulse per tick each time the engine ignites: blown left by
 *  the exhaust with random lift, tumble and stagger, like debris. */
function useBlastImpulses(isMax: boolean) {
  return useMemo(
    () =>
      EFFORT_LEVELS.map(() => ({
        x: -(70 + Math.random() * 130),
        y: (Math.random() - 0.5) * 70,
        rotate: (Math.random() - 0.5) * 720,
        delay: Math.random() * 0.3,
      })),
    [isMax],
  );
}

/** The tick row on the effort track: one tick per stop, fading past the
 *  current value; at max they blast off like exhaust debris. */
function EffortTicks({
  index,
  isMax,
  blast,
}: {
  index: number;
  isMax: boolean;
  blast: { x: number; y: number; rotate: number; delay: number }[];
}) {
  return (
    <div className="absolute inset-x-[9px] top-[7px] flex h-[13px] items-center justify-between">
      {EFFORT_LEVELS.map((level, i) => (
        <motion.span
          key={level}
          aria-hidden
          animate={
            isMax
              ? {
                  x: blast[i].x,
                  y: blast[i].y,
                  rotate: blast[i].rotate,
                  opacity: 0,
                }
              : { x: 0, y: 0, rotate: 0, opacity: i > index ? 0.3 : 1 }
          }
          transition={
            isMax
              ? { duration: 1.6, ease: [0.22, 0.5, 0.5, 1], delay: blast[i].delay }
              : { duration: 0.3, ease: "easeOut" }
          }
          className="h-full w-[3px] rounded-[2px] bg-foreground-icon-tertiary"
        />
      ))}
    </div>
  );
}

/**
 * Effort slider (Board UI Figma node 4037:4885, five stops here): 27px
 * neutral track with a tick per stop, a light fill up to the 21×27 bordered
 * thumb. Built on react-aria's Slider for drag + keyboard support.
 *
 * The thumb travels edge to edge: its center moves from 10.5px to
 * (width − 10.5)px, and the tick row is inset to match, so ticks sit on the
 * stops at any rendered width. At max the ticks blast off like exhaust
 * debris and the flame shader washes over the track.
 */
function EffortSlider({
  value,
  onChange,
}: {
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
}) {
  const { t } = useTranslation();
  const index = Math.max(0, EFFORT_LEVELS.indexOf(value));
  const isMax = index === EFFORT_LEVELS.length - 1;
  const blast = useBlastImpulses(isMax);
  // Thumb center sits at `fraction` of the 21px-inset rail, so its right
  // edge is at fraction × (track − 21px) + 21px — in calc() so the fill
  // lands flush against the thumb at any rendered width.
  const fraction = index / (EFFORT_LEVELS.length - 1);

  return (
    <AriaSlider
      aria-label={t("chat.effort")}
      minValue={0}
      maxValue={EFFORT_LEVELS.length - 1}
      step={1}
      value={index}
      onChange={(v) => onChange(EFFORT_LEVELS[v as number] ?? "medium")}
      className="w-full"
    >
      <div className="relative h-[27px] w-full overflow-hidden rounded-lg bg-background-secondary-default">
        {/* Fill up to the thumb's right edge. */}
        <div
          className="absolute inset-y-0 left-0 rounded-lg bg-background-tertiary-hover transition-[width] duration-150 ease-out"
          style={{ width: `calc(${fraction} * (100% - 21px) + 21px)` }}
        />
        <EffortTicks index={index} isMax={isMax} blast={blast} />
        {/* Above the ticks so the flame washes over the step dividers. */}
        <AnimatePresence>{isMax && <FlameOverlay />}</AnimatePresence>
        {/* Rail inset by half the thumb width so the 21px thumb lands flush
            on both track edges. The wrapper does the absolute positioning
            because SliderTrack forces `position: relative` inline. */}
        <div className="absolute inset-x-[10.5px] inset-y-0">
          <AriaSliderTrack className="h-full w-full">
            <AriaSliderThumb className="top-1/2 h-[27px] w-[21px] cursor-grab rounded-[7px] border border-border-checkbox-default bg-background-primary-default shadow-xs outline-none transition-shadow data-[dragging]:cursor-grabbing data-[focus-visible]:ring-2 data-[focus-visible]:ring-border-focus-ring" />
          </AriaSliderTrack>
        </div>
      </div>
    </AriaSlider>
  );
}

export interface ModelOption {
  /** "" selects the CLI/provider default model. */
  id: string;
  label: string;
}

/** Per-engine model flyout: pops to the right of the CLI popover, bottom-
 *  aligned with the engine list so the taller panel never clips below the
 *  composer-anchored popover. */
const FLYOUT_CLASSES = cx(
  "absolute left-full bottom-0 z-10 ml-2 w-72 max-w-[calc(100vw-32px)]",
  "rounded-lg border border-border-button-default bg-background-primary-default p-1 shadow-dropdown",
);

/* -------------------------------------------------------------- engine row */

/** One engine row in the CLI list: brand mark, name, selection dot (active
 *  engine only) and the chevron that hints at the flyout. */
function EngineRow({
  option,
  selected,
  flyoutOpen,
  onSelect,
  onHover,
}: {
  option: MenuOption;
  selected: boolean;
  /** This engine's flyout is currently open. */
  flyoutOpen: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      aria-disabled={option.disabled || undefined}
      title={option.disabled ? option.disabledReason : undefined}
      aria-pressed={selected}
      onClick={onSelect}
      onMouseEnter={onHover}
      onFocus={onHover}
      className={cx(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors",
        selected || flyoutOpen
          ? "bg-background-primary-hover"
          : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
        option.disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <EngineIcon
        engine={option.id}
        size={18}
        className="shrink-0 text-foreground-icon-primary"
      />
      <span className="text-body-medium text-text-primary">
        {CLI_DISPLAY_NAMES[option.id] ?? option.label}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {selected && (
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-notification-success-foreground"
          />
        )}
        <ChevronRight
          className="size-4 text-foreground-icon-secondary"
          aria-hidden
        />
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ flyout */

/** One checkmark model row inside the flyout's radio group. */
function ModelRow({
  option,
  selected,
  engineId,
  onPick,
}: {
  option: ModelOption;
  selected: boolean;
  engineId: string;
  onPick: (engine: string, id: string) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onPick(engineId, option.id)}
      className={cx(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors",
        selected
          ? "bg-background-primary-hover"
          : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
      )}
    >
      <EngineIcon
        engine={inferModelEngine(`${option.label} ${option.id}`) ?? engineId}
        size={18}
        className="shrink-0 text-foreground-icon-primary"
      />
      <span className="truncate text-body-medium whitespace-nowrap text-text-primary">
        {option.label}
      </span>
      {selected && (
        <Check
          className="ml-auto size-4 shrink-0 text-foreground-icon-primary"
          aria-hidden
        />
      )}
    </button>
  );
}

/** The flyout's effort section: label with a keyed blur-in value, the
 *  faster/smarter captions, and the five-stop slider. */
function FlyoutEffortSection({
  effort,
  onChange,
}: {
  effort: EffortLevel;
  onChange: (level: EffortLevel) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col">
      <span className="pl-2 text-body-medium text-text-secondary">
        {t("chat.effort")}{" "}
        {/* Keyed on the value so each change remounts and blurs in. */}
        <motion.span
          key={effort}
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="inline-block text-text-primary"
        >
          {t(EFFORT_LABEL_KEYS[effort])}
        </motion.span>
      </span>
      <div className="flex w-full items-center justify-between px-2 pt-2 pb-[3px]">
        <span className="text-body-2-medium whitespace-nowrap text-text-secondary">
          {t("chat.effortFaster")}
        </span>
        <span className="text-body-2-medium whitespace-nowrap text-text-secondary">
          {t("chat.effortSmarter")}
        </span>
      </div>
      <div className="w-full px-2 pb-2">
        <EffortSlider value={effort} onChange={onChange} />
      </div>
    </div>
  );
}

/**
 * Per-engine flyout panel: "{name} 引擎" header over a search field over
 * checkmark model rows over the effort slider. Picking a model dismisses the
 * whole menu (handled by the parent via `onPickModel`).
 */
function EngineFlyout({
  option,
  models,
  selectedModelId,
  query,
  onQueryChange,
  effort,
  onPickModel,
  onEffortChange,
}: {
  option: MenuOption;
  models: ModelOption[];
  selectedModelId: string;
  query: string;
  onQueryChange: (value: string) => void;
  effort: EffortLevel;
  onPickModel: (engine: string, id: string) => void;
  onEffortChange: (engine: string, level: EffortLevel) => void;
}) {
  const { t } = useTranslation();
  const normalizedQuery = query.trim().toLowerCase();
  const filteredModels = normalizedQuery
    ? models.filter(
        (m) =>
          m.label.toLowerCase().includes(normalizedQuery) ||
          m.id.toLowerCase().includes(normalizedQuery),
      )
    : models;

  return (
    <div className={FLYOUT_CLASSES}>
      <div className="flex w-full flex-col gap-1.5">
        <span className="truncate px-2 py-1.5 text-body-medium text-text-secondary">
          {t("chat.engineHeader", {
            name: CLI_DISPLAY_NAMES[option.id] ?? option.label,
          })}
        </span>
        <div className="relative mx-1 -mt-1.5 pb-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-[calc(50%+2px)] text-foreground-icon-secondary"
            aria-hidden
          />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("chat.modelSearchPlaceholder")}
            aria-label={t("chat.modelSearchPlaceholder")}
            className="h-8 w-full rounded-md border border-separator-border bg-background-secondary-default pr-2 pl-7 text-body-regular text-text-primary outline-none placeholder:text-text-tertiary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          />
        </div>
        <div
          className="flex max-h-[240px] w-full flex-col overflow-y-auto"
          role="radiogroup"
          aria-label={t("chat.modelPicker")}
        >
          {filteredModels.map((model) => (
            <ModelRow
              key={model.id || "__default__"}
              option={model}
              selected={model.id === selectedModelId}
              engineId={option.id}
              onPick={onPickModel}
            />
          ))}
          {filteredModels.length === 0 && (
            <span className="p-2 text-body-medium text-text-tertiary">
              {t("chat.noMatchingModels")}
            </span>
          )}
        </div>

        {/* Full-bleed divider, like the reference submenu. */}
        <div aria-hidden className="-mx-1 mt-[7px] mb-3 h-px bg-border-button-default" />
        <FlyoutEffortSection
          effort={effort}
          onChange={(level) => onEffortChange(option.id, level)}
        />
      </div>
    </div>
  );
}

/**
 * CLI + model switcher, visually mirroring the reference ModelSelect
 * (desktop-cc-gui): a borderless trigger showing the full selection —
 * "{CLI} / {model} · {effort}" — hairline-separated engine rows where
 * only the active engine carries a status dot, and a per-engine flyout.
 * Picking a model in another engine's flyout switches to that engine (when
 * installed), matching the reference picker's behavior.
 */
export function CliMenu({
  options,
  value,
  onChange,
  modelsByEngine,
  models,
  onModelChange,
  efforts,
  onEffortChange,
}: {
  options: MenuOption[];
  value: string;
  onChange: (id: string) => void;
  /** Per-engine model lists; concrete ids only, CLI default first. */
  modelsByEngine: Record<string, ModelOption[]>;
  /** Selected model id per engine. */
  models: Record<string, string>;
  onModelChange: (engine: string, id: string) => void;
  /** Per-engine reasoning effort, rendered under each flyout's model list. */
  efforts: Record<string, EffortLevel>;
  onEffortChange: (engine: string, level: EffortLevel) => void;
}) {
  const { t } = useTranslation();
  const { isOpen, triggerRef, popoverRef, close, setOpen } = usePopoverState();
  const current = options.find((o) => o.id === value);

  // Trigger carries the whole selection at a glance:
  // "Claude Code / 默认 · 高" (CLI name / model / effort). The model part
  // only drops out when the engine has no model list at all.
  const selectedModelId = models[value] ?? "";
  const selectedModel = (modelsByEngine[value] ?? []).find((m) => m.id === selectedModelId);
  const engineName = CLI_DISPLAY_NAMES[value] ?? current?.label ?? value;
  const triggerEffort: EffortLevel = efforts[value] ?? "medium";

  // Which engine's model flyout is open. Pre-opens on the active engine so
  // the current selection is visible the moment the menu opens.
  const [openEngine, setOpenEngine] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const closeTimer = useRef<number | null>(null);
  const cancelFlyoutClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  // Brief grace period so the pointer can cross the gap into the flyout.
  const scheduleFlyoutClose = () => {
    cancelFlyoutClose();
    closeTimer.current = window.setTimeout(() => setOpenEngine(null), 150);
  };
  useEffect(() => {
    setQuery("");
  }, [openEngine]);
  useEffect(() => () => cancelFlyoutClose(), []);

  const handleOpenChange = (o: boolean) => {
    if (!setOpen(o)) return;
    setOpenEngine(o ? value : null);
    if (!o) setQuery("");
  };

  const flyoutOption = options.find((o) => o.id === openEngine);

  // Picking a model is the decision the flyout exists for, so it dismisses
  // the whole menu; a model picked on another installed engine also switches
  // the active engine to it.
  const pickModel = (engine: string, id: string) => {
    onModelChange(engine, id);
    const target = options.find((o) => o.id === engine);
    if (engine !== value && target && !target.disabled) onChange(engine);
    close();
    setOpenEngine(null);
  };

  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={handleOpenChange}>
      <AriaButton
        ref={triggerRef}
        className="group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <EngineIcon engine={value} size={16} className="shrink-0 text-foreground-icon-secondary" />
        <span className="flex min-w-0 items-center gap-1 text-body-2-medium whitespace-nowrap text-text-secondary transition-colors duration-150 ease group-hover:text-text-primary">
          <span className="shrink-0">{engineName}</span>
          {selectedModel && (
            <>
              <span aria-hidden className="shrink-0 text-text-tertiary">
                /
              </span>
              <span className="max-w-44 truncate">{selectedModel.label}</span>
            </>
          )}
          <span aria-hidden className="shrink-0 text-text-tertiary">
            ·
          </span>
          <span className="shrink-0">{t(EFFORT_LABEL_KEYS[triggerEffort])}</span>
        </span>
      </AriaButton>

      <AriaPopover
        ref={popoverRef}
        isNonModal
        placement="top end"
        offset={8}
        className={CLI_POPOVER_CLASSES}
      >
        <AriaDialog aria-label={t("chat.cliPicker")} className="outline-none">
          <div className="flex w-full flex-col">
            <div
              className="relative"
              onMouseEnter={cancelFlyoutClose}
              onMouseLeave={scheduleFlyoutClose}
            >
              <div className="flex w-full flex-col">
                {options.map((option, index) => (
                  <Fragment key={option.id}>
                    {index > 0 && (
                      <div
                        aria-hidden
                        className="-mx-1 my-1 border-t border-separator-border"
                      />
                    )}
                    {/* Not `disabled`: that attribute would swallow hover
                        events and leave a stale flyout on the prior engine. */}
                    <EngineRow
                      option={option}
                      selected={option.id === value}
                      flyoutOpen={option.id === openEngine}
                      onSelect={() => {
                        if (option.disabled) return;
                        onChange(option.id);
                        close();
                      }}
                      onHover={() => {
                        cancelFlyoutClose();
                        setOpenEngine(option.id);
                      }}
                    />
                  </Fragment>
                ))}
              </div>

              {flyoutOption && (
                <EngineFlyout
                  option={flyoutOption}
                  models={modelsByEngine[flyoutOption.id] ?? []}
                  selectedModelId={models[flyoutOption.id] ?? ""}
                  query={query}
                  onQueryChange={setQuery}
                  effort={efforts[flyoutOption.id] ?? "medium"}
                  onPickModel={pickModel}
                  onEffortChange={onEffortChange}
                />
              )}
            </div>
          </div>
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
