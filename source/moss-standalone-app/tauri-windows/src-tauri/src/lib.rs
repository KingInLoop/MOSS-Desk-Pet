mod layout;
mod monitor;
mod settings;
mod usage;

use layout::{pet_bounds, reflow, window_size, Placement, Rect};
use monitor::{MonitorEvent, PublicTask, Snapshot};
use serde_json::{json, Value};
use settings::{Settings, EYE_COLORS, SCALES, TRAY_ICON_MODES};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, Submenu},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Theme, WebviewWindow, Wry,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::{NotificationExt, PermissionState};

#[derive(Clone)]
struct RuntimeState {
    settings: Settings,
    settings_path: PathBuf,
    details_expanded: bool,
    panel_mode: String,
    placement: Placement,
    snapshot: Snapshot,
    usage: usage::UsageSnapshot,
}

struct AppState {
    runtime: Mutex<RuntimeState>,
    stop: Arc<AtomicBool>,
}

fn effective_tray_icon_mode(settings: &Settings, theme: Theme) -> &str {
    if settings.tray_icon_mode == "auto" {
        if theme == Theme::Dark {
            "light"
        } else {
            "dark"
        }
    } else {
        settings.tray_icon_mode.as_str()
    }
}

fn tray_icon_image(mode: &str) -> Result<Image<'static>, String> {
    let bytes = if mode == "light" {
        include_bytes!("../../../assets/icons/tray-light.png").as_slice()
    } else {
        include_bytes!("../../../assets/icons/tray-dark.png").as_slice()
    };
    Image::from_bytes(bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tray_icon_tests {
    use super::*;

    #[test]
    fn automatic_mode_uses_the_opposite_system_brightness() {
        let settings = Settings::default();
        assert_eq!(effective_tray_icon_mode(&settings, Theme::Dark), "light");
        assert_eq!(effective_tray_icon_mode(&settings, Theme::Light), "dark");
    }

    #[test]
    fn manual_mode_overrides_the_system_theme() {
        let mut settings = Settings::default();
        settings.tray_icon_mode = "light".into();
        assert_eq!(effective_tray_icon_mode(&settings, Theme::Light), "light");
    }
}

fn refresh_tray_icon(app: &AppHandle, theme_override: Option<Theme>) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("MOSS 窗口不存在")?;
    let theme = theme_override
        .or_else(|| window.theme().ok())
        .unwrap_or(Theme::Light);
    let settings = app
        .state::<AppState>()
        .runtime
        .lock()
        .map_err(|_| "运行状态锁定失败")?
        .settings
        .clone();
    let mode = effective_tray_icon_mode(&settings, theme);
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_icon(Some(tray_icon_image(mode)?))
            .map_err(|error| error.to_string())?;
    }
    window
        .set_icon(tray_icon_image(mode)?)
        .map_err(|error| error.to_string())
}

fn source_label(source: &str) -> &'static str {
    match source {
        "desktop" => "Codex 桌面端",
        "vscode" => "VS Code Codex",
        _ => "Codex",
    }
}

fn task_name(task: Option<&PublicTask>) -> String {
    task.map(|task| format!("“{}”", task.title))
        .unwrap_or_else(|| "任务".into())
}

fn emit_snapshot<R: Runtime>(window: &WebviewWindow<R>, snapshot: &Snapshot) {
    let _ = window.emit("task-snapshot", snapshot);
}

fn emit_pet_event<R: Runtime>(
    window: &WebviewWindow<R>,
    event_type: &str,
    snapshot: &Snapshot,
    source: Option<&str>,
    task: Option<&PublicTask>,
    interruption_kind: Option<&str>,
) {
    let mut value = serde_json::to_value(snapshot).unwrap_or_else(|_| json!({}));
    if let Some(object) = value.as_object_mut() {
        object.insert("type".into(), Value::String(event_type.into()));
        if let Some(source) = source {
            object.insert("source".into(), Value::String(source.into()));
        }
        if let Some(task) = task {
            object.insert(
                "task".into(),
                serde_json::to_value(task).unwrap_or(Value::Null),
            );
        }
        if let Some(kind) = interruption_kind {
            object.insert("interruptionKind".into(), Value::String(kind.into()));
        }
    }
    let _ = window.emit("pet-event", value);
}

