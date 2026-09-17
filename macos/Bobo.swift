import AppKit
import SwiftUI
import UserNotifications
import WebKit

@main
final class Bobo: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, UNUserNotificationCenterDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var notchWindow: NotchPanel!
    private var islandHosting: NSHostingView<IslandView>?
    private let islandModel = IslandModel()
    private var islandCollapse: DispatchWorkItem?
    private var islandAutoCollapse: DispatchWorkItem?
    private var islandTask: Task<Void, Never>?
    private var islandDragMonitor: Any?
    private var islandDragStartMouseX: CGFloat?
    private var islandDragStartOriginX: CGFloat?
    private var islandDragging = false
    private var isHopping = false
    private var lastNoticeKey = ""
    private var launchTime = Date().timeIntervalSince1970 * 1000
    // 面板当前所在的屏幕签名（frame 取整）：用于判断换屏，以及 auto 模式下保持不跳。
    private var currentScreenSignature = ""
    private static let islandOffsetKey = "islandOffsetX"
    // 面板位置偏移：只有打开「可移动」时才生效，否则恒定居中吸附在刘海区域。
    private var islandOffset: CGFloat {
        get { islandModel.settings.movable ? CGFloat(UserDefaults.standard.double(forKey: Self.islandOffsetKey)) : 0 }
        set { UserDefaults.standard.set(Double(newValue), forKey: Self.islandOffsetKey) }
    }
    private var apiToken = ""
    private var statusMenuStateItem: NSMenuItem!
    private var notchState = "", notchLabel = "", notchCount = 0
    // 面板显隐：初始为 false，等网页上报 visible 后再显示（否则 setNotchVisible(true) 会被短路，窗口永远不出现）。
    private var notchVisible = false
    private var statusItem: NSStatusItem?
    private var statusMenu: NSMenu!
    private var service: Process?
    private let address = URL(string: "http://127.0.0.1:4318")!
    private let appAddress = URL(string: "http://127.0.0.1:4318/?app=1")!
    private static let titlebarHeight: CGFloat = 28
    private var attempts = 0

    static func main() {
        let app = NSApplication.shared
        let delegate = Bobo()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let icon = Bundle.main.url(forResource: "Bobo", withExtension: "icns") {
            NSApp.applicationIconImage = NSImage(contentsOf: icon)
        }
        setupMainMenu()
        setupStatusMenu()
        setupWindow()
        setupNotch()
        requestNotificationAuth()
        webView.loadHTMLString("<body style='font:14px -apple-system;color-scheme:light dark;color:graytext;background:canvas;display:grid;place-items:center;height:95vh;margin:0'>正在启动 bobo…</body>", baseURL: nil)
        probe(startIfNeeded: true)
    }

    // 应用菜单仍用于窗口内的编辑快捷键；应用不显示在 Dock，仅在状态栏保留入口。
    private func setupMainMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 bobo", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 bobo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let edit = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        edit.submenu = editMenu
        menu.addItem(edit)
        // 窗口菜单提供 ⌘W，关闭窗口走 windowShouldClose 的隐藏逻辑。
        let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        let windowMenu = NSMenu(title: "窗口")
        let reload = NSMenuItem(title: "重新载入", action: #selector(reloadPages), keyEquivalent: "r")
        reload.target = self
        windowMenu.addItem(reload)
        windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu
    }

    // 状态栏图标默认不显示（只保留刘海）：是否显示由「设置 → 菜单栏」的开关决定，
    // 开关经 /api/opencode/stream 的快照同步到 applyIsland，再调用 syncStatusItem。
    private func setupStatusMenu() {
        let menu = NSMenu()
        let state = NSMenuItem(title: "OpenCode：未连接", action: nil, keyEquivalent: "")
        state.isEnabled = false
        menu.addItem(state)
        statusMenuStateItem = state
        menu.addItem(.separator())
        let open = NSMenuItem(title: "打开 bobo", action: #selector(showWindow), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        let status = NSMenuItem(title: "通知岛…", action: #selector(showOpenCodeStatus), keyEquivalent: "")
        status.target = self
        menu.addItem(status)
        let center = NSMenuItem(title: "通知岛居中", action: #selector(centerIsland), keyEquivalent: "")
        center.target = self
        menu.addItem(center)
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 bobo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        statusMenu = menu
    }

    private func syncStatusItem(_ visible: Bool) {
        if visible { showStatusItem() } else { hideStatusItem() }
    }

    private func showStatusItem() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = statusImage(state: notchState)
            button.toolTip = "bobo"
            button.target = self
            button.action = #selector(statusItemClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item
    }

    private func hideStatusItem() {
        guard let item = statusItem else { return }
        NSStatusBar.system.removeStatusItem(item)
        statusItem = nil
    }

    // 状态栏图标：应用图标右下角叠加状态点（没有状态点时就是原始图标）。
    private func statusImage(state: String) -> NSImage {
        let colors: [String: NSColor] = ["working": .systemBlue, "waiting": .systemOrange, "idle": .systemGreen, "error": .systemRed]
        return NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            if let icon = NSApp.applicationIconImage {
                NSGraphicsContext.current?.imageInterpolation = .high
                icon.draw(in: rect)
            } else {
                NSImage(systemSymbolName: "shippingbox", accessibilityDescription: "bobo")?.draw(in: rect)
            }
            if let color = colors[state] {
                let dot = NSRect(x: 10.5, y: 0.5, width: 7, height: 7)
                NSColor.white.withAlphaComponent(0.92).setFill()
                NSBezierPath(ovalIn: dot.insetBy(dx: -1.2, dy: -1.2)).fill()
                color.setFill()
                NSBezierPath(ovalIn: dot).fill()
            }
            return true
        }
    }

    private func setupWindow() {
        webView = WKWebView(frame: .zero)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1140, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "bobo"
        // 隐藏原生标题栏：页面顶栏与红黄绿灯融为一体，界面完全由网页绘制。
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 760, height: 500)
        // 用容器把网页与顶部拖拽条分层：红黄绿灯所在的 28pt 区域只负责拖动窗口，不遮挡网页。
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 1140, height: 760))
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        let drag = TitlebarDragView(frame: NSRect(x: 0, y: 760 - Self.titlebarHeight, width: 1140, height: Self.titlebarHeight))
        drag.autoresizingMask = [.width, .minYMargin]
        container.addSubview(drag)
        window.contentView = container
        // 关窗只隐藏窗口：不释放窗口对象，也不终止应用（应用继续驻留状态栏）。
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        showWindow()
    }

    // 通知岛：无边框悬浮窗，顶部与屏幕顶边齐平（有刘海的屏幕优先），内容用 SwiftUI 绘制。
    // 形态与交互参考 CodeIsland：比菜单栏高两级、约束重排时不被压下去、所有空间与全屏下可见；
    // 折叠时只占一条与刘海同高的胶囊，鼠标移入向下展开会话列表。
    private func setupNotch() {
        let width: CGFloat = 220, height: CGFloat = 30
        notchWindow = NotchPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        notchWindow.isFloatingPanel = true
        notchWindow.becomesKeyOnlyIfNeeded = true
        notchWindow.hidesOnDeactivate = false
        notchWindow.acceptsMouseMovedEvents = true
        notchWindow.isMovableByWindowBackground = false
        notchWindow.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 2)
        notchWindow.backgroundColor = .clear
        notchWindow.isOpaque = false
        notchWindow.hasShadow = false
        notchWindow.isReleasedWhenClosed = false
        notchWindow.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        let hosting = IslandHostingView(rootView: IslandView(
            model: islandModel,
            onSelect: { [weak self] session in self?.focusIsland(session) },
            onActivate: { [weak self] in
                guard let self, !self.islandDragging else { return }
                self.showWindow()
            },
            onQuota: { [weak self] in
                guard let self, !self.islandDragging else { return }
                self.cycleUsage()
            }
        ))
        hosting.onHoverChange = { [weak self] hovering in self?.islandHovering(hovering) }
        hosting.frame = NSRect(x: 0, y: 0, width: width, height: height)
        hosting.autoresizingMask = [.width, .height]
        // 关键：不让 SwiftUI 用内容的 intrinsic 尺寸去改自身 frame，否则面板会缩到内容高度、顶部露出桌面。
        hosting.sizingOptions = []
        hosting.translatesAutoresizingMaskIntoConstraints = true
        islandHosting = hosting
        notchWindow.contentView = hosting
        setupIslandDrag()
        positionNotch()
        // 屏幕配置变化（插拔、分辨率、排列）与前台应用切换都要重判面板该在哪块屏。
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.handleScreenParametersChange()
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refreshScreen()
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refreshScreen()
        }
    }

    // 面板该显示在哪块屏幕（设置里的 display 决定）：
    // auto 跟随当前前台应用的活动窗口（参考 CodeIsland 的 ScreenDetector），其次有刘海的屏幕，再次主屏；
    // builtin 固定有刘海的屏幕，main 固定主屏。auto 下拿不到目标时保持当前屏幕，避免面板来回跳。
    // 主屏＝带菜单栏的那块，即 `NSScreen.screens[0]`；**不要用 `NSScreen.main`**——它的定义是
    // 「当前键盘焦点窗口所在的屏幕」，会随焦点在显示器之间移动，主屏模式下也会跟着跳。
    private func chosenScreen() -> NSScreen? {
        let screens = NSScreen.screens
        guard let primary = screens.first else { return nil }
        switch islandModel.settings.display {
        case "builtin": return screens.first { Self.hasNotch($0) } ?? primary
        case "main": return primary
        default:
            if let bounds = frontmostWindowBounds(), let hit = screen(containing: bounds) { return hit }
            return screen(withSignature: currentScreenSignature) ?? screens.first { Self.hasNotch($0) } ?? primary
        }
    }

    private static func hasNotch(_ screen: NSScreen) -> Bool { screen.safeAreaInsets.top > 0 }

    private static func signature(_ screen: NSScreen) -> String {
        let frame = screen.frame.integral
        return "\(Int(frame.origin.x)):\(Int(frame.origin.y)):\(Int(frame.width)):\(Int(frame.height))"
    }

    private func screen(withSignature signature: String) -> NSScreen? {
        signature.isEmpty ? nil : NSScreen.screens.first { Self.signature($0) == signature }
    }

    // 窗口中心落在哪块屏上；不在任何屏内时退到重叠面积最大的一块。
    private func screen(containing rect: CGRect) -> NSScreen? {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        if let hit = NSScreen.screens.first(where: { $0.frame.contains(center) }) { return hit }
        let best = NSScreen.screens.max { Self.overlapArea($0.frame, rect) < Self.overlapArea($1.frame, rect) }
        guard let best, Self.overlapArea(best.frame, rect) > 0 else { return nil }
        return best
    }

    private static func overlapArea(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
        let intersection = lhs.intersection(rhs)
        return intersection.isNull || intersection.isEmpty ? 0 : intersection.width * intersection.height
    }

    // 前台应用（排除 bobo 自己）最上面那个普通窗口的位置；拿不到就返回 nil（保持当前屏幕）。
    private func frontmostWindowBounds() -> CGRect? {
        guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return nil }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for window in windows {
            guard let pid = window[kCGWindowOwnerPID as String] as? pid_t, pid == front.processIdentifier,
                  let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 0, rect.height > 0 else { continue }
            return rect
        }
        return nil
    }

    // 屏幕配置变化时 macOS 发通知，但此刻 NSScreen.screens 可能还没更新：立刻 + 0.5 秒各处理一次。
    private func handleScreenParametersChange() {
        refreshScreen(force: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.refreshScreen(force: true) }
    }

    // 重判面板该在哪块屏幕：屏幕签名变了（或强制）才触发换屏动画。
    private func refreshScreen(force: Bool = false) {
        guard !islandDragging, let screen = chosenScreen() else { return }
        let signature = Self.signature(screen)
        guard force || signature != currentScreenSignature else { return }
        hopToScreen(screen)
    }

    private func positionNotch() {
        guard let window = notchWindow, let screen = chosenScreen() else { return }
        currentScreenSignature = Self.signature(screen)
        let size = window.frame.size
        window.setFrameOrigin(NSPoint(x: screen.frame.midX - size.width / 2, y: screen.frame.maxY - size.height))
    }

    // 面板在某块屏上的尺寸（折叠/展开共用）：折叠是一条胶囊，展开是刘海宽度加出卡片。
    // 折叠宽度：内置刘海屏保持「比刘海宽 60」（两侧各露出一点，不会被刘海盖住）；
    // 跟到外接屏（没有刘海）时按内容自适应，不再留那圈宽度。
    private func islandSize(for screen: NSScreen) -> NSSize {
        let maxWidth = screen.frame.width - 40
        let nw = notchWidth(screen)
        let slots = islandModel.avatars.isEmpty ? 1 : islandModel.avatars.count
        // 有额度指示时把它的宽度和两侧间距一起算进内容宽度（折叠是圆环、展开多一个百分比），否则面板会比内容窄。
        let quota = islandModel.usage?.displayed?.session == nil ? 0 : (islandModel.expanded ? IslandMetrics.quotaExpandedWidth : IslandMetrics.quotaCollapsedWidth) + 10
        let content = 28 + CGFloat(slots) * 22 + quota + 29
        let collapsed = Self.hasNotch(screen) ? max(content, nw + 60) : content
        let width = islandModel.expanded ? min(max(nw + 280, 460), maxWidth) : min(collapsed, maxWidth)
        // 展开高度按设置里的条数算（会话不足时跟着变矮），装不下的会话在列表里滚动查看。
        let visibleRows = max(1, min(islandModel.settings.rows, islandModel.listed.count))
        let listHeight: CGFloat = islandModel.expanded ? (islandModel.listed.isEmpty ? 42 : 13.5 + CGFloat(visibleRows) * 38) : 0
        return NSSize(width: max(96, width), height: islandBarHeight(screen) + listHeight)
    }

    // 面板在某块屏上的目标位置：水平居中（可带偏移）并 clamp，顶部贴住该屏顶边。
    private func islandFrame(for screen: NSScreen) -> NSRect {
        let size = islandSize(for: screen)
        let x = islandClampedX(screen.frame.midX - size.width / 2 + islandOffset, width: size.width, on: screen)
        return NSRect(x: x, y: screen.frame.maxY - size.height, width: size.width, height: size.height)
    }

    // 以顶部中心为锚点缩放（面板贴着屏幕顶边，缩小/放大都从这里出发）。
    private func scaled(_ frame: NSRect, by scale: CGFloat) -> NSRect {
        let width = frame.width * scale, height = frame.height * scale
        return NSRect(x: frame.midX - width / 2, y: frame.maxY - height, width: width, height: height)
    }

    private func updateIslandLayout() {
        guard !isHopping, let screen = chosenScreen() else { return }
        islandModel.barHeight = islandBarHeight(screen)
        guard islandModel.visible else { setNotchVisible(false); return }
        setNotchVisible(true)
        applyIslandFrame(islandFrame(for: screen), animated: true, screen: screen)
    }

    // 换屏动画（参考 CodeIsland 的 screen hop，但按截图需求改成缩放式）：
    // 先向中心缩小并渐隐，切到新屏幕后再从小放大两段（过冲一点再回落），渐现。
    private func hopToScreen(_ screen: NSScreen) {
        guard !isHopping else { return }
        guard let window = notchWindow, window.isVisible, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            currentScreenSignature = Self.signature(screen)
            updateIslandLayout()
            return
        }
        isHopping = true
        islandModel.barHeight = islandBarHeight(screen)
        let target = islandFrame(for: screen)
        let overshoot = scaled(target, by: 1.06)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            window.animator().alphaValue = 0
            window.animator().setFrame(scaled(window.frame, by: 0.58), display: true)
        } completionHandler: { [weak self] in
            guard let self else { return }
            window.alphaValue = 0
            window.setFrame(target, display: true)
            self.currentScreenSignature = Self.signature(screen)
            // 第一段展开：淡入并放大到略微过冲。
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.26
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 1.0, 0.3, 1.0)
                window.animator().alphaValue = 1
                window.animator().setFrame(overshoot, display: true)
            } completionHandler: { [weak self] in
                guard let self else { return }
                // 第二段：回落到目标尺寸。
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.14
                    context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    window.animator().setFrame(target, display: true)
                } completionHandler: { [weak self] in
                    guard let self else { return }
                    self.isHopping = false
                    self.updateIslandLayout()
                }
            }
        }
    }

    // 把面板摆到指定 frame：尺寸或位置任一变了才重设，展开/收起用 0.2 秒 easeOut。
    private func applyIslandFrame(_ frame: NSRect, animated: Bool, screen: NSScreen?) {
        guard let window = notchWindow else { return }
        if let screen { currentScreenSignature = Self.signature(screen) }
        // 换屏时 y 也会变，必须一起比较，否则切屏不会重贴顶边。
        let unchanged = abs(window.frame.width - frame.width) <= 0.5 && abs(window.frame.height - frame.height) <= 0.5
            && abs(window.frame.origin.x - frame.origin.x) <= 0.5 && abs(window.frame.origin.y - frame.origin.y) <= 0.5
        guard !unchanged else { return }
        guard animated, window.isVisible, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            window.setFrame(frame, display: true)
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().setFrame(frame, display: true)
        }
    }

    // 调整面板窗口：宽度居中、顶部保持贴住屏幕顶边（与 CodeIsland 的位置算法一致）。
    private func resizeNotch(_ width: CGFloat, _ height: CGFloat, animated: Bool = true) {
        guard let screen = chosenScreen() else { return }
        let w = max(140, min(width, screen.frame.width - 20)), h = max(20, min(height, screen.frame.height / 2))
        let x = islandClampedX(screen.frame.midX - w / 2 + islandOffset, width: w, on: screen)
        applyIslandFrame(NSRect(x: x, y: screen.frame.maxY - h, width: w, height: h), animated: animated, screen: screen)
    }

    // 刘海高度与宽度：有刘海的屏幕用安全区与两侧留白，没有就退回菜单栏高度与模拟宽度。
    private func islandBarHeight(_ screen: NSScreen) -> CGFloat {
        screen.safeAreaInsets.top > 0 ? screen.safeAreaInsets.top : max(24, screen.frame.maxY - screen.visibleFrame.maxY)
    }

    private func notchWidth(_ screen: NSScreen) -> CGFloat {
        let left = screen.auxiliaryTopLeftArea?.width ?? 0, right = screen.auxiliaryTopRightArea?.width ?? 0
        return left > 0 || right > 0 ? screen.frame.width - left - right : min(max(screen.frame.width * 0.14, 160), 240)
    }

    // 旧的内联版本已合并进 islandSize(for:) + updateIslandLayout()。

    // 鼠标移入立即展开，移出稍等再收起（避免划过时闪动）。
    // 改完模型先让出一帧：等 SwiftUI 把内容渲染出来再动窗口，动画中就不会出现「窗口已变大、内容还没画」的空隙。
    private func islandHovering(_ hovering: Bool) {
        islandCollapse?.cancel()
        if hovering {
            // 鼠标移入即解除「3 秒后自动收起」的限制：临时展开交给悬停保持，移出后再按 0.35 秒收起。
            islandAutoCollapse?.cancel()
            islandModel.autoRevealed = false
            if !islandModel.hovering {
                islandModel.hovering = true
                scheduleIslandLayout()
            }
            return
        }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            // mouseExited 有时是误报（滚动、窗口尺寸动画时系统会重算跟踪区）：鼠标还在面板上就别收起。
            if let window = self.notchWindow, window.frame.contains(NSEvent.mouseLocation) { return }
            self.islandModel.hovering = false
            self.scheduleIslandLayout()
        }
        islandCollapse = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
    }

    // 「等你回答」或会话结束/终止时自动亮起：没有操作就收回胶囊；鼠标移入即解除限制（见 islandHovering）。
    private func revealIslandTemporarily(seconds: Double) {
        guard islandModel.settings.autoExpand, !islandModel.hovering else { return }
        islandModel.autoRevealed = true
        islandAutoCollapse?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.islandModel.hovering else { return }
            self.islandModel.autoRevealed = false
            self.scheduleIslandLayout()
        }
        islandAutoCollapse = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func scheduleIslandLayout() {
        DispatchQueue.main.async { [weak self] in self?.updateIslandLayout() }
    }

    // 点击会话：让 bobo 服务去 Otty 里找对应的标签页（找不到就打开 Otty）。
    private func focusIsland(_ session: IslandSession) {
        postIsland("/api/opencode/focus", ["id": session.id, "title": session.title ?? "", "directory": session.directory ?? "", "source": session.source ?? "opencode"])
    }

    private func postIsland(_ path: String, _ body: [String: Any]) {
        guard !apiToken.isEmpty, let url = URL(string: "http://127.0.0.1:4318" + path) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(apiToken, forHTTPHeaderField: "x-bobo-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request).resume()
    }

    // 水平拖动：按住面板左右移动（阈值 5pt，避免把单击误判成拖动），松手后记住偏移。
    // 做法与 CodeIsland 的 setupHorizontalDragMonitor 相同：本地事件监视器，不改窗口的可拖动属性。
    private func setupIslandDrag() {
        islandDragMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { [weak self] event in
            guard let self, let panel = self.notchWindow, event.window === panel else { return event }
            // 「可移动」没打开时面板固定在刘海正中，不响应拖动。
            guard self.islandModel.settings.movable else { return event }
            switch event.type {
            case .leftMouseDown:
                self.islandDragStartMouseX = NSEvent.mouseLocation.x
                self.islandDragStartOriginX = panel.frame.origin.x
                self.islandDragging = false
            case .leftMouseDragged:
                guard let startMouse = self.islandDragStartMouseX, let startOrigin = self.islandDragStartOriginX else { return event }
                let delta = NSEvent.mouseLocation.x - startMouse
                if !self.islandDragging {
                    guard abs(delta) > 5 else { return event }
                    self.islandDragging = true
                }
                if let screen = self.chosenScreen() {
                    let x = self.islandClampedX(startOrigin + delta, width: panel.frame.width, on: screen)
                    panel.setFrameOrigin(NSPoint(x: x, y: panel.frame.origin.y))
                }
            case .leftMouseUp:
                // 以面板中心为基准记偏移：折叠与展开宽度不同，按中心记才不会在切换时横向跳。
                if self.islandDragging, let screen = self.chosenScreen() {
                    self.islandOffset = panel.frame.midX - screen.frame.midX
                }
                self.islandDragStartMouseX = nil
                self.islandDragStartOriginX = nil
                // 延后一点再清标志：同一轮事件里的点击手势不应该被当成「打开窗口」。
                DispatchQueue.main.async { self.islandDragging = false }
            default:
                break
            }
            return event
        }
    }

    private func islandClampedX(_ x: CGFloat, width: CGFloat, on screen: NSScreen) -> CGFloat {
        min(max(x, screen.frame.minX), screen.frame.maxX - width)
    }

    @objc private func centerIsland() {
        islandOffset = 0
        updateIslandLayout()
    }

    // 「没有活跃会话时隐藏」：真正把面板收起来（而不是缩成小窗挡点击）。
    private func setNotchVisible(_ visible: Bool) {
        guard notchVisible != visible else { return }
        notchVisible = visible
        if visible { notchWindow.orderFrontRegardless() } else { notchWindow.orderOut(nil) }
    }

    // 点刘海上的额度指示：在可用的几家之间切换（服务端记住选择并推回新快照）。
    private func cycleUsage() {
        guard let usage = islandModel.usage, usage.switchable else { return }
        postIsland("/api/usage/provider", ["next": true])
    }

    // 状态栏图标右下角叠加状态点，并在菜单第一行写明当前状态（图标未开启时只更新菜单）。
    private func updateNotchStatus(_ state: String, label: String, count: Int) {
        notchState = state;notchLabel = label;notchCount = count
        statusItem?.button?.image = statusImage(state: state)
        statusItem?.button?.toolTip = state.isEmpty ? "bobo" : "bobo · " + label + (count > 1 ? "（\(count) 个会话）" : "")
        statusMenuStateItem?.title = state.isEmpty ? "通知岛：未连接" : "通知岛：" + label
    }

    // 订阅 bobo 的状态流（NDJSON）：驱动通知岛面板与状态栏图标，断线自动重连。
    private func startIslandStream() {
        guard islandTask == nil else { return }
        islandTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.apiToken.isEmpty {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    continue
                }
                do {
                    var request = URLRequest(url: URL(string: "http://127.0.0.1:4318/api/opencode/stream")!)
                    request.setValue(self.apiToken, forHTTPHeaderField: "x-bobo-token")
                    request.timeoutInterval = 3600
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                    for try await line in bytes.lines {
                        guard let data = line.data(using: .utf8), let snapshot = try? JSONDecoder().decode(IslandSnapshot.self, from: data) else { continue }
                        await MainActor.run { self.applyIsland(snapshot) }
                    }
                } catch {}
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func applyIsland(_ snapshot: IslandSnapshot) {
        let before = islandModel.sessions
        let waitingBefore = islandModel.waiting?.id
        islandModel.connected = snapshot.connected
        islandModel.sessions = snapshot.sessions
        islandModel.usage = snapshot.usage
        let displayChanged = islandModel.settings.display != snapshot.settings.display
        islandModel.settings = snapshot.settings
        // 回答完：「等你回答」亮起的展开立刻收回。被自动展开的窗口可能把鼠标圈在里面，hover 会一直为真，
        // 所以这里主动清掉，避免回答完面板还挂着。
        if waitingBefore != nil, islandModel.waiting == nil {
            islandAutoCollapse?.cancel()
            islandModel.autoRevealed = false
            islandModel.hovering = false
        }
        // 状态变化自动亮起：新的「等你回答」3 秒（同一会话再次提问时由通知里的 question 重新点亮）；
        // 会话进入结束 / 终止 2 秒，完成和终止也要能直接看到结果。
        if let waiting = islandModel.waiting, waiting.id != waitingBefore { revealIslandTemporarily(seconds: 3) }
        else if justFinished(from: before) { revealIslandTemporarily(seconds: 2) }
        // 系统通知由 app 自己发（归属 bobo、图标也是 bobo）。
        // 用时间戳而不是 seq 判断新旧：服务重启后 seq 会从 1 重新开始，只靠 seq 会把新通知当成旧的丢掉。
        if let notice = snapshot.notice, Double(notice.at) > launchTime {
            let key = "\(notice.at)-\(notice.seq)"
            if key != lastNoticeKey {
                lastNoticeKey = key
                postNotice(notice)
                if notice.kind == "question" { revealIslandTemporarily(seconds: 3) }
            }
        }
        syncStatusItem(snapshot.settings.menubar)
        let state = islandModel.connected ? (islandModel.top?.state ?? "idle") : ""
        updateNotchStatus(state, label: state.isEmpty ? "" : islandModel.label(state), count: islandModel.busy.count)
        // 选屏设置变了要立刻换屏（含重排），否则只按当前内容重排。
        if displayChanged { refreshScreen(force: true) } else { scheduleIslandLayout() }
    }

    // 与上一份快照比较：是否有会话刚进入「已结束 / 已终止」（首次出现的会话不算，那是历史记录）。
    private func justFinished(from before: [IslandSession]) -> Bool {
        let previous = Dictionary(before.map { ($0.id, $0.state) }, uniquingKeysWith: { first, _ in first })
        return islandModel.sessions.contains { session in
            guard session.state == "idle" || session.state == "error" else { return false }
            return previous[session.id].map { $0 != session.state } ?? false
        }
    }

    // 点击会话后的跳转交给 bobo 服务（otty.mjs），原生不再重复实现一套匹配逻辑。

    // 系统通知：归属并显示为 bobo，点击默认激活本应用（不会再拉起脚本编辑器）。
    // 诊断写 ~/.bobo/notif.log：应用进程的 print 不会进 app.log，unified log 在这里也查不到。
    private func notifLog(_ message: String) {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bobo/notif.log")
        let line = "\(Date()) \(message)\n"
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? line.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    private func requestNotificationAuth() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            self.notifLog("settings before request: \(settings.authorizationStatus.rawValue)")
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            self.notifLog("authorization granted=\(granted) error=\(String(describing: error))")
        }
    }

    private func postNotice(_ notice: IslandNotice) {
        let content = UNMutableNotificationContent()
        content.title = notice.title.isEmpty ? "bobo" : notice.title
        if !notice.message.isEmpty { content.body = notice.message }
        // 声音交给服务端的 afplay（按事件区分音效），通知本身不再响一次。
        let request = UNNotificationRequest(identifier: "bobo-notice-\(notice.seq)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { self.notifLog("add failed: \(error)") } else { self.notifLog("posted seq=\(notice.seq)") }
        }
    }

    // 应用在前台时也把横幅显示出来（否则用户在看 bobo 窗口时收不到提醒）。
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner])
    }

    @objc private func showOpenCodeStatus() {
        showWindow()
        webView.evaluateJavaScript("document.getElementById('islandTab')?.click()", completionHandler: nil)
    }

    // 左键切换窗口显示，右键或 Control+左键弹出菜单。
    @objc private func statusItemClicked(_ sender: Any?) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            statusItem?.menu = statusMenu
            statusItem?.button?.performClick(nil)
            statusItem?.menu = nil
        } else {
            toggleWindow()
        }
    }

    @objc private func toggleWindow() {
        if window.isVisible && NSApp.isActive { hideWindow() } else { showWindow() }
    }

    // 窗口打开时作为普通应用出现在 Dock 与 ⌘Tab；关闭后只留状态栏。
    @objc private func showWindow() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func hideWindow() {
        window.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
    }

    // ⌘R 重新载入两个页面：应用内没有别的刷新入口，源码更新后用它拉取最新界面。
    @objc private func reloadPages() {
        webView.reload()
    }

    private func probe(startIfNeeded: Bool) {
        var request = URLRequest(url: address)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let valid = data.flatMap { String(data: $0, encoding: .utf8) }?.contains("name=\"app\" content=\"bobo\"") == true
            DispatchQueue.main.async {
                if valid { self.webView.load(URLRequest(url: self.appAddress)); self.updateIslandLayout(); self.startIslandStream(); return }
                if startIfNeeded {
                    do { try self.startService() } catch { self.showError(error.localizedDescription); return }
                }
                self.attempts += 1
                if self.attempts >= 40 { self.showError("本地服务未能启动。请检查 4318 端口，或查看 ~/.bobo/app.log。"); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.probe(startIfNeeded: false) }
            }
        }.resume()
    }

    private func startService() throws {
        let resources = Bundle.main.resourceURL!
        let configured = (try? String(contentsOf: resources.appendingPathComponent("node-path"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidates = [configured, "/opt/homebrew/bin/node", "/usr/local/bin/node"].compactMap { $0 }
        guard let node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw NSError(domain: "bobo", code: 1, userInfo: [NSLocalizedDescriptionKey: "找不到 Node.js。请安装 Node.js 22 或更高版本。"])
        }
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bobo")
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let log = logs.appendingPathComponent("app.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: log)
        try handle.seekToEnd()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [resources.appendingPathComponent("server.mjs").path]
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = URL(fileURLWithPath: node).deletingLastPathComponent().path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PORT"] = "4318"
        process.environment = environment
        process.standardOutput = handle
        process.standardError = handle
        process.standardInput = FileHandle.nullDevice
        try process.run()
        service = process
        try handle.close()
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "无法启动 bobo"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

    // 关闭按钮 / ⌘W 只隐藏窗口，应用与本地服务继续运行（同时从 Dock 与 ⌘Tab 中隐藏）。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hideWindow()
        return false
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }
    func applicationWillTerminate(_ notification: Notification) {
        if let service = service, service.isRunning { service.terminate() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "bobo"
        alert.informativeText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let input = NSTextField(string: defaultText ?? "")
        input.frame = NSRect(x: 0, y: 0, width: 330, height: 24)
        alert.accessoryView = input
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = input
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? input.stringValue : nil) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || (url.host == "127.0.0.1" && url.port == 4318) { decisionHandler(.allow) }
        else { if ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
    }
    // 页面加载完成后读一次进程 token：通知岛原生订阅与跳转请求都用它鉴权。
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        webView.evaluateJavaScript("document.querySelector('meta[name=token]')?.content || ''") { [weak self] value, _ in
            guard let self, let token = value as? String, !token.isEmpty, !token.contains("__") else { return }
            self.apiToken = token
            self.startIslandStream()
            self.updateIslandLayout()
        }
    }
}

// 刘海面板用的窗口：AppKit 在屏幕重排（切换分辨率、唤醒）时会把无边框窗口压到菜单栏下方，
// 这会把它从刘海区域拽走，所以直接放行不做约束（与 CodeIsland 的处理一致）。
private final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

// 面板的宿主视图：非激活面板上的第一次点击也要交给 SwiftUI；
// 用 .activeAlways 的跟踪区自己上报悬停，比 SwiftUI 的 onHover 在非激活窗口上更可靠。
private final class IslandHostingView<Content: View>: NSHostingView<Content> {
    var onHoverChange: ((Bool) -> Void)?
    private var tracking: NSTrackingArea?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        window?.makeKey()
        super.mouseDown(with: event)
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }
    override func mouseEntered(with event: NSEvent) { onHoverChange?(true) }
    override func mouseExited(with event: NSEvent) { onHoverChange?(false) }
}

// 覆盖红黄绿灯所在的顶部区域：拖动窗口，双击缩放；其它事件（滚动等）透传给网页。
private final class TitlebarDragView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard NSApp.currentEvent?.type == .leftMouseDown else { return nil }
        return super.hitTest(point)
    }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
    }
}

