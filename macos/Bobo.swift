import AppKit
import Combine
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
    private var islandLayoutScheduled = false
    private var islandFrameTarget: NSRect?
    private var islandBarTarget: IslandBarLayout?
    private var islandLayoutTimer: Timer?
    private var islandCollapse: DispatchWorkItem?
    private var islandAutoCollapse: DispatchWorkItem?
    // 悬停明细卡：额度 / 设备指示悬停半秒后弹出的只读小窗（独立窗口，贴在面板下方、层级高于面板）。
    private var detailWindow: NotchPanel!
    private var detailHosting: NSHostingView<IslandDetailView>?
    private var detailShowWork: DispatchWorkItem?
    private var detailHideWork: DispatchWorkItem?
    private var detailObserver: AnyCancellable?
    // 鼠标当前停在哪个指示上（nil = 都不在）：明细卡只在触发指示或卡片本身被悬停时保留。
    private var detailHover: IslandDetailKind?
    // 弹出位置锚点（鼠标位置，屏幕坐标）：卡片尺寸变化时按它重算，不跟着鼠标跑。
    private var detailAnchor = NSPoint.zero
    // 终端归属只在面板展开时扫描：展开期间定期让服务端续期，收起即停（见 syncTerminalWatch）。
    private var menuBarWatchTimer: Timer?
    private var menuBarYielding = false
    private var menuBarLeftAt: Date?
    // 让位（防遮挡菜单栏 / 全屏应用）状态：true 时面板缩成一只 bobo 躲进刘海区域（见 setIslandYielding）。
    private var islandYielding = false
    private var terminalWatchTimer: Timer?
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
            },
            onDevice: { [weak self] in
                guard let self, !self.islandDragging else { return }
                self.showDeviceStatus()
            },
            onDetail: { [weak self] kind, hovering in self?.detailHoverChanged(kind, hovering) },
            onQuit: {
                // 退出 bobo：和菜单里的「退出 bobo」同一条路径，applicationWillTerminate 会顺带停掉本地服务。
                NSApp.terminate(nil)
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
        // 只采鼠标坐标，不扫描应用或启动子进程。让出菜单栏后一直保持隐藏，直到鼠标离开。
        menuBarWatchTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            self?.updateMenuBarYield()
        }
        menuBarWatchTimer?.tolerance = 0.05
        setupDetail()
        positionNotch()
        // 屏幕配置变化（插拔、分辨率、排列）与前台应用切换都要重判面板该在哪块屏。
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.handleScreenParametersChange()
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refreshScreen()
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.handleSpaceChange()
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

    // 前台应用（排除 bobo 自己）是否正处于全屏：进入全屏会切到一个专属空间，窗口铺满整块屏幕
    // （连菜单栏/刘海那一条也占掉）。这时通知岛要让位——它带着 .fullScreenAuxiliary，会一直顶在全屏内容上。
    // 判定复用取窗口的同一段逻辑：前台应用的 layer 0 窗口与某块屏幕的完整 frame 完全重合即为全屏。
    private func frontmostAppFullScreen() -> Bool {
        guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return false }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
        for window in windows {
            guard let pid = window[kCGWindowOwnerPID as String] as? pid_t, pid == front.processIdentifier,
                  let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 0, rect.height > 0 else { continue }
            // 用 CGDisplayBounds 比：窗口 bounds 是 Quartz 坐标（左上角原点），和 NSScreen.frame 的
            // 原点方向不一致，按屏幕各自的显示器 ID 取 bounds 才不会在上下排列的多屏里判错。
            let full = NSScreen.screens.contains { screen in
                guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else { return false }
                let display = CGDisplayBounds(id)
                return abs(rect.minX - display.minX) < 1 && abs(rect.minY - display.minY) < 1
                    && abs(rect.width - display.width) < 1 && abs(rect.height - display.height) < 1
            }
            if full { return true }
        }
        return false
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

    // 切换空间（包含进入 / 退出全屏）后系统发通知，但此刻窗口列表与前台应用可能还没更新：立刻 + 0.4 秒各查一次。
    private func handleSpaceChange() {
        refreshScreen()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.refreshScreen() }
    }

    // 重判面板该在哪块屏幕：屏幕签名变了（或强制）才触发换屏动画。
    // 屏幕没变也要重排一次——全屏显隐属于「屏幕没变但不该再显示」的变化，靠这一步生效。
    private func refreshScreen(force: Bool = false) {
        guard !islandDragging, let screen = chosenScreen() else { return }
        let signature = Self.signature(screen)
        guard force || signature != currentScreenSignature else { updateIslandLayout(); return }
        hopToScreen(screen)
    }

    private func positionNotch() {
        guard let window = notchWindow, let screen = chosenScreen() else { return }
        currentScreenSignature = Self.signature(screen)
        let size = window.frame.size
        window.setFrameOrigin(NSPoint(x: screen.frame.midX - size.width / 2, y: screen.frame.maxY - size.height))
    }

    // 面板在某块屏上的尺寸（折叠/展开共用）：宽度按顶部栏的分区算（见 IslandBarGeometry），
    // 高度是顶部栏 + 展开的会话列表。有真实刘海的屏幕：折叠头像收紧到最多 4 个，内容排进刘海两侧的
    // 翼里、中间空出刘海，两翼等宽，内容较少的一侧补留白；外接屏（没有
    // 刘海）维持按内容自适应，中间只是一个普通间距。
    private func islandSize(for screen: NSScreen) -> NSSize {
        // 让位（防遮挡）时把窗口与分区都收拢到刘海正中那一小段（配合整体淡出，见 setIslandYielding）：
        // 不这样收，窗口会按完整胶囊继续铺在菜单栏 / 全屏内容上。
        if islandYielding, islandModel.visible {
            islandModel.barLayout = IslandBarLayout(left: 0, keepOut: 0, right: 0)
            return IslandBarGeometry.yieldSize(barHeight: islandBarHeight(screen))
        }
        let notched = Self.hasNotch(screen) && abs(islandOffset) < 1
        let notch = notched ? notchWidth(screen) : 0
        islandModel.avatarLimit = notched ? IslandMetrics.notchAvatars : IslandMetrics.maxAvatars
        let plan = islandModel.avatarPlan
        // 内容宽度按同一套图标规格算：头像（空位时是默认的置灰 bobo）+ 额度 + 设备（+ 悬停时的设置与退出）。
        // 头像按脸宽（19）算：圆环外沿是 22，这样画面里每一段间距看起来都是同一个 itemSpacing。
        let widths = IslandBarGeometry.contentWidths(
            faces: max(1, plan.shown),
            hidden: plan.hidden,
            quota: islandModel.usage?.displayed?.session != nil,
            device: islandModel.device != nil,
            hoverButtons: islandModel.hovering)
        // 刘海屏上下同宽，列表沿用顶部内容宽度；外接屏保留原有展开宽度。
        let minWidth: CGFloat = islandModel.expanded && !notched ? max(notchWidth(screen) + 280, 460) : 0
        let layout = IslandBarGeometry.layout(left: widths.left, right: widths.right, notch: notch)
        islandModel.barLayout = layout
        let barWidth = notched ? layout.keepOut + 2 * max(layout.left, layout.right) : 0
        let width = IslandBarGeometry.width(layout, minWidth: max(minWidth, barWidth), maxWidth: screen.frame.width - 40)
        // 展开高度按设置里的条数算（会话不足时跟着变矮），装不下的会话在列表里滚动查看。
        let visibleRows = max(1, min(islandModel.settings.rows, islandModel.listed.count))
        let listHeight: CGFloat = islandModel.expanded ? (islandModel.listed.isEmpty ? 42 : 13.5 + CGFloat(visibleRows) * 38) : 0
        return NSSize(width: width, height: islandBarHeight(screen) + listHeight)
    }

    // 窗口包络始终以屏幕中心加拖动偏移定位；刘海屏的顶部栏在包络内独立对齐。
    private func islandFrame(for screen: NSScreen) -> NSRect {
        let size = islandSize(for: screen)
        // 刘海屏使用对称的透明窗口包络，顶部紧凑栏独立定位，列表宽度不影响让位中心。
        let x = screen.frame.midX - size.width / 2 + islandOffset
        let clamped = islandClampedX(x, width: size.width, on: screen)
        return NSRect(x: clamped, y: screen.frame.maxY - size.height, width: size.width, height: size.height)
    }

    // 以顶部中心为锚点缩放（面板贴着屏幕顶边，缩小/放大都从这里出发）。
    // 有真实刘海时窗口不对称，缩放锚点要落在刘海正中，否则换屏动画会绕着窗口中心偏。
    private func scaled(_ frame: NSRect, by scale: CGFloat, anchorX: CGFloat? = nil) -> NSRect {
        let width = frame.width * scale, height = frame.height * scale
        let anchor = anchorX ?? frame.midX
        return NSRect(x: anchor - width / 2, y: frame.maxY - height, width: width, height: height)
    }

    private func updateIslandLayout() {
        guard !isHopping, !islandDragging, let screen = chosenScreen() else { return }
        islandModel.barHeight = islandBarHeight(screen)
        guard islandModel.visible else {
            // 面板本来就要收起（关掉显示 / hideWhenIdle）：直接清掉让位状态，别再淡入一次，交给 setNotchVisible 淡出。
            islandYielding = false
            notchWindow?.ignoresMouseEvents = false
            setNotchVisible(false)
            syncTerminalWatch(force: false)
            return
        }
        // 防遮挡：前台应用全屏、或鼠标停在菜单栏上时让位。不再整块收起（那样是生硬的出现 / 消失），
        // 改为缩成一只 bobo 躲进刘海区域，回来时同样淡入 + 尺寸补间（见 setIslandYielding）。
        let yielding = menuBarYielding || frontmostAppFullScreen()
        if yielding {
            islandCollapse?.cancel()
            islandAutoCollapse?.cancel()
            islandModel.hovering = false
            islandModel.autoRevealed = false
        }
        setIslandYielding(yielding)
        setNotchVisible(true)
        syncTerminalWatch(force: yielding ? false : nil)
        let previousLayout = islandModel.barLayout
        let target = islandFrame(for: screen)
        let targetLayout = islandModel.barLayout
        islandModel.barLayout = previousLayout
        applyIslandFrame(target, animated: true, screen: screen, layout: targetLayout)
    }

    // 换屏动画（参考 CodeIsland 的 screen hop，但按截图需求改成缩放式）：
    // 先向中心缩小并渐隐，切到新屏幕后再从小放大两段（过冲一点再回落），渐现。
    private func hopToScreen(_ screen: NSScreen) {
        guard !isHopping else { return }
        hideDetail()
        stopIslandLayoutAnimation()
        guard let window = notchWindow, window.isVisible, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            currentScreenSignature = Self.signature(screen)
            updateIslandLayout()
            return
        }
        islandFrameTarget = nil
        isHopping = true
        islandModel.barHeight = islandBarHeight(screen)
        let target = islandFrame(for: screen)
        // 刘海屏上窗口不对称，缩放要锚在刘海正中（与 islandFrame 的定位口径一致）。
        let anchorX = islandModel.barLayout.notched ? screen.frame.midX : nil
        let overshoot = scaled(target, by: 1.06, anchorX: anchorX)
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
                // 让位期间换屏也保持不可见：淡入的目标是 islandAlpha（让位时是 0）。
                window.animator().alphaValue = self.islandAlpha
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

    private func stopIslandLayoutAnimation() {
        islandLayoutTimer?.invalidate()
        islandLayoutTimer = nil
        islandFrameTarget = nil
        islandBarTarget = nil
    }

    // 窗口与两翼共用同一个进度，保持让位区的屏幕坐标稳定；中途反向从当前呈现值接续。
    private func applyIslandFrame(_ frame: NSRect, animated: Bool, screen: NSScreen?, layout: IslandBarLayout? = nil) {
        guard let window = notchWindow else { return }
        if let screen { currentScreenSignature = Self.signature(screen) }
        let targetLayout = layout ?? islandModel.barLayout
        if islandFrameTarget == frame, islandBarTarget == targetLayout { return }
        stopIslandLayoutAnimation()
        islandFrameTarget = frame
        islandBarTarget = targetLayout
        let startFrame = window.frame, startLayout = islandModel.barLayout
        guard startFrame != frame || startLayout != targetLayout else { return }
        guard animated, window.isVisible, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            islandModel.barLayout = targetLayout
            window.setFrame(frame, display: true)
            return
        }
        let started = CACurrentMediaTime()
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self, weak window] timer in
            guard let self, let window else { timer.invalidate(); return }
            let t = min(1, (CACurrentMediaTime() - started) / 0.24)
            let progress = CGFloat(1 - pow(1 - t, 3))
            let step = IslandLayoutTween.sample(from: startFrame, to: frame, fromLayout: startLayout,
                                                toLayout: targetLayout, progress: progress)
            // 禁止 SwiftUI 再叠一层独立动画；一帧内提交两翼与窗口，刷新后一起显示。
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { self.islandModel.barLayout = step.layout }
            window.setFrame(step.frame, display: false)
            self.islandHosting?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            if t >= 1 { timer.invalidate(); self.islandLayoutTimer = nil }
        }
        islandLayoutTimer = timer
        RunLoop.main.add(timer, forMode: .common)
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
            let mouse = NSEvent.mouseLocation
            // mouseExited 有时是误报（滚动、窗口尺寸动画时系统会重算跟踪区）：鼠标还在面板上就别收起。
            if let window = self.notchWindow, window.frame.contains(mouse) { return }
            if self.islandModel.hovering {
                self.islandModel.hovering = false
                self.scheduleIslandLayout()
            }
            // 鼠标移到明细卡上：面板可以收起，卡片留着（移开卡片后会自己消失）。
            if let card = self.detailWindow, card.isVisible, card.frame.contains(mouse) { return }
            self.hideDetail()
        }
        islandCollapse = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
    }

    // MARK: 悬停明细卡

    // 明细卡是一个独立的无边框小窗（和面板同一层级、同一套深色观感）：内容用 SwiftUI 画，尺寸由内容决定。
    private func setupDetail() {
        let panel = NotchPanel(contentRect: NSRect(x: 0, y: 0, width: IslandMetrics.detailWidth, height: 90), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        // 比通知岛面板再高一级：点击面板（切换来源、点会话行）会把它提到同层级窗口的最前，
        // 弹窗必须始终压在面板之上，否则会被展开的会话列表盖住。
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 3)
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        let hosting = IslandHostingView(rootView: IslandDetailView(model: islandModel))
        hosting.onHoverChange = { [weak self] hovering in
            guard let self else { return }
            if hovering { self.detailHideWork?.cancel() } else { self.scheduleDetailHide() }
        }
        hosting.frame = NSRect(x: 0, y: 0, width: IslandMetrics.detailWidth, height: 90)
        hosting.autoresizingMask = [.width, .height]
        // 卡片的内容尺寸就是它自身的固有尺寸（窗口尺寸仍由 applyDetail 指定，不受影响）；
        // SwiftUI 的上报没赶上时用它兜底（见 applyDetail）。
        hosting.sizingOptions = [.intrinsicContentSize]
        hosting.translatesAutoresizingMaskIntoConstraints = true
        panel.contentView = hosting
        detailWindow = panel
        detailHosting = hosting
        // SwiftUI 量好卡片尺寸后回调：按它调窗口大小与位置（数据刷新导致行数变化时也会走这里）。
        detailObserver = islandModel.$detailMetrics
            .receive(on: RunLoop.main)
            .sink { [weak self] metrics in self?.applyDetail(metrics) }
    }

    // 悬停额度 / 设备指示：满半秒弹明细卡；离开后 0.4 秒内没落在卡片上就收起。
    private func detailHoverChanged(_ kind: IslandDetailKind, _ hovering: Bool) {
        if hovering {
            guard islandModel.detail != kind else { return }
            detailHover = kind
            detailShowWork?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.detailHover == kind else { return }
                self.showDetail(kind)
            }
            detailShowWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + IslandMetrics.detailDelay, execute: work)
        } else {
            if detailHover == kind { detailHover = nil }
            detailShowWork?.cancel(); detailShowWork = nil
            scheduleDetailHide()
        }
    }

    private func showDetail(_ kind: IslandDetailKind) {
        guard islandModel.visible, let panel = notchWindow, panel.isVisible else { return }
        detailAnchor = NSEvent.mouseLocation
        islandModel.detail = kind
        refreshDetail(kind)
        // 内容与尺寸都没变（同一种卡重新打开）时 SwiftUI 不会再上报：这里按已有尺寸直接摆好。
        applyDetail(islandModel.detailMetrics)
    }

    private func hideDetail() {
        detailShowWork?.cancel(); detailShowWork = nil
        detailHideWork?.cancel(); detailHideWork = nil
        detailHover = nil
        guard islandModel.detail != nil else { return }
        islandModel.detail = nil
        detailWindow?.orderOut(nil)
    }

    // 鼠标离开触发指示后：0.4 秒宽限，落在卡片上就留着（卡片自己的 mouseExited 会再来一轮检查）。
    private func scheduleDetailHide() {
        guard islandModel.detail != nil else { return }
        detailHideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.detailHover != nil { return }
            if let card = self.detailWindow, card.isVisible, card.frame.contains(NSEvent.mouseLocation) { return }
            self.hideDetail()
        }
        detailHideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    // 按 SwiftUI 报来的尺寸摆放明细卡：水平居中在弹出时的鼠标位置（clamp 进屏幕），顶边在鼠标下方一点；
    // 尺寸变化时按同一个锚点重算，卡片不会跟着鼠标乱跑。
    private func applyDetail(_ metrics: DetailMetrics) {
        guard let kind = metrics.kind, kind == islandModel.detail, let panel = detailWindow else { return }
        // 尺寸优先用 SwiftUI 量好的（含卡片内边距）；还没量到时退回宿主的固有尺寸（Auto Layout 已算好内容尺寸）。
        var size = metrics.size
        if size.width < 2 || size.height < 2, let hosting = detailHosting {
            let intrinsic = hosting.intrinsicContentSize
            if intrinsic.width >= 2 && intrinsic.height >= 2 { size = intrinsic }
        }
        guard size.width >= 2, size.height >= 2 else { return }
        panel.setContentSize(size)
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(detailAnchor) }) ?? chosenScreen() else { return }
        let x = min(max(detailAnchor.x - size.width / 2, screen.frame.minX + 8), screen.frame.maxX - size.width - 8)
        let y = max(detailAnchor.y - 14 - size.height, screen.frame.minY + 8)
        panel.setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: true)
        panel.invalidateShadow()
        guard !panel.isVisible else { return }
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
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
        guard !islandLayoutScheduled else { return }
        islandLayoutScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.islandLayoutScheduled = false
            self.updateIslandLayout()
        }
    }

    // 终端归属只在面板展开时扫描：展开期间每 4 秒让服务端续期（服务端 10 秒窗口内每 3 秒扫一次终端标签页），
    // 收起 / 隐藏 / 全屏让位后不再续期，服务端自然停扫——只有真正看着列表的这几秒才有额外子进程。
    private func syncTerminalWatch(force: Bool? = nil) {
        guard force ?? islandModel.expanded else { stopTerminalWatch(); return }
        guard terminalWatchTimer == nil else { return }
        postIsland("/api/terminals/watch", [:])
        terminalWatchTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            self?.postIsland("/api/terminals/watch", [:])
        }
    }
    private func stopTerminalWatch() { terminalWatchTimer?.invalidate(); terminalWatchTimer = nil }

    // 点击会话：让 bobo 服务去对应终端（Otty / Ghostty / Terminal.app）里找标签页。
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

    // 明细卡弹出时顺手让服务端立刻采一次最新数据：磁盘常驻采样约 60 秒一轮、额度也各有节奏，
    // 等下一轮太慢；数据变了服务端会经状态流推回来，卡片跟着刷新。
    private func refreshDetail(_ kind: IslandDetailKind) {
        let path = kind == .quota ? "/api/usage?refresh=1" : "/api/devices?refresh=1"
        guard !apiToken.isEmpty, let url = URL(string: "http://127.0.0.1:4318" + path) else { return }
        var request = URLRequest(url: url)
        request.setValue(apiToken, forHTTPHeaderField: "x-bobo-token")
        URLSession.shared.dataTask(with: request).resume()
    }

    // 水平拖动：按住面板左右移动（阈值 5pt，避免把单击误判成拖动），松手后记住偏移。
    // 做法与 CodeIsland 的 setupHorizontalDragMonitor 相同：本地事件监视器，不改窗口的可拖动属性。
    private func setupIslandDrag() {
        islandDragMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { [weak self] event in
            guard let self, let panel = self.notchWindow, event.window === panel else { return event }
            // 所有屏幕都遵循「可移动」开关。
            guard self.islandModel.settings.movable else { return event }
            switch event.type {
            case .leftMouseDown:
                self.hideDetail()
                self.islandDragStartMouseX = NSEvent.mouseLocation.x
                self.islandDragStartOriginX = panel.frame.origin.x
                self.islandDragging = false
            case .leftMouseDragged:
                guard let startMouse = self.islandDragStartMouseX, let startOrigin = self.islandDragStartOriginX else { return event }
                let delta = NSEvent.mouseLocation.x - startMouse
                if !self.islandDragging {
                    guard abs(delta) > 5 else { return event }
                    self.stopIslandLayoutAnimation()
                    self.islandDragging = true
                }
                if let screen = self.chosenScreen() {
                    let x = self.islandClampedX(startOrigin + delta, width: panel.frame.width, on: screen)
                    self.islandFrameTarget = nil
                    panel.setFrameOrigin(NSPoint(x: x, y: panel.frame.origin.y))
                }
            case .leftMouseUp:
                // 与 islandFrame 使用同一个窗口中心锚点；拖离中心后恢复普通胶囊布局。
                if self.islandDragging, let screen = self.chosenScreen() {
                    self.islandOffset = panel.frame.midX - screen.frame.midX
                }
                self.islandDragStartMouseX = nil
                self.islandDragStartOriginX = nil
                // 延后一点再清标志：同一轮事件里的点击手势不应该被当成「打开窗口」。
                DispatchQueue.main.async { self.islandDragging = false; self.scheduleIslandLayout() }
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

    private func updateMenuBarYield() {
        guard !islandDragging, !isHopping, islandLayoutTimer == nil, let panel = notchWindow, let screen = panel.screen else { return }
        let mouse = NSEvent.mouseLocation
        let bar = NSRect(x: screen.frame.minX, y: screen.frame.maxY - islandBarHeight(screen),
                         width: screen.frame.width, height: islandBarHeight(screen))
        let top = IslandLayoutTween.barFrame(width: panel.frame.width, height: islandBarHeight(screen), layout: islandModel.barLayout)
        let visibleBar = NSRect(x: panel.frame.minX + top.minX, y: bar.minY, width: top.width, height: bar.height)
        if menuBarYielding {
            if bar.contains(mouse) { menuBarLeftAt = nil; return }
            // 等鼠标稳定离开再恢复，防止在菜单栏边缘反复闪现。
            if menuBarLeftAt == nil { menuBarLeftAt = Date(); return }
            guard Date().timeIntervalSince(menuBarLeftAt!) >= 0.45 else { return }
            menuBarYielding = false
            menuBarLeftAt = nil
            scheduleIslandLayout()
        } else if panel.isVisible, bar.contains(mouse), !visibleBar.contains(mouse) {
            menuBarYielding = true
            islandCollapse?.cancel()
            islandAutoCollapse?.cancel()
            islandModel.hovering = false
            islandModel.autoRevealed = false
            // 让出菜单栏：不整块收起，缩成一只 bobo 躲进刘海区域（见 setIslandYielding）。
            scheduleIslandLayout()
            stopTerminalWatch()
        }
    }

    // 「没有活跃会话时隐藏」/ 关掉显示：真正把面板收起来（而不是缩成小窗挡点击）；再显示时淡入、收起时淡出，
    // 避免生硬地出现 / 消失。让位（防遮挡）不走这里，走 setIslandYielding。
    private func setNotchVisible(_ visible: Bool) {
        guard notchVisible != visible else { return }
        notchVisible = visible
        if visible {
            // 先摆到透明再上台，避免 orderFront 那一帧闪一下。
            notchWindow.alphaValue = 0
            notchWindow.orderFrontRegardless()
            animateIslandAlpha(islandAlpha, duration: 0.18)
        } else {
            stopIslandLayoutAnimation(); hideDetail()
            guard notchWindow.isVisible else { notchWindow.alphaValue = 1; return }
            animateIslandAlpha(0, duration: 0.16) { [weak self] in
                guard let self, !self.notchVisible else { return }
                self.notchWindow.orderOut(nil)
                self.notchWindow.alphaValue = 1
            }
        }
    }

    // 让位（防遮挡菜单栏 / 全屏应用）：面板补间收拢到刘海正中并淡出到完全不可见——窗口不 orderOut，
    // 所以让位与回来都是同一条「尺寸补间 + 淡入淡出」（收拢尺寸见 islandSize 的让位分支），不会硬切。
    // 收着的时候不接收鼠标事件，免得挡住菜单栏 / 全屏内容上的点击。
    private func setIslandYielding(_ yielding: Bool) {
        guard islandYielding != yielding else { return }
        islandYielding = yielding
        notchWindow?.ignoresMouseEvents = yielding
        if yielding { hideDetail() }
        animateIslandAlpha(islandAlpha, duration: 0.22)
    }

    // 面板的淡入淡出（让位 / 换屏 / 显隐共用）：alpha 走窗口自身的动画，与 applyIslandFrame 的尺寸补间同一条时间线。
    private var islandAlpha: CGFloat { islandYielding ? 0 : 1 }
    private func animateIslandAlpha(_ alpha: CGFloat, duration: Double, completion: (() -> Void)? = nil) {
        guard let window = notchWindow else { completion?(); return }
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            window.alphaValue = alpha
            completion?()
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: alpha > 0 ? .easeOut : .easeIn)
            window.animator().alphaValue = alpha
        } completionHandler: { completion?() }
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
        islandModel.device = snapshot.device
        let displayChanged = islandModel.settings.display != snapshot.settings.display
        islandModel.settings = snapshot.settings
        // 描边高亮：这次提醒涉及的会话，直到用户去终端看过（acked）才撤掉。
        updateHighlights(from: before)
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
                // 同一会话再次提问时状态可能一直停在 waiting（没有再触发上面的状态变化），
                // 这里按通知本身再点亮一次，保证新问题会被描边提醒。
                if notice.kind == "question", let waiting = islandModel.waiting, waiting.acked != true {
                    islandModel.highlighted[waiting.id] = waiting.state
                }
            }
        }
        syncStatusItem(snapshot.settings.menubar)
        let state = islandModel.connected ? (islandModel.top?.state ?? "idle") : ""
        updateNotchStatus(state, label: state.isEmpty ? "" : islandModel.label(state), count: islandModel.busy.count)
        // 选屏设置变了要立刻换屏（含重排），否则只按当前内容重排。
        if displayChanged { refreshScreen(force: true) } else { scheduleIslandLayout() }
    }

    // 描边高亮：收到提醒（新的「等你回答」、刚结束 / 终止）的会话在展开列表里描一圈提醒类型的
    // 颜色（等你回答=橙 / 已结束=绿 / 已终止=红），用户去终端看过（acked == true）或会话已不在
    // 列表里才撤掉——和折叠态头像的消失规则一致。
    private func updateHighlights(from before: [IslandSession]) {
        let live = Set(islandModel.sessions.map { $0.id })
        var highlighted = islandModel.highlighted.filter { live.contains($0.key) }
        for session in islandModel.sessions where session.acked == true { highlighted.removeValue(forKey: session.id) }
        let previous = Dictionary(before.map { ($0.id, $0.state) }, uniquingKeysWith: { first, _ in first })
        for session in islandModel.sessions {
            if session.state == "waiting" {
                if previous[session.id] != "waiting" { highlighted[session.id] = session.state }
            } else if session.state == "idle" || session.state == "error" {
                if let old = previous[session.id], old != session.state { highlighted[session.id] = session.state }
            }
        }
        if highlighted != islandModel.highlighted { islandModel.highlighted = highlighted }
    }

    // 与上一份快照比较：是否有会话刚进入「已结束 / 已终止」（首次出现的会话不算，那是历史记录）。
    private func justFinished(from before: [IslandSession]) -> Bool {
        let previous = Dictionary(before.map { ($0.id, $0.state) }, uniquingKeysWith: { first, _ in first })
        return islandModel.sessions.contains { session in
            guard session.state == "idle" || session.state == "error" else { return false }
            return previous[session.id].map { $0 != session.state } ?? false
        }
    }

    // 点击会话后的跳转交给 bobo 服务（terminals.mjs），原生不再重复实现一套匹配逻辑。

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

    // 点刘海上的设备指示：打开窗口并切到「设备」视图（和通知岛菜单同一条路径）。
    private func showDeviceStatus() {
        showWindow()
        webView.evaluateJavaScript("document.getElementById('deviceTab')?.click()", completionHandler: nil)
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
        hideDetail()
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
        process.arguments = [resources.appendingPathComponent("src/server.mjs").path]
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
        menuBarWatchTimer?.invalidate()
        stopIslandLayoutAnimation()
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

// 单个行 / 控件的悬停：非激活面板上 SwiftUI 的 onHover 收不到事件（见 IslandHostingView 注释），
// 所以这里同样用 .activeAlways 的跟踪区自己上报；hitTest 返回 nil，鼠标点击照常透传给底下的 SwiftUI 按钮。
private final class HoverTrackingView: NSView {
    var onHoverChange: ((Bool) -> Void)?
    private var tracking: NSTrackingArea?
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }
    // 滚动时鼠标不动、内容在动，AppKit 不会给「滑出光标」的行补发 mouseExited，那些行的悬停会一直亮着
    // （表现为滚动后多行同时 hover）。所以在滚动视图的可见区域变化后，按光标位置自己重判一次。
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        NotificationCenter.default.removeObserver(self, name: NSView.boundsDidChangeNotification, object: nil)
        guard window != nil, let clip = enclosingScrollView?.contentView else { return }
        clip.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(recheckHover), name: NSView.boundsDidChangeNotification, object: clip)
    }
    @objc private func recheckHover() {
        guard let window else { return }
        onHoverChange?(bounds.contains(convert(window.mouseLocationOutsideOfEventStream, from: nil)))
    }
    override func mouseEntered(with event: NSEvent) { onHoverChange?(true) }
    override func mouseExited(with event: NSEvent) { onHoverChange?(false) }
}

