// bobo v2 桌面壳（Tauri 2）：复用主项目的 Node 服务与网页资源。
// 主窗口加载本地服务页面（服务未就绪时不显示）；关闭窗口只是隐藏，应用常驻托盘。
mod island;
mod service;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};

fn app_url() -> String {
    format!("http://127.0.0.1:{}/?app=1", service::port())
}

/// 显示并激活主窗口：macOS 上同时切到 regular（出现 Dock 图标与 ⌘Tab），与 Swift 版一致。
fn show_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 隐藏窗口：macOS 上切回 accessory（关掉 Dock 图标），应用留在托盘。
fn hide_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

// 托盘菜单：M2 只有「打开 bobo / 退出 bobo」；通知岛相关项在 M3 接上。
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 bobo", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 bobo", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id("tray")
        .tooltip("bobo")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        });
    match tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
        Ok(icon) => builder = builder.icon(icon),
        Err(_) => {
            if let Some(icon) = app.default_window_icon().cloned() {
                builder = builder.icon(icon);
            }
        }
    }
    builder.build(app)?;
    Ok(())
}

/// 通知岛：窗口在 setup 里就创建好（AppKit 要求主线程建窗口），服务就绪后再定位并显示。
fn show_island(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(island::LABEL) else {
        return;
    };
    // 重新指向当前端口（BOBO_PORT 可变），并贴屏幕顶边居中。
    let page = format!("http://127.0.0.1:{}/panel.html", service::port());
    if let Ok(url) = page.parse::<tauri::Url>() {
        let _ = window.navigate(url);
    }
    if let Some(position) = island::top_center_position(&window, island::COLLAPSED_W) {
        let _ = window.set_position(position);
    }
    let _ = window.show();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二次启动：唤出已有窗口，不再开新实例。
            show_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(service::Service::default())
        .invoke_handler(tauri::generate_handler![island::island_resize])
        .setup(|app| {
            let handle = app.handle().clone();
            // 启动时无 Dock 图标：只有打开窗口时才切到 regular（见 show_window）。
            #[cfg(target_os = "macos")]
            let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            setup_tray(&handle)?;
            // 通知岛窗口必须在主线程创建，所以在这里就建好（先隐藏），服务就绪后再 show。
            let page = format!("http://127.0.0.1:{}/panel.html", service::port());
            match island::create(&handle, &page) {
                Ok(window) => {
                    let _ = window.hide();
                }
                Err(error) => eprintln!("[bobo] 通知岛创建失败：{error}"),
            }
            if let Some(window) = app.get_webview_window("main") {
                let h = handle.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        // 关闭＝隐藏：应用继续驻留托盘（与 Swift 版行为一致）。
                        api.prevent_close();
                        hide_window(&h);
                    }
                });
            }
            // 启动服务要等端口就绪，放到后台线程，避免阻塞主线程的事件循环。
            std::thread::spawn(move || match service::ensure(&handle) {
                Ok(()) => {
                    if let Some(window) = handle.get_webview_window("main") {
                        if let Ok(url) = app_url().parse::<tauri::Url>() {
                            let _ = window.navigate(url);
                        }
                    }
                    show_window(&handle);
                    show_island(&handle);
                }
                Err(message) => {
                    eprintln!("[bobo] 服务启动失败：{message}");
                    use tauri_plugin_dialog::DialogExt;
                    let _ = handle
                        .dialog()
                        .message(message)
                        .title("bobo 启动失败")
                        .blocking_show();
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("bobo 初始化失败")
        .run(|handle, event| {
            match event {
            RunEvent::ExitRequested { .. } => {
                handle.state::<service::Service>().stop();
            }
            // macOS：点 Dock 图标重新显示窗口。
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_window(handle),
            _ => {}
        }
    });
}