// MARK: - 通知岛（SwiftUI）

// 会话快照里 bobo 需要的字段；其余字段忽略。
struct IslandSession: Identifiable, Decodable {
    var id: String
    var name: String?
    var title: String?
    var state: String
    var detail: String?
    var directory: String?
    // 会话来自哪家 Agent：opencode（默认）或 codex；通知岛里用来区分标签与跳转。
    var source: String?
    // 结束 / 终止后用户是否已在终端里看过（看过才让折叠态头像消失）。
    var acked: Bool?
}

struct IslandSettings: Decodable {
    var notify = true, sound = true, notch = true, hideWhenIdle = false, autoExpand = true, menubar = false, movable = false
    // 面板显示在哪块屏：auto（跟随当前使用的应用）/ builtin（内置刘海屏）/ main（主屏）。
    var display = "auto"
    var rows = 3
    private enum Keys: String, CodingKey { case notify, sound, notch, hideWhenIdle, autoExpand, menubar, movable, display, rows }
    init() {}
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        notify = (try? container.decode(Bool.self, forKey: .notify)) ?? true
        sound = (try? container.decode(Bool.self, forKey: .sound)) ?? true
        notch = (try? container.decode(Bool.self, forKey: .notch)) ?? true
        hideWhenIdle = (try? container.decode(Bool.self, forKey: .hideWhenIdle)) ?? false
        autoExpand = (try? container.decode(Bool.self, forKey: .autoExpand)) ?? true
        menubar = (try? container.decode(Bool.self, forKey: .menubar)) ?? false
        movable = (try? container.decode(Bool.self, forKey: .movable)) ?? false
        let mode = (try? container.decode(String.self, forKey: .display)) ?? "auto"
        display = ["auto", "builtin", "main"].contains(mode) ? mode : "auto"
        rows = (try? container.decode(Int.self, forKey: .rows)) ?? 3
    }
}

