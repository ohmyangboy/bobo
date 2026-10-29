import AppKit
import Combine
import EventKit
import SwiftUI
import WebKit

enum TodoAuthorization: String, Encodable { case notDetermined, allowed, denied, restricted }

struct TodoList: Equatable, Encodable, Identifiable {
    var id: String
    var title: String
}

struct TodoReminder: Equatable, Identifiable {
    var id: String
    var title: String
    var list: String
    var due: DateComponents?
    var priority = 0
    var completed = false

    func dueDate(calendar: Calendar) -> Date? {
        guard var due, due.year != nil, due.month != nil, due.day != nil else { return nil }
        var source = due.calendar ?? calendar
        source.timeZone = due.timeZone ?? calendar.timeZone
        due.calendar = source
        return source.date(from: due)
    }
}

enum TodoBucket: String, CaseIterable, Encodable {
    case later, week, today
    var title: String { switch self { case .later: return "稍后"; case .week: return "本周"; case .today: return "今天" } }
}

struct TodoItem: Equatable, Encodable, Identifiable {
    var id: String
    var title: String
    var list: String
    var dateText: String
    var overdue: Bool
}

struct TodoColumn: Equatable, Encodable, Identifiable {
    var bucket: TodoBucket
    var items: [TodoItem]
    var id: String { bucket.rawValue }
    var title: String { bucket.title }
}

struct TodoSnapshot: Equatable, Encodable {
    var enabled = false
    var authorization = TodoAuthorization.notDetermined
    var loading = false
    var error = ""
    var lists: [TodoList] = []
    var defaultList = ""
    var columns = TodoBucket.allCases.map { TodoColumn(bucket: $0, items: []) }
    var count: Int { columns.reduce(0) { $0 + $1.items.count } }
    var height: CGFloat {
        guard enabled else { return 0 }
        guard authorization == .allowed, error.isEmpty else { return 80 }
        return 72 + CGFloat(max(1, min(3, columns.map { $0.items.count }.max() ?? 0))) * 40
    }
}

enum TodoGrouping {
    static func columns(_ reminders: [TodoReminder], now: Date, calendar: Calendar) -> [TodoColumn] {
        let today = calendar.startOfDay(for: now)
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: today)!
        let weekEnd = calendar.dateInterval(of: .weekOfYear, for: now)?.end ?? tomorrow
        let dayFormatter = DateFormatter()
        dayFormatter.locale = Locale(identifier: "zh_CN")
        dayFormatter.calendar = calendar
        dayFormatter.timeZone = calendar.timeZone
        dayFormatter.dateFormat = "M月d日"
        let timeFormatter = DateFormatter()
        timeFormatter.locale = dayFormatter.locale
        timeFormatter.timeZone = calendar.timeZone
        timeFormatter.dateFormat = "HH:mm"
        var groups: [TodoBucket: [TodoItem]] = [:]
        let sorted = reminders.filter { !$0.completed }.sorted {
            let a = $0.dueDate(calendar: calendar) ?? .distantFuture, b = $1.dueDate(calendar: calendar) ?? .distantFuture
            if a != b { return a < b }
            let ap = $0.priority == 0 ? 10 : $0.priority, bp = $1.priority == 0 ? 10 : $1.priority
            if ap != bp { return ap < bp }
            if $0.title != $1.title { return $0.title.localizedStandardCompare($1.title) == .orderedAscending }
            return $0.id < $1.id
        }
        for reminder in sorted {
            let due = reminder.dueDate(calendar: calendar)
            let bucket: TodoBucket = due.map { $0 < tomorrow ? .today : ($0 < weekEnd ? .week : .later) } ?? .later
            let timed = reminder.due?.hour != nil
            let overdue = due.map { timed ? $0 < now : $0 < today } ?? false
            var label = due.map { calendar.isDate($0, inSameDayAs: now) ? (timed ? timeFormatter.string(from: $0) : "今天") : dayFormatter.string(from: $0) } ?? "未设日期"
            if overdue { label = "已逾期 · " + label }
            groups[bucket, default: []].append(TodoItem(id: reminder.id, title: reminder.title.isEmpty ? "未命名事项" : reminder.title, list: reminder.list, dateText: label, overdue: overdue))
        }
        return TodoBucket.allCases.map { TodoColumn(bucket: $0, items: groups[$0] ?? []) }
    }

    static func dateComponents(_ text: String, calendar: Calendar) -> DateComponents? {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]), (1...9999).contains(year) else { return nil }
        let components = DateComponents(calendar: calendar, year: year, month: month, day: day)
        guard let date = calendar.date(from: components), calendar.component(.year, from: date) == year,
              calendar.component(.month, from: date) == month, calendar.component(.day, from: date) == day else { return nil }
        return components
    }
}

