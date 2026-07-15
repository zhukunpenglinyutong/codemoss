use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const NEW_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Shift+N";
const RELOAD_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+R";

/// Native menu labels for a single language. The native (GTK/AppKit) menu is
/// built in Rust, so it can't reach the React i18next layer; we mirror the
/// `menu.*` translation keys here and build the menu in the saved language.
///
/// Runtime re-labelling via `menu_update_labels` works on macOS but does not
/// reliably repaint the GTK menubar on Linux (muda/GTK limitation), so building
/// in the right language up front is what actually makes the menu localized
/// there. Live switching still applies on next launch. New locales = one more
/// constructor; strings must stay in sync with `src/i18n/locales/*/menu`.
struct MenuLabels {
    check_for_updates: &'static str,
    settings: &'static str,
    file: &'static str,
    new_agent: &'static str,
    new_worktree_agent: &'static str,
    new_clone_agent: &'static str,
    new_window: &'static str,
    add_workspace: &'static str,
    close_window: &'static str,
    quit: &'static str,
    edit: &'static str,
    composer: &'static str,
    cycle_model: &'static str,
    cycle_access: &'static str,
    cycle_reasoning: &'static str,
    cycle_collaboration: &'static str,
    view: &'static str,
    toggle_projects_sidebar: &'static str,
    toggle_git_sidebar: &'static str,
    toggle_global_search: &'static str,
    toggle_debug_panel: &'static str,
    toggle_terminal: &'static str,
    toggle_devtools: &'static str,
    next_agent: &'static str,
    prev_agent: &'static str,
    next_workspace: &'static str,
    prev_workspace: &'static str,
    fullscreen: &'static str,
    window: &'static str,
    minimize: &'static str,
    maximize: &'static str,
    reload_window: &'static str,
    help: &'static str,
    about_prefix: &'static str, // "关于" / "About" — prepended to the app name
}

const LABELS_ZH: MenuLabels = MenuLabels {
    check_for_updates: "检查更新…",
    settings: "设置…",
    file: "文件",
    new_agent: "新建会话",
    new_worktree_agent: "新建工作树代理",
    new_clone_agent: "新建克隆代理",
    new_window: "新建窗口",
    add_workspace: "添加工作区…",
    close_window: "关闭窗口",
    quit: "退出",
    edit: "编辑",
    composer: "编辑器",
    cycle_model: "切换模型",
    cycle_access: "切换访问模式",
    cycle_reasoning: "切换推理模式",
    cycle_collaboration: "切换协作模式",
    view: "视图",
    toggle_projects_sidebar: "切换项目侧边栏",
    toggle_git_sidebar: "切换右侧边栏",
    toggle_global_search: "切换全局搜索",
    toggle_debug_panel: "切换调试面板",
    toggle_terminal: "切换终端",
    toggle_devtools: "切换开发者工具",
    next_agent: "下一个代理",
    prev_agent: "上一个代理",
    next_workspace: "下一个工作区",
    prev_workspace: "上一个工作区",
    fullscreen: "切换全屏",
    window: "窗口",
    minimize: "最小化",
    maximize: "最大化",
    reload_window: "重新加载窗口",
    help: "帮助",
    about_prefix: "关于",
};

const LABELS_EN: MenuLabels = MenuLabels {
    check_for_updates: "Check for Updates…",
    settings: "Settings…",
    file: "File",
    new_agent: "New Agent",
    new_worktree_agent: "New Worktree Agent",
    new_clone_agent: "New Clone Agent",
    new_window: "New Window",
    add_workspace: "Add Workspace…",
    close_window: "Close Window",
    quit: "Quit",
    edit: "Edit",
    composer: "Composer",
    cycle_model: "Cycle Model",
    cycle_access: "Cycle Access Mode",
    cycle_reasoning: "Cycle Reasoning Mode",
    cycle_collaboration: "Cycle Collaboration Mode",
    view: "View",
    toggle_projects_sidebar: "Toggle Projects Sidebar",
    toggle_git_sidebar: "Toggle Right Sidebar",
    toggle_global_search: "Toggle Global Search",
    toggle_debug_panel: "Toggle Debug Panel",
    toggle_terminal: "Toggle Terminal",
    toggle_devtools: "Toggle Developer Tools",
    next_agent: "Next Agent",
    prev_agent: "Previous Agent",
    next_workspace: "Next Workspace",
    prev_workspace: "Previous Workspace",
    fullscreen: "Toggle Full Screen",
    window: "Window",
    minimize: "Minimize",
    maximize: "Maximize",
    reload_window: "Reload Window",
    help: "Help",
    about_prefix: "About",
};

