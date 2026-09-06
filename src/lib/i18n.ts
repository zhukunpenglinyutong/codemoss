import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { zh } from "@/i18n/zh";
import { en } from "@/i18n/en";

const stored = localStorage.getItem("ccgui-next.language");

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: stored === "en" ? "en" : "zh",
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
});

/** Keep <html lang> in sync with the active UI language (screen readers and
 * font fallback read it). Synced once at init, then on every change. */
const HTML_LANG_TAGS: Record<string, string> = { zh: "zh-CN", en: "en" };
function syncHtmlLang(lng: string) {
  document.documentElement.lang = HTML_LANG_TAGS[lng] ?? lng;
}
syncHtmlLang(i18n.language);
i18n.on("languageChanged", syncHtmlLang);

export default i18n;
