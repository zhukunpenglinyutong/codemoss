import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import i18n from "./lib/i18n";
import { ipc } from "./lib/ipc";
import { applyTheme, THEME_STORAGE_KEY } from "./features/settings/theme";

// Apply the locally cached theme synchronously, before first paint, so the
// window never flashes the wrong color scheme while settings load.
const cachedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
if (cachedTheme) applyTheme(cachedTheme);

// Kick off the authoritative settings fetch at module scope (shared cached
// promise in ipc.ts); apply theme/language as soon as it resolves. Rendering
// is not blocked on this.
void ipc
  .getAppSettings()
  .then((settings) => {
    applyTheme(settings.theme);
    if (settings.language && settings.language !== i18n.language) {
      void i18n.changeLanguage(settings.language);
    }
  })
  .catch(() => {});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