private struct HoverReporter: NSViewRepresentable {
    var onChange: (Bool) -> Void
    func makeNSView(context: Context) -> HoverTrackingView {
        let view = HoverTrackingView()
        view.onHoverChange = onChange
        return view
    }
    func updateNSView(_ view: HoverTrackingView, context: Context) { view.onHoverChange = onChange }
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
    // 会话来自哪家 Agent：opencode（默认）、codex 或 omp；通知岛里用来区分标签与跳转。
    var source: String?
    // 会话归属的终端（Otty / Ghostty / Terminal），只在面板展开时由服务端扫描后随状态流下发。
    var terminal: String?
    // 会话开始时间（epoch 毫秒，服务端各来源记的创建时间）：会话行右侧的计时标签读它。
    var startedAt: Double?
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

// 额度总快照：刘海胶囊显示 selected 那家，悬停弹明细卡看每一家的窗口（点击切换）。
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
}

// 设备快照（服务端 devices.mjs 挂在状态流里）：折叠胶囊的额度右边那枚设备指示读它。
// 三块都可选，缺哪块就不画哪块（例如内存读不到时只剩 CPU 与磁盘），数字都在悬停提示里。
struct IslandDevice: Decodable {
    struct CPU: Decodable {
        var usage: Double?
        var perCore: [Double]?
        var cores: Int?
        var load: [Double]?
        var model: String?
        var level: String?
    }
    struct Memory: Decodable {
        var used: Double?
        var total: Double?
        var cached: Double?
        var free: Double?
        var wired: Double?
        var compressed: Double?
        var usedPercent: Double?
        var pressureLabel: String?
        var level: String?
    }
    struct Disk: Decodable {
        var used: Double?
        var total: Double?
        var free: Double?
        var usedPercent: Double?
        var level: String?
    }
    var available: Bool?
    var cpu: CPU?
    var memory: Memory?
    var disk: Disk?
    // 容量单位照 macOS 的习惯：内存用 About This Mac 的口径（GiB 记作 GB），磁盘用 Finder 的十进制。
    static func size(_ bytes: Double?, binary: Bool = false) -> String {
        let value = (bytes ?? 0) / (binary ? 1_073_741_824 : 1_000_000_000)
        return value >= 100 ? String(format: "%.0f GB", value) : String(format: "%.1f GB", value)
    }
}