struct IslandNotice: Decodable {
    var seq: Int
    var kind: String
    var title: String
    var message: String
    var at: Double
}

// 额度窗口：服务端归好类的窗口（key = session / week / month，Codex 可能只有 week）。
// 本机估算的窗口带金额（usedUSD / limitUSD），Codex 只有百分比。
struct IslandQuotaWindow: Decodable {
    var key = "", label = "", status = "", usedPercent = 0.0, remainingPercent = 100.0, resetInSec = 0.0
    var usedUSD: Double?, limitUSD: Double?
    private enum Keys: String, CodingKey { case key, label, status, usedUSD, limitUSD, usedPercent, remainingPercent, resetInSec }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        key = (try? container.decode(String.self, forKey: .key)) ?? ""
        label = (try? container.decode(String.self, forKey: .label)) ?? ""
        status = (try? container.decode(String.self, forKey: .status)) ?? ""
        usedUSD = try? container.decodeIfPresent(Double.self, forKey: .usedUSD)
        limitUSD = try? container.decodeIfPresent(Double.self, forKey: .limitUSD)
        usedPercent = (try? container.decode(Double.self, forKey: .usedPercent)) ?? 0
        remainingPercent = (try? container.decode(Double.self, forKey: .remainingPercent)) ?? 100
        resetInSec = (try? container.decode(Double.self, forKey: .resetInSec)) ?? 0
    }
    // 悬停提示里的明细：有金额就带上「已用 $x / $y」；rate-limited 之类的状态也要说出来。
    var detail: String {
        let money = limitUSD.map { limit in "已用 $\(String(format: "%.2f", usedUSD ?? 0)) / $\(Int(limit))" } ?? "已用 \(Int(usedPercent.rounded()))%"
        let state = status.isEmpty || status == "ok" ? "" : " · \(status)"
        return "\(label.isEmpty ? key : label)：剩余 \(Int(remainingPercent.rounded()))%（\(money)\(state)）"
    }
}