fn show_notification(app: &AppHandle, title: &str, body: &str) {
    let notifications_enabled = app
        .state::<AppState>()
        .runtime
        .lock()
        .map(|runtime| runtime.settings.notifications)
        .unwrap_or(false);
    if !notifications_enabled {
        return;
    }
    let notification = app.notification();
    let permission = notification
        .permission_state()
        .unwrap_or(PermissionState::Prompt);
    let granted = permission == PermissionState::Granted
        || (permission == PermissionState::Prompt
            && notification.request_permission().ok() == Some(PermissionState::Granted));
    if granted {
        let _ = notification.builder().title(title).body(body).show();
    }
}

fn handle_monitor_event(app: &AppHandle, event: MonitorEvent) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let snapshot = match &event {
        MonitorEvent::Ready(snapshot)
        | MonitorEvent::Started { snapshot, .. }
        | MonitorEvent::Completed { snapshot, .. }
        | MonitorEvent::Interrupted { snapshot, .. }
        | MonitorEvent::Cancelled { snapshot, .. } => snapshot.clone(),
    };
    if let Ok(mut runtime) = app.state::<AppState>().runtime.lock() {
        runtime.snapshot = snapshot.clone();
    }
    match &event {
        MonitorEvent::Ready(snapshot) => {
            emit_pet_event(
                &window,
                if snapshot.active_count > 0 {
                    "running"
                } else {
                    "idle"
                },
                snapshot,
                snapshot.source.as_deref(),
                None,
                None,
            );
        }
        MonitorEvent::Started {
            snapshot,
            source,
            task,
        } => {
            emit_pet_event(&window, "running", snapshot, Some(source), Some(task), None);
        }
        MonitorEvent::Completed {
            snapshot,
            source,
            task,
        } => {
            emit_pet_event(
                &window,
                "completed",
                snapshot,
                Some(source),
                task.as_ref(),
                None,
            );
            show_notification(
                app,
                "MOSS：任务完成",
                &format!(
                    "{} 的{}已正常完成。",
                    source_label(source),
                    task_name(task.as_ref())
                ),
            );
        }
        MonitorEvent::Interrupted {
            snapshot,
            source,
            task,
            kind,
        } => {
            emit_pet_event(
                &window,
                "interrupted",
                snapshot,
                Some(source),
                task.as_ref(),
                Some(kind),
            );
            let reason = match kind.as_str() {
                "network" => "网络连接异常",
                "authentication" => "身份认证异常",
                "rate-limit" => "请求频率受限",
                "service" => "Codex 服务异常",
                _ => "未知运行异常",
            };
            show_notification(
                app,
                "MOSS：任务异常中断",
                &format!("{}因{}而中断。", task_name(task.as_ref()), reason),
            );
        }
        MonitorEvent::Cancelled {
            snapshot,
            source,
            task,
        } => {
            emit_pet_event(
                &window,
                "cancelled",
                snapshot,
                Some(source),
                task.as_ref(),
                None,
            );
        }
    }
    emit_snapshot(&window, &snapshot);
    rebuild_tray(app);
}

fn checked<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    value: bool,
) -> tauri::Result<CheckMenuItem<R>> {
    CheckMenuItem::with_id(app, id, label, true, value, None::<&str>)
}