// 折叠胶囊的几何常量：窗口宽度按内容宽度计算，额度指示的宽度要一起算进去（见 Bobo.islandSize）。
enum IslandMetrics {
    // 折叠胶囊里每个图标共用一套规格：22 的外框（热区与悬停圆底）、5 的间距、同一套悬停底色；
    // bobo 头像的脸是 19，设置 / 退出这类 SF Symbol 图形对齐额度圆环里那枚来源图标（13），比例才一致。
    static let itemSize: CGFloat = 22
    static let itemSpacing: CGFloat = 5
    // 头像区与右边状态图标之间的一条细竖线：宽度算进内容宽度里（见 Bobo.islandSize），
    // 两边的间距与图标之间一样是 itemSpacing，不额外占位。
    static let dividerWidth: CGFloat = 1
    static let dividerHeight: CGFloat = 14
    static let glyphSize: CGFloat = 19
    // 额度圆环里来源图标的尺寸（IslandQuotaChip），设置 / 退出的图形与它对齐。
    static let quotaIconSize: CGFloat = 13
    static let actionGlyphSize: CGFloat = quotaIconSize
    static let fillIdle: Double = 0.12
    static let fillHover: Double = 0.22
    // 顶部栏：两端端帽（内容到胶囊边缘的距离）、内容与真实刘海之间的空隙（刘海两侧各留一个）。
    static let barEdge: CGFloat = 14
    static let notchGap: CGFloat = 7
    // 让位（防遮挡菜单栏 / 全屏应用）时窗口补间收拢到的尺寸：宽度固定，高度按菜单栏 / 刘海高度
    // 往下留一点（避开刘海底部的圆角）。收拢过程中整块面板淡出到不可见（见 Bobo.setIslandYielding）。
    static let yieldWidth: CGFloat = 44
    static let yieldHeightInset: CGFloat = 6
    // 折叠态最多显示几个会话头像：外接屏够宽，最多 8 个；有真实刘海时头像只能排进刘海左侧那一小段，
    // 超过就换成「+N」徽标（见 IslandBarGeometry.avatars）。
    static let maxAvatars = 8
    static let notchAvatars = 4
    // 悬停明细卡（额度 / 设备）：宽度固定，高度由内容决定；圆角与内边距与面板同一套观感。
    static let detailWidth: CGFloat = 236
    // 鼠标停在指示上多久弹出明细卡（秒）。
    static let detailDelay: Double = 0.5
    // 指示与明细卡共用的颜色：绿 / 橙 / 红三档，与网页「用量」「设备」同一套阈值。
    static let healthyHue = Color(red: 0.19, green: 0.82, blue: 0.35)
    static let warnHue = Color(red: 1.00, green: 0.62, blue: 0.04)
    static let criticalHue = Color(red: 1.00, green: 0.27, blue: 0.23)
    // 内存弧与明细卡里的内存条专用色（青色），与存储的白色分开才看得出是哪一项。
    static let memoryHue = Color(red: 0.35, green: 0.78, blue: 0.98)
    // 额度剩余三档：≥ 50% 绿、≥ 20% 橙，再少就红。
    static func remainingColor(_ percent: Double) -> Color {
        percent >= 50 ? healthyHue : percent >= 20 ? warnHue : criticalHue
    }
    // 设备占用率三档：≥ 85% 红、≥ 75% 橙，其余是各自的健康色（磁盘白、内存青）。
    static func usageColor(_ percent: Double, healthy: Color) -> Color {
        percent >= 85 ? criticalHue : percent >= 75 ? warnHue : healthy
    }
    // 服务端的压力等级（ok / warn / low）对应的颜色。
    static func levelColor(_ level: String?) -> Color {
        level == "warn" ? warnHue : level == "low" ? criticalHue : healthyHue
    }
    // 重置时间的说法与网页「用量」一致；没有重置时间的窗口返回 nil（明细卡里不显示这一行）。
    static func resetText(_ seconds: Double) -> String? {
        guard seconds > 0 else { return nil }
        if seconds < 3600 { return "\(max(1, Int((seconds / 60).rounded()))) 分钟后重置" }
        if seconds < 86400 { return "\(Int(seconds / 3600)) 小时 \(Int(((seconds.truncatingRemainder(dividingBy: 3600)) / 60).rounded())) 分后重置" }
        return "\(Int(seconds / 86400)) 天后重置"
    }
    // 会话计时文案（对齐 CodeIsland 的 SessionTag）：会话开始至今，`<1m` / `5m` / `2h` / `1d`。
    // 没记到开始时间（老数据）返回 nil，行上不显示这一格；时钟漂移导致的负值按「刚开始」处理。
    static func elapsedText(_ startedAt: Double?, now: Double = Date().timeIntervalSince1970 * 1000) -> String? {
        guard let startedAt, startedAt > 0 else { return nil }
        let seconds = max(0, Int((now - startedAt) / 1000))
        if seconds < 60 { return "<1m" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86400)d"
    }
    // provider.symbol 缺失时的兜底图标（与服务端 providers 表一致）。
    static func symbol(for provider: IslandQuotaProvider) -> String {
        if !provider.symbol.isEmpty { return provider.symbol }
        return provider.id == "codex" ? "sparkles" : "terminal"
    }
    // 来源图标：update.sh 把 bobo-provider-<id>.svg 复制进 App bundle（codex / opencode-go 来自 CodexBar 的
    // MIT 资源，omp 取自 can1357/oh-my-pi 的 MIT 品牌图标），加载成模板图后按白色渲染；
    // 加载不到（旧系统或资源缺失）就退回 SF Symbol。
    nonisolated(unsafe) private static var iconCache: [String: NSImage?] = [:]
    static func icon(id: String) -> NSImage? {
        if let cached = iconCache[id] { return cached }
        let image = Bundle.main.url(forResource: "bobo-provider-\(id)", withExtension: "svg")
            .flatMap { NSImage(contentsOf: $0) }
        image?.isTemplate = true
        iconCache[id] = image
        return image
    }
    static func icon(for provider: IslandQuotaProvider) -> NSImage? {
        icon(id: provider.id)
    }
    // 会话来源（opencode / codex / omp）对应的来源图标 id，展开列表与折叠胶囊都用它显示 Agent 图标；
    // 三个来源都有打包好的 bobo-provider-<id>.svg（opencode 与额度来源 opencode-go 共用同一枚标记）。
    static func providerId(forSource source: String?) -> String {
        source == "codex" ? "codex" : source == "omp" ? "omp" : source == "claude" ? "claude" : source == "dsh" ? "dsh" : "opencode-go"
    }
    // 盒面用各家 IP 的主色区分来源；颜色只作用于很小的品牌牌面，不改变 bobo 本身的配色。
    // OpenCode 的品牌黑在纯黑刘海上会和背景糊成一整块（牌的轮廓、圆角都看不见），提亮成深灰；
    // 别家颜色本来就亮，照旧。
    static func providerBadgeColor(forSource source: String?) -> Color {
        switch providerId(forSource: source) {
        case "codex": return Color(red: 0.42, green: 0.32, blue: 0.82)      // Codex 紫
        case "omp": return Color(red: 0.48, green: 0.64, blue: 0.95)        // omp 蓝
        case "claude": return Color(red: 0.84, green: 0.39, blue: 0.25)    // Claude 橙
        case "dsh": return Color(red: 0.34, green: 0.53, blue: 0.996)      // DeepSeek 蓝
        default: return Color(red: 0.30, green: 0.29, blue: 0.29)            // OpenCode 深灰（品牌黑会和刘海背景重合）
        }
    }
    // 会话来源图标加载不到时（旧系统或资源缺失）的 SF Symbol 兜底。
    static func symbol(forSource source: String?) -> String {
        source == "codex" ? "sparkles" : "terminal"
    }
}