// 一家额度的快照（Codex 走 chatgpt.com，OpenCode Go 读本机数据库估算）。
struct IslandQuotaProvider: Decodable {
    var id = "", name = "", symbol = "", available = false, estimated = false, plan = ""
    var reason: String?
    var error: String?
    var windows: [IslandQuotaWindow] = []
    private enum Keys: String, CodingKey { case id, name, symbol, available, estimated, plan, reason, error, windows }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        id = (try? container.decode(String.self, forKey: .id)) ?? ""
        name = (try? container.decode(String.self, forKey: .name)) ?? id
        symbol = (try? container.decode(String.self, forKey: .symbol)) ?? ""
        available = (try? container.decode(Bool.self, forKey: .available)) ?? false
        estimated = (try? container.decode(Bool.self, forKey: .estimated)) ?? false
        plan = (try? container.decode(String.self, forKey: .plan)) ?? ""
        reason = try? container.decodeIfPresent(String.self, forKey: .reason)
        error = try? container.decodeIfPresent(String.self, forKey: .error)
        windows = (try? container.decodeIfPresent([IslandQuotaWindow].self, forKey: .windows)) ?? []
    }
    // 折叠胶囊显示 5 小时窗口；没有就退回第一个窗口（例如只返回周窗口的套餐）。
    var session: IslandQuotaWindow? { windows.first { $0.key == "session" } ?? windows.first }
}