/// Read the saved UI language from the client `app` store. Defaults to `zh`
/// (matching the frontend default) when unset or unreadable. Only zh/en exist.
fn saved_menu_labels() -> &'static MenuLabels {
    let language = crate::client_storage::client_store_read("app".to_string())
        .ok()
        .and_then(|value| {
            value
                .get("language")
                .and_then(|lang| lang.as_str())
                .map(str::to_string)
        });
    match language.as_deref() {
        Some("en") => &LABELS_EN,
        _ => &LABELS_ZH,
    }
}

fn reload_window_accelerator() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        Some(RELOAD_WINDOW_ACCELERATOR)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn build_reload_window_item<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
    labels: &MenuLabels,
) -> tauri::Result<MenuItem<R>> {
    let builder = MenuItemBuilder::with_id("window_reload", labels.reload_window);
    let builder = match reload_window_accelerator() {
        Some(accelerator) => builder.accelerator(accelerator),
        None => builder,
    };
    builder.build(handle)
}

pub struct MenuItemRegistry<R: Runtime> {
    items: Mutex<HashMap<String, MenuItem<R>>>,
    submenus: Mutex<HashMap<String, Submenu<R>>>,
}

impl<R: Runtime> Default for MenuItemRegistry<R> {
    fn default() -> Self {
        Self {
            items: Mutex::new(HashMap::new()),
            submenus: Mutex::new(HashMap::new()),
        }
    }
}

impl<R: Runtime> MenuItemRegistry<R> {
    fn register(&self, id: &str, item: &MenuItem<R>) {
        if let Ok(mut items) = self.items.lock() {
            items.insert(id.to_string(), item.clone());
        }
    }

    fn register_submenu(&self, id: &str, submenu: &Submenu<R>) {
        if let Ok(mut submenus) = self.submenus.lock() {
            submenus.insert(id.to_string(), submenu.clone());
        }
    }

