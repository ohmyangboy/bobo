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
    var notes = ""
    var listID = ""
    var editable = true
    var alarm: Date?
    var url = ""

    func dueDate(calendar: Calendar) -> Date? {
        guard var due, due.year != nil, due.month != nil, due.day != nil else { return nil }
        var source = due.calendar ?? calendar
        source.timeZone = due.timeZone ?? calendar.timeZone
        due.calendar = source
        return source.date(from: due)
    }
}

enum TodoBucket: String, CaseIterable, Encodable {
    case today, week, later
    var title: String { switch self { case .later: return "事务"; case .week: return "近七"; case .today: return "今日" } }
}

struct TodoItem: Equatable, Encodable, Identifiable {
    var id: String
    var title: String
    var list: String
    var dateText: String
    var overdue: Bool
    var notes = ""
    var priority = 0
    var completed = false
    var listID = ""
    var editable = true
    var date = ""
    var time = ""
    var alarm = ""
    var url = ""
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
    var showCompleted = false
    var columns = TodoBucket.allCases.map { TodoColumn(bucket: $0, items: []) }
    var count: Int { columns.reduce(0) { $0 + $1.items.count } }
    var height: CGFloat {
        guard enabled else { return 0 }
        guard authorization == .allowed else { return 80 }
        return 360
    }
}