// 额度总快照：刘海胶囊显示 selected 那家，悬停看两家的明细（点击切换）。
struct IslandQuota: Decodable {
    var available = false
    var selected = ""
    var providers: [IslandQuotaProvider] = []
    private enum Keys: String, CodingKey { case available, selected, providers }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        available = (try? container.decode(Bool.self, forKey: .available)) ?? false
        selected = (try? container.decode(String.self, forKey: .selected)) ?? ""
        providers = (try? container.decodeIfPresent([IslandQuotaProvider].self, forKey: .providers)) ?? []
    }
    var displayed: IslandQuotaProvider? {
        providers.first { $0.id == selected && $0.available } ?? providers.first { $0.available }
    }
    var switchable: Bool { providers.filter(\.available).count > 1 }
    // 悬停提示：每家的套餐与窗口明细；没有可用窗口时说明原因。
    var summary: String {
        guard available, !providers.isEmpty else { return "额度不可用" }
        var lines = ["bobo · 额度（本机读数）"]
        for provider in providers {
            var head = provider.name + (provider.estimated ? " · 本机估算" : "")
            if !provider.plan.isEmpty { head += " · " + provider.plan }
            lines.append(head)
            if provider.available {
                if provider.windows.isEmpty { lines.append("  没有返回额度窗口") }
                for window in provider.windows { lines.append("  " + window.detail) }
                if let error = provider.error { lines.append("  ⚠ " + error) }
            } else {
                lines.append("  " + (provider.reason ?? "不可用"))
            }
        }
        if switchable { lines.append("点击切换显示哪一家") }
        return lines.joined(separator: "\n")
    }
}