fn build_menu(app: &AppHandle<Wry>, context: bool) -> tauri::Result<Menu<Wry>> {
    let (settings, details_expanded, panel_mode, snapshot, visible) = {
        let state = app.state::<AppState>();
        let runtime = state.runtime.lock().expect("runtime state poisoned");
        let visible = app
            .get_webview_window("main")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);
        (
            runtime.settings.clone(),
            runtime.details_expanded,
            runtime.panel_mode.clone(),
            runtime.snapshot.clone(),
            visible,
        )
    };
    let status_text = if snapshot.active_count > 0 {
        format!(
            "正在执行 {} 个任务 · {}",
            snapshot.active_count,
            source_label(snapshot.source.as_deref().unwrap_or("codex"))
        )
    } else {
        "正在监听 Codex 任务".into()
    };
    let status = MenuItem::with_id(app, "status", status_text, false, None::<&str>)?;
    let window_toggle = MenuItem::with_id(
        app,
        "window:toggle",
        if visible {
            "隐藏 MOSS"
        } else {
            "显示 MOSS"
        },
        true,
        None::<&str>,
    )?;
    let tasks = MenuItem::with_id(
        app,
        "tasks:toggle",
        if context && details_expanded && panel_mode == "tasks" {
            "收起运行任务".into()
        } else {
            format!("查看运行任务（{}）", snapshot.active_count)
        },
        true,
        None::<&str>,
    )?;
    let usage = MenuItem::with_id(
        app,
        "usage:toggle",
        if context && details_expanded && panel_mode == "usage" {
            "收起订阅额度"
        } else {
            "查看订阅额度"
        },
        true,
        None::<&str>,
    )?;

    let dark = checked(app, "skin:dark", "暗黑枪灰", settings.skin == "dark")?;
    let light = checked(app, "skin:light", "明亮白色", settings.skin == "light")?;
    let skin = Submenu::with_items(app, "皮肤", true, &[&dark, &light])?;

    let eye_default = checked(
        app,
        "eye:default",
        "MOSS 红",
        settings.eye_color == "default",
    )?;
    let eye_cyan = checked(app, "eye:cyan", "氦青", settings.eye_color == "cyan")?;
    let eye_blue = checked(app, "eye:blue", "导航蓝", settings.eye_color == "blue")?;
    let eye_amber = checked(app, "eye:amber", "警告琥珀", settings.eye_color == "amber")?;
    let eye_violet = checked(app, "eye:violet", "量子紫", settings.eye_color == "violet")?;
    let eye_green = checked(app, "eye:green", "系统绿", settings.eye_color == "green")?;
    let eye = Submenu::with_items(
        app,
        "镜头颜色",
        true,
        &[
            &eye_default,
            &eye_cyan,
            &eye_blue,
            &eye_amber,
            &eye_violet,
            &eye_green,
        ],
    )?;

    let size_small = checked(app, "scale:0.55", "小", settings.scale == 0.55)?;
    let size_medium = checked(app, "scale:0.65", "中", settings.scale == 0.65)?;
    let size_default = checked(app, "scale:0.75", "默认", settings.scale == 0.75)?;
    let size_large = checked(app, "scale:0.875", "大", settings.scale == 0.875)?;
    let size_xlarge = checked(app, "scale:1", "特大", settings.scale == 1.0)?;
    let size = Submenu::with_items(
        app,
        "显示大小",
        true,
        &[
            &size_small,
            &size_medium,
            &size_default,
            &size_large,
            &size_xlarge,
        ],
    )?;

    let tray_auto = checked(
        app,
        "tray-icon:auto",
        "自动（推荐）",
        settings.tray_icon_mode == "auto",
    )?;
    let tray_light = checked(
        app,
        "tray-icon:light",
        "浅色图标（适合深色背景）",
        settings.tray_icon_mode == "light",
    )?;
    let tray_dark = checked(
        app,
        "tray-icon:dark",
        "深色图标（适合浅色背景）",
        settings.tray_icon_mode == "dark",
    )?;
    let tray_icon = Submenu::with_items(
        app,
        "任务栏图标",
        true,
        &[&tray_auto, &tray_light, &tray_dark],
    )?;

    let always = checked(
        app,
        "toggle:always-on-top",
        "始终置顶",
        settings.always_on_top,
    )?;
    let notifications = checked(
        app,
        "toggle:notifications",
        "任务状态通知",
        settings.notifications,
    )?;
    let badge = checked(
        app,
        "toggle:status-badge",
        "显示状态灯",
        settings.show_status_badge,
    )?;
    let login = checked(
        app,
        "toggle:launch-at-login",
        "登录时启动",
        settings.launch_at_login,
    )?;
    let hide = MenuItem::with_id(app, "window:hide", "隐藏 MOSS", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "app:quit", "退出 MOSS", true, None::<&str>)?;

    let separator_1 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let separator_2 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let separator_3 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&status, &separator_1];
    if !context {
        items.push(&window_toggle);
    }
    items.push(&tasks);
    items.push(&usage);
    items.push(&skin);
    items.push(&eye);
    items.push(&size);
    items.push(&tray_icon);
    items.push(&separator_2);
    items.push(&always);
    items.push(&notifications);
    items.push(&badge);
    items.push(&login);
    items.push(&separator_3);
    if context {
        items.push(&hide);
    }
    items.push(&quit);
    Menu::with_items(app, &items)
}

fn rebuild_tray(app: &AppHandle) {
    let Ok(menu) = build_menu(app, false) else {
        return;
    };
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_menu(Some(menu));
    }
}

fn logical_window_and_area(window: &WebviewWindow) -> Result<(Rect, Rect), String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let size = window
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or("找不到显示器")?;
    let monitor_scale = monitor.scale_factor();
    let work_position = monitor
        .work_area()
        .position
        .to_logical::<f64>(monitor_scale);
    let work_size = monitor.work_area().size.to_logical::<f64>(monitor_scale);
    Ok((
        Rect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        Rect {
            x: work_position.x,
            y: work_position.y,
            width: work_size.width,
            height: work_size.height,
        },
    ))
}