@MainActor protocol TodoRepository: AnyObject {
    var authorization: TodoAuthorization { get }
    var onChange: (() -> Void)? { get set }
    func requestAccess() async throws -> Bool
    func fetch() async throws -> [TodoReminder]
    func writableLists() -> [TodoList]
    func defaultListID() -> String
    func create(title: String, due: DateComponents?, listID: String) throws
}

@MainActor final class EventKitTodoRepository: TodoRepository {
    private let store = EKEventStore()
    private var observer: NSObjectProtocol?
    var onChange: (() -> Void)?
    init() {
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.onChange?() }
        }
    }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    var authorization: TodoAuthorization {
        let status = EKEventStore.authorizationStatus(for: .reminder)
        if #available(macOS 14, *), status == .fullAccess { return .allowed }
        switch status {
        case .authorized: return .allowed
        case .notDetermined: return .notDetermined
        case .restricted: return .restricted
        default: return .denied
        }
    }
    func requestAccess() async throws -> Bool {
        if #available(macOS 14, *) { return try await store.requestFullAccessToReminders() }
        return try await store.requestAccess(to: .reminder)
    }
    func fetch() async throws -> [TodoReminder] {
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        return try await withCheckedThrowingContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                guard let reminders else { continuation.resume(throwing: TodoError.message("读取提醒事项失败，请刷新重试")); return }
                continuation.resume(returning: reminders.map { TodoReminder(id: $0.calendarItemIdentifier, title: $0.title ?? "", list: $0.calendar.title, due: $0.dueDateComponents, priority: $0.priority, completed: $0.isCompleted) })
            }
        }
    }
    func writableLists() -> [TodoList] {
        store.calendars(for: .reminder).filter(\.allowsContentModifications).map { TodoList(id: $0.calendarIdentifier, title: $0.title) }
    }
    func defaultListID() -> String { store.defaultCalendarForNewReminders()?.calendarIdentifier ?? "" }
    func create(title: String, due: DateComponents?, listID: String) throws {
        guard let list = store.calendar(withIdentifier: listID), list.allowedEntityTypes.contains(.reminder), list.allowsContentModifications else { throw TodoError.message("此列表不可写，请重新选择提醒事项列表") }
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.calendar = list
        reminder.dueDateComponents = due
        // EventKit 要求开始时间不晚于截止时间；全天提醒不设置时分或额外闹钟。
        reminder.startDateComponents = due
        try store.save(reminder, commit: true)
    }
}

enum TodoError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let message): return message } }
}

@MainActor final class TodoStore: ObservableObject {
    @Published private(set) var snapshot = TodoSnapshot()
    private let repository: any TodoRepository
    private let defaults: UserDefaults
    private let now: () -> Date
    private let calendar: () -> Calendar
    private var generation = 0
    private var pendingRefresh = false
    private var requesting = false
    private var observers: [NSObjectProtocol] = []