enum TodoGrouping {
    static func columns(_ reminders: [TodoReminder], now: Date, calendar: Calendar, showCompleted: Bool = false) -> [TodoColumn] {
        let today = calendar.startOfDay(for: now)
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: today)!
        let sevenEnd = calendar.date(byAdding: .day, value: 8, to: today)!
        let dayFormatter = DateFormatter()
        dayFormatter.locale = Locale(identifier: "zh_CN")
        dayFormatter.calendar = calendar
        dayFormatter.timeZone = calendar.timeZone
        dayFormatter.dateFormat = "M月d日"
        let timeFormatter = DateFormatter()
        timeFormatter.locale = dayFormatter.locale
        timeFormatter.timeZone = calendar.timeZone
        timeFormatter.dateFormat = "HH:mm"
        let dateFormatter = DateFormatter()
        dateFormatter.calendar = calendar; dateFormatter.timeZone = calendar.timeZone
        dateFormatter.locale = Locale(identifier: "en_US_POSIX"); dateFormatter.dateFormat = "yyyy-MM-dd"
        var groups: [TodoBucket: [TodoItem]] = [:]
        let sorted = reminders.filter { showCompleted || !$0.completed }.sorted {
            if $0.completed != $1.completed { return !$0.completed }
            let a = $0.dueDate(calendar: calendar) ?? .distantFuture, b = $1.dueDate(calendar: calendar) ?? .distantFuture
            if a != b { return a < b }
            let ap = $0.priority == 0 ? 10 : $0.priority, bp = $1.priority == 0 ? 10 : $1.priority
            if ap != bp { return ap < bp }
            if $0.title != $1.title { return $0.title.localizedStandardCompare($1.title) == .orderedAscending }
            return $0.id < $1.id
        }
        for reminder in sorted {
            let due = reminder.dueDate(calendar: calendar)
            let bucket: TodoBucket = due.map { $0 < tomorrow ? .today : ($0 < sevenEnd ? .week : .later) } ?? .later
            let timed = reminder.due?.hour != nil
            let overdue = !reminder.completed && (due.map { timed ? $0 < now : $0 < today } ?? false)
            var label = due.map { calendar.isDate($0, inSameDayAs: now) ? (timed ? timeFormatter.string(from: $0) : "今天") : dayFormatter.string(from: $0) } ?? "未设日期"
            if overdue { label = "已逾期 · " + label }
            groups[bucket, default: []].append(TodoItem(id: reminder.id, title: reminder.title.isEmpty ? "未命名事项" : reminder.title, list: reminder.list, dateText: label, overdue: overdue, notes: reminder.notes, priority: reminder.priority, completed: reminder.completed, listID: reminder.listID, editable: reminder.editable, date: due.map { dateFormatter.string(from: $0) } ?? "", time: timed ? due.map { timeFormatter.string(from: $0) } ?? "" : "", alarm: reminder.alarm.map { ISO8601DateFormatter().string(from: $0) } ?? "", url: reminder.url))
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

// 子任务清单与标签作为备注保存；EventKit 没有公开的子任务 / 标签写入 API。
struct TodoDetails: Equatable {
    var notes = ""
    var checklist = ""
    var tags = ""
    var priority = 0
    var alarm: Date?
    var time = ""
    var url = ""
    var savedNotes: String {
        if checklist.isEmpty && tags.isEmpty { return notes }
        return [notes.trimmingCharacters(in: .whitespacesAndNewlines),
         checklist.split(separator: "\n").map { "☐ " + $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "\n"),
         tags.split(whereSeparator: { $0.isWhitespace || $0 == "," || $0 == "，" }).map { "#" + $0.trimmingCharacters(in: CharacterSet(charactersIn: "#")) }.joined(separator: " ")]
            .filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
}

struct TodoDraft: Identifiable {
    let id = UUID()
    var title = ""
    var bucket = TodoBucket.later
    var date = ""
    var listID = ""
    var details = TodoDetails()
}

@MainActor protocol TodoRepository: AnyObject {
    var authorization: TodoAuthorization { get }
    var onChange: (() -> Void)? { get set }
    func requestAccess() async throws -> Bool
    func fetch(includeCompleted: Bool) async throws -> [TodoReminder]
    func writableLists() -> [TodoList]
    func defaultListID() -> String
    func create(title: String, due: DateComponents?, listID: String, details: TodoDetails) throws
    func update(id: String, title: String, due: DateComponents?, listID: String, details: TodoDetails, preserveDue: Bool) throws
    func complete(id: String, completed: Bool) throws
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
    func fetch(includeCompleted: Bool) async throws -> [TodoReminder] {
        let predicate = includeCompleted ? store.predicateForReminders(in: nil) : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        return try await withCheckedThrowingContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                guard let reminders else { continuation.resume(throwing: TodoError.message("读取提醒事项失败，请刷新重试")); return }
                continuation.resume(returning: reminders.map { TodoReminder(id: $0.calendarItemIdentifier, title: $0.title ?? "", list: $0.calendar.title, due: $0.dueDateComponents, priority: $0.priority, completed: $0.isCompleted, notes: $0.notes ?? "", listID: $0.calendar.calendarIdentifier, editable: $0.calendar.allowsContentModifications, alarm: $0.alarms?.first?.absoluteDate, url: $0.url?.absoluteString ?? "") })
            }
        }
    }
    func writableLists() -> [TodoList] {
        store.calendars(for: .reminder).filter(\.allowsContentModifications).map { TodoList(id: $0.calendarIdentifier, title: $0.title) }
    }
    func defaultListID() -> String { store.defaultCalendarForNewReminders()?.calendarIdentifier ?? "" }
    func create(title: String, due: DateComponents?, listID: String, details: TodoDetails) throws {
        guard let list = store.calendar(withIdentifier: listID), list.allowedEntityTypes.contains(.reminder), list.allowsContentModifications else { throw TodoError.message("此列表不可写，请重新选择提醒事项列表") }
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.calendar = list
        reminder.notes = details.savedNotes
        reminder.priority = details.priority
        reminder.url = details.url.isEmpty ? nil : URL(string: details.url)
        if let alarm = details.alarm { reminder.addAlarm(EKAlarm(absoluteDate: alarm)) }
        reminder.dueDateComponents = due
        // EventKit 要求开始时间不晚于截止时间；全天提醒不设置时分或额外闹钟。
        reminder.startDateComponents = due
        try store.save(reminder, commit: true)
    }
    func update(id: String, title: String, due: DateComponents?, listID: String, details: TodoDetails, preserveDue: Bool) throws {
        guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder, reminder.calendar.allowsContentModifications else { throw TodoError.message("事项已移除或不可编辑，请刷新") }
        guard let list = store.calendar(withIdentifier: listID), list.allowedEntityTypes.contains(.reminder), list.allowsContentModifications else { throw TodoError.message("此列表不可写，请重新选择提醒事项列表") }
        reminder.title = title; reminder.notes = details.savedNotes; reminder.priority = details.priority
        reminder.calendar = list; reminder.url = details.url.isEmpty ? nil : URL(string: details.url)
        if !preserveDue { reminder.startDateComponents = due; reminder.dueDateComponents = due }
        // 未修改的闹钟与未暴露的系统字段（重复、附件等）原样保留。
        if reminder.alarms?.first?.absoluteDate != details.alarm {
            reminder.alarms = details.alarm.map { [EKAlarm(absoluteDate: $0)] } ?? []
        }
        try store.save(reminder, commit: true)
    }
    func complete(id: String, completed: Bool) throws {
        guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder, reminder.calendar.allowsContentModifications else { throw TodoError.message("事项已移除或不可编辑，请刷新") }
        reminder.isCompleted = completed
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
        snapshot.showCompleted = defaults.bool(forKey: "todoShowCompleted")
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
    func setShowCompleted(_ show: Bool) {
        generation += 1; snapshot.loading = false; pendingRefresh = false
        snapshot.showCompleted = show; defaults.set(show, forKey: "todoShowCompleted")
        snapshot.columns = TodoSnapshot().columns
        refresh()
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
                let reminders = try await self.repository.fetch(includeCompleted: self.snapshot.showCompleted)
                guard current == self.generation else { return }
                guard self.repository.authorization == .allowed else { self.refresh(); return }
                self.snapshot.columns = TodoGrouping.columns(reminders, now: self.now(), calendar: self.calendar(), showCompleted: self.snapshot.showCompleted)
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
    func create(title: String, date: String, listID: String, bucket: TodoBucket? = nil, details: TodoDetails = TodoDetails(), editingID: String? = nil) -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            guard snapshot.enabled, repository.authorization == .allowed else { throw TodoError.message("请先连接提醒事项") }
            guard !title.isEmpty, title.count <= 500 else { throw TodoError.message("请填写 1–500 字的事项标题") }
            guard [0, 1, 5, 9].contains(details.priority), details.savedNotes.count <= 20000 else { throw TodoError.message("优先级或备注无效") }
            guard details.url.isEmpty || (details.url.count <= 4000 && URL(string: details.url)?.scheme != nil) else { throw TodoError.message("URL 无效，请填写完整链接") }
            var due = date.isEmpty ? nil : TodoGrouping.dateComponents(date, calendar: calendar())
            if date.isEmpty, let bucket, bucket != .later {
                let cal = calendar(), today = cal.startOfDay(for: now())
                let target = bucket == .today ? today : cal.date(byAdding: .day, value: 1, to: today)!
                due = cal.dateComponents([.year, .month, .day], from: target)
            }
            guard date.isEmpty || due != nil else { throw TodoError.message("日期无效，请重新选择") }
            if !details.time.isEmpty {
                let parts = details.time.split(separator: ":")
                guard due != nil, parts.count == 2, parts.allSatisfy({ $0.count == 2 }), let hour = Int(parts[0]), let minute = Int(parts[1]), (0...23).contains(hour), (0...59).contains(minute) else { throw TodoError.message("请先设置日期，并选择有效时间") }
                due?.hour = hour; due?.minute = minute; due?.timeZone = calendar().timeZone
                guard let actual = due.flatMap({ calendar().date(from: $0) }), calendar().component(.hour, from: actual) == hour else { throw TodoError.message("此时间因夏令时调整不存在，请重新选择") }
            }
            if let editingID {
                guard let item = snapshot.columns.flatMap(\.items).first(where: { $0.id == editingID }), item.editable else { throw TodoError.message("事项已移除或不可编辑，请刷新") }
                try repository.update(id: editingID, title: title, due: due, listID: listID, details: details, preserveDue: date == item.date && details.time == item.time)
            } else { try repository.create(title: title, due: due, listID: listID, details: details) }
            snapshot.error = ""; refresh(); return true
        } catch { snapshot.error = error.localizedDescription; return false }
    }
    func complete(id: String, completed: Bool) {
        do {
            guard snapshot.enabled, repository.authorization == .allowed, snapshot.columns.flatMap(\.items).contains(where: { $0.id == id && $0.editable }) else { throw TodoError.message("事项不可编辑，请刷新") }
            try repository.complete(id: id, completed: completed)
            snapshot.error = ""; refresh()
        } catch { snapshot.error = error.localizedDescription }
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
        case "showCompleted": if let show = body["show"] as? Bool { store.setShowCompleted(show) }
        case "complete": if let id = body["id"] as? String, let completed = body["completed"] as? Bool { store.complete(id: id, completed: completed) }
        case "openSystem":
            let id = body["id"] as? String
            guard id == nil || store.snapshot.columns.contains(where: { $0.items.contains(where: { $0.id == id }) }) else { return }
            TodoNavigation.open(id)
        case "settings": if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders") { NSWorkspace.shared.open(url) }
        case "create", "update":
            guard let title = body["title"] as? String, let date = body["date"] as? String, let listID = body["listID"] as? String else { return }
            let bucket = (body["bucket"] as? String).flatMap(TodoBucket.init(rawValue:))
            let alarmText = body["alarm"] as? String ?? ""
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let alarm = formatter.date(from: alarmText) ?? ISO8601DateFormatter().date(from: alarmText)
            guard alarmText.isEmpty || alarm != nil else { return }
            let details = TodoDetails(notes: body["notes"] as? String ?? "", priority: body["priority"] as? Int ?? 0, alarm: alarm, time: body["time"] as? String ?? "", url: body["url"] as? String ?? "")
            if action == "update", body["id"] as? String == nil { return }
            let saved = store.create(title: title, date: date, listID: listID, bucket: action == "update" ? nil : bucket, details: details, editingID: action == "update" ? body["id"] as? String : nil)
            webView?.evaluateJavaScript("window.__boboTodoCreated?.(\(saved))")
        default: break
        }
    }
}