fn resize_window(
    app: &AppHandle,
    previous_scale: f64,
    previous_expanded: bool,
) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("MOSS 窗口不存在")?;
    let (current, work_area) = logical_window_and_area(&window)?;
    let (next_scale, next_expanded, previous_placement) = {
        let state = app.state::<AppState>();
        let runtime = state.runtime.lock().map_err(|_| "运行状态锁定失败")?;
        (
            runtime.settings.scale,
            runtime.details_expanded,
            runtime.placement,
        )
    };
    let (next, placement) = reflow(
        current,
        previous_scale,
        previous_expanded,
        previous_placement,
        next_scale,
        next_expanded,
        work_area,
    );
    window
        .set_size(LogicalSize::new(next.width, next.height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(LogicalPosition::new(next.x, next.y))
        .map_err(|error| error.to_string())?;
    if let Ok(mut runtime) = app.state::<AppState>().runtime.lock() {
        runtime.placement = placement;
    }
    let _ = window.emit("panel-placement", placement);
    Ok(())
}

fn sync_autostart(app: &AppHandle, enabled: bool) {
    let manager = app.autolaunch();
    if enabled {
        let _ = manager.enable();
    } else {
        let _ = manager.disable();
    }
}

fn update_settings<F>(app: &AppHandle, update: F) -> Result<(), String>
where
    F: FnOnce(&mut Settings),
{
    let (previous_scale, details_expanded, settings, path) = {
        let state = app.state::<AppState>();
        let mut runtime = state.runtime.lock().map_err(|_| "运行状态锁定失败")?;
        let previous_scale = runtime.settings.scale;
        update(&mut runtime.settings);
        runtime.settings = runtime.settings.clone().normalize();
        (
            previous_scale,
            runtime.details_expanded,
            runtime.settings.clone(),
            runtime.settings_path.clone(),
        )
    };
    settings::write(&path, &settings)?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(settings.always_on_top);
        let _ = window.emit("settings", &settings);
    }
    if (previous_scale - settings.scale).abs() > f64::EPSILON {
        resize_window(app, previous_scale, details_expanded)?;
    }
    sync_autostart(app, settings.launch_at_login);
    refresh_tray_icon(app, None)?;
    rebuild_tray(app);
    Ok(())
}

fn set_details(app: &AppHandle, expanded: bool) -> Result<(), String> {
    let (previous_expanded, scale) = {
        let state = app.state::<AppState>();
        let mut runtime = state.runtime.lock().map_err(|_| "运行状态锁定失败")?;
        let previous = runtime.details_expanded;
        runtime.details_expanded = expanded;
        (previous, runtime.settings.scale)
    };
    resize_window(app, scale, previous_expanded)?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("details-expanded", expanded);
    }
    rebuild_tray(app);
    Ok(())
}

fn set_panel(app: &AppHandle, mode: &str, expanded: bool) -> Result<(), String> {
    if let Ok(mut runtime) = app.state::<AppState>().runtime.lock() {
        runtime.panel_mode = if mode == "usage" { "usage" } else { "tasks" }.into();
    }
    set_details(app, expanded)?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("panel-mode", mode);
    }
    if expanded && mode == "usage" {
        refresh_usage_now(app.clone());
    }
    Ok(())
}

fn refresh_usage_now(app: AppHandle) {
    thread::spawn(move || {
        let snapshot = usage::read();
        if let Ok(mut runtime) = app.state::<AppState>().runtime.lock() {
            runtime.usage = snapshot.clone();
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("usage-snapshot", snapshot);
        }
    });
}