// 顶部栏的水平分区：左翼 + 中间的让位 + 右翼，三者之和就是面板宽度。
// 没有真实刘海时中间只是一个普通间距（维持原来的居中排布）；有真实刘海时中间正好让给刘海
// （宽 = 刘海 + 两侧各一个 notchGap），两侧内容各自贴住刘海——摄像头模组那块区域物理上不可见，
// 内容排进去就会被盖住。两翼各自只包住自己的内容（左翼包头像、右翼包额度与设备），所以窗口左右
// 不对称：定位时让让位区正中（而不是窗口中心）对准屏幕正中，空白就不会全堆在内容少的那一侧。
struct IslandBarLayout: Equatable {
    var left: CGFloat
    var keepOut: CGFloat
    var right: CGFloat
    // 有真实刘海：keepOut 是「刘海 + 两侧各 notchGap」这个最小让位宽度（内容贴住刘海，展开时多出来的
    // 宽度由中间的可伸缩间距吸收）；没有刘海：keepOut 只是内容之间的普通间距。两种情况都是
    // Spacer(minLength: keepOut)，内容各贴面板一端。
    var notched = false
}

// 线性插值同时作用于窗口与分区；曲线只在调用端计算一次。
enum IslandLayoutTween {
    static func barFrame(width: CGFloat, height: CGFloat, layout: IslandBarLayout) -> NSRect {
        guard layout.notched else { return NSRect(x: 0, y: 0, width: width, height: height) }
        return NSRect(x: (width - layout.keepOut) / 2 - layout.left, y: 0,
                      width: layout.left + layout.keepOut + layout.right, height: height)
    }

