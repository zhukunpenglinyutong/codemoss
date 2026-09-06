import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";

/** About page: app identity + version (from the Tauri bundle metadata). */
export function AboutSection() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsSectionLabel>{t("settings.about")}</SettingsSectionLabel>
      <SettingsCard>
        <SettingsRow label="CC GUI">
          <span className="text-body-regular text-text-secondary">
            {version ? `v${version}` : "…"}
          </span>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
