import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { loadAboutStyles } from "../../../styles/featureStyleLoaders";

const GITHUB_URL = "https://github.com/zhukunpenglinyutong/desktop-cc-gui";

export function AboutView() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void loadAboutStyles();
  }, []);

  const handleOpenGitHub = () => {
    void openUrl(GITHUB_URL);
  };

  useEffect(() => {
    let active = true;
    const fetchVersion = async () => {
      try {
        const value = await getVersion();
        if (active) {
          setVersion(value);
        }
      } catch {
        if (active) {
          setVersion(null);
        }
      }
    };

    void fetchVersion();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="about">
      <div className="about-card">
        <div className="about-header">
          <img
            className="about-icon"
            src="/app-icon.png"
            alt="CodePort icon"
          />
          <div className="about-title">CodePort</div>
        </div>
        <div className="about-version">
          {version ? `${t("about.version")} ${version}` : `${t("about.version")} —`}
        </div>
        <div className="about-tagline">
          {t("about.tagline")}
        </div>
        <div className="about-divider" />
        <div className="about-links">
          <button
            type="button"
            className="about-link"
            onClick={handleOpenGitHub}
          >
            {t("about.github")}
          </button>
        </div>
      </div>
    </div>
  );
}