struct IslandTodoView: View {
    var snapshot: TodoSnapshot
    var onManage: () -> Void
    var onOpen: (String) -> Void
    var onCreate: (TodoDraft) -> Bool = { _ in false }
    var onCompose: (Bool) -> Void = { _ in }
    var onShowCompleted: (Bool) -> Void = { _ in }
    var onComplete: (String, Bool) -> Void = { _, _ in }
    @State private var draft: TodoDraft?
    @State private var quickTitle = ""
    @State private var bucket = TodoBucket.later
    @FocusState private var quickFocused: Bool

    private func begin(_ bucket: TodoBucket) {
        let listID = snapshot.lists.contains { $0.id == snapshot.defaultList } ? snapshot.defaultList : snapshot.lists.first?.id ?? ""
        draft = TodoDraft(title: quickTitle, bucket: bucket, listID: listID)
        quickFocused = false
        onCompose(true)
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: onManage) { HStack(spacing: 6) { TodoBoboMark(size: 20); Text("Todo").font(.system(size: 12, weight: .semibold)) } }
                    .help("打开 bobo Todo 看板").accessibilityIdentifier("island-todo-manage")
                Text("\(snapshot.count)").font(.system(size: 10)).foregroundStyle(.white.opacity(0.65))
                Spacer()
                Button { onShowCompleted(!snapshot.showCompleted) } label: { Image(systemName: snapshot.showCompleted ? "checkmark.circle.fill" : "checkmark.circle").font(.system(size: 13)) }.help(snapshot.showCompleted ? "隐藏已完成" : "显示已完成").accessibilityLabel(snapshot.showCompleted ? "隐藏已完成" : "显示已完成")
                Button(action: onManage) { Image(systemName: "arrow.up.right").font(.system(size: 11)) }.help("在 bobo 中展开看板")
            }.foregroundStyle(.white.opacity(0.7)).padding(.horizontal, 18).frame(height: 34)
            if snapshot.authorization != .allowed {
                Button("连接提醒事项，开始安排 →", action: onManage).foregroundStyle(.secondary)
                Spacer()
            } else {
                if !snapshot.error.isEmpty, draft == nil {
                    Text(snapshot.error).font(.system(size: 10)).foregroundStyle(.orange).lineLimit(1).padding(.horizontal, 18)
                }
                HStack(spacing: 8) {
                    ForEach(snapshot.columns) { column in
                        IslandTodoColumn(column: column, onOpen: onOpen, onComplete: onComplete, onAdd: { begin(column.bucket) })
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }.padding(.horizontal, 12)
                HStack(spacing: 8) {
                    Menu { ForEach(TodoBucket.allCases, id: \.self) { value in Button(value.title) { bucket = value } } } label: {
                        Text(bucket.title).font(.system(size: 10)).foregroundStyle(.white.opacity(0.75))
                    }.menuStyle(.borderlessButton).fixedSize().help("新增到哪一列")
                    TextField("", text: $quickTitle, prompt: Text("接下来要做什么？").foregroundColor(Color(white: 0.68))).textFieldStyle(.plain).font(.system(size: 12))
                        .focused($quickFocused).onSubmit { begin(bucket) }.accessibilityLabel("接下来要做什么？")
                    Button { begin(bucket) } label: { Image(systemName: "return").font(.system(size: 11)).frame(width: 26, height: 24).background(.white.opacity(0.05), in: Capsule()) }
                        .help("展开创建卡片").accessibilityLabel("展开创建任务")
                }
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Color(white: 0.14), in: Capsule()).overlay(Capsule().stroke(.white.opacity(0.12), lineWidth: 0.5))
                .padding(.horizontal, 48).padding(.vertical, 13)
            }
        }
        .allowsHitTesting(draft == nil)
        .accessibilityHidden(draft != nil)
        .overlay {
            if let draft {
                IslandTodoCreateCard(initial: draft, lists: snapshot.lists, error: snapshot.error, onCancel: { self.draft = nil; onCompose(false) }, onSave: { value in
                    if onCreate(value) { self.draft = nil; quickTitle = ""; onCompose(false) }
                })
                .id(draft.id).padding(10)
            }
        }
        .onChange(of: quickFocused) { focused in if draft == nil { onCompose(focused) } }
        .onDisappear { onCompose(false) }
        .buttonStyle(.plain).foregroundStyle(Color.white).environment(\.colorScheme, .dark).frame(height: snapshot.height)
        .background(Color(white: 0.055))
        .accessibilityElement(children: .contain).accessibilityLabel("Todo 看板，今日、近七、事务")
    }
}

