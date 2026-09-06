import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import type { ProviderEntry } from "./providers";

export interface ProviderFormValues {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  remark: string;
}

interface ProviderDialogProps {
  mode: "add" | "edit";
  /** Initial field values when editing. */
  initial?: ProviderEntry;
  onCancel: () => void;
  /** Parent closes the dialog on success; reject/throw keeps it open. */
  onSave: (values: ProviderFormValues) => void | Promise<void>;
}

export function ProviderDialog({ mode, initial, onCancel, onSave }: ProviderDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [remark, setRemark] = useState(initial?.remark ?? "");
  const [saving, setSaving] = useState(false);

  const canSave = name.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave({ name, baseUrl, apiKey, model, remark });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-backdrop p-4"
    >
      <Modal className="w-full max-w-md">
        <Dialog className="flex flex-col gap-4 rounded-2lg border border-separator-border bg-background-primary-default p-5 shadow-lg outline-none">
          <h2 className="text-headline-semibold text-text-primary">
            {mode === "add" ? t("settings.addProvider") : t("settings.editProvider")}
          </h2>
          <Input
            label={t("settings.name")}
            isRequired
            value={name}
            onChange={setName}
            autoFocus
          />
          <Input label={t("settings.baseUrl")} value={baseUrl} onChange={setBaseUrl} />
          <Input
            label={t("settings.apiKey")}
            type="password"
            value={apiKey}
            onChange={setApiKey}
          />
          <Input label={t("settings.model")} value={model} onChange={setModel} />
          <Input label={t("settings.remark")} value={remark} onChange={setRemark} />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void handleSave()} disabled={!canSave}>
              {t("common.save")}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