// 折叠胶囊的几何常量：窗口宽度按内容宽度计算，额度指示的宽度要一起算进去（见 Bobo.islandSize）。
enum IslandMetrics {
    // 额度指示：折叠时是一个圆（只有圆环），展开后加上百分比文字；宽度按内容自适应，这里只用于窗口宽度预留。
    static let quotaCollapsedWidth: CGFloat = 22
    static let quotaExpandedWidth: CGFloat = 64
    // provider.symbol 缺失时的兜底图标（与服务端 providers 表一致）。
    static func symbol(for provider: IslandQuotaProvider) -> String {
        if !provider.symbol.isEmpty { return provider.symbol }
        return provider.id == "codex" ? "sparkles" : "terminal"
    }
    // 来源图标：macos/update 把 bobo-provider-<id>.svg 复制进 App bundle（来自 CodexBar 的 MIT 资源），
    // 加载成模板图后按白色渲染；加载不到（旧系统或资源缺失）就退回 SF Symbol。
    nonisolated(unsafe) private static var iconCache: [String: NSImage?] = [:]
    static func icon(for provider: IslandQuotaProvider) -> NSImage? {
        if let cached = iconCache[provider.id] { return cached }
        let image = Bundle.main.url(forResource: "bobo-provider-\(provider.id)", withExtension: "svg")
            .flatMap { NSImage(contentsOf: $0) }
        image?.isTemplate = true
        iconCache[provider.id] = image
        return image
    }
}

struct IslandSnapshot: Decodable {
    var connected: Bool
    var sessions: [IslandSession]
    var settings: IslandSettings
    var notice: IslandNotice?
    // 各家额度（Codex / OpenCode Go，服务端 /api/usage 挂在状态流里）；缺字段时视为不可用。
    var usage: IslandQuota?
}