    fn set_accelerator(&self, id: &str, accelerator: Option<&str>) -> tauri::Result<bool> {
        let item = match self.items.lock() {
            Ok(items) => items.get(id).cloned(),
            Err(_) => return Ok(false),
        };
        if let Some(item) = item {
            item.set_accelerator(accelerator)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn set_text(&self, id: &str, text: &str) -> tauri::Result<bool> {
        // Try items first
        let item = match self.items.lock() {
            Ok(items) => items.get(id).cloned(),
            Err(_) => return Ok(false),
        };
        if let Some(item) = item {
            item.set_text(text)?;
            return Ok(true);
        }
        // Then try submenus
        let submenu = match self.submenus.lock() {
            Ok(submenus) => submenus.get(id).cloned(),
            Err(_) => return Ok(false),
        };
        if let Some(submenu) = submenu {
            submenu.set_text(text)?;
            return Ok(true);
        }
        Ok(false)
    }
}

#[derive(Debug, Deserialize)]
pub struct MenuAcceleratorUpdate {
    pub id: String,
    pub accelerator: Option<String>,
}

#[tauri::command]
pub fn menu_set_accelerators<R: Runtime>(
    app: tauri::AppHandle<R>,
    updates: Vec<MenuAcceleratorUpdate>,
) -> Result<(), String> {
    let registry = app.state::<MenuItemRegistry<R>>();
    for update in updates {
        registry
            .set_accelerator(&update.id, update.accelerator.as_deref())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct MenuLabelUpdate {
    pub id: String,
    pub text: String,
}

#[tauri::command]
pub fn menu_update_labels<R: Runtime>(
    app: tauri::AppHandle<R>,
    updates: Vec<MenuLabelUpdate>,
) -> Result<(), String> {
    let registry = app.state::<MenuItemRegistry<R>>();
    for update in updates {
        registry
            .set_text(&update.id, &update.text)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn resolve_target_webview_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<tauri::WebviewWindow<R>> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
}

pub(crate) fn build_menu<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
) -> tauri::Result<Menu<R>> {
    let registry = handle.state::<MenuItemRegistry<R>>();
    let labels = saved_menu_labels();
    let app_name = handle.package_info().name.clone();
    let about_label = format!("{} {app_name}", labels.about_prefix);
    let about_item = MenuItemBuilder::with_id("about", about_label.clone()).build(handle)?;
    let check_updates_item =
        MenuItemBuilder::with_id("check_for_updates", labels.check_for_updates).build(handle)?;
    let settings_item = MenuItemBuilder::with_id("file_open_settings", labels.settings)
        .accelerator("CmdOrCtrl+,")
        .build(handle)?;

    // Register items for localization
    registry.register("about", &about_item);
    registry.register("check_for_updates", &check_updates_item);
    registry.register("file_open_settings", &settings_item);

    let app_menu = Submenu::with_items(
        handle,
        app_name.clone(),
        true,
        &[
            &about_item,
            &check_updates_item,
            &settings_item,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let new_agent_item =
        MenuItemBuilder::with_id("file_new_agent", labels.new_agent).build(handle)?;
    let new_worktree_agent_item =
        MenuItemBuilder::with_id("file_new_worktree_agent", labels.new_worktree_agent)
            .build(handle)?;
    let new_clone_agent_item =
        MenuItemBuilder::with_id("file_new_clone_agent", labels.new_clone_agent).build(handle)?;
    let new_window_item = MenuItemBuilder::with_id("file_new_window", labels.new_window)
        .accelerator(NEW_WINDOW_ACCELERATOR)
        .build(handle)?;
    let add_workspace_item =
        MenuItemBuilder::with_id("file_add_workspace", labels.add_workspace).build(handle)?;

    registry.register("file_new_agent", &new_agent_item);
    registry.register("file_new_worktree_agent", &new_worktree_agent_item);
    registry.register("file_new_clone_agent", &new_clone_agent_item);
    registry.register("file_new_window", &new_window_item);
    registry.register("file_add_workspace", &add_workspace_item);

    #[cfg(target_os = "linux")]
    let file_menu = {
        let close_window_item =
            MenuItemBuilder::with_id("file_close_window", labels.close_window).build(handle)?;
        let quit_item = MenuItemBuilder::with_id("file_quit", labels.quit).build(handle)?;
        registry.register("file_close_window", &close_window_item);
        registry.register("file_quit", &quit_item);
        let submenu = SubmenuBuilder::with_id(handle, "file_menu", labels.file)
            .items(&[
                &new_agent_item,
                &new_worktree_agent_item,
                &new_clone_agent_item,
                &new_window_item,
                &PredefinedMenuItem::separator(handle)?,
                &add_workspace_item,
                &PredefinedMenuItem::separator(handle)?,
                &close_window_item,
                &quit_item,
            ])
            .build()?;
        registry.register_submenu("file_menu", &submenu);
        submenu
    };
    #[cfg(not(target_os = "linux"))]
    let file_menu = {
        let submenu = SubmenuBuilder::with_id(handle, "file_menu", labels.file)
            .items(&[
                &new_agent_item,
                &new_worktree_agent_item,
                &new_clone_agent_item,
                &new_window_item,
                &PredefinedMenuItem::separator(handle)?,
                &add_workspace_item,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::close_window(handle, None)?,
                #[cfg(not(target_os = "macos"))]
                &PredefinedMenuItem::quit(handle, None)?,
            ])
            .build()?;
        registry.register_submenu("file_menu", &submenu);
        submenu
    };

    let edit_menu = {
        let submenu = SubmenuBuilder::with_id(handle, "edit_menu", labels.edit)
            .items(&[
                &PredefinedMenuItem::undo(handle, None)?,
                &PredefinedMenuItem::redo(handle, None)?,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::cut(handle, None)?,
                &PredefinedMenuItem::copy(handle, None)?,
                &PredefinedMenuItem::paste(handle, None)?,
                &PredefinedMenuItem::select_all(handle, None)?,
            ])
            .build()?;
        registry.register_submenu("edit_menu", &submenu);
        submenu
    };

    let cycle_model_item = MenuItemBuilder::with_id("composer_cycle_model", labels.cycle_model)
        .accelerator("CmdOrCtrl+Shift+M")
        .build(handle)?;
    let cycle_access_item = MenuItemBuilder::with_id("composer_cycle_access", labels.cycle_access)
        .accelerator("CmdOrCtrl+Shift+A")
        .build(handle)?;
    let cycle_reasoning_item =
        MenuItemBuilder::with_id("composer_cycle_reasoning", labels.cycle_reasoning)
            .accelerator("CmdOrCtrl+Shift+R")
            .build(handle)?;
    let cycle_collaboration_item =
        MenuItemBuilder::with_id("composer_cycle_collaboration", labels.cycle_collaboration)
            .accelerator("Shift+Tab")
            .build(handle)?;
    registry.register("composer_cycle_model", &cycle_model_item);
    registry.register("composer_cycle_access", &cycle_access_item);
    registry.register("composer_cycle_reasoning", &cycle_reasoning_item);
    registry.register("composer_cycle_collaboration", &cycle_collaboration_item);

    let composer_menu = {
        let submenu = SubmenuBuilder::with_id(handle, "composer_menu", labels.composer)
            .items(&[
                &cycle_model_item,
                &cycle_access_item,
                &cycle_reasoning_item,
                &cycle_collaboration_item,
            ])
            .build()?;
        registry.register_submenu("composer_menu", &submenu);
        submenu
    };

    let toggle_projects_sidebar_item =
        MenuItemBuilder::with_id("view_toggle_projects_sidebar", labels.toggle_projects_sidebar)
            .build(handle)?;
    let toggle_git_sidebar_item =
        MenuItemBuilder::with_id("view_toggle_git_sidebar", labels.toggle_git_sidebar)
            .build(handle)?;
    let toggle_global_search_item =
        MenuItemBuilder::with_id("view_toggle_global_search", labels.toggle_global_search)
            .accelerator("CmdOrCtrl+O")
            .build(handle)?;
    let toggle_debug_panel_item =
        MenuItemBuilder::with_id("view_toggle_debug_panel", labels.toggle_debug_panel)
            .accelerator("CmdOrCtrl+Shift+D")
            .build(handle)?;
    let toggle_terminal_item =
        MenuItemBuilder::with_id("view_toggle_terminal", labels.toggle_terminal)
            .accelerator("CmdOrCtrl+Shift+T")
            .build(handle)?;
    let toggle_devtools_item =
        MenuItemBuilder::with_id("view_toggle_devtools", labels.toggle_devtools)
            .accelerator("CmdOrCtrl+Alt+I")
            .build(handle)?;
    let next_agent_item =
        MenuItemBuilder::with_id("view_next_agent", labels.next_agent).build(handle)?;
    let prev_agent_item =
        MenuItemBuilder::with_id("view_prev_agent", labels.prev_agent).build(handle)?;
    let next_workspace_item =
        MenuItemBuilder::with_id("view_next_workspace", labels.next_workspace).build(handle)?;
    let prev_workspace_item =
        MenuItemBuilder::with_id("view_prev_workspace", labels.prev_workspace).build(handle)?;
    registry.register(
        "view_toggle_projects_sidebar",
        &toggle_projects_sidebar_item,
    );
    registry.register("view_toggle_git_sidebar", &toggle_git_sidebar_item);
    registry.register("view_toggle_global_search", &toggle_global_search_item);
    registry.register("view_toggle_debug_panel", &toggle_debug_panel_item);
    registry.register("view_toggle_terminal", &toggle_terminal_item);
    registry.register("view_toggle_devtools", &toggle_devtools_item);
    registry.register("view_next_agent", &next_agent_item);
    registry.register("view_prev_agent", &prev_agent_item);
    registry.register("view_next_workspace", &next_workspace_item);
    registry.register("view_prev_workspace", &prev_workspace_item);

    #[cfg(target_os = "linux")]
    let view_menu = {
        let fullscreen_item =
            MenuItemBuilder::with_id("view_fullscreen", labels.fullscreen).build(handle)?;
        registry.register("view_fullscreen", &fullscreen_item);
        let submenu = SubmenuBuilder::with_id(handle, "view_menu", labels.view)
            .items(&[
                &toggle_projects_sidebar_item,
                &toggle_git_sidebar_item,
                &toggle_global_search_item,
                &PredefinedMenuItem::separator(handle)?,
                &toggle_debug_panel_item,
                &toggle_terminal_item,
                &toggle_devtools_item,
                &PredefinedMenuItem::separator(handle)?,
                &next_agent_item,
                &prev_agent_item,
                &next_workspace_item,
                &prev_workspace_item,
                &PredefinedMenuItem::separator(handle)?,
                &fullscreen_item,
            ])
            .build()?;
        registry.register_submenu("view_menu", &submenu);
        submenu
    };
    #[cfg(not(target_os = "linux"))]
    let view_menu = {
        let submenu = SubmenuBuilder::with_id(handle, "view_menu", labels.view)
            .items(&[
                &toggle_projects_sidebar_item,
                &toggle_git_sidebar_item,
                &toggle_global_search_item,
                &PredefinedMenuItem::separator(handle)?,
                &toggle_debug_panel_item,
                &toggle_terminal_item,
                &toggle_devtools_item,
                &PredefinedMenuItem::separator(handle)?,
                &next_agent_item,
                &prev_agent_item,
                &next_workspace_item,
                &prev_workspace_item,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::fullscreen(handle, None)?,
            ])
            .build()?;
        registry.register_submenu("view_menu", &submenu);
        submenu
    };

    #[cfg(target_os = "linux")]
    let window_menu = {
        let minimize_item =
            MenuItemBuilder::with_id("window_minimize", labels.minimize).build(handle)?;
        let maximize_item =
            MenuItemBuilder::with_id("window_maximize", labels.maximize).build(handle)?;
        let reload_item = build_reload_window_item(handle, labels)?;
        let close_item =
            MenuItemBuilder::with_id("window_close", labels.close_window).build(handle)?;
        registry.register("window_minimize", &minimize_item);
        registry.register("window_maximize", &maximize_item);
        registry.register("window_reload", &reload_item);
        registry.register("window_close", &close_item);
        let submenu = SubmenuBuilder::with_id(handle, "window_menu", labels.window)
            .items(&[
                &minimize_item,
                &maximize_item,
                &reload_item,
                &PredefinedMenuItem::separator(handle)?,
                &close_item,
            ])
            .build()?;
        registry.register_submenu("window_menu", &submenu);
        submenu
    };
    #[cfg(not(target_os = "linux"))]
    let window_menu = {
        let reload_item = build_reload_window_item(handle, labels)?;
        registry.register("window_reload", &reload_item);
        let submenu = SubmenuBuilder::with_id(handle, "window_menu", labels.window)
            .items(&[
                &PredefinedMenuItem::minimize(handle, None)?,
                &PredefinedMenuItem::maximize(handle, None)?,
                &reload_item,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::close_window(handle, None)?,
            ])
            .build()?;
        registry.register_submenu("window_menu", &submenu);
        submenu
    };

    #[cfg(target_os = "linux")]
    let help_menu = {
        let about_item =
            MenuItemBuilder::with_id("help_about", about_label.clone()).build(handle)?;
        registry.register("help_about", &about_item);
        let submenu = SubmenuBuilder::with_id(handle, "help_menu", labels.help)
            .items(&[&about_item])
            .build()?;
        registry.register_submenu("help_menu", &submenu);
        submenu
    };
    #[cfg(not(target_os = "linux"))]
    let help_menu = {
        let submenu = SubmenuBuilder::with_id(handle, "help_menu", labels.help).build()?;
        registry.register_submenu("help_menu", &submenu);
        submenu
    };

    Menu::with_items(
        handle,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &composer_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

pub(crate) fn handle_menu_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    event: tauri::menu::MenuEvent,
) {
    match event.id().as_ref() {
        "about" | "help_about" => {
            if let Some(window) = app.get_webview_window("about") {
                let _ = window.show();
                let _ = window.set_focus();
                return;
            }
            let about_title = format!("{} CodePort", saved_menu_labels().about_prefix);
            let _ = WebviewWindowBuilder::new(app, "about", WebviewUrl::App("index.html".into()))
                .title(about_title)
                .resizable(false)
                .inner_size(360.0, 240.0)
                .center()
                .build();
        }
        "check_for_updates" => {
            let _ = app.emit("updater-check", ());
        }
        "file_close_window" | "window_close" => {
            if let Some(window) = resolve_target_webview_window(app) {
                let _ = window.close();
            }
        }
        "file_quit" => {
            app.exit(0);
        }
        "view_fullscreen" => {
            if let Some(window) = resolve_target_webview_window(app) {
                let is_fullscreen = window.is_fullscreen().unwrap_or(false);
                let _ = window.set_fullscreen(!is_fullscreen);
            }
        }
        "view_toggle_devtools" => {
            if let Some(window) = resolve_target_webview_window(app) {
                if window.is_devtools_open() {
                    window.close_devtools();
                } else {
                    window.open_devtools();
                }
            }
        }
        "window_minimize" => {
            if let Some(window) = resolve_target_webview_window(app) {
                let _ = window.minimize();
            }
        }
        "window_reload" => {
            if let Some(window) = resolve_target_webview_window(app) {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.reload();
            }
        }
        "window_maximize" => {
            if let Some(window) = resolve_target_webview_window(app) {
                let _ = window.maximize();
            }
        }
        menu_id => {
            if let Some(menu_event_name) = menu_event_name_for_id(menu_id) {
                emit_menu_event(app, menu_event_name);
            }
        }
    }
}

fn menu_event_name_for_id(menu_id: &str) -> Option<&'static str> {
    match menu_id {
        "file_new_agent" => Some("menu-new-agent"),
        "file_new_worktree_agent" => Some("menu-new-worktree-agent"),
        "file_new_clone_agent" => Some("menu-new-clone-agent"),
        "file_new_window" => Some("menu-new-window"),
        "file_add_workspace" => Some("menu-add-workspace"),
        "file_open_settings" => Some("menu-open-settings"),
        "view_toggle_projects_sidebar" => Some("menu-toggle-projects-sidebar"),
        "view_toggle_git_sidebar" => Some("menu-toggle-git-sidebar"),
        "view_toggle_global_search" => Some("menu-toggle-global-search"),
        "view_toggle_debug_panel" => Some("menu-toggle-debug-panel"),
        "view_toggle_terminal" => Some("menu-toggle-terminal"),
        "view_next_agent" => Some("menu-next-agent"),
        "view_prev_agent" => Some("menu-prev-agent"),
        "view_next_workspace" => Some("menu-next-workspace"),
        "view_prev_workspace" => Some("menu-prev-workspace"),
        "composer_cycle_model" => Some("menu-composer-cycle-model"),
        "composer_cycle_access" => Some("menu-composer-cycle-access"),
        "composer_cycle_reasoning" => Some("menu-composer-cycle-reasoning"),
        "composer_cycle_collaboration" => Some("menu-composer-cycle-collaboration"),
        _ => None,
    }
}

fn emit_menu_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit(event, ());
    } else {
        let _ = app.emit(event, ());
    }
}

#[cfg(test)]
mod tests {
    use super::{menu_event_name_for_id, reload_window_accelerator, NEW_WINDOW_ACCELERATOR};

    #[test]
    fn new_window_menu_shortcut_matches_expected() {
        assert_eq!(NEW_WINDOW_ACCELERATOR, "CmdOrCtrl+Shift+N");
    }

    #[test]
    fn reload_window_menu_shortcut_matches_expected() {
        #[cfg(target_os = "macos")]
        assert_eq!(reload_window_accelerator(), Some("CmdOrCtrl+R"));
        #[cfg(not(target_os = "macos"))]
        assert_eq!(reload_window_accelerator(), None);
    }

    #[test]
    fn menu_event_mapping_includes_new_window() {
        assert_eq!(
            menu_event_name_for_id("file_new_window"),
            Some("menu-new-window")
        );
        assert_eq!(menu_event_name_for_id("unknown"), None);
    }
}
