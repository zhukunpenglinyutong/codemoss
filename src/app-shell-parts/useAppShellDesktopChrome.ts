import { useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWindowDrag } from "../features/layout/hooks/useWindowDrag";
import { isMacPlatform, isWindowsPlatform } from "../utils/platform";
import type { WorkspaceInfo } from "../types";

export function useAppShellDesktopChrome(activeWorkspace: WorkspaceInfo | null) {
  useWindowDrag("titlebar");

  const isWindowsDesktop = useMemo(() => isWindowsPlatform(), []);
  const isMacDesktop = useMemo(() => isMacPlatform(), []);

  useEffect(() => {
    const title = activeWorkspace ? `CodePort - ${activeWorkspace.name}` : "CodePort";
    try {
      void getCurrentWindow()
        .setTitle(title)
        .catch(() => {});
    } catch {
      // 普通浏览器没有 Tauri window internals，dev-server 预览时跳过窗口标题同步。
    }
  }, [activeWorkspace]);

  return {
    isMacDesktop,
    isWindowsDesktop,
  };
}