// 通知岛的状态：会话、设置、鼠标悬停与刘海高度。SwiftUI 视图与窗口布局都读它。
final class IslandModel: ObservableObject {
    @Published var connected = false
    @Published var sessions: [IslandSession] = []
    @Published var settings = IslandSettings()
    // 本机 OpenCode Go 的额度估算（折叠胶囊右侧的剩余额度）。
    @Published var usage: IslandQuota?
    @Published var hovering = false
    // 状态变化自动亮起的展开态：由 app 在「等你回答」或结束/终止时置 true，过几秒（或鼠标移入时）清掉。
    @Published var autoRevealed = false
    @Published var barHeight: CGFloat = 30

    var waiting: IslandSession? { sessions.first { $0.state == "waiting" } }
    // 「开着」的会话：运行中 / 等你回答，以及结束、终止了但用户还没去终端看过的（看过才让头像消失，见 acked）。
    var busy: [IslandSession] {
        sessions.filter { $0.state == "working" || $0.state == "waiting" || (($0.state == "idle" || $0.state == "error") && $0.acked != true) }
    }
    var top: IslandSession? { waiting ?? sessions.first { $0.state == "working" } ?? sessions.first }
    // 展开：鼠标悬停，或（设置允许时）状态变化自动亮起（等你回答 3 秒、结束/终止 2 秒，见 revealIslandTemporarily）。
    var expanded: Bool { hovering || (settings.autoExpand && autoRevealed) }
    var visible: Bool { settings.notch && (!settings.hideWhenIdle || !busy.isEmpty) }
    // 列表顺序完全由服务端决定：最近发生状态变更的会话排在最上面，工具调用等活动不会让它来回跳。
    var listed: [IslandSession] { sessions }
    // 折叠态头像：运行中 / 等你回答 / 还没去终端看过的结束与终止，最多 8 个；状态由头像下方的指示灯表示，不再有文字。
    var avatars: [IslandSession] { Array(busy.prefix(8)) }
    // 头像资源：用会话 ID 的稳定哈希取值，同一个会话始终使用同一张图。
    private static let avatarAssetNames = [
        "bobo-island-avatar-a1", "bobo-island-avatar-a2", "bobo-island-avatar-a3",
        "bobo-island-avatar-a4", "bobo-island-avatar-a5", "bobo-island-avatar-a6",
    ]
    private static let avatarImages: [NSImage?] = avatarAssetNames.map {
        guard let url = Bundle.main.url(forResource: $0, withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }
    private static let palette: [Color] = [
        Color(red: 0.36, green: 0.61, blue: 0.98),
        Color(red: 0.98, green: 0.62, blue: 0.36),
        Color(red: 0.56, green: 0.80, blue: 0.42),
        Color(red: 0.85, green: 0.50, blue: 0.85),
        Color(red: 0.98, green: 0.52, blue: 0.60),
        Color(red: 0.42, green: 0.80, blue: 0.82),
        Color(red: 0.95, green: 0.78, blue: 0.36),
        Color(red: 0.66, green: 0.66, blue: 0.72),
    ]
    private static func avatarHash(_ id: String) -> Int {
        var hash = 5381
        for scalar in id.unicodeScalars { hash = (hash &* 33 &+ Int(scalar.value)) & 0xFFFFFF }
        return hash
    }
    func avatarImage(_ id: String) -> NSImage? {
        Self.avatarImages[Self.avatarHash(id) % Self.avatarImages.count]
    }
    func avatarImage(_ id: String, among sessions: [IslandSession]) -> NSImage? {
        let ids = sessions.map { $0.id }.sorted()
        var used = Set<Int>()
        for candidate in ids {
            let base = Self.avatarHash(candidate) % Self.avatarImages.count
            var slot: Int?
            for offset in 0..<Self.avatarImages.count {
                let index = (base + offset) % Self.avatarImages.count
                if !used.contains(index) { slot = index; break }
            }
            let index = slot ?? base
            used.insert(index)
            if candidate == id { return Self.avatarImages[index] }
        }
        return avatarImage(id)
    }
    func avatarColor(_ id: String) -> Color {
        Self.palette[Self.avatarHash(id) % Self.palette.count]
    }
    func label(_ state: String) -> String {
        ["working": "运行中", "waiting": "等你回答", "idle": "已结束", "error": "已终止"][state] ?? state
    }
    func color(_ state: String?) -> Color {
        switch state {
        case "working": return Color(red: 0.04, green: 0.52, blue: 1.00)
        case "waiting": return Color(red: 1.00, green: 0.62, blue: 0.04)
        case "idle": return Color(red: 0.19, green: 0.82, blue: 0.35)
        case "error": return Color(red: 1.00, green: 0.27, blue: 0.23)
        default: return Color(white: 0.55)
        }
    }
}

// 通知岛面板：黑色卡片贴住刘海，折叠时只有一条胶囊，展开时向下列出会话。
// 形状与层级参考 CodeIsland（NotchPanelShape）：顶部贴屏幕边，底部连续曲率圆角。
struct IslandView: View {
    @ObservedObject var model: IslandModel
    var onSelect: (IslandSession) -> Void
    var onActivate: () -> Void
    var onQuota: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            bar
            if model.expanded {
                Rectangle().fill(.white.opacity(0.14)).frame(height: 0.5).padding(.horizontal, 12)
                list
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(IslandShape(bottomRadius: model.expanded ? 22 : 12).fill(.black))
    }

    // 折叠态：一排会话头像（最多 8 个，每个下方带状态灯）+ 汇总文案，最右侧是剩余额度与打开主窗口的齿轮。
    private var bar: some View {
        HStack(spacing: 5) {
            ForEach(model.avatars) { session in
                IslandAvatar(image: model.avatarImage(session.id, among: model.avatars), color: model.avatarColor(session.id), state: session.state, stateColor: model.color(session.state))
            }
            Spacer(minLength: 0)
            if model.avatars.isEmpty {
                // 没有任务时在右侧留一个置灰的 bobo：面板不会缩进刘海、被黑色完全盖住。
                IslandAvatar(color: Color(white: 0.30), state: "idle", stateColor: Color(white: 0.42))
            }
            if let quota = model.usage, let provider = quota.displayed, let session = provider.session {
                IslandQuotaChip(provider: provider, window: session, summary: quota.summary, expanded: model.expanded, action: onQuota)
            }
            NotchIconButton(icon: "gearshape", tooltip: "打开 bobo", action: onActivate)
        }
        .padding(.horizontal, 14)
        .frame(height: model.barHeight)
        .contentShape(Rectangle())
        .onTapGesture(perform: onActivate)
    }

    // 会话列表：高度按设置里的条数固定，装不下时可以滚动查看其余会话。
    private var list: some View {
        ScrollView(.vertical) {
            LazyVStack(spacing: 2) {
                if model.listed.isEmpty {
                    Text("还没有会话记录").font(.system(size: 11)).foregroundStyle(.white.opacity(0.45)).padding(.vertical, 6)
                }
                ForEach(model.listed) { session in
                    IslandRow(model: model, session: session, onSelect: onSelect).frame(height: 36)
                }
            }
            .padding(.horizontal, 8)
            .padding(.top, 6)
            .padding(.bottom, 9)
        }
        .frame(maxHeight: .infinity)
    }
}

// 会话行：悬停高亮，点击跳到 Otty 里对应的标签页。
struct IslandRow: View {
    @ObservedObject var model: IslandModel
    let session: IslandSession
    var onSelect: (IslandSession) -> Void
    @State private var hovering = false

