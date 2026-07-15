import { useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { updateMenuLabels } from "../../../services/tauri";

const APP_NAME = "CodePort";

type MenuLabelUpdate = {
  id: string;
  text: string;
};

export function useMenuLocalization() {
  const { t, i18n } = useTranslation();

  const syncMenuLabels = useCallback(async () => {
    const updates: MenuLabelUpdate[] = [
      // App menu items
      { id: "about", text: t("menu.about", { appName: APP_NAME }) },
      { id: "check_for_updates", text: t("menu.checkForUpdates") },
      { id: "file_open_settings", text: t("menu.settings") },

      // File menu
      { id: "file_menu", text: t("menu.file") },
      { id: "file_new_agent", text: t("menu.newAgent") },
      { id: "file_new_worktree_agent", text: t("menu.newWorktreeAgent") },
      { id: "file_new_clone_agent", text: t("menu.newCloneAgent") },
      { id: "file_new_window", text: t("menu.newWindow") },
      { id: "file_add_workspace", text: t("menu.addWorkspace") },
      // Linux-specific items
      { id: "file_close_window", text: t("menu.closeWindow") },
      { id: "file_quit", text: t("menu.quit") },

      // Edit menu
      { id: "edit_menu", text: t("menu.edit") },

      // Composer menu
      { id: "composer_menu", text: t("menu.composer") },
      { id: "composer_cycle_model", text: t("menu.cycleModel") },
      { id: "composer_cycle_access", text: t("menu.cycleAccessMode") },
      { id: "composer_cycle_reasoning", text: t("menu.cycleReasoningMode") },
      { id: "composer_cycle_collaboration", text: t("menu.cycleCollaborationMode") },

      // View menu
      { id: "view_menu", text: t("menu.view") },
      { id: "view_toggle_projects_sidebar", text: t("menu.toggleProjectsSidebar") },
      { id: "view_toggle_git_sidebar", text: t("menu.toggleGitSidebar") },
      { id: "view_toggle_global_search", text: t("menu.toggleGlobalSearch") },
      { id: "view_toggle_debug_panel", text: t("menu.toggleDebugPanel") },
      { id: "view_toggle_terminal", text: t("menu.toggleTerminal") },
      { id: "view_toggle_devtools", text: t("menu.toggleDevtools") },
      { id: "view_next_agent", text: t("menu.nextAgent") },
      { id: "view_prev_agent", text: t("menu.previousAgent") },
      { id: "view_next_workspace", text: t("menu.nextWorkspace") },
      { id: "view_prev_workspace", text: t("menu.previousWorkspace") },
      // Linux-specific
      { id: "view_fullscreen", text: t("menu.toggleFullScreen") },

      // Window menu
      { id: "window_menu", text: t("menu.window") },
      // Linux-specific
      { id: "window_minimize", text: t("menu.minimize") },
      { id: "window_maximize", text: t("menu.maximize") },
      { id: "window_reload", text: t("menu.reloadWindow") },
      { id: "window_close", text: t("menu.closeWindow") },

      // Help menu
      { id: "help_menu", text: t("menu.help") },
      { id: "help_about", text: t("menu.about", { appName: APP_NAME }) },
    ];

    try {
      await updateMenuLabels(updates);
    } catch (error) {
      console.error("Failed to update menu labels:", error);
    }
  }, [t]);

  // Sync menu labels when language changes
  useEffect(() => {
    void syncMenuLabels();
  }, [syncMenuLabels, i18n.language]);

  return { syncMenuLabels };
}
