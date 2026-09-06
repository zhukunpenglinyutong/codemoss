import { lazy, Suspense, useEffect } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import ChatPage from "@/features/chat/ChatPage";
import { bindSystemThemeSync, bindThemeChangePersistence } from "@/features/settings/theme";

// Settings is a rare route; load it on demand so startup ships less JS.
// Warm the chunk shortly after startup so the first click has no fetch gap.
const loadSettingsPage = () => import("@/features/settings/SettingsPage");
const SettingsPage = lazy(loadSettingsPage);

export default function App() {
  // Startup theme/language init lives in main.tsx module scope; only the
  // theme-change listeners (with their own cleanup) are registered here.
  useEffect(() => bindThemeChangePersistence(), []);
  // bindSystemThemeSync keeps a "system" theme following OS color-scheme
  // flips app-wide — this used to live in the settings page, where it only
  // worked while Settings was open.
  useEffect(() => bindSystemThemeSync(), []);
  // Prefetch the settings chunk once startup work has settled.
  useEffect(() => {
    const id = setTimeout(() => void loadSettingsPage(), 2000);
    return () => clearTimeout(id);
  }, []);

  return (
    <HashRouter>
      {/* ChatPage stays mounted on every route; /settings only adds the
          modal overlay on top, so opening/closing settings never rebuilds
          the chat tree. */}
      <ChatPage />
      <Routes>
        <Route
          path="/settings"
          element={
            <Suspense fallback={null}>
              <SettingsPage />
            </Suspense>
          }
        />
      </Routes>
    </HashRouter>
  );
}