    static func sample(from: NSRect, to: NSRect, fromLayout: IslandBarLayout,
                       toLayout: IslandBarLayout, progress: CGFloat) -> (frame: NSRect, layout: IslandBarLayout) {
        let p = min(1, max(0, progress))
        func mix(_ a: CGFloat, _ b: CGFloat) -> CGFloat { a + (b - a) * p }
        return (NSRect(x: mix(from.minX, to.minX), y: mix(from.minY, to.minY),
                       width: mix(from.width, to.width), height: mix(from.height, to.height)),
                IslandBarLayout(left: mix(fromLayout.left, toLayout.left),
                                keepOut: mix(fromLayout.keepOut, toLayout.keepOut),
                                right: mix(fromLayout.right, toLayout.right), notched: toLayout.notched))
    }
}

// 顶部栏的排布计算（纯函数，方便单独验证）：内容宽度、面板宽度、栏内分区、折叠头像的取舍。
enum IslandBarGeometry {
    // 两侧内容的宽度（不含端帽）：左侧是会话头像 + 分隔线（放不下时最后一格换成「+N」徽标，
    // 尺寸与头像脸一致），右侧是额度 + 设备（+ 悬停时的设置与退出）。间距与图标规格共用 IslandMetrics。
    static func contentWidths(faces: Int, hidden: Int, quota: Bool, device: Bool, hoverButtons: Bool) -> (left: CGFloat, right: CGFloat) {
        // 头像之间、头像与徽标 / 分隔线之间都是同一个间距；分隔线自己也占一格的宽度。
        var left = CGFloat(faces) * IslandMetrics.glyphSize + IslandMetrics.itemSpacing * CGFloat(faces) + IslandMetrics.dividerWidth
        if hidden > 0 { left += IslandMetrics.itemSpacing + IslandMetrics.glyphSize }
        let chips = (quota ? 1 : 0) + (device ? 1 : 0) + (hoverButtons ? 2 : 0)
        return (left, CGFloat(chips) * IslandMetrics.itemSize + IslandMetrics.itemSpacing * CGFloat(max(0, chips - 1)))
    }

    // 刘海两翼按内容较宽的一侧统一宽度，较窄侧补留白，保持左右对称；外接屏仍按内容排布。
    static func layout(left: CGFloat, right: CGFloat, notch: CGFloat) -> IslandBarLayout {
        guard notch > 0 else {
            return IslandBarLayout(left: IslandMetrics.barEdge + left, keepOut: IslandMetrics.itemSpacing, right: IslandMetrics.barEdge + right)
        }
        let wing = IslandMetrics.barEdge + max(left, right)
        return IslandBarLayout(left: wing, keepOut: notch + IslandMetrics.notchGap * 2,
                               right: wing, notched: true)
    }

    // 面板宽度：左翼 + 让位 + 右翼；展开态要撑到 minWidth（卡片得放下会话列表，有刘海时还要比刘海宽出
    // 一圈，多出来的部分由中间的 Spacer 吸收），再兜一个最小可点击宽度与屏幕上限。
    static func width(_ layout: IslandBarLayout, minWidth: CGFloat = 0, maxWidth: CGFloat = CGFloat.greatestFiniteMagnitude) -> CGFloat {
        min(max(layout.left + layout.keepOut + layout.right, max(minWidth, 96)), maxWidth)
    }

    // 折叠态头像的取舍：最多 cap 个；放不下时最后一格留给「+N」徽标（shown 个头像、hidden 个藏起来），
    // 这样胶囊宽度不会因为会话变多而无限拉长。
    static func avatars(_ count: Int, cap: Int) -> (shown: Int, hidden: Int) {
        let limit = max(1, cap)
        guard count > limit else { return (max(0, count), 0) }
        return (limit - 1, count - (limit - 1))
    }

    // 让位时窗口收拢到的尺寸：高度按菜单栏 / 刘海高度往下留一点（避开刘海底部的圆角），宽度固定成一小段。
    // 收到这个尺寸的过程中面板整体淡出，所以有真实刘海时最后那点内容正好消失在刘海区域里。
    static func yieldSize(barHeight: CGFloat) -> NSSize {
        NSSize(width: IslandMetrics.yieldWidth, height: max(18, barHeight - IslandMetrics.yieldHeightInset))
    }
}

struct IslandSnapshot: Decodable {
    var connected: Bool
    var sessions: [IslandSession]
    var settings: IslandSettings
    var notice: IslandNotice?
    // 各家额度（Codex / OpenCode Go，服务端 /api/usage 挂在状态流里）；缺字段时视为不可用。
    var usage: IslandQuota?
    // 设备（CPU / 内存 / 磁盘，服务端 /api/devices 挂在状态流里）；缺字段时胶囊上不画设备指示。
    var device: IslandDevice?
}

// 悬停明细卡的内容类型：额度（额度圆环）或设备（设备指示）。
enum IslandDetailKind: String { case quota, device }

// SwiftUI 明细卡量好自身尺寸后回报（kind 是卡片里实际渲染的内容）：
// 原生按它调整小窗尺寸与位置，尺寸变了也只是重排、不跟着鼠标跑（见 Bobo.applyDetail）。
struct DetailMetrics: Equatable {
    var kind: IslandDetailKind?
    var size: CGSize = .zero
}

