import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import Settings from "lucide-react/dist/esm/icons/settings";
import { SettingsModal } from "@/components/application/settings/settings-modal";
import { GeneralSection } from "./GeneralSection";

/**
 * Settings route: overlay for the BoardUI settings modal. ChatPage itself is mounted once
 * by App on every route, so opening and closing settings never rebuilds
 * the chat tree.
 */
export default function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const pageParam = searchParams.get("page") ?? "general";

  const groups = useMemo(
    () => [
      {
        label: t("settings.title"),
        items: [{ key: "general", label: t("settings.general"), icon: Settings }],
      },
    ],
    [t],
  );

  const titles = useMemo(() => ({ general: t("settings.general") }), [t]);

  return (
    <SettingsModal
      isOpen
      onClose={() => navigate("/")}
      defaultPage={pageParam}
      ariaLabel={t("settings.title")}
      groups={groups}
      titles={titles}
      renderPage={() => <GeneralSection />}
    />
  );
}