private struct TodoBoboMark: View {
    var size: CGFloat
    var body: some View {
        Group {
            if let url = Bundle.main.url(forResource: "bobo-island-avatar-idle", withExtension: "png"), let image = NSImage(contentsOf: url) {
                Image(nsImage: image).resizable().scaledToFit()
            } else { Image(nsImage: NSImage(named: NSImage.applicationIconName)!).resizable().scaledToFit() }
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

private struct IslandTodoColumn: View {
    var column: TodoColumn
    var onOpen: (String) -> Void
    var onComplete: (String, Bool) -> Void
    var onAdd: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 5) {
                Circle().fill(column.bucket == .today ? Color.orange : column.bucket == .week ? Color.cyan : Color(white: 0.65)).frame(width: 5, height: 5)
                Text(column.title).font(.system(size: 12, weight: .semibold))
                Text("\(column.items.count)").font(.system(size: 10)).foregroundStyle(Color(white: 0.65))
                Spacer(minLength: 0)
                Button(action: onAdd) { Image(systemName: "plus").font(.system(size: 12)).frame(width: 24, height: 26) }
                    .foregroundStyle(Color(white: 0.8)).accessibilityLabel("新增到\(column.title)")
            }.padding(.horizontal, 10).frame(height: 34).background(Color(white: 0.13))
            if column.items.isEmpty {
                VStack(spacing: 8) { TodoBoboMark(size: 34); Text("暂无事项").font(.system(size: 10)) }
                    .foregroundStyle(Color(white: 0.65)).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView(.vertical) {
                    LazyVStack(spacing: 6) {
                        ForEach(column.items) { item in
                            HStack(alignment: .top, spacing: 7) {
                                Button { onComplete(item.id, !item.completed) } label: {
                                    Image(systemName: item.completed ? "checkmark.circle.fill" : "circle").font(.system(size: 14)).foregroundStyle(item.completed ? Color.green : Color(white: 0.65))
                                }.disabled(!item.editable).padding(.top, 2).accessibilityLabel("\(item.completed ? "标记未完成" : "完成")：\(item.title)")
                                Button { onOpen(item.id) } label: {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(item.title).font(.system(size: 11, weight: .medium)).foregroundStyle(Color(white: item.completed ? 0.65 : 0.95)).strikethrough(item.completed).lineLimit(3).multilineTextAlignment(.leading)
                                        Text(item.dateText).font(.system(size: 10)).foregroundStyle(item.overdue ? Color.orange : Color(white: 0.7))
                                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                }.help("\(item.title) · \(item.list)；在 bobo 中查看").accessibilityLabel("\(item.title)，\(item.dateText)，在 bobo 中查看")
                            }.padding(9).frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(white: 0.17), in: RoundedRectangle(cornerRadius: 9))
                                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.07), lineWidth: 0.5))
                        }
                    }.padding(6)
                }.accessibilityLabel("\(column.title)事项，可滚动")
            }
        }.background(Color(white: 0.095), in: RoundedRectangle(cornerRadius: 12))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.1), lineWidth: 0.5))
    }
}

