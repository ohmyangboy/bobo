// 通知岛：屏幕顶部的透明悬浮胶囊（面板内容见 public/panel.html）。
// 这里只负责窗口形态与定位；数据由面板自己订阅 /api/opencode/stream。
//
// macOS 上有三处 Tauri 没暴露、必须用 AppKit 补：
//   1. 窗口层级要盖过菜单栏（mainMenuWindow + 2）；
//   2. collectionBehavior 要能跨空间、进出全屏不消失、不参与 ⌘Tab；
//   3. 刘海宽度与高度只有 NSScreen 知道（safeAreaInsets / auxiliaryTopLeftArea）。
// 三步分别落在 apply_macos_behavior / notch_metrics 里。
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "island";
/// 折叠态胶囊的初始尺寸：宽度够放下内容即可，面板加载后会回报实际宽度（见 island_resize）；
/// 高度与 Swift 版对齐（折叠态一条胶囊，展开态由内容决定）。
pub const COLLAPSED_W: f64 = 420.0;
pub const COLLAPSED_H: f64 = 34.0;

pub fn create(app: &AppHandle, page: &str) -> tauri::Result<tauri::WebviewWindow> {
    let url: tauri::Url = page.parse().expect("无效的通知岛地址");
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("bobo island")
        .inner_size(COLLAPSED_W, COLLAPSED_H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()?;
    #[cfg(target_os = "macos")]
    apply_macos_behavior(&window);
    Ok(window)
}

// ---- macOS：窗口层级与 collectionBehavior ----
#[cfg(target_os = "macos")]
fn apply_macos_behavior(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let Ok(ptr) = window.ns_window() else { return };
    // SAFETY：ns_window 返回的就是这块 WKWebView 所在窗口的 NSWindow 指针，所有权在 Tauri 手里，
    // 这里只借用做配置，不接管生命周期。
    let ns: &NSWindow = unsafe { &*(ptr as *mut NSWindow) };
    // 盖过菜单栏：mainMenuWindow(24) + 2，与 Swift 版一致。
    ns.setLevel(26);
    ns.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    ns.setAcceptsMouseMovedEvents(true);
}

/// 面板回报内容尺寸：调整窗口尺寸并重新贴顶居中（窗口是无边框透明窗，尺寸必须等于画面）。
#[tauri::command]
pub fn island_resize(window: tauri::WebviewWindow, width: f64, height: f64) {
    if window.label() != LABEL {
        return;
    }
    let width = width.clamp(120.0, 900.0);
    let height = height.clamp(COLLAPSED_H, 640.0);
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    if let Some(position) = top_center_position(&window, width) {
        let _ = window.set_position(position);
    }
}

/// 屏幕顶边居中的位置：macOS 用主屏（有刘海的优先），其它平台用主显示器。
pub fn top_center_position(window: &tauri::WebviewWindow, width: f64) -> Option<tauri::LogicalPosition<f64>> {
    let monitor = window.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let screen_width = monitor.size().width as f64 / scale;
    Some(tauri::LogicalPosition::new((screen_width - width) / 2.0, 0.0))
}
