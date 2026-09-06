import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import Plus from "lucide-react/dist/esm/icons/plus";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { ipc, type AppSettings, type CliConfig, type ProviderSection } from "@/lib/ipc";
import { ProviderDialog, type ProviderFormValues } from "./ProviderDialog";
import { ConfirmDialog } from "@/components/dialogs";
import {
  ENGINE_IDS,
  PSEUDO_LOCAL,
  PSEUDO_PROVIDER_IDS,
  isPseudoProvider,
  parseProvider,
  type EngineId,
  type ProviderEntry,
  type PseudoProviderId,
} from "./providers";

const binField = (engine: EngineId) => `${engine}Bin` as keyof AppSettings;

/** Normalize before persisting: empty bin overrides mean auto-detect. */
const normalizeSettings = (s: AppSettings): AppSettings => {
  const out = { ...s };
  for (const eng of ENGINE_IDS) {
    const field = binField(eng);
    const trimmed = ((out[field] as string | null) ?? "").trim();
    (out as Record<string, unknown>)[field] = trimmed === "" ? null : trimmed;
  }
  return out;
};

/** Diff two settings snapshots; the nested model/effort maps are diffed per
 * engine so merging the patch onto a fresh read touches only edited keys. */
function diffSettings(prev: AppSettings | null, next: AppSettings): Partial<AppSettings> {
  if (!prev) return next;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof AppSettings)[]) {
    if (key === "defaultModels" || key === "defaultEfforts") continue;
    if (next[key] !== prev[key]) patch[key] = next[key];
  }
  for (const field of ["defaultModels", "defaultEfforts"] as const) {
    const edited: Record<string, string> = {};
    let changed = false;
    for (const eng of Object.keys(next[field])) {
      if (next[field][eng] !== prev[field][eng]) {
        edited[eng] = next[field][eng];
        changed = true;
      }
    }
    if (changed) patch[field] = edited;
  }
  return patch;
}

interface RowCallbacks {
  onSetCurrent: (engine: EngineId, id: string) => void;
  onEdit: (engine: EngineId, entry: ProviderEntry) => void;
  onDelete: (engine: EngineId, id: string) => void;
  onMove: (engine: EngineId, id: string, dir: -1 | 1) => void;
}

/** Row chrome matching SettingsRow, with an inline chip slot by the label. */
const PROVIDER_ROW_CLASSES =
  "flex min-h-[52px] w-full items-center justify-between gap-4 py-2.5 pr-2.5 border-b border-separator-border last:border-b-0";

const PseudoProviderRow = memo(function PseudoProviderRow({
  engine,
  pseudoId,
  isCurrent,
  onSetCurrent,
}: {
  engine: EngineId;
  pseudoId: PseudoProviderId;
  isCurrent: boolean;
  onSetCurrent: RowCallbacks["onSetCurrent"];
}) {
  const { t } = useTranslation();
  return (
    <div className={PROVIDER_ROW_CLASSES}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-body-regular text-text-primary">
          {pseudoId === PSEUDO_LOCAL ? t("settings.localSettings") : t("settings.disabled")}
        </span>
        {isCurrent && (
          <Chip variant="caption" color="blue">
            {t("settings.current")}
          </Chip>
        )}
      </div>
      {!isCurrent && (
        <Button size="xs" variant="ghost" onClick={() => onSetCurrent(engine, pseudoId)}>
          {t("settings.setCurrent")}
        </Button>
      )}
    </div>
  );
});