fn handle_menu(app: &AppHandle, id: &str) {
    let result = match id {
        "app:quit" => {
            app.exit(0);
            return;
        }
        "window:hide" => app
            .get_webview_window("main")
            .map(|window| window.hide().map_err(|error| error.to_string()))
            .unwrap_or(Ok(())),
        "window:toggle" => {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_visible().unwrap_or(false) {
                    window.hide()
                } else {
                    let _ = window.show();
                    window.set_focus()
                }
                .map_err(|error| error.to_string())
            } else {
                Ok(())
            }
        }
        "tasks:toggle" => {
            let expanded = app
                .state::<AppState>()
                .runtime
                .lock()
                .map(|runtime| !(runtime.details_expanded && runtime.panel_mode == "tasks"))
                .unwrap_or(true);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            set_panel(app, "tasks", expanded)
        }
        "usage:toggle" => {
            let expanded = app
                .state::<AppState>()
                .runtime
                .lock()
                .map(|runtime| !(runtime.details_expanded && runtime.panel_mode == "usage"))
                .unwrap_or(true);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            set_panel(app, "usage", expanded)
        }
        "skin:dark" => update_settings(app, |settings| settings.skin = "dark".into()),
        "skin:light" => update_settings(app, |settings| settings.skin = "light".into()),
        value if value.starts_with("eye:") => {
            let color = value.trim_start_matches("eye:");
            if EYE_COLORS.contains(&color) {
                update_settings(app, |settings| settings.eye_color = color.into())
            } else {
                Ok(())
            }
        }
        value if value.starts_with("scale:") => {
            let scale = value
                .trim_start_matches("scale:")
                .parse::<f64>()
                .unwrap_or(0.75);
            if SCALES.contains(&scale) {
                update_settings(app, |settings| settings.scale = scale)
            } else {
                Ok(())
            }
        }
        value if value.starts_with("tray-icon:") => {
            let mode = value.trim_start_matches("tray-icon:");
            if TRAY_ICON_MODES.contains(&mode) {
                update_settings(app, |settings| settings.tray_icon_mode = mode.into())
            } else {
                Ok(())
            }
        }
        "toggle:always-on-top" => update_settings(app, |settings| {
            settings.always_on_top = !settings.always_on_top
        }),
        "toggle:notifications" => update_settings(app, |settings| {
            settings.notifications = !settings.notifications
        }),
        "toggle:status-badge" => update_settings(app, |settings| {
            settings.show_status_badge = !settings.show_status_badge
        }),
        "toggle:launch-at-login" => update_settings(app, |settings| {
            settings.launch_at_login = !settings.launch_at_login
        }),
        _ => Ok(()),
    };
    if let Err(error) = result {
        eprintln!("MOSS menu action failed: {error}");
    }
}

#[tauri::command]
fn renderer_ready(app: AppHandle) {
    let (settings, expanded, panel_mode, placement, snapshot, usage) = {
        let state = app.state::<AppState>();
        let runtime = state.runtime.lock().expect("runtime state poisoned");
        (
            runtime.settings.clone(),
            runtime.details_expanded,
            runtime.panel_mode.clone(),
            runtime.placement,
            runtime.snapshot.clone(),
            runtime.usage.clone(),
        )
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("settings", settings);
        let _ = window.emit("details-expanded", expanded);
        let _ = window.emit("panel-mode", panel_mode);
        let _ = window.emit("panel-placement", placement);
        emit_snapshot(&window, &snapshot);
        let _ = window.emit("usage-snapshot", usage);
        emit_pet_event(
            &window,
            if snapshot.active_count > 0 {
                "running"
            } else {
                "idle"
            },
            &snapshot,
            snapshot.source.as_deref(),
            None,
            None,
        );
    }
}

#[tauri::command]
fn toggle_skin(app: AppHandle) -> Result<(), String> {
    update_settings(&app, |settings| {
        settings.skin = if settings.skin == "dark" {
            "light".into()
        } else {
            "dark".into()
        }
    })
}

#[tauri::command]
fn set_details_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    set_details(&app, expanded)
}

#[tauri::command]
fn set_panel_mode(app: AppHandle, mode: String) -> Result<(), String> {
    set_panel(&app, &mode, true)
}

#[tauri::command]
fn refresh_usage(app: AppHandle) {
    refresh_usage_now(app);
}

#[tauri::command]
fn show_context_menu(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let menu = build_menu(&app, true).map_err(|error| error.to_string())?;
    window.popup_menu(&menu).map_err(|error| error.to_string())
}

#[tauri::command]
fn move_pet_by(window: WebviewWindow, delta_x: f64, delta_y: f64) -> Result<(), String> {
    if !delta_x.is_finite() || !delta_y.is_finite() {
        return Err("无效的拖动距离".into());
    }
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let clamp = |value: f64| value.clamp(-500.0, 500.0);
    window
        .set_position(LogicalPosition::new(
            position.x + clamp(delta_x),
            position.y + clamp(delta_y),
        ))
        .map_err(|error| error.to_string())
}