// 通知岛的状态：会话、设置、鼠标悬停与刘海高度。SwiftUI 视图与窗口布局都读它。
final class IslandModel: ObservableObject {
    @Published var connected = false
    @Published var sessions: [IslandSession] = []
    @Published var settings = IslandSettings()
    // 本机 OpenCode Go 的额度估算（折叠胶囊右侧的剩余额度）。
    @Published var usage: IslandQuota?
    // 本机设备（CPU / 内存 / 磁盘，折叠胶囊里额度右边的设备指示）。
    @Published var device: IslandDevice?
    // 悬停明细卡：nil 为不显示；detailMetrics 由 SwiftUI 上报，原生用它定窗口尺寸（见 Bobo.applyDetail）。
    @Published var detail: IslandDetailKind?
    @Published var detailMetrics = DetailMetrics()
    @Published var hovering = false
    // 顶部栏的分区（左右两翼宽度 + 中间的刘海让位）：由原生按当前屏幕算好（见 IslandBarGeometry.layout），
    // SwiftUI 只是照着排——有真实刘海时头像与状态图标必须排在刘海两侧，不能排进刘海里。
    @Published var barLayout = IslandBarGeometry.layout(left: 19 + IslandMetrics.itemSpacing + IslandMetrics.dividerWidth, right: 0, notch: 0)
    // 折叠态最多显示几个头像：有真实刘海时少一些（见 IslandMetrics），由原生按屏幕设置。
    @Published var avatarLimit = IslandMetrics.maxAvatars
    // 状态变化自动亮起的展开态：由 app 在「等你回答」或结束/终止时置 true，过几秒（或鼠标移入时）清掉。
    @Published var autoRevealed = false
    // 收到提醒的会话：展开的列表里给对应行描一圈 outline，用户去终端看过（acked）才撤掉。
    // 值是触发提醒时的状态，outline 用它取色（等你回答=橙 / 已结束=绿 / 已终止=红），
    // 后续状态变化不会把颜色改掉，直到下一次提醒才更新。
    @Published var highlighted: [String: String] = [:]
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
    // 折叠态头像：运行中 / 等你回答 / 还没去终端看过的结束与终止，最多 avatarLimit 个；
    // 放不下时最后一格换成「+N」徽标——列表顺序由服务端决定，所以留下的是最近有动静的那几个。
    var avatarPlan: (shown: Int, hidden: Int) { IslandBarGeometry.avatars(busy.count, cap: avatarLimit) }
    var avatars: [IslandSession] { Array(busy.prefix(avatarPlan.shown)) }
    // 被「+N」徽标藏起来的会话数（没有藏起来的返回 nil，界面就不画徽标）。
    var hiddenAvatarCount: Int? { avatarPlan.hidden > 0 ? avatarPlan.hidden : nil }
    // 「+N」徽标：被藏起来的会话里有「等你回答」就转橙，其次运行中，都没有就按第一个的状态取色。
    var hiddenAvatarState: String? {
        guard avatarPlan.hidden > 0 else { return nil }
        let hidden = busy.dropFirst(avatarPlan.shown)
        return hidden.first { $0.state == "waiting" }?.state ?? hidden.first { $0.state == "working" }?.state ?? hidden.first?.state
    }
    // 头像资源：用会话 ID 的稳定哈希取值，同一个会话始终使用同一张图。
    private static let avatarAssetNames = [
        "bobo-island-avatar-a1", "bobo-island-avatar-a2", "bobo-island-avatar-a3",
        "bobo-island-avatar-a4", "bobo-island-avatar-a5", "bobo-island-avatar-a6",
    ]
    private static let avatarImages: [NSImage?] = avatarAssetNames.map {
        guard let url = Bundle.main.url(forResource: $0, withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }
    private static let idleImage: NSImage? = {
        guard let url = Bundle.main.url(forResource: "bobo-island-avatar-idle", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()
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
    func idleAvatarImage() -> NSImage? { Self.idleImage }
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
    var onDevice: () -> Void
    // 额度 / 设备指示的悬停变化：满半秒由原生弹明细卡（见 Bobo.detailHoverChanged）。
    var onDetail: (IslandDetailKind, Bool) -> Void
    var onQuit: () -> Void

    var body: some View {
        GeometryReader { geometry in
            let rect = IslandLayoutTween.barFrame(width: geometry.size.width, height: model.barHeight, layout: model.barLayout)
            VStack(spacing: 0) {
                bar
                if model.expanded {
                    Rectangle().fill(.white.opacity(0.14)).frame(height: 0.5).padding(.horizontal, 12)
                    list
                }
            }
            .frame(width: rect.width, height: geometry.size.height, alignment: .top)
            .background(IslandShape(bottomRadius: model.expanded ? 22 : 12).fill(.black))
            .offset(x: rect.minX)
        }
    }

    // 折叠态 / 展开态的顶部栏：左右两组内容各自排在刘海两侧的「翼」里（两翼宽度由原生按内容算好，
    // 见 IslandBarLayout）。左翼端帽在左、内容靠右，右翼反过来，于是内容分贴面板两端。
    // 刘海屏中间间距固定，顶部栏独立于列表宽度定位；外接屏仍用可伸缩间距。
    private var bar: some View {
        HStack(spacing: 0) {
            HStack(spacing: IslandMetrics.itemSpacing) {
                // 默认图标（没有活跃会话时的置灰 bobo）固定靠左，占住会话头像的位置。
                if model.avatars.isEmpty {
                    IslandAvatar(image: model.idleAvatarImage(), color: Color(white: 0.30), state: "idle", stateColor: Color(white: 0.42))
                } else {
                    ForEach(model.avatars) { session in
                        IslandAvatar(
                            image: model.avatarImage(session.id, among: model.avatars),
                            logo: IslandMetrics.icon(id: IslandMetrics.providerId(forSource: session.source)),
                            badgeColor: IslandMetrics.providerBadgeColor(forSource: session.source),
                            color: model.avatarColor(session.id),
                            state: session.state,
                            stateColor: model.color(session.state)
                        )
                    }
                    // 放不下的会话：最后一格是「+N」徽标，完整列表在展开态里看。
                    if let hidden = model.hiddenAvatarCount {
                        IslandOverflowBadge(count: hidden, color: model.color(model.hiddenAvatarState))
                    }
                }
                // bobo / 会话头像与右边的状态图标之间用一条细竖线分开；两边的间距与图标之间一样。
                Capsule().fill(.white.opacity(0.2)).frame(width: IslandMetrics.dividerWidth, height: IslandMetrics.dividerHeight)
            }
            .padding(.leading, IslandMetrics.barEdge)
            .frame(width: model.barLayout.left, alignment: .leading)
            // 中间的可伸缩间距：折叠时正好等于让位区宽度（内容贴住刘海两侧），展开时吸收多出来的宽度——
            // 内容因此贴住面板两端，与外接屏一致；有真实刘海时这段也保证不小于「刘海 + 两侧各 notchGap」，
            // 内容不会排进摄像头模组那块物理上看不见的区域。
            if model.barLayout.notched {
                Color.clear.frame(width: model.barLayout.keepOut)
            } else {
                Spacer(minLength: model.barLayout.keepOut)
            }
            HStack(spacing: IslandMetrics.itemSpacing) {
                if let quota = model.usage, let provider = quota.displayed, let session = provider.session {
                    IslandQuotaChip(provider: provider, window: session, action: onQuota, onHover: { onDetail(.quota, $0) })
                }
                // 额度右边的设备指示（CPU 压力灯 + 磁盘 / 内存双弧）：始终显示，不随悬停出现。
                if let device = model.device {
                    IslandDeviceChip(device: device, action: onDevice, onHover: { onDetail(.device, $0) })
                }
                // 设置与退出只在鼠标移上来（面板展开）时出现，收起时保持干净。
                if model.hovering {
                    NotchIconButton(icon: "gearshape", tooltip: "打开 bobo", action: onActivate)
                    NotchIconButton(icon: "power", tint: Color(red: 1.0, green: 0.40, blue: 0.40), tooltip: "退出 bobo", action: onQuit)
                }
            }
            .frame(width: model.barLayout.right, alignment: .leading)
            .clipped()
        }
        .frame(height: model.barHeight)
        .contentShape(Rectangle())
        .onTapGesture(perform: onActivate)
    }

    // 会话列表：高度按设置里的条数固定，装不下时可以滚动查看其余会话。
    // 必须用 showsIndicators:false：内容可滚动时 SwiftUI 会在尾部预留约 17pt 给滚动条，
    // 会让整列右侧比左侧多出一截空隙；.scrollIndicators(.hidden) 只隐藏指示条、不释放这段空间。
    private var list: some View {
        ScrollView(.vertical, showsIndicators: false) {
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

// 会话行：悬停高亮，点击跳到对应终端里对应的标签页。
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
                HStack(spacing: 4) {
                    // 会话计时（CodeIsland 的 SessionTag 做法）：从会话开始至今，过一分钟自己走一格。
                    // TimelineView 只重画这一格文字，展开着面板时每秒一次，收起后列表不在视图里、不占开销。
                    if session.startedAt != nil {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            if let text = IslandMetrics.elapsedText(session.startedAt, now: context.date.timeIntervalSince1970 * 1000) {
                                IslandSessionTag(text: text)
                            }
                        }
                    }
                    agentIcon
                    Text(model.label(session.state)).font(.system(size: 11)).foregroundStyle(.white.opacity(0.65))
                }
            }
            .padding(.horizontal, 9)
            .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 7).fill(background))
            .overlay {
                // 收到提醒、还没被查看的会话：描一圈提醒类型的颜色（等你回答=橙 / 运行中=蓝 / 已结束=绿 / 已终止=红）。
                if let state = model.highlighted[session.id] {
                    RoundedRectangle(cornerRadius: 7).strokeBorder(model.color(state), lineWidth: 1.5)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(HoverReporter { hovering = $0 })
    }

    private var subtitle: String? {
        let source = session.source == "codex" ? "Codex" : session.source == "omp" ? "omp" : session.source == "claude" ? "Claude Code" : session.source == "dsh" ? "DeepSeek" : "OpenCode"
        let parts = [source, session.terminal, session.name, session.detail].filter { $0?.isEmpty == false }.compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
    // 状态文案左侧的 Agent 来源图标（Codex / OpenCode / omp），与文字用同一档灰度。
    @ViewBuilder private var agentIcon: some View {
        if let icon = IslandMetrics.icon(id: IslandMetrics.providerId(forSource: session.source)) {
            Image(nsImage: icon).resizable().renderingMode(.template).interpolation(.high).scaledToFit()
                .frame(width: 11, height: 11).foregroundStyle(.white.opacity(0.55))
        } else {
            Image(systemName: IslandMetrics.symbol(forSource: session.source))
                .font(.system(size: 10, weight: .medium)).foregroundStyle(.white.opacity(0.55))
        }
    }
    private var background: Color {
        if session.state == "waiting" { return Color.orange.opacity(hovering ? 0.26 : 0.16) }
        return .white.opacity(hovering ? 0.11 : 0.05)
    }
}

// 会话计时标签：等宽小字 + 淡底圆角，观感对齐 CodeIsland 的 SessionTag（`<1m` / `5m` / `2h` / `1d`）。
struct IslandSessionTag: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 9.5, weight: .medium, design: .monospaced))
            .foregroundStyle(.white.opacity(0.7))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 5).fill(.white.opacity(0.12)))
            .fixedSize()
    }
}