    init(repository: any TodoRepository, defaults: UserDefaults, now: @escaping () -> Date = Date.init, calendar: @escaping () -> Calendar = { .current }, observeSystem: Bool = true) {
        self.repository = repository; self.defaults = defaults; self.now = now; self.calendar = calendar
        snapshot.enabled = defaults.bool(forKey: "todoEnabled")
        snapshot.authorization = repository.authorization
        repository.onChange = { [weak self] in self?.refresh() }
        if observeSystem {
            for name in [Notification.Name.NSCalendarDayChanged, .NSSystemTimeZoneDidChange] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.refresh() } })
            }
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.refresh() } })
        }
    }
    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer); NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    }
    func setEnabled(_ enabled: Bool) {
        generation += 1
        pendingRefresh = false
        snapshot.enabled = enabled
        defaults.set(enabled, forKey: "todoEnabled")
        snapshot.loading = false
        snapshot.error = ""
        snapshot.columns = TodoSnapshot().columns
        snapshot.lists = []
        snapshot.defaultList = ""
        if enabled { refresh() }
    }
    func connect() async {
        guard !requesting else { return }
        requesting = true
        defer { requesting = false }
        snapshot.error = ""
        do {
            if repository.authorization == .notDetermined { _ = try await repository.requestAccess() }
            snapshot.authorization = repository.authorization
            if snapshot.authorization == .allowed { setEnabled(true) }
        } catch { snapshot.error = error.localizedDescription }
    }
    func refresh() {
        snapshot.authorization = repository.authorization
        guard snapshot.enabled, snapshot.authorization == .allowed else {
            generation += 1; pendingRefresh = false; snapshot.loading = false; snapshot.columns = TodoSnapshot().columns; snapshot.lists = []; snapshot.defaultList = ""
            return
        }
        if snapshot.loading { pendingRefresh = true; return }
        snapshot.loading = true
        let current = generation
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let reminders = try await self.repository.fetch()
                guard current == self.generation else { return }
                guard self.repository.authorization == .allowed else { self.refresh(); return }
                self.snapshot.columns = TodoGrouping.columns(reminders, now: self.now(), calendar: self.calendar())
                self.snapshot.lists = self.repository.writableLists()
                self.snapshot.defaultList = self.repository.defaultListID()
                self.snapshot.error = ""
            } catch {
                guard current == self.generation else { return }
                guard self.repository.authorization == .allowed else { self.refresh(); return }
                self.snapshot.error = error.localizedDescription
            }
            self.snapshot.loading = false
            if self.pendingRefresh { self.pendingRefresh = false; self.refresh() }
        }
    }
    func create(title: String, date: String, listID: String) -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            guard snapshot.enabled, repository.authorization == .allowed else { throw TodoError.message("请先连接提醒事项") }
            guard !title.isEmpty, title.count <= 500 else { throw TodoError.message("请填写 1–500 字的事项标题") }
            let due = date.isEmpty ? nil : TodoGrouping.dateComponents(date, calendar: calendar())
            guard date.isEmpty || due != nil else { throw TodoError.message("日期无效，请重新选择") }
            try repository.create(title: title, due: due, listID: listID)
            snapshot.error = ""; refresh(); return true
        } catch { snapshot.error = error.localizedDescription; return false }
    }
}

enum TodoNavigation {
    static func reminderURL(_ id: String?) -> URL? {
        guard let id, let uuid = UUID(uuidString: id) else { return nil }
        return URL(string: "x-apple-reminderkit://REMCDReminder/\(uuid.uuidString)/details")
    }
    @MainActor static func open(_ id: String? = nil) {
        let workspace = NSWorkspace.shared
        guard let app = workspace.urlForApplication(withBundleIdentifier: "com.apple.reminders") else { return }
        let config = NSWorkspace.OpenConfiguration()
        if let url = reminderURL(id) {
            workspace.open([url], withApplicationAt: app, configuration: config) { _, error in
                if error != nil { Task { @MainActor in NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration()) } }
            }
        } else { workspace.openApplication(at: app, configuration: config) }
    }
}