const ProviderRow = memo(function ProviderRow({
  engine,
  entry,
  isCurrent,
  isFirst,
  isLast,
  onSetCurrent,
  onEdit,
  onDelete,
  onMove,
}: {
  engine: EngineId;
  entry: ProviderEntry;
  isCurrent: boolean;
  isFirst: boolean;
  isLast: boolean;
} & RowCallbacks) {
  const { t } = useTranslation();
  const description = [entry.baseUrl, entry.remark].filter(Boolean).join(" · ");
  return (
    <div className={PROVIDER_ROW_CLASSES}>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-body-regular text-text-primary">{entry.name}</span>
          {isCurrent && (
            <Chip variant="caption" color="blue">
              {t("settings.current")}
            </Chip>
          )}
        </div>
        {description && (
          <span className="truncate text-body-2-regular text-text-secondary">{description}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!isCurrent && (
          <Button size="xs" variant="ghost" onClick={() => onSetCurrent(engine, entry.id)}>
            {t("settings.setCurrent")}
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={() => onEdit(engine, entry)}>
          {t("common.edit")}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => onDelete(engine, entry.id)}>
          {t("common.delete")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          iconOnly
          leadingIcon={ArrowUp}
          aria-label={t("settings.moveUp")}
          disabled={isFirst}
          onClick={() => onMove(engine, entry.id, -1)}
        />
        <Button
          size="xs"
          variant="ghost"
          iconOnly
          leadingIcon={ArrowDown}
          aria-label={t("settings.moveDown")}
          disabled={isLast}
          onClick={() => onMove(engine, entry.id, 1)}
        />
      </div>
    </div>
  );
});

function EnginePanel({
  engine,
  section,
  appSettings,
  onSettingsChange,
  onAdd,
  ...callbacks
}: {
  engine: EngineId;
  section: ProviderSection | undefined;
  appSettings: AppSettings;
  onSettingsChange: (next: AppSettings, persist: boolean) => void;
  onAdd: (engine: EngineId) => void;
} & RowCallbacks) {
  const { t } = useTranslation();

  const entries = useMemo(
    () =>
      Object.entries(section?.providers ?? {})
        .filter(([id]) => !isPseudoProvider(id))
        .map(([id, raw]) => parseProvider(id, raw)),
    [section],
  );

  return (
    <div className="flex flex-col gap-6 pt-2">
      {/* Engine defaults: bin override + default model, saved on blur. */}
      <div className="flex w-full flex-col gap-2">
        <SettingsSectionLabel>{t("settings.engineDefaults")}</SettingsSectionLabel>
        <SettingsCard>
          <SettingsRow label={t("settings.binPath")}>
            <Input
              aria-label={`${engine} ${t("settings.binPath")}`}
              className="w-[240px]"
              value={(appSettings[binField(engine)] as string | null) ?? ""}
              onChange={(v) =>
                onSettingsChange({ ...appSettings, [binField(engine)]: v }, false)
              }
              onBlur={() => onSettingsChange(appSettings, true)}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.defaultModel")}>
            <Input
              aria-label={`${engine} ${t("settings.defaultModel")}`}
              className="w-[240px]"
              value={appSettings.defaultModels[engine] ?? ""}
              onChange={(v) =>
                onSettingsChange(
                  {
                    ...appSettings,
                    defaultModels: { ...appSettings.defaultModels, [engine]: v },
                  },
                  false,
                )
              }
              onBlur={() => onSettingsChange(appSettings, true)}
            />
          </SettingsRow>
        </SettingsCard>
      </div>

      <div className="flex w-full flex-col gap-2">
        <div className="flex items-center justify-between">
          <SettingsSectionLabel>{t("settings.providers")}</SettingsSectionLabel>
          {engine !== "claude" && (
            <Button size="small" variant="secondary" leadingIcon={Plus} onClick={() => onAdd(engine)}>
              {t("settings.addProvider")}
            </Button>
          )}
        </div>
        {engine === "claude" ? (
          <p className="px-3 text-body-2-regular text-text-tertiary">
            {t("settings.claudeUsesCliConfig")}
          </p>
        ) : (
          <>
        <SettingsCard>
          {PSEUDO_PROVIDER_IDS.map((pseudoId) => (
            <PseudoProviderRow
              key={pseudoId}
              engine={engine}
              pseudoId={pseudoId}
              isCurrent={section?.current === pseudoId}
              onSetCurrent={callbacks.onSetCurrent}
            />
          ))}
          {entries.map((entry, i) => (
            <ProviderRow
              key={entry.id}
              engine={engine}
              entry={entry}
              isCurrent={section?.current === entry.id}
              isFirst={i === 0}
              isLast={i === entries.length - 1}
              {...callbacks}
            />
          ))}
        </SettingsCard>
        {entries.length === 0 && (
          <p className="px-3 text-body-2-regular text-text-tertiary">
            {t("settings.noProviders")}
          </p>
        )}
          </>
        )}
      </div>
    </div>
  );
}

type DialogState =
  | { engine: EngineId; mode: "add" }
  | { engine: EngineId; mode: "edit"; entry: ProviderEntry };

/** One engine's config page: bin/model defaults + provider channels. */
export function CliConfigSection({ engine }: { engine: EngineId }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<CliConfig | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ engine: EngineId; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cliConfig, settings] = await Promise.all([
        ipc.getCliConfig(),
        ipc.getAppSettings(),
      ]);
      setConfig(cliConfig);
      setAppSettings(settings);
      persistedRef.current = settings;
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Latest config for handlers that need current provider order.
  const configRef = useRef(config);
  configRef.current = config;
  // Last PERSISTED settings snapshot: the persist path diffs the local draft
  // against this (not against the previous render, which already carries the
  // edit) so exactly the user's changes are merged onto a fresh read.
  const persistedRef = useRef<AppSettings | null>(null);

  const run = useCallback(
    async (op: () => Promise<unknown>) => {
      try {
        await op();
        await load();
      } catch (e) {
        setError(String(e));
      }
    },
    [load],
  );

  const handleSettingsChange = useCallback((next: AppSettings, persist: boolean) => {
    setAppSettings(next);
    if (!persist) return;
    // Read-modify-write: the local draft descends from a mount-time snapshot,
    // so persisting it whole would clobber concurrent edits (the other
    // settings page, chat-side model pinning). Diff the draft against the
    // last persisted value, apply just that patch onto a fresh read.
    const patch = diffSettings(persistedRef.current, next);
    void (async () => {
      try {
        const latest = await ipc.getAppSettings();
        const merged = normalizeSettings({
          ...latest,
          ...patch,
          defaultModels: { ...latest.defaultModels, ...(patch.defaultModels ?? {}) },
          defaultEfforts: { ...latest.defaultEfforts, ...(patch.defaultEfforts ?? {}) },
        });
        await ipc.updateAppSettings(merged);
        persistedRef.current = merged;
        setAppSettings(merged);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  const handleSetCurrent = useCallback(
    (eng: EngineId, id: string) => void run(() => ipc.setCurrentProvider(eng, id)),
    [run],
  );

  const handleDelete = useCallback(
    (eng: EngineId, id: string) => {
      setConfirmDelete({ engine: eng, id });
    },
    [],
  );

  const handleMove = useCallback(
    (eng: EngineId, id: string, dir: -1 | 1) => {
      const section = configRef.current?.[eng];
      if (!section) return;
      const all = Object.keys(section.providers);
      const allSet = new Set(all);
      const realIds = all.filter((k) => !isPseudoProvider(k));
      const i = realIds.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= realIds.length) return;
      [realIds[i], realIds[j]] = [realIds[j], realIds[i]];
      // Keep any pseudo ids present in the map pinned ahead of real ones.
      const pseudo = PSEUDO_PROVIDER_IDS.filter((p) => allSet.has(p));
      void run(() => ipc.reorderProviders(eng, [...pseudo, ...realIds]));
    },
    [run],
  );

  const handleAdd = useCallback(
    (eng: EngineId) => setDialog({ engine: eng, mode: "add" }),
    [],
  );
  const handleEdit = useCallback(
    (eng: EngineId, entry: ProviderEntry) => setDialog({ engine: eng, mode: "edit", entry }),
    [],
  );

  const handleSaveProvider = async (values: ProviderFormValues) => {
    if (!dialog) return;
    const json: Record<string, string> = {};
    for (const key of ["name", "baseUrl", "apiKey", "model", "remark"] as const) {
      const v = values[key].trim();
      if (v) json[key] = v;
    }
    const id = dialog.mode === "edit" ? dialog.entry.id : crypto.randomUUID();
    try {
      await ipc.upsertProvider(dialog.engine, id, json);
      setDialog(null);
      await load();
    } catch (e) {
      // Keep the dialog open so entered values are not lost.
      setError(String(e));
    }
  };

  return (
    <div className="flex w-full flex-col gap-4">
      {error && (
        <p role="alert" className="text-body-regular text-text-error-primary">
          {t("common.error")}: {error}
        </p>
      )}
      {(!config || !appSettings) && !error && (
        <p className="text-body-regular text-text-tertiary">{t("common.loading")}</p>
      )}
      {config && appSettings && (
        <EnginePanel
          engine={engine}
          section={config[engine]}
          appSettings={appSettings}
          onSettingsChange={handleSettingsChange}
          onAdd={handleAdd}
          onSetCurrent={handleSetCurrent}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onMove={handleMove}
        />
      )}
      {dialog && (
        <ProviderDialog
          key={dialog.mode === "edit" ? `edit-${dialog.entry.id}` : `add-${dialog.engine}`}
          mode={dialog.mode}
          initial={dialog.mode === "edit" ? dialog.entry : undefined}
          onCancel={() => setDialog(null)}
          onSave={handleSaveProvider}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          danger
          message={t("settings.confirmDeleteProvider")}
          onConfirm={() => {
            const { engine: eng, id } = confirmDelete;
            setConfirmDelete(null);
            void run(() => ipc.deleteProvider(eng, id));
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