private struct IslandTodoCreateCard: View {
    private enum Option { case date, alarm, organize, url }
    @State private var draft: TodoDraft
    @State private var dateEnabled: Bool
    @State private var timeEnabled = false
    @State private var dueDate: Date
    @State private var alarmEnabled = false
    @State private var alarmDate = Date().addingTimeInterval(3600)
    @State private var option: Option?
    @FocusState private var titleFocused: Bool
    var lists: [TodoList]
    var error: String
    var onCancel: () -> Void
    var onSave: (TodoDraft) -> Void
    init(initial: TodoDraft, lists: [TodoList], error: String, onCancel: @escaping () -> Void, onSave: @escaping (TodoDraft) -> Void) {
        _draft = State(initialValue: initial)
        _dateEnabled = State(initialValue: initial.bucket != .later)
        _dueDate = State(initialValue: Calendar.current.date(byAdding: .day, value: initial.bucket == .week ? 1 : 0, to: Date())!)
        self.lists = lists; self.error = error; self.onCancel = onCancel; self.onSave = onSave
    }
    private func field(_ label: String, _ value: Binding<String>, title: Bool = false) -> some View {
        TextField("", text: value, prompt: Text(label).foregroundColor(Color(white: 0.68)), axis: .vertical)
            .font(.system(size: title ? 17 : 12, weight: title ? .medium : .regular)).lineLimit(title ? 1...2 : 2...3)
            .textFieldStyle(.plain).foregroundStyle(Color(white: 0.97)).padding(.vertical, 4).accessibilityLabel(label)
    }
    private func tool(_ value: Option, _ icon: String, _ label: String, active: Bool = false) -> some View {
        Button { option = option == value ? nil : value } label: {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 13))
                if value == .date && dateEnabled { Text(dueDate, format: .dateTime.month().day()).font(.system(size: 10)) }
            }.padding(.horizontal, 10).frame(height: 32)
                .foregroundStyle(active ? Color(red: 0.35, green: 0.7, blue: 1) : Color(white: 0.85))
                .background(active ? Color.blue.opacity(0.2) : Color(white: 0.23), in: Capsule())
                .overlay(Capsule().stroke(Color.white.opacity(option == value ? 0.4 : 0), lineWidth: 0.5))
        }.help(label).accessibilityLabel(label).accessibilityValue(option == value ? "已展开" : "已收起")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                TodoBoboMark(size: 24)
                Spacer()
                Button(action: onCancel) { Image(systemName: "xmark").font(.system(size: 12)).frame(width: 26, height: 26).background(Color(white: 0.24), in: Circle()) }.accessibilityLabel("取消创建")
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        field("接下来要做什么？", $draft.title, title: true).focused($titleFocused).accessibilityLabel("任务标题")
                        field("备注", $draft.details.notes)
                    }.padding(.horizontal, 4)
                    if option == .date {
                        VStack(spacing: 10) {
                            HStack { Text("日期"); Spacer(); if dateEnabled { DatePicker("日期", selection: $dueDate, displayedComponents: .date).labelsHidden() }; Toggle("日期", isOn: $dateEnabled).labelsHidden().toggleStyle(.switch) }
                            Divider()
                            HStack { Text("时间").foregroundStyle(Color(white: dateEnabled ? 0.95 : 0.65)); Spacer(); if dateEnabled && timeEnabled { DatePicker("时间", selection: $dueDate, displayedComponents: .hourAndMinute).labelsHidden() }; Toggle("时间", isOn: $timeEnabled).labelsHidden().toggleStyle(.switch).disabled(!dateEnabled) }
                        }.padding(12).background(Color(white: 0.18), in: RoundedRectangle(cornerRadius: 12))
                    }
                    if option == .alarm {
                        HStack { Text("提醒我"); Spacer(); if alarmEnabled { DatePicker("提醒时间", selection: $alarmDate).labelsHidden() }; Toggle("提醒我", isOn: $alarmEnabled).labelsHidden().toggleStyle(.switch) }
                            .padding(12).background(Color(white: 0.18), in: RoundedRectangle(cornerRadius: 12))
                    }
                    if option == .organize {
                        VStack(spacing: 10) {
                            HStack { Text("列表"); Spacer(); Picker("列表", selection: $draft.listID) { ForEach(lists) { Text($0.title).tag($0.id) } }.labelsHidden().pickerStyle(.menu).buttonStyle(.bordered).frame(maxWidth: 240) }
                            Divider()
                            HStack { Text("优先级"); Spacer(); Picker("优先级", selection: $draft.details.priority) { Text("无").tag(0); Text("低").tag(9); Text("中").tag(5); Text("高").tag(1) }.labelsHidden().pickerStyle(.menu).buttonStyle(.bordered).frame(maxWidth: 240) }
                        }.padding(12).background(Color(white: 0.18), in: RoundedRectangle(cornerRadius: 12))
                    }
                    if option == .url {
                        field("URL", $draft.details.url).padding(12).background(Color(white: 0.18), in: RoundedRectangle(cornerRadius: 12))
                    }
                    if !error.isEmpty { Text(error).font(.system(size: 11)).foregroundStyle(.orange) }
                    if lists.isEmpty { Text("没有可写列表，请在提醒事项中先创建列表。").font(.system(size: 11)).foregroundStyle(.orange) }
                }.font(.system(size: 11)).padding(.trailing, 4)
            }
            HStack {
                HStack(spacing: 6) {
                    tool(.date, "calendar", "日期与时间", active: dateEnabled)
                    tool(.alarm, "bell", "提醒时间", active: alarmEnabled)
                    tool(.organize, "list.bullet", "列表与优先级", active: draft.details.priority > 0)
                    tool(.url, "link", "URL", active: !draft.details.url.isEmpty)
                }
                Spacer()
                Button(action: save) { Text("创建").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.white).padding(.horizontal, 20).padding(.vertical, 8).background(Color(red: 0.05, green: 0.45, blue: 0.95), in: Capsule()) }
                    .disabled(draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || lists.isEmpty).accessibilityIdentifier("island-todo-create")
            }
        }.padding(16).background(Color(white: 0.11), in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.25), lineWidth: 0.5))
            .task { await Task.yield(); titleFocused = true }.onExitCommand(perform: onCancel)
    }
    private func save() {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        draft.date = dateEnabled ? formatter.string(from: dueDate) : ""
        // 无日期时明确保持在事务，避免默认列重新补回日期。
        if !dateEnabled { draft.bucket = .later }
        formatter.dateFormat = "HH:mm"
        draft.details.time = dateEnabled && timeEnabled ? formatter.string(from: dueDate) : ""
        draft.details.alarm = alarmEnabled ? alarmDate : nil
        onSave(draft)
    }
}