// 仅向受信任的本机主页面提供能力；提醒事项数据不经过 Node HTTP API。
@MainActor final class TodoWebBridge: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private let store: TodoStore
    private var subscription: AnyCancellable?
    init(webView: WKWebView, store: TodoStore) {
        self.webView = webView; self.store = store
        super.init()
        subscription = store.$snapshot.sink { [weak self] snapshot in self?.publish(snapshot) }
    }
    static func trusted(_ url: URL?) -> Bool { url?.scheme == "http" && url?.host == "127.0.0.1" && url?.port == 4318 && url?.path == "/" }
    private func publish(_ snapshot: TodoSnapshot) {
        guard Self.trusted(webView?.url), let data = try? JSONEncoder().encode(snapshot), let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__boboTodoReceive?.(\(json))")
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, Self.trusted(message.frameInfo.request.url), let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "get": publish(store.snapshot); store.refresh()
        case "connect": Task { await store.connect(); publish(store.snapshot) }
        case "enabled": if let enabled = body["enabled"] as? Bool { store.setEnabled(enabled) }
        case "open":
            let id = body["id"] as? String
            guard id == nil || store.snapshot.columns.contains(where: { $0.items.contains(where: { $0.id == id }) }) else { return }
            TodoNavigation.open(id)
        case "settings": if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders") { NSWorkspace.shared.open(url) }
        case "create":
            guard let title = body["title"] as? String, let date = body["date"] as? String, let listID = body["listID"] as? String else { return }
            let saved = store.create(title: title, date: date, listID: listID)
            webView?.evaluateJavaScript("window.__boboTodoCreated?.(\(saved))")
        default: break
        }
    }
}

struct IslandTodoView: View {
    var snapshot: TodoSnapshot
    var onManage: () -> Void
    var onOpen: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button(action: onManage) { Label("Todo", systemImage: "checklist").font(.system(size: 11, weight: .medium)) }
                    .help("查看全部待办与连接设置").accessibilityIdentifier("island-todo-manage")
                Text("\(snapshot.count)").font(.system(size: 10)).foregroundStyle(.white.opacity(0.4))
                Spacer()
                Button(action: onManage) { Image(systemName: "plus").font(.system(size: 10)) }.help("新增提醒事项")
            }.foregroundStyle(.white.opacity(0.7)).frame(height: 18)
            if snapshot.authorization != .allowed || !snapshot.error.isEmpty {
                Button(action: onManage) { Text(snapshot.error.isEmpty ? "连接提醒事项，查看待办 →" : snapshot.error).lineLimit(2).font(.system(size: 11)) }
                    .foregroundStyle(.white.opacity(0.5))
            } else {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(snapshot.columns) { column in
                        IslandTodoColumn(column: column, onOpen: onOpen, onMore: onManage).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .buttonStyle(.plain)
        .padding(10)
        .frame(height: snapshot.height)
        .background(.white.opacity(0.035))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("提醒事项，稍后、本周、今天")
    }
}

private struct IslandTodoColumn: View {
    var column: TodoColumn
    var onOpen: (String) -> Void
    var onMore: () -> Void
    private var tint: Color { switch column.bucket { case .later: return Color(white: 0.65); case .week: return .cyan; case .today: return .orange } }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) { Circle().fill(tint).frame(width: 4, height: 4); Text(column.title); Text("\(column.items.count)").foregroundStyle(.white.opacity(0.35)) }
                .font(.system(size: 10, weight: .medium)).foregroundStyle(.white.opacity(0.65)).frame(height: 14)
            if column.items.isEmpty { Text("暂无事项").font(.system(size: 10)).foregroundStyle(.white.opacity(0.25)).padding(.top, 8) }
            ForEach(Array(column.items.prefix(3))) { item in
                Button { onOpen(item.id) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title).font(.system(size: 11)).foregroundStyle(.white.opacity(0.9)).lineLimit(1)
                        Text(item.dateText).font(.system(size: 9)).foregroundStyle(item.overdue ? .orange : .white.opacity(0.4)).lineLimit(1)
                    }.frame(maxWidth: .infinity, minHeight: 32, maxHeight: 32, alignment: .leading)
                        .padding(.horizontal, 6).background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 6))
                }.help("\(item.title) · \(item.list)；在提醒事项中打开").accessibilityLabel("\(item.title)，\(item.dateText)，在提醒事项中打开")
            }
            if column.items.count > 3 { Button("还有 \(column.items.count - 3) 项 →", action: onMore).font(.system(size: 9)).foregroundStyle(tint) }
        }
    }
}
