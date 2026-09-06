import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";

/**
 * Shared shell for the small imperative dialogs below. Built on react-aria's
 * Modal/ModalOverlay/Dialog, which own the a11y contract outright: role +
 * aria-modal, the focus trap, Escape dismissal, outside-press dismissal
 * (`isDismissable`), and portalling to document.body.
 */
function ModalShell({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-backdrop"
    >
      <Modal
        isDismissable
        className="w-80 rounded-2lg border border-border-button-default bg-background-primary-default p-4 shadow-xl outline-none"
      >
        <Dialog className="outline-none">{children}</Dialog>
      </Modal>
    </ModalOverlay>
  );
}

interface PromptDialogProps {
  title: string;
  initial?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** Single-field name prompt (new folder / rename). window.prompt is not
 * reliable inside Tauri's WKWebView, so this is a real modal. */
export function PromptDialog({ title, initial = "", onSubmit, onCancel }: PromptDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  // The field (not the first button) takes the initial focus, selected so a
  // rename can be typed over directly.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = value.trim();

  return (
    <ModalShell onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) onSubmit(trimmed);
        }}
        className="flex flex-col gap-3"
      >
        <Input
          ref={inputRef}
          label={title}
          value={value}
          onChange={setValue}
          size="small"
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="small" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="small" disabled={!trimmed}>
            {t("common.confirm")}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

interface ConfirmDialogProps {
  message: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ message, danger = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <ModalShell onClose={onCancel}>
      <p className="text-body-medium text-text-primary">{message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" size="small" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        {/* The confirm button takes the dialog's initial focus so Enter
         *  confirms instead of cancelling. */}
        <Button variant={danger ? "danger" : "primary"} size="small" autoFocus onClick={onConfirm}>
          {t("common.confirm")}
        </Button>
      </div>
    </ModalShell>
  );
}