    var body: some View {
        Button { onSelect(session) } label: {
            HStack(spacing: 8) {
                IslandDot(color: model.color(session.state), pulsing: session.state == "working" || session.state == "waiting")
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.title?.isEmpty == false ? (session.title ?? "") : (session.name ?? session.id))
                        .font(.system(size: 12)).foregroundStyle(.white).lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle).font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                Text(model.label(session.state)).font(.system(size: 11)).foregroundStyle(.white.opacity(0.65))
            }
            .padding(.horizontal, 9)
            .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 7).fill(background))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }

    private var subtitle: String? {
        let source = session.source == "codex" ? "Codex" : "OpenCode"
        let parts = [source, session.name, session.detail].filter { $0?.isEmpty == false }.compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
    private var background: Color {
        if session.state == "waiting" { return Color.orange.opacity(hovering ? 0.26 : 0.16) }
        return .white.opacity(hovering ? 0.11 : 0.05)
    }
}

// 折叠胶囊的额度指示：圆环里是来源图标（模板图，白色）；折叠时只露出圆环，展开（悬停或自动亮起）后补上剩余百分比。
// 宽度是固定的（IslandMetrics.quotaCollapsedWidth / quotaExpandedWidth），窗口宽度按内容算时要一起加上（见 Bobo.islandSize）。
struct IslandQuotaChip: View {
    let provider: IslandQuotaProvider
    let window: IslandQuotaWindow
    let summary: String
    let expanded: Bool
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    // 剩余越少越显眼：绿 / 橙 / 红，与网页「用量」里的进度条同一套阈值。
    private var color: Color {
        if window.remainingPercent >= 50 { return Color(red: 0.19, green: 0.82, blue: 0.35) }
        if window.remainingPercent >= 20 { return Color(red: 1.00, green: 0.62, blue: 0.04) }
        return Color(red: 1.00, green: 0.27, blue: 0.23)
    }

    // 圆环：底圈 + 剩余比例圆弧，来源图标放在环里。
    private var ring: some View {
        ZStack {
            Circle().stroke(.white.opacity(0.22), lineWidth: 2)
            Circle().trim(from: 0, to: max(0.03, min(1, window.remainingPercent / 100)))
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
            providerIcon.frame(width: 11, height: 11).foregroundStyle(.white.opacity(0.92))
        }
        .frame(width: 18, height: 18)
    }

    @ViewBuilder private var providerIcon: some View {
        if let icon = IslandMetrics.icon(for: provider) {
            Image(nsImage: icon).resizable().renderingMode(.template).interpolation(.high).scaledToFit()
        } else {
            Image(systemName: IslandMetrics.symbol(for: provider)).font(.system(size: 9, weight: .medium))
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                ring
                if expanded {
                    Text("\(Int(window.remainingPercent.rounded()))%")
                        .font(.system(size: 10, weight: .semibold)).monospacedDigit()
                        .foregroundStyle(.white.opacity(0.92))
                }
            }
            // 背景跟着内容走（折叠时是一个圆、展开时才加宽），不会比内容多出一圈灰底。
            .padding(.horizontal, expanded ? 8 : 2)
            .frame(minHeight: 22)
            .background(Capsule().fill(.white.opacity(hovering ? 0.16 : 0.08)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovering)
        .onHover { hovering = $0 }
        .help(summary)
    }
}

// 刘海上的小图标按钮（形态参考 CodeIsland 的 NotchIconButton）：悬停时圆形底色变亮。
struct NotchIconButton: View {
    let icon: String
    var tooltip: String? = nil
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.white.opacity(hovering ? 1 : 0.85))
                .frame(width: 22, height: 22)
                .background(Circle().fill(.white.opacity(hovering ? 0.2 : 0.08)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovering)
        .onHover { hovering = $0 }
        .help(tooltip ?? "")
    }
}

// 折叠态的头像：优先显示按会话 ID 稳定哈希选出的 bobo 图；缺少资源时回退为圆角方块脸。
// 运行中 / 等你回答时指示灯缓慢呼吸（与展开列表里的状态点一致），收起后也能一眼看出哪个会话在跑。
struct IslandAvatar: View {
    let image: NSImage?
    let color: Color
    let state: String
    let stateColor: Color
    @State private var animating = false

    init(image: NSImage? = nil, color: Color, state: String, stateColor: Color) {
        self.image = image
        self.color = color
        self.state = state
        self.stateColor = stateColor
    }

    private var pulsing: Bool { state == "working" || state == "waiting" }

    @ViewBuilder
    private var face: some View {
        if let image {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .scaledToFill()
                .scaleEffect(1.28)
        } else {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(color)
                .overlay(
                    HStack(spacing: 4) {
                        Capsule().fill(.black.opacity(0.72)).frame(width: 2.5, height: 4.5)
                        Capsule().fill(.black.opacity(0.72)).frame(width: 2.5, height: 4.5)
                    }
                )
        }
    }

    var body: some View {
        VStack(spacing: 1.5) {
            face
                .frame(width: 17, height: 17)
                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            Circle().fill(stateColor).frame(width: 4, height: 4)
                .opacity(pulsing ? (animating ? 0.35 : 1) : 0.6)
                .onAppear { start() }
                .onChange(of: pulsing) { _, _ in start() }
        }
    }

    private func start() {
        guard pulsing, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { animating = false; return }
        withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) { animating = true }
    }
}

// 状态点：运行中/等你回答时缓慢呼吸，其它状态常亮。
struct IslandDot: View {
    let color: Color
    let pulsing: Bool
    @State private var animating = false
    var body: some View {
        Circle().fill(color).frame(width: 7, height: 7)
            .opacity(pulsing && animating ? 0.35 : 1)
            .onAppear { start() }
            .onChange(of: pulsing) { _, _ in start() }
    }
    private func start() {
        guard pulsing, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { animating = false; return }
        withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) { animating = true }
    }
}

// 顶部与屏幕边齐平、底部连续曲率圆角（0.62 接近 Apple 的 squircle）。
struct IslandShape: Shape {
    var bottomRadius: CGFloat
    var animatableData: CGFloat {
        get { bottomRadius }
        set { bottomRadius = newValue }
    }
    func path(in rect: CGRect) -> Path {
        let r = min(bottomRadius, rect.width / 4, rect.height / 2)
        let k: CGFloat = 0.62
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        path.addCurve(to: CGPoint(x: rect.maxX - r, y: rect.maxY),
                      control1: CGPoint(x: rect.maxX, y: rect.maxY - r * (1 - k)),
                      control2: CGPoint(x: rect.maxX - r * (1 - k), y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        path.addCurve(to: CGPoint(x: rect.minX, y: rect.maxY - r),
                      control1: CGPoint(x: rect.minX + r * (1 - k), y: rect.maxY),
                      control2: CGPoint(x: rect.minX, y: rect.maxY - r * (1 - k)))
        path.closeSubpath()
        return path
    }
}