// 折叠胶囊的额度指示：一枚圆环（底圈 + 剩余比例圆弧），环里是来源图标（模板图，白色）。
// 不再显示百分比文字——数字放进悬停半秒后弹出的明细卡里，宽度因此恒为一枚图标（见 Bobo.islandSize）。
struct IslandQuotaChip: View {
    let provider: IslandQuotaProvider
    let window: IslandQuotaWindow
    let action: () -> Void
    var onHover: ((Bool) -> Void)? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    // 剩余越少越显眼：绿 / 橙 / 红，与网页「用量」里的进度条同一套阈值。
    private var color: Color { IslandMetrics.remainingColor(window.remainingPercent) }

    // 圆环：底圈 + 剩余比例圆弧，来源图标放在环里。
    // 环的外圈正好是 22pt（= 胶囊高度）：胶囊的左端帽就是这个圆，不留额外灰边。
    private var ring: some View {
        ZStack {
            Circle().inset(by: 1).stroke(.white.opacity(0.22), lineWidth: 2)
            Circle().inset(by: 1).trim(from: 0, to: max(0.03, min(1, window.remainingPercent / 100)))
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
            providerIcon.frame(width: IslandMetrics.quotaIconSize, height: IslandMetrics.quotaIconSize).foregroundStyle(.white.opacity(0.92))
        }
        .frame(width: IslandMetrics.itemSize, height: IslandMetrics.itemSize)
    }

    @ViewBuilder private var providerIcon: some View {
        if let icon = IslandMetrics.icon(for: provider) {
            Image(nsImage: icon).resizable().renderingMode(.template).interpolation(.high).scaledToFit()
        } else {
            Image(systemName: IslandMetrics.symbol(for: provider)).font(.system(size: 10, weight: .medium))
        }
    }

    var body: some View {
        Button(action: action) {
            ring
                .frame(height: IslandMetrics.itemSize)
                .background(Capsule().fill(.white.opacity(hovering ? IslandMetrics.fillHover : IslandMetrics.fillIdle)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovering)
        .background(HoverReporter { hovering = $0; onHover?($0) })
    }
}

// 折叠胶囊的设备指示（形态参考 Status Trio 的三合一图标）：外环上 2/3 是存储（白色）、下 1/3 是内存（青色），
// 都从各自中心向两侧对称展开，中心圆点是 CPU 压力灯（绿 / 橙 / 红）；越界（low）的弧整段转红。
// 数字都在悬停半秒后弹出的明细卡里（见 Bobo.detailHoverChanged），圆环不占额外宽度。
struct IslandDeviceChip: View {
    let device: IslandDevice
    let action: () -> Void
    var onHover: ((Bool) -> Void)? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    // 这枚图标只有 22pt：圆环外沿与额度圆环一样顶到 22（inset 1 + 线宽 2）。存储占上 260°（比 2/3 再多一点，
    // 填充起来明显超过半圆）、内存占下 100°，两段各留 14° 缺口——只留几度会被圆头端点和暗轨道糊成一整圈。
    private static let gap: Double = 14
    private static let diskSpan: Double = 260 - 2 * gap
    private static let ramSpan: Double = 100 - 2 * gap
    private var cpuColor: Color { IslandMetrics.levelColor(device.cpu?.level) }
    // 弧按占用率分三档：≥85% 红、≥75% 橙，其余是各自的健康色（存储白、内存青）。
    // 只看百分比，不掺内存压力——压力等级留给网页里的卡片。
    private var diskColor: Color { IslandMetrics.usageColor(device.disk?.usedPercent ?? 0, healthy: .white.opacity(0.95)) }
    private var ramColor: Color { IslandMetrics.usageColor(device.memory?.usedPercent ?? 0, healthy: IslandMetrics.memoryHue) }
    private var diskFill: Double { min(1, max(0, (device.disk?.usedPercent ?? 0) / 100)) }
    private var ramFill: Double { min(1, max(0, (device.memory?.usedPercent ?? 0) / 100)) }

    // clock 是弧的起点（0 = 12 点方向，顺时针角度），sweep 是扫过的角度；轨道用平头端点，缺口不会被圆头盖住。
    private func arc(clock: Double, sweep: Double, color: Color, cap: CGLineCap = .round) -> some View {
        Circle().inset(by: 1)
            .trim(from: 0, to: max(0.008, min(1, sweep / 360)))
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: cap))
            .rotationEffect(.degrees(clock - 90))
    }

    var body: some View {
        Button(action: action) {
            ZStack {
                // 存储占上 260°（中心 12 点）、内存占下 100°（中心 6 点），两段在左侧（约 8 点）与右侧（约 4 点）各留 14° 缺口。
                arc(clock: -Self.diskSpan / 2, sweep: Self.diskSpan, color: .white.opacity(0.22), cap: .butt)
                arc(clock: 180 - Self.ramSpan / 2, sweep: Self.ramSpan, color: .white.opacity(0.22), cap: .butt)
                // 两条进度都从左侧（8 点那端）起长：存储顺时针往上绕过顶部，内存逆时针沿下弧向右——
                // 内存是下弧，顺时针会顶进存储那一段，所以要反过来长。
                arc(clock: -Self.diskSpan / 2, sweep: Self.diskSpan * diskFill, color: diskColor)
                arc(clock: 180 + Self.ramSpan / 2 - Self.ramSpan * ramFill, sweep: Self.ramSpan * ramFill, color: ramColor)
                Circle().fill(cpuColor).frame(width: 7, height: 7)
            }
            .frame(width: IslandMetrics.itemSize, height: IslandMetrics.itemSize)
            .background(Circle().fill(.white.opacity(hovering ? IslandMetrics.fillHover : IslandMetrics.fillIdle)))
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovering)
        .background(HoverReporter { hovering = $0; onHover?($0) })
    }
}

// MARK: - 悬停明细卡（额度 / 设备）

// 悬停指示半秒后出现的只读卡片：深色底、圆角与通知岛面板同一套观感，内容按类型切换。
// 卡片只负责画内容并量尺寸；显示、定位与隐藏都由 Bobo 管理（见 detailHoverChanged / applyDetail）。
struct IslandDetailView: View {
    @ObservedObject var model: IslandModel
    // 卡片里实际渲染的类型：面板隐藏（detail = nil）时保持上一次内容，重新打开同一种时尺寸不跳。
    @State private var shown: IslandDetailKind = .quota
    @State private var size: CGSize = .zero

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch shown {
            case .quota: IslandQuotaDetail(quota: model.usage)
            case .device: IslandDeviceDetail(device: model.device)
            }
        }
        .padding(13)
        .frame(width: IslandMetrics.detailWidth, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 13, style: .continuous).fill(.black))
        .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(.white.opacity(0.12), lineWidth: 1))
        .background(GeometryReader { proxy in
            Color.clear
                .onAppear {
                    if let kind = model.detail { shown = kind }
                    report(proxy.size)
                }
                .onChange(of: proxy.size) { _, value in report(value) }
        })
        .onChange(of: model.detail) { _, kind in
            if let kind { shown = kind }
            report(size)
        }
    }

    // 上报的 kind 是「逻辑显示状态」（model.detail）而不是卡片里保留的内容：原生据此决定收不收卡片。
    private func report(_ value: CGSize) {
        if size != value { size = value }
        let metrics = DetailMetrics(kind: model.detail, size: value)
        if model.detailMetrics != metrics { model.detailMetrics = metrics }
    }
}

// 明细卡的小标题行：左侧灰色标题，右侧可放一句说明（例如「点击圆环切换来源」）。
private struct DetailHeader: View {
    let title: String
    var note: String? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.5))
            Spacer(minLength: 0)
            if let note { Text(note).font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.4)) }
        }
    }
}

// 明细卡里的细进度条：轨道浅、填充按指标上色，与网页 meter 同一套形态。
private struct DetailMeter: View {
    let fraction: Double
    let color: Color
    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.14))
                if fraction > 0 {
                    Capsule().fill(color).frame(width: max(2, proxy.size.width * min(1, fraction)))
                }
            }
        }
        .frame(height: 5)
    }
}

// 额度明细：只列当前选中这一家（与圆环一致），切换来源后卡片内容跟着换成新的一家。
private struct IslandQuotaDetail: View {
    let quota: IslandQuota?