fn start_cursor_tracker(app: AppHandle, stop: Arc<AtomicBool>) {
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(180));
            let Some(window) = app.get_webview_window("main") else {
                continue;
            };
            if !window.is_visible().unwrap_or(false) {
                continue;
            }
            let Ok(scale_factor) = window.scale_factor() else {
                continue;
            };
            let Ok(cursor) = window.cursor_position() else {
                continue;
            };
            let cursor = cursor.to_logical::<f64>(scale_factor);
            let Ok(position) = window.outer_position() else {
                continue;
            };
            let position = position.to_logical::<f64>(scale_factor);
            let Ok(size) = window.inner_size() else {
                continue;
            };
            let size = size.to_logical::<f64>(scale_factor);
            let (scale, expanded, placement) = {
                let state = app.state::<AppState>();
                let Ok(runtime) = state.runtime.lock() else {
                    continue;
                };
                (
                    runtime.settings.scale,
                    runtime.details_expanded,
                    runtime.placement,
                )
            };
            let pet = pet_bounds(
                Rect {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                },
                scale,
                expanded,
                placement,
            );
            let dx = cursor.x - (pet.x + pet.width / 2.0);
            let dy = cursor.y - (pet.y + pet.height / 2.0);
            let distance = (dx * dx + dy * dy).sqrt();
            let degrees = (dx.atan2(-dy).to_degrees() + 360.0) % 360.0;
            let _ = window.emit(
                "look-direction",
                json!({
                    "index": ((degrees / 22.5).round() as u8) % 16,
                    "engaged": distance < 760.0
                }),
            );
        }
    });
}

fn position_initial_window(window: &WebviewWindow, scale: f64) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("找不到主显示器")?;
    let factor = monitor.scale_factor();
    let position = monitor.work_area().position.to_logical::<f64>(factor);
    let size = monitor.work_area().size.to_logical::<f64>(factor);
    let (width, height) = window_size(scale, false);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(LogicalPosition::new(
            position.x + size.width - width - 24.0,
            position.y + size.height - height - 24.0,
        ))
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let settings = settings::read(&settings_path);
            let stop = Arc::new(AtomicBool::new(false));
            app.manage(AppState {
                runtime: Mutex::new(RuntimeState {
                    settings: settings.clone(),
                    settings_path,
                    details_expanded: false,
                    panel_mode: "tasks".into(),
                    placement: Placement::default(),
                    snapshot: Snapshot::default(),
                    usage: usage::UsageSnapshot::default(),
                }),
                stop: stop.clone(),
            });
            let window = app
                .get_webview_window("main")
                .ok_or("MOSS main window missing")?;
            window.set_always_on_top(settings.always_on_top)?;
            position_initial_window(&window, settings.scale).map_err(std::io::Error::other)?;
            let menu = build_menu(app.handle(), false)?;
            let theme = window.theme().unwrap_or(Theme::Light);
            let icon_mode = effective_tray_icon_mode(&settings, theme);
            window.set_icon(tray_icon_image(icon_mode)?)?;
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon_image(icon_mode)?)
                .tooltip("MOSS Desk Pet")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        }
                    ) {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
            sync_autostart(app.handle(), settings.launch_at_login);
            window.show()?;

            let monitor_app = app.handle().clone();
            let monitor_stop = stop.clone();
            thread::spawn(move || {
                monitor::run(monitor_stop, |event| {
                    handle_monitor_event(&monitor_app, event)
                })
            });
            start_cursor_tracker(app.handle().clone(), stop);
            refresh_usage_now(app.handle().clone());
            let usage_app = app.handle().clone();
            let usage_stop = app.state::<AppState>().stop.clone();
            thread::spawn(move || {
                while !usage_stop.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_secs(300));
                    if !usage_stop.load(Ordering::Relaxed) {
                        refresh_usage_now(usage_app.clone());
                    }
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            tauri::WindowEvent::ThemeChanged(theme) => {
                let automatic = window
                    .app_handle()
                    .state::<AppState>()
                    .runtime
                    .lock()
                    .map(|runtime| runtime.settings.tray_icon_mode == "auto")
                    .unwrap_or(false);
                if automatic {
                    let _ = refresh_tray_icon(window.app_handle(), Some(*theme));
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            renderer_ready,
            toggle_skin,
            set_details_expanded,
            set_panel_mode,
            refresh_usage,
            show_context_menu,
            move_pet_by
        ])
        .build(tauri::generate_context!())
        .expect("error while building MOSS Tauri application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(state) = app.try_state::<AppState>() {
                    state.stop.store(true, Ordering::Relaxed);
                }
            }
        });
}