    var body: some View {
        DetailHeader(title: "额度", note: quota?.switchable == true ? "点击圆环切换来源" : nil)
        if let provider = quota?.displayed {
            IslandQuotaProviderBlock(provider: provider)
        } else {
            Text("额度暂不可用").font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

private struct IslandQuotaProviderBlock: View {
    let provider: IslandQuotaProvider

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if let icon = IslandMetrics.icon(for: provider) {
                    Image(nsImage: icon).resizable().renderingMode(.template).interpolation(.high).scaledToFit()
                        .frame(width: 13, height: 13).foregroundStyle(.white.opacity(0.9))
                } else {
                    Image(systemName: IslandMetrics.symbol(for: provider)).font(.system(size: 10, weight: .medium)).foregroundStyle(.white.opacity(0.9))
                }
                Text(provider.name).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                if !provider.plan.isEmpty {
                    Text(provider.plan).font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.5))
                }
                if provider.estimated {
                    Text("本机估算").font(.system(size: 9.5)).foregroundStyle(.white.opacity(0.55))
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(Capsule().fill(.white.opacity(0.12)))
                }
                Spacer(minLength: 0)
            }
            if provider.windows.isEmpty {
                Text("没有返回额度窗口").font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.45))
            }
            ForEach(provider.windows, id: \.key) { IslandQuotaWindowRow(window: $0) }
            if let error = provider.error, !error.isEmpty {
                Text("⚠ " + error).font(.system(size: 10)).foregroundStyle(IslandMetrics.warnHue)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// 一个额度窗口：标题 + 剩余百分比、进度条、已用情况（金额优先）与重置时间。
private struct IslandQuotaWindowRow: View {
    let window: IslandQuotaWindow

    private var limited: Bool { !window.status.isEmpty && window.status != "ok" }
    private var money: String? {
        guard let limit = window.limitUSD else { return nil }
        // 与网页「用量」一致：整分以上保留两位，更小的零头保留四位，免得读成 $0。
        let used = window.usedUSD ?? 0
        let usedText = used >= 0.01 ? String(format: "$%.2f", used) : String(format: "$%.4f", used)
        let limitText = limit == limit.rounded() ? String(format: "$%.0f", limit) : String(format: "$%.2f", limit)
        return "已用 \(usedText) / \(limitText)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(window.label.isEmpty ? window.key : window.label).font(.system(size: 11)).foregroundStyle(.white.opacity(0.62))
                if limited { Text("已限额").font(.system(size: 10, weight: .medium)).foregroundStyle(IslandMetrics.criticalHue) }
                Spacer(minLength: 4)
                Text("剩余 \(Int(window.remainingPercent.rounded()))%")
                    .font(.system(size: 11.5, weight: .semibold)).monospacedDigit().foregroundStyle(.white)
            }
            DetailMeter(fraction: window.remainingPercent / 100, color: IslandMetrics.remainingColor(window.remainingPercent))
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(money ?? "已用 \(Int(window.usedPercent.rounded()))%")
                Spacer(minLength: 4)
                if let reset = IslandMetrics.resetText(window.resetInSec) { Text(reset) }
            }
            .font(.system(size: 10.5)).monospacedDigit().foregroundStyle(.white.opacity(0.45))
        }
    }
}

// 设备明细：CPU（占用率 + 核数 + 负载）、内存（含缓存与压力）、磁盘（含可用空间），
// 颜色与胶囊上的设备指示同一套阈值（内存青、磁盘白，≥ 75% 橙、≥ 85% 红）。
private struct IslandDeviceDetail: View {
    let device: IslandDevice?

    var body: some View {
        DetailHeader(title: "设备")
        if let device {
            if let cpu = device.cpu {
                IslandDeviceRow(
                    label: "CPU",
                    value: cpu.usage.map { "\(Int($0.rounded()))%" } ?? "—",
                    fraction: (cpu.usage ?? 0) / 100,
                    color: IslandMetrics.levelColor(cpu.level),
                    detail: cpuDetail(cpu)
                )
            }
            if let memory = device.memory {
                let percent = memory.usedPercent ?? 0
                IslandDeviceRow(
                    label: "内存",
                    value: "\(Int(percent.rounded()))%",
                    fraction: percent / 100,
                    color: IslandMetrics.usageColor(percent, healthy: IslandMetrics.memoryHue),
                    detail: memoryDetail(memory)
                )
            }
            if let disk = device.disk {
                let percent = disk.usedPercent ?? 0
                IslandDeviceRow(
                    label: "磁盘",
                    value: "\(Int(percent.rounded()))%",
                    fraction: percent / 100,
                    color: IslandMetrics.usageColor(percent, healthy: .white.opacity(0.9)),
                    detail: diskDetail(disk)
                )
            }
        } else {
            Text("正在读取…").font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
        }
    }

    // CPU 明细省略型号（卡片一行放不下）：核数与 1 / 5 / 15 分钟负载。
    private func cpuDetail(_ cpu: IslandDevice.CPU) -> String {
        var parts: [String] = []
        if let cores = cpu.cores, cores > 0 { parts.append("\(cores) 核") }
        if let load = cpu.load, !load.isEmpty { parts.append("负载 " + load.prefix(3).map { String(format: "%.2f", $0) }.joined(separator: " / ")) }
        return parts.isEmpty ? "读取中" : parts.joined(separator: " · ")
    }
    private func memoryDetail(_ memory: IslandDevice.Memory) -> String {
        var parts = [IslandDevice.size(memory.used, binary: true) + " / " + IslandDevice.size(memory.total, binary: true)]
        if let cached = memory.cached { parts.append("缓存 " + IslandDevice.size(cached, binary: true)) }
        if let pressure = memory.pressureLabel, !pressure.isEmpty { parts.append("压力" + pressure) }
        return parts.joined(separator: " · ")
    }
    private func diskDetail(_ disk: IslandDevice.Disk) -> String {
        var parts = [IslandDevice.size(disk.used) + " / " + IslandDevice.size(disk.total)]
        if let free = disk.free { parts.append("可用 " + IslandDevice.size(free)) }
        return parts.joined(separator: " · ")
    }
}

private struct IslandDeviceRow: View {
    let label: String
    let value: String
    let fraction: Double
    let color: Color
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(label).font(.system(size: 11)).foregroundStyle(.white.opacity(0.62))
                Spacer(minLength: 4)
                Text(value).font(.system(size: 11.5, weight: .semibold)).monospacedDigit().foregroundStyle(.white)
            }
            DetailMeter(fraction: fraction, color: color)
            Text(detail).font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.45)).lineLimit(2)
        }
    }
}

// 刘海上的小图标按钮（形态参考 CodeIsland 的 NotchIconButton）：悬停时圆形底色变亮。
// 尺寸/底色与折叠胶囊里其它图标共用 IslandMetrics，保证一样大、间距一致。
struct NotchIconButton: View {
    let icon: String
    var tint: Color = .white
    var tooltip: String? = nil
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: IslandMetrics.actionGlyphSize, weight: .medium))
                .foregroundStyle(tint.opacity(hovering ? 1 : 0.85))
                .frame(width: IslandMetrics.itemSize, height: IslandMetrics.itemSize)
                .background(Circle().fill(.white.opacity(hovering ? IslandMetrics.fillHover : IslandMetrics.fillIdle)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovering)
        .background(HoverReporter { hovering = $0 })
        .help(tooltip ?? "")
    }
}

// 折叠态的头像：优先显示按会话 ID 稳定哈希选出的 bobo 图；缺少资源时回退为圆角方块脸。
// 运行中 / 等你回答时指示灯缓慢呼吸（与展开列表里的状态点一致），收起后也能一眼看出哪个会话在跑。
struct IslandAvatar: View {
    let image: NSImage?
    let logo: NSImage?
    let badgeColor: Color
    let color: Color
    let state: String
    let stateColor: Color
    @State private var animating = false

    init(image: NSImage? = nil, logo: NSImage? = nil, badgeColor: Color = Color(white: 0.94), color: Color, state: String, stateColor: Color) {
        self.image = image
        self.logo = logo
        self.badgeColor = badgeColor
        self.color = color
        self.state = state
        self.stateColor = stateColor
    }

    private var pulsing: Bool { state == "working" || state == "waiting" }

    @ViewBuilder
    private var face: some View {
        if let image {
            ZStack {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
                    .scaleEffect(1.28)
                if let logo {
                    ZStack {
                        RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                            .fill(badgeColor)
                            .frame(width: 14, height: 10.5)
                        Image(nsImage: logo)
                            .resizable()
                            .renderingMode(.template)
                            .interpolation(.high)
                            .scaledToFit()
                            .frame(width: 10.5, height: 10.5)
                                .foregroundStyle(.white.opacity(0.98))
                    }
                    // 独立落在盒面下半部，避免 logo 与 bobo 的脸混在一起。
                    .offset(y: 5)
                }
            }
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
        // 脸与其它图标一样大（glyphSize），下面的状态灯只占 1pt 间距，整体不超过非刘海屏的 24pt 栏高。
        VStack(spacing: 1) {
            face
                .frame(width: IslandMetrics.glyphSize, height: IslandMetrics.glyphSize)
                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            Circle().fill(stateColor).frame(width: 4, height: 4)
                .opacity(pulsing ? (animating ? 0.35 : 1) : 0.6)
                .onAppear { start() }
                .onChange(of: pulsing) { _, _ in start() }
        }
        // 宽度就是脸宽（19）而不是外框 22：这样头像之间的视觉间距和圆环（外沿正好 22）之间的一致。
        .frame(width: IslandMetrics.glyphSize)
    }

    private func start() {
        guard pulsing, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { animating = false; return }
        withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) { animating = true }
    }
}

// 折叠胶囊里放不下的会话：最后一格是「+N」计数徽标（尺寸与头像脸一致），完整列表在展开态里看。
// 颜色跟着被藏起来的会话里最需要关注的状态走，提醒不会被藏没。
struct IslandOverflowBadge: View {
    let count: Int
    let color: Color
    var body: some View {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(color.opacity(0.22))
            .frame(width: IslandMetrics.glyphSize, height: IslandMetrics.glyphSize)
            .overlay(Text("+\(count)").font(.system(size: 9.5, weight: .semibold)).monospacedDigit().foregroundStyle(color))
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
