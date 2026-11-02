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

struct TodoFocusSettings: Codable, Equatable {
    var minutes = 25
    var notify = true
    var breakMinutes = 5
    var systemNotify = true
    var sound = true
    var hasReminder: Bool { notify || systemNotify || sound }
    var valid: Bool { (1...180).contains(minutes) && (1...60).contains(breakMinutes) }
    private enum CodingKeys: String, CodingKey { case minutes, notify, breakMinutes, systemNotify, sound }
    init(minutes: Int = 25, notify: Bool = true, breakMinutes: Int = 5, systemNotify: Bool? = nil, sound: Bool? = nil) {
        self.minutes = minutes; self.notify = notify; self.breakMinutes = breakMinutes
        self.systemNotify = systemNotify ?? notify; self.sound = sound ?? notify
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        minutes = try values.decodeIfPresent(Int.self, forKey: .minutes) ?? 25
        notify = try values.decodeIfPresent(Bool.self, forKey: .notify) ?? true
        breakMinutes = try values.decodeIfPresent(Int.self, forKey: .breakMinutes) ?? 5
        // 旧版关闭结束提醒时，迁移后仍保持全部静默。
        systemNotify = try values.decodeIfPresent(Bool.self, forKey: .systemNotify) ?? notify
        sound = try values.decodeIfPresent(Bool.self, forKey: .sound) ?? notify
    }
    static func parse(_ value: [String: Any]) -> TodoFocusSettings? {
        func integer(_ key: String, range: ClosedRange<Double>) -> Int? {
            guard let number = value[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, range.contains(number.doubleValue), number.doubleValue.rounded() == number.doubleValue else { return nil }
            return number.intValue
        }
        func boolean(_ key: String) -> Bool? {
            guard let number = value[key] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
            return number.boolValue
        }
        guard Set(value.keys) == ["minutes", "notify", "breakMinutes", "systemNotify", "sound"],
              let minutes = integer("minutes", range: 1...180), let rest = integer("breakMinutes", range: 1...60),
              let notify = boolean("notify"), let systemNotify = boolean("systemNotify"), let sound = boolean("sound") else { return nil }
        return TodoFocusSettings(minutes: minutes, notify: notify, breakMinutes: rest, systemNotify: systemNotify, sound: sound)
    }
}

// 使用绝对截止时间；暂停保存剩余秒数，只有这块局部视图逐秒刷新。
struct TodoFocusSession: Codable, Equatable, Identifiable {
    var startedAt: TimeInterval
    var endsAt: TimeInterval
    var id = UUID().uuidString
    var phase = "focus"
    var pausedRemaining: TimeInterval?
    var isPaused: Bool { pausedRemaining != nil }
    var isRest: Bool { phase == "rest" }
    var isReady: Bool { phase == "ready" }
    var title: String { isReady ? "待开始" : (isRest ? "休息" : "专注") }
    var symbol: String { isRest ? "☕️" : "🍅" }
    var valid: Bool {
        startedAt.isFinite && endsAt.isFinite && (isReady ? endsAt == startedAt && pausedRemaining == nil : endsAt > startedAt) && endsAt - startedAt <= 180 * 60 &&
        !id.isEmpty && id.utf8.count <= 128 && ["focus", "rest", "ready"].contains(phase) &&
        (pausedRemaining.map { $0.isFinite && $0 > 0 && $0 <= 180 * 60 } ?? true)
    }
    private enum CodingKeys: String, CodingKey { case startedAt, endsAt, id, phase, pausedRemaining }
    init(startedAt: TimeInterval, endsAt: TimeInterval, id: String = UUID().uuidString, phase: String = "focus", pausedRemaining: TimeInterval? = nil) {
        self.startedAt = startedAt; self.endsAt = endsAt; self.id = id; self.phase = phase; self.pausedRemaining = pausedRemaining
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        startedAt = try values.decode(TimeInterval.self, forKey: .startedAt)
        endsAt = try values.decode(TimeInterval.self, forKey: .endsAt)
        id = try values.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        phase = try values.decodeIfPresent(String.self, forKey: .phase) ?? "focus"
        pausedRemaining = try values.decodeIfPresent(TimeInterval.self, forKey: .pausedRemaining)
    }
    func remaining(at date: Date) -> Int { Int(ceil(min(180 * 60, max(0, pausedRemaining ?? (endsAt - date.timeIntervalSince1970))))) }
    func label(at date: Date) -> String { let seconds = remaining(at: date); return String(format: "%02d:%02d", seconds / 60, seconds % 60) }
}

// 会话和完成数放在同一份偏好记录，崩溃后不会重复结算一轮。
private struct TodoFocusState: Codable {
    var focus: TodoFocusSession?
    var completed = 0
    var days: [String: Int] = [:]
    var valid: Bool { (focus?.valid ?? true) && completed >= 0 && days.values.allSatisfy { $0 >= 0 && $0 <= completed } }
}

struct TodoSnapshot: Equatable, Encodable {
    var enabled = false
    var authorization = TodoAuthorization.notDetermined
    var loading = false
    var error = ""
    var lists: [TodoList] = []
    var defaultList = ""
    var showCompleted = false
    var focusSettings = TodoFocusSettings()
    var focus: TodoFocusSession?
    var focusError = ""
    var focusCompleted = 0
    var focusCompletedToday = 0
    var columns = TodoBucket.allCases.map { TodoColumn(bucket: $0, items: []) }
    var count: Int { columns.reduce(0) { $0 + $1.items.count } }
    var height: CGFloat {
        guard enabled else { return 0 }
        guard authorization == .allowed else { return 80 }
        return 216
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

struct TodoDraft: Identifiable, Equatable {
    let id = UUID()
    var title = ""
    var bucket = TodoBucket.today
    var date = ""
    var listID = ""
    var details = TodoDetails()
    var isEmpty: Bool { [title, details.notes, details.url].allSatisfy { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }
    static func editing(_ item: TodoItem, bucket: TodoBucket) -> TodoDraft {
        let details = TodoDetails(notes: item.notes, priority: item.priority, alarm: ISO8601DateFormatter().date(from: item.alarm), time: item.time, url: item.url)
        return TodoDraft(title: item.title, bucket: bucket, date: item.date, listID: item.listID, details: details)
    }
}

private struct IslandTodoEdit {
    var itemID: String
    var original: TodoDraft
    var draft: TodoDraft
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
    func remove(id: String) throws
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
    func remove(id: String) throws {
        guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder, reminder.calendar.allowsContentModifications else { throw TodoError.message("事项已移除或不可编辑，请刷新") }
        try store.remove(reminder, commit: true)
    }
}

enum TodoError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let message): return message } }
}

@MainActor final class TodoStore: ObservableObject {
    @Published private(set) var snapshot = TodoSnapshot()
    // 专注与休息自然到点各派发一次；手动结束、暂停、等待开始不派发。
    var onFocusFinished: ((TodoFocusSession) -> Void)?
    private let repository: any TodoRepository
    private let defaults: UserDefaults
    private let now: () -> Date
    private let calendar: () -> Calendar
    private var generation = 0
    private var pendingRefresh = false
    private var requesting = false
    private var observers: [NSObjectProtocol] = []
    private var focusTimer: Timer?
    private var focusState = TodoFocusState()

    init(repository: any TodoRepository, defaults: UserDefaults, now: @escaping () -> Date = Date.init, calendar: @escaping () -> Calendar = { .current }, observeSystem: Bool = true) {
        self.repository = repository; self.defaults = defaults; self.now = now; self.calendar = calendar
        snapshot.enabled = defaults.bool(forKey: "todoEnabled")
        snapshot.showCompleted = defaults.bool(forKey: "todoShowCompleted")
        if let data = defaults.data(forKey: "todoFocusSettings"), let settings = try? JSONDecoder().decode(TodoFocusSettings.self, from: data), settings.valid { snapshot.focusSettings = settings }
        if let data = defaults.data(forKey: "todoFocusState"), let state = try? JSONDecoder().decode(TodoFocusState.self, from: data), state.valid {
            focusState = state
        } else if let data = defaults.data(forKey: "todoFocusSession"), let focus = try? JSONDecoder().decode(TodoFocusSession.self, from: data), focus.valid {
            focusState.focus = focus
        }
        snapshot.focus = focusState.focus
        updateFocusCounts()
        persistFocus()
        snapshot.authorization = repository.authorization
        repository.onChange = { [weak self] in self?.refresh() }
        if observeSystem {
            for name in [Notification.Name.NSCalendarDayChanged, .NSSystemTimeZoneDidChange] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.refresh() } })
            }
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.refresh() } })
        }
        finishFocusIfNeeded()
        scheduleFocusDeadline()
    }
    deinit {
        focusTimer?.invalidate()
        for observer in observers { NotificationCenter.default.removeObserver(observer); NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    }
    @discardableResult func saveFocusSettings(_ value: [String: Any]) -> Bool {
        guard let settings = TodoFocusSettings.parse(value) else { snapshot.focusError = "专注时长应为 1–180 分钟，休息时长应为 1–60 分钟，提醒开关应为布尔值"; return false }
        snapshot.focusError = ""
        snapshot.focusSettings = settings
        defaults.set(try? JSONEncoder().encode(settings), forKey: "todoFocusSettings")
        return true
    }
    @discardableResult func saveFocusSettings(_ settings: TodoFocusSettings) -> Bool {
        saveFocusSettings(["minutes": settings.minutes, "notify": settings.notify, "breakMinutes": settings.breakMinutes, "systemNotify": settings.systemNotify, "sound": settings.sound])
    }
    func toggleFocus() {
        finishFocusIfNeeded()
        guard var focus = snapshot.focus else { beginFocusPhase("focus"); return }
        if focus.isReady { beginFocusPhase("focus"); return }
        let instant = now().timeIntervalSince1970
        if let remaining = focus.pausedRemaining {
            focus.pausedRemaining = nil
            // 保留本轮时长，暂停期间的墙钟时间不算入倒计时。
            let duration = focus.endsAt - focus.startedAt
            focus.endsAt = instant + remaining; focus.startedAt = focus.endsAt - duration
        } else { focus.pausedRemaining = max(0.001, focus.endsAt - instant) }
        setFocus(focus)
    }
    func stopFocus() { if snapshot.focus != nil { setFocus(nil) } }
    func finishFocusIfNeeded() {
        updateFocusCounts()
        guard let focus = snapshot.focus, !focus.isReady, !focus.isPaused, focus.remaining(at: now()) == 0 else { return }
        if !focus.isRest {
            if focusState.completed < Int.max { focusState.completed += 1 }
            let day = focusDay(Date(timeIntervalSince1970: focus.endsAt))
            let previous = focusState.days[day, default: 0]
            if previous < Int.max { focusState.days[day] = previous + 1 }
        }
        // 晚唤醒只结算眼前这一轮，下一阶段从现在开始，不凭空补出完成数。
        beginFocusPhase(focus.isRest ? "ready" : "rest")
        if snapshot.focusSettings.hasReminder { onFocusFinished?(focus) }
    }
    private func beginFocusPhase(_ phase: String) {
        let start = now().timeIntervalSince1970
        let settings = snapshot.focusSettings
        let seconds = phase == "ready" ? 0 : (phase == "rest" ? settings.breakMinutes : settings.minutes) * 60
        setFocus(TodoFocusSession(startedAt: start, endsAt: start + Double(seconds), phase: phase))
    }
    private func setFocus(_ focus: TodoFocusSession?) {
        focusState.focus = focus
        persistFocus()
        var next = snapshot
        next.focus = focus; next.focusError = ""
        next.focusCompleted = focusState.completed; next.focusCompletedToday = focusState.days[focusDay(now()), default: 0]
        snapshot = next
        scheduleFocusDeadline()
    }
    private func focusDay(_ date: Date) -> String {
        let components = calendar().dateComponents([.era, .year, .month, .day], from: date)
        return "\(components.era ?? 0)-\(components.year ?? 0)-\(components.month ?? 0)-\(components.day ?? 0)"
    }
    private func updateFocusCounts() {
        let today = focusState.days[focusDay(now()), default: 0]
        if snapshot.focusCompleted != focusState.completed { snapshot.focusCompleted = focusState.completed }
        if snapshot.focusCompletedToday != today { snapshot.focusCompletedToday = today }
    }
    private func persistFocus() {
        defaults.set(try? JSONEncoder().encode(focusState), forKey: "todoFocusState")
        defaults.removeObject(forKey: "todoFocusSession")
    }
    private func scheduleFocusDeadline() {
        focusTimer?.invalidate(); focusTimer = nil
        guard let focus = snapshot.focus, !focus.isReady, !focus.isPaused else { return }
        let timer = Timer(timeInterval: max(0.05, focus.endsAt - now().timeIntervalSince1970), repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in self?.finishFocusIfNeeded(); self?.scheduleFocusDeadline() }
        }
        focusTimer = timer
        RunLoop.main.add(timer, forMode: .common)
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
        finishFocusIfNeeded()
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
            let targetListID = listID.isEmpty ? snapshot.defaultList : listID
            guard snapshot.lists.contains(where: { $0.id == targetListID }) else { throw TodoError.message("请选择可写的提醒事项列表") }
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
                try repository.update(id: editingID, title: title, due: due, listID: targetListID, details: details, preserveDue: date == item.date && details.time == item.time)
            } else { try repository.create(title: title, due: due, listID: targetListID, details: details) }
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
    func remove(id: String) -> Bool {
        do {
            guard snapshot.enabled, repository.authorization == .allowed, snapshot.columns.flatMap(\.items).contains(where: { $0.id == id && $0.editable }) else { throw TodoError.message("事项不可删除，请刷新") }
            try repository.remove(id: id)
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
    private let onOpenTobo: () -> Void
    private var subscription: AnyCancellable?
    init(webView: WKWebView, store: TodoStore, onOpenTobo: @escaping () -> Void = {}) {
        self.webView = webView; self.store = store; self.onOpenTobo = onOpenTobo
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
        case "focusToggle": store.toggleFocus(); publish(store.snapshot)
        case "focusStop": store.stopFocus(); publish(store.snapshot)
        case "focusSettings":
            _ = store.saveFocusSettings(body.filter { $0.key != "action" })
            publish(store.snapshot)
        case "connect": Task { await store.connect(); publish(store.snapshot) }
        case "enabled": if let enabled = body["enabled"] as? Bool { store.setEnabled(enabled) }
        case "showCompleted": if let show = body["show"] as? Bool { store.setShowCompleted(show) }
        case "complete": if let id = body["id"] as? String, let completed = body["completed"] as? Bool { store.complete(id: id, completed: completed) }
        case "openTobo": onOpenTobo()
        case "remove":
            guard let id = body["id"] as? String else { return }
            let saved = store.remove(id: id)
            webView?.evaluateJavaScript("window.__boboTodoCreated?.(\(saved))")
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

@MainActor final class TodoInputMonitor {
    weak var view: NSView?
    var dismiss: (() -> Void)?
    func contains(_ point: NSPoint) -> Bool {
        guard let view, let window = view.window else { return false }
        return window.convertToScreen(view.convert(view.bounds, to: nil)).contains(point)
    }
}

private struct TodoInputRegion: NSViewRepresentable {
    var monitor: TodoInputMonitor?
    private final class InputView: NSView { override func hitTest(_ point: NSPoint) -> NSView? { nil } }
    func makeNSView(context: Context) -> NSView { let view = InputView(); monitor?.view = view; return view }
    func updateNSView(_ nsView: NSView, context: Context) { monitor?.view = nsView }
}

struct TodoSwipeMotion {
    static let width: CGFloat = 68
    private(set) var translation = CGSize.zero
    private(set) var horizontal: Bool?
    mutating func update(x: CGFloat, y: CGFloat) {
        translation.width += x; translation.height += y
        if horizontal == nil && max(abs(translation.width), abs(translation.height)) >= 6 {
            horizontal = abs(translation.width) > abs(translation.height) * 1.3
        }
    }
    func offset(revealed: Bool) -> CGFloat { min(0, max(-Self.width, (revealed ? -Self.width : 0) + translation.width)) }
}

// SwiftUI 的 ScrollView 不提供 macOS 横滑操作；只接管锁定为横向的滚轮事件，纵向继续交给列表。
private struct TodoSwipeRegion: NSViewRepresentable {
    var enabled: Bool
    var onChange: (TodoSwipeMotion) -> Void
    var onEnd: (Bool) -> Void
    final class SwipeView: NSView {
        var enabled = true
        var onChange: (TodoSwipeMotion) -> Void = { _ in }
        var onEnd: (Bool) -> Void = { _ in }
        private var monitor: Any?
        private var motion = TodoSwipeMotion()
        private var tracking = false
        private var suppressMomentum = false
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow(); stop()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                guard let self else { return event }; return self.scroll(event)
            }
        }
        func stop() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil; tracking = false }
        private func scroll(_ event: NSEvent) -> NSEvent? {
            guard enabled, event.window === window else { return event }
            if !event.momentumPhase.isEmpty { return suppressMomentum ? nil : event }
            let discrete = event.phase.isEmpty
            if event.phase.contains(.began) || discrete {
                tracking = bounds.contains(convert(event.locationInWindow, from: nil))
                motion = TodoSwipeMotion(); suppressMomentum = false
            }
            guard tracking else { return event }
            motion.update(x: event.scrollingDeltaX, y: event.scrollingDeltaY)
            let horizontal = motion.horizontal == true
            if horizontal { onChange(motion) }
            if discrete || event.phase.contains(.ended) || event.phase.contains(.cancelled) {
                tracking = false; suppressMomentum = horizontal
                if horizontal { onEnd(event.phase.contains(.cancelled)) }
            }
            return horizontal ? nil : event
        }
    }
    func makeNSView(context: Context) -> SwipeView { let view = SwipeView(); updateNSView(view, context: context); return view }
    func updateNSView(_ view: SwipeView, context: Context) { view.enabled = enabled; view.onChange = onChange; view.onEnd = onEnd }
    static func dismantleNSView(_ view: SwipeView, coordinator: ()) { view.stop() }
}

private struct IslandTodoSwipeRow<Content: View>: View {
    @Binding var revealed: Bool
    var enabled: Bool
    var title: String
    var onDelete: () -> Void
    @ViewBuilder var content: Content
    @State private var offset: CGFloat?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var position: CGFloat { offset ?? (revealed ? -TodoSwipeMotion.width : 0) }
    private func settle(_ cancelled: Bool) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
            if !cancelled { revealed = position < -TodoSwipeMotion.width * 0.4 }
            offset = nil
        }
    }
    var body: some View {
        ZStack(alignment: .trailing) {
            Button(action: onDelete) {
                VStack(spacing: 3) {
                    Image(systemName: "trash").font(.system(size: 13)).foregroundStyle(Color.white)
                        .frame(width: 56, height: 28).background(Color(red: 1, green: 0.23, blue: 0.25), in: Capsule())
                    Text("删除").font(.system(size: 10)).foregroundStyle(Color(white: 0.65))
                }.frame(width: TodoSwipeMotion.width)
            }.buttonStyle(.plain).accessibilityLabel("删除：\(title)")
                .opacity(min(1, -position / TodoSwipeMotion.width)).allowsHitTesting(revealed && offset == nil)
                .accessibilityHidden(!revealed)
            content.frame(minHeight: 50).background(Color(white: 0.14), in: RoundedRectangle(cornerRadius: 8))
                .allowsHitTesting(!revealed)
                .overlay { if revealed { Color.clear.contentShape(Rectangle()).onTapGesture { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { revealed = false } } } }
                .offset(x: position)
        }.clipped()
            .background(TodoSwipeRegion(enabled: enabled, onChange: { motion in
                offset = motion.offset(revealed: revealed)
            }, onEnd: settle))
            .accessibilityElement(children: .contain)
            .accessibilityAction(named: Text(revealed ? "收起删除" : "显示删除")) { if enabled { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { revealed.toggle() } } }
            .onChange(of: enabled) { value in if !value { revealed = false; offset = nil } }
    }
}

// 到点提示在原输入胶囊内切换，不额外插入状态行或改变看板高度。
struct TodoFocusPrompt: View {
    var ready: Bool
    var onToggle: () -> Void = {}
    var onStop: () -> Void = {}
    var onAction: () -> Void
    var body: some View {
        HStack(spacing: 9) {
            TodoFocusControl(running: true, onToggle: onToggle, onStop: onStop) { progress in
                Text("🍅").font(.system(size: 18)).frame(width: 25, height: 26)
                    .overlay { TodoFocusHoldRing(progress: progress) }
            }.accessibilityLabel(ready ? "开始下一轮番茄专注，长按结束" : "暂停或继续休息，长按结束")
            Text(ready ? "继续专注" : "喝口水").font(.system(size: 12, weight: .medium))
            Button(action: onAction) {
                Image(systemName: ready ? "play.circle.fill" : "checkmark.circle.fill")
                    .font(.system(size: 21)).foregroundStyle(ready ? Color.orange : Color.green)
                    .frame(width: 26, height: 26)
            }.buttonStyle(.plain)
                .accessibilityLabel(ready ? "开始下一轮番茄专注" : "知道了，继续休息")
                .help(ready ? "点击后开始下一轮" : "收起提示，休息计时继续")
        }.padding(.horizontal, 14).padding(.vertical, 5).foregroundStyle(.white)
    }
}

struct IslandTodoView: View {
    var snapshot: TodoSnapshot
    var onManage: () -> Void
    var onOpen: (String) -> Void
    var onCreate: (TodoDraft) -> Bool = { _ in false }
    var onUpdate: (String, TodoDraft) -> Bool = { _, _ in false }
    var onDelete: (String) -> Bool = { _ in false }
    var onCompose: (Bool) -> Void = { _ in }
    var onShowCompleted: (Bool) -> Void = { _ in }
    var onComplete: (String, Bool) -> Void = { _, _ in }
    var onFocus: () -> Void = {}
    var onFocusStop: () -> Void = {}
    var onFocusSettings: () -> Void = {}
    var onFocusSettingsChange: (TodoFocusSettings) -> Void = { _ in }
    var active = true
    var inputMonitor: TodoInputMonitor?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft: TodoDraft?
    @State private var composerOpen = false
    @State private var editing: IslandTodoEdit?
    @State private var swipedItem: String?
    @State private var restPromptID: String?
    private var showsFocusPrompt: Bool {
        !composerOpen && editing == nil && (snapshot.focus?.isReady == true || (restPromptID != nil && restPromptID == snapshot.focus?.id))
    }

    private func begin(_ bucket: TodoBucket) {
        guard finishEdit(save: true) else { return }
        swipedItem = nil
        draft = TodoDraft(bucket: bucket); composerOpen = true
        onCompose(true)
    }
    private func finish() { draft = nil; composerOpen = false; onCompose(editing != nil) }
    private func hideComposer() {
        if draft?.isEmpty == true { draft = nil }
        composerOpen = false; onCompose(editing != nil)
    }
    private func resumeComposer() {
        guard finishEdit(save: true) else { return }
        swipedItem = nil
        if draft == nil { draft = TodoDraft() }
        composerOpen = true; onCompose(true)
    }
    private func dismissInput() { if composerOpen { hideComposer() }; finishEdit(save: true) }
    private func beginEdit(_ item: TodoItem, bucket: TodoBucket) {
        guard item.editable else { onOpen(item.id); return }
        guard editing?.itemID != item.id, finishEdit(save: true) else { return }
        swipedItem = nil
        if composerOpen { hideComposer() }
        let value = TodoDraft.editing(item, bucket: bucket)
        editing = IslandTodoEdit(itemID: item.id, original: value, draft: value)
        onCompose(true)
    }
    @discardableResult private func finishEdit(save: Bool) -> Bool {
        guard let value = editing else { return true }
        if save && value.draft != value.original {
            let saved = value.draft.isEmpty ? onDelete(value.itemID) : onUpdate(value.itemID, value.draft)
            if !saved { return false }
        }
        editing = nil; onCompose(composerOpen)
        return true
    }
    private func saveEdit(_ value: TodoDraft) { guard editing?.draft.id == value.id else { return }; editing?.draft = value; finishEdit(save: true) }
    var body: some View {
        VStack(spacing: 0) {
            if snapshot.authorization != .allowed {
                Button("连接提醒事项，开始安排 →", action: onManage).foregroundStyle(.secondary)
                Spacer()
            } else {
                if !snapshot.error.isEmpty, !composerOpen {
                    Text(snapshot.error).font(.system(size: 10)).foregroundStyle(.orange).lineLimit(1).padding(.horizontal, 18)
                }
                HStack(spacing: 0) {
                    ForEach(snapshot.columns) { column in
                        IslandTodoColumn(column: column, editing: editing, error: snapshot.error, lists: snapshot.lists, inputMonitor: inputMonitor, swipedItem: $swipedItem,
                            onEdit: { beginEdit($0, bucket: column.bucket) }, onEditChange: { if editing?.draft.id == $0.id { editing?.draft = $0 } },
                            onSaveEdit: saveEdit, onCancelEdit: { finishEdit(save: false) }, onComplete: { id, completed in
                                let removing = editing?.itemID == id && editing?.draft.isEmpty == true
                                if (editing?.itemID != id || finishEdit(save: true)) && !removing { onComplete(id, completed) }
                            }, onDelete: { id in if finishEdit(save: true) && onDelete(id) { swipedItem = nil } }, onAdd: { begin(column.bucket) })
                            .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
                            .overlay(alignment: .leading) {
                                if column.bucket != .today { Rectangle().fill(.white.opacity(0.07)).frame(width: 0.5).padding(.vertical, 8) }
                            }
                    }
                }.padding(.horizontal, 8).padding(.bottom, 16)
            }
        }
        .overlay(alignment: .bottom) {
            if snapshot.authorization == .allowed {
                HStack(alignment: .bottom, spacing: 8) {
                    if !composerOpen && !showsFocusPrompt { focusButton }
                    VStack(spacing: 0) {
                        if composerOpen, let draft {
                            IslandTodoCreateCard(initial: draft, lists: snapshot.lists, error: snapshot.error, inputMonitor: inputMonitor, onManage: onManage, showCompleted: snapshot.showCompleted, onShowCompleted: { onShowCompleted(!snapshot.showCompleted) }, onDraftChange: { if draft.id == $0.id { self.draft = $0 } }, onCancel: hideComposer, onSave: { value in
                                if onCreate(value) { finish() }
                            }).id(draft.id).fixedSize(horizontal: false, vertical: true)
                                .transaction { $0.animation = nil }
                                .transition(.opacity)
                        } else if showsFocusPrompt {
                            TodoFocusPrompt(ready: snapshot.focus?.isReady == true, onToggle: onFocus, onStop: onFocusStop) {
                                if snapshot.focus?.isReady == true { onFocus() } else { restPromptID = nil }
                            }.contextMenu {
                                TodoFocusMenu(settings: snapshot.focusSettings, onChange: onFocusSettingsChange, onSettings: onFocusSettings, focus: snapshot.focus, onToggle: onFocus, onStop: onFocusStop)
                            }.transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.94)))
                        } else {
                            quickInput.transition(.opacity)
                        }
                    }
                    .frame(maxWidth: composerOpen ? 360 : (showsFocusPrompt ? nil : 128))
                    .fixedSize(horizontal: showsFocusPrompt, vertical: false)
                    .background(Color(white: 0.12).opacity(composerOpen ? 0.85 : 0), in: RoundedRectangle(cornerRadius: 26))
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26))
                    .overlay(RoundedRectangle(cornerRadius: 26).stroke(.white.opacity(0.14), lineWidth: 0.5))
                    .clipShape(RoundedRectangle(cornerRadius: 26))
                    .shadow(color: .black.opacity(0.2), radius: 10, y: 3)
                    if !composerOpen && !showsFocusPrompt { Color.clear.frame(width: 34, height: 34).allowsHitTesting(false) }
                }
                .frame(maxWidth: composerOpen ? 360 : (showsFocusPrompt ? nil : 212))
                .padding(.horizontal, 32).padding(.vertical, 18)
                .animation(reduceMotion ? nil : .timingCurve(0.2, 0.8, 0.2, 1, duration: 0.18), value: composerOpen)
                .animation(reduceMotion ? nil : .timingCurve(0.2, 0.8, 0.2, 1, duration: 0.22), value: showsFocusPrompt)
            }
        }
        .onChange(of: active) { value in
            if !value { dismissInput(); swipedItem = nil }
            else if composerOpen || editing != nil { onCompose(true) }
        }
        .onChange(of: snapshot.columns) { columns in
            if let editing, !columns.contains(where: { $0.items.contains(where: { $0.id == editing.itemID }) }) { finishEdit(save: false) }
            if let swipedItem, !columns.contains(where: { $0.items.contains(where: { $0.id == swipedItem }) }) { self.swipedItem = nil }
        }
        .onAppear { inputMonitor?.dismiss = dismissInput }
        .task(id: snapshot.focus?.id) {
            restPromptID = nil
            guard let focus = snapshot.focus, focus.isRest, snapshot.focusSettings.notify else { return }
            let remaining = focus.startedAt + 6 - Date().timeIntervalSince1970
            guard remaining > 0 else { return }
            restPromptID = focus.id
            try? await Task.sleep(nanoseconds: UInt64(min(6, remaining) * 1_000_000_000))
            guard !Task.isCancelled, restPromptID == focus.id else { return }
            restPromptID = nil
        }
        .onDisappear { inputMonitor?.dismiss = nil; onCompose(false) }
        .buttonStyle(.plain).foregroundStyle(Color.white).environment(\.colorScheme, .dark)
        .padding(.top, 8)
        .background(Color(white: 0.14), in: RoundedRectangle(cornerRadius: 18))
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(height: snapshot.height)
        .accessibilityElement(children: .contain).accessibilityLabel("tobo 看板，今日、近七、事务")
    }
    private var focusButton: some View {
        let focus = snapshot.focus
        return TodoFocusControl(running: focus != nil, onToggle: onFocus, onStop: onFocusStop) { progress in
            Text(focus?.symbol ?? "🍅").font(.system(size: 18)).frame(width: 34, height: 34)
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().stroke(focus == nil ? .white.opacity(0.14) : (focus!.isRest ? Color.green : Color.red).opacity(0.7), lineWidth: focus == nil ? 0.5 : 1))
                .overlay { TodoFocusHoldRing(progress: progress).padding(1) }
                .overlay(alignment: .bottomTrailing) {
                    if focus?.isPaused == true { Image(systemName: "pause.fill").font(.system(size: 7, weight: .bold)).padding(3).background(.black, in: Circle()) }
                }
        }
        .help(focus == nil ? "开始 \(snapshot.focusSettings.minutes) 分钟番茄专注" : (focus!.isReady ? "开始下一轮番茄专注，长按结束" : "单击\(focus!.isPaused ? "继续" : "暂停")\(focus!.title)，长按结束"))
        .accessibilityLabel(focus == nil ? "开始番茄专注" : (focus!.isReady ? "开始下一轮番茄专注" : "\(focus!.isPaused ? "继续" : "暂停")番茄\(focus!.title)"))
        .accessibilityIdentifier("island-todo-focus")
        .contextMenu {
            TodoFocusMenu(settings: snapshot.focusSettings, onChange: onFocusSettingsChange, onSettings: onFocusSettings, focus: focus, onToggle: onFocus, onStop: onFocusStop)
        }
    }
    private var quickInput: some View {
        HStack(spacing: 8) {
            Button { TodoNavigation.open() } label: { TodoRemindersMark(size: 16) }.help("打开提醒事项").accessibilityLabel("提醒事项").accessibilityIdentifier("island-todo-manage")
            Button(action: resumeComposer) {
                Text("tobo!").font(.system(size: 12)).foregroundStyle(Color(white: 0.68))
                    .frame(maxWidth: .infinity).contentShape(Rectangle())
            }.accessibilityLabel("tobo!").help("添加提醒事项")
            TodoMoreMenu(showCompleted: snapshot.showCompleted, onManage: onManage, onShowCompleted: { onShowCompleted(!snapshot.showCompleted) })
        }.padding(.horizontal, 14).padding(.vertical, 10)
    }

}

// SwiftUI 菜单项转换为 NSMenu 后不会触发 onAppear，跟随原生跟踪通知保持通知岛展开。
@MainActor final class TodoFocusMenuTracker {
    static let settingsTitle = "番茄时钟设置…"
    var onChange: ((Bool) -> Void)?
    private let center: NotificationCenter
    private var observers: [NSObjectProtocol] = []
    private weak var tracked: NSMenu?
    init(center: NotificationCenter = .default) {
        self.center = center
        for (name, began) in [(NSMenu.didBeginTrackingNotification, true), (NSMenu.didEndTrackingNotification, false)] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] notice in
                guard let menu = notice.object as? NSMenu else { return }
                // 同一主队列保持 begin/end 的顺序，不在菜单跟踪的嵌套循环里依赖 SwiftUI 生命周期。
                DispatchQueue.main.async { self?.track(menu, began: began) }
            })
        }
    }
    deinit { for observer in observers { center.removeObserver(observer) } }
    private func track(_ menu: NSMenu, began: Bool) {
        if began {
            guard menu.items.contains(where: { $0.title == Self.settingsTitle }) else { return }
            tracked = menu; onChange?(true)
        } else if tracked === menu { tracked = nil; onChange?(false) }
    }
}

// 胶囊按钮与顶部倒计时共用同一份配置，右键调整只影响下一轮。
struct TodoFocusMenu: View {
    var settings: TodoFocusSettings
    var onChange: (TodoFocusSettings) -> Void
    var onSettings: () -> Void
    var focus: TodoFocusSession?
    var onToggle: () -> Void = {}
    var onStop: () -> Void = {}
    private var durations: [Int] { Array(Set([5, 15, 25, 30, 45, 60, 90, 120, 180, settings.minutes])).sorted() }
    private var breaks: [Int] { Array(Set([1, 3, 5, 10, 15, 20, 30, 60, settings.breakMinutes])).sorted() }
    var body: some View {
        if let focus {
            Button(focus.isReady ? "开始下一轮番茄专注" : "\(focus.isPaused ? "继续" : "暂停")番茄\(focus.title)", action: onToggle)
            Button("结束番茄钟", action: onStop)
            Divider()
        }
        Picker("专注时长", selection: Binding(get: { settings.minutes }, set: { minutes in
            var next = settings; next.minutes = minutes; onChange(next)
        })) {
            ForEach(durations, id: \.self) { minutes in Text("\(minutes) 分钟").tag(minutes) }
        }
        Picker("休息时长", selection: Binding(get: { settings.breakMinutes }, set: { minutes in
            var next = settings; next.breakMinutes = minutes; onChange(next)
        })) {
            ForEach(breaks, id: \.self) { minutes in Text("\(minutes) 分钟").tag(minutes) }
        }
        Toggle("通知岛提示", isOn: Binding(get: { settings.notify }, set: { notify in
            var next = settings; next.notify = notify; onChange(next)
        }))
        Toggle("系统通知", isOn: Binding(get: { settings.systemNotify }, set: { notify in
            var next = settings; next.systemNotify = notify; onChange(next)
        }))
        Toggle("提示音", isOn: Binding(get: { settings.sound }, set: { sound in
            var next = settings; next.sound = sound; onChange(next)
        }))
        Divider()
        Button(TodoFocusMenuTracker.settingsTitle, action: onSettings)
    }
}

// 点击与长按共用一次按下序列，进度填满之后抬起不会再触发暂停或重启。
struct TodoFocusPress {
    static let duration = 0.8
    static let maximumDistance = 8.0
    private(set) var began = false
    private(set) var cancelled = false
    private(set) var completed = false
    mutating func begin() -> Bool { guard !began else { return false }; began = true; return true }
    mutating func move(distance: Double) -> Bool {
        guard began, !cancelled, !completed, distance > Self.maximumDistance else { return false }
        cancelled = true; return true
    }
    mutating func complete() -> Bool {
        guard began, !cancelled, !completed else { return false }
        completed = true; return true
    }
    mutating func release() -> Bool {
        let tap = began && !cancelled && !completed
        self = Self(); return tap
    }
}

private struct TodoFocusHoldRing: View {
    var progress: Double
    var body: some View {
        Circle().trim(from: 0, to: progress).stroke(.orange, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .rotationEffect(.degrees(-90)).opacity(progress > 0 ? 1 : 0).allowsHitTesting(false).accessibilityHidden(true)
    }
}

private struct TodoFocusControl<Content: View>: View {
    var running: Bool
    var onToggle: () -> Void
    var onStop: () -> Void
    @ViewBuilder var content: (Double) -> Content
    @State private var press = TodoFocusPress()
    @State private var progress = 0.0
    @State private var holdTask: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        content(progress).contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                if press.begin(), running {
                    // 进度是长按时限的必要反馈；减少动态效果时取消回落动画，不额外缩放或呼吸。
                    withAnimation(.linear(duration: TodoFocusPress.duration)) { progress = 1 }
                    holdTask = Task { @MainActor in
                        try? await Task.sleep(nanoseconds: UInt64(TodoFocusPress.duration * 1_000_000_000))
                        guard !Task.isCancelled, press.complete() else { return }
                        onStop()
                    }
                }
                if press.move(distance: hypot(value.translation.width, value.translation.height)) { cancelProgress() }
            }.onEnded { _ in
                let tap = press.release()
                cancelProgress()
                if tap { onToggle() }
            })
            .onDisappear { press = TodoFocusPress(); holdTask?.cancel(); holdTask = nil; progress = 0 }
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { onToggle() }
            .accessibilityAction(named: Text("结束番茄钟")) { if running { onStop() } }
    }
    private func cancelProgress() {
        holdTask?.cancel(); holdTask = nil
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.12)) { progress = 0 }
    }
}

// 倒计时只更新这一小块；通知岛其它会话和看板不随每秒重绘。
struct TodoFocusCountdown: View {
    var session: TodoFocusSession
    var active = true
    var onToggle: () -> Void = {}
    var onStop: () -> Void = {}
    var body: some View {
        TodoFocusControl(running: true, onToggle: onToggle, onStop: onStop) { progress in
            if active && !session.isPaused && !session.isReady {
                TimelineView(.periodic(from: .now, by: 1)) { context in content(at: context.date, progress: progress) }
            } else { content(at: .now, progress: progress) }
        }
        .help(session.isReady ? "休息结束；单击开始下一轮，长按结束，右键设置" : "\(session.title)\(session.isPaused ? "已暂停" : "中")；单击\(session.isPaused ? "继续" : "暂停")，长按结束，右键设置")
    }
    private func content(at date: Date, progress: Double) -> some View {
        HStack(spacing: 4) {
            Text(session.symbol).font(.system(size: 16)).frame(width: 21, height: 25)
                .overlay { TodoFocusHoldRing(progress: progress) }
                .overlay(alignment: .bottomTrailing) {
                    if session.isPaused { Image(systemName: "pause.fill").font(.system(size: 6, weight: .bold)).padding(2).background(.black, in: Circle()) }
                }
            Text(session.isReady ? "开始" : session.label(at: date)).font(.system(size: 12, weight: .semibold)).monospacedDigit()
        }
        .foregroundStyle(session.isRest ? .green : .white).fixedSize()
        .accessibilityElement(children: .ignore).accessibilityLabel(session.isReady ? "开始下一轮番茄专注" : "番茄\(session.title)\(session.isPaused ? "已暂停" : "")，剩余 \(session.label(at: date))")
    }
}

private struct TodoRemindersMark: View {
    var size: CGFloat
    private static let image: NSImage = {
        if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.reminders") {
            return NSWorkspace.shared.icon(forFile: app.path)
        }
        return NSImage(systemSymbolName: "checklist", accessibilityDescription: nil)!
    }()
    var body: some View {
        Image(nsImage: Self.image).resizable().scaledToFit()
            .frame(width: size, height: size).accessibilityHidden(true)
    }
}

private struct TodoMoreMenu: View {
    var showCompleted: Bool
    var onManage: () -> Void
    var onShowCompleted: () -> Void
    var onCancel: (() -> Void)?
    var body: some View {
        Menu {
            Button(showCompleted ? "隐藏已完成" : "显示已完成", action: onShowCompleted)
            Button("打开 tobo", action: onManage)
            Button("打开提醒事项") { TodoNavigation.open() }
            if let onCancel { Button("收起输入", action: onCancel) }
        } label: { Image(systemName: "ellipsis").font(.system(size: 12)).frame(width: 20, height: 20) }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(Color(white: 0.65)).accessibilityLabel("tobo 更多操作")
    }
}

private struct IslandTodoColumn: View {
    var column: TodoColumn
    var editing: IslandTodoEdit?
    var error: String
    var lists: [TodoList]
    var inputMonitor: TodoInputMonitor?
    @Binding var swipedItem: String?
    var onEdit: (TodoItem) -> Void
    var onEditChange: (TodoDraft) -> Void
    var onSaveEdit: (TodoDraft) -> Void
    var onCancelEdit: () -> Void
    var onComplete: (String, Bool) -> Void
    var onDelete: (String) -> Void
    var onAdd: () -> Void
    @State private var hoveredItem: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(column.bucket == .today ? Color.orange : column.bucket == .week ? Color.cyan : Color(white: 0.65)).frame(width: 5, height: 5).frame(width: 18)
                Text(column.title).font(.system(size: 12, weight: .semibold))
                Text("\(column.items.count)").font(.system(size: 10)).foregroundStyle(Color(white: 0.65))
                Spacer(minLength: 0)
                Button(action: onAdd) { Image(systemName: "plus").font(.system(size: 12)).frame(width: 24, height: 26) }
                    .foregroundStyle(Color(white: 0.8)).accessibilityLabel("新增到\(column.title)")
            }.padding(.horizontal, 12).frame(height: 38)
            if column.items.isEmpty {
                Text("暂无事项").font(.system(size: 10))
                    .foregroundStyle(Color(white: 0.65)).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(spacing: 2) {
                        ForEach(column.items) { item in
                            IslandTodoSwipeRow(revealed: Binding(get: { swipedItem == item.id }, set: { if $0 { swipedItem = item.id } else if swipedItem == item.id { swipedItem = nil } }), enabled: item.editable && editing?.itemID != item.id, title: item.title, onDelete: { onDelete(item.id) }) {
                            HStack(alignment: .top, spacing: 8) {
                                Button { onComplete(item.id, !item.completed) } label: {
                                    Image(systemName: item.completed ? "checkmark.circle.fill" : "circle").font(.system(size: 14)).foregroundStyle(item.completed ? Color.green : Color(white: 0.65))
                                }.frame(width: 18).disabled(!item.editable).padding(.top, 1).accessibilityLabel("\(item.completed ? "标记未完成" : "完成")：\(item.title)")
                                if let editing, editing.itemID == item.id {
                                    IslandTodoCreateCard(initial: editing.draft, lists: lists, error: error, inline: true, inputMonitor: inputMonitor, onDraftChange: onEditChange, onCancel: onCancelEdit, onSave: onSaveEdit)
                                        .id(editing.draft.id).fixedSize(horizontal: false, vertical: true)
                                } else {
                                Button { onEdit(item) } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(item.title).font(.system(size: 12)).foregroundStyle(Color(white: item.completed ? 0.65 : 0.92)).strikethrough(item.completed).lineLimit(3).multilineTextAlignment(.leading)
                                        if !item.dateText.isEmpty && !["今天", "未设日期"].contains(item.dateText) {
                                            Text(item.dateText).font(.system(size: 10)).foregroundStyle(item.overdue ? Color.orange : Color(white: 0.65))
                                        }
                                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                }.help("\(item.title) · \(item.list)；点击原位编辑").accessibilityLabel("\(item.title)，\(item.dateText)，\(item.editable ? "原位编辑" : "查看")")
                                }
                            }.padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
                                .background(.white.opacity(hoveredItem == item.id ? 0.05 : 0), in: RoundedRectangle(cornerRadius: 8))
                                .onHover { hoveredItem = $0 ? item.id : nil }
                            }
                        }
                    }.padding(.top, 4).padding(.bottom, 44)
                }.accessibilityLabel("\(column.title)事项，可滚动")
            }
        }.clipped()
    }
}

// 独立弹窗要同时声明原生外观与实色底板，不能只把 SwiftUI 文字切成深色模式。
struct TodoOptionPopover<Content: View>: View {
    var width: CGFloat = 270
    @ViewBuilder var content: Content
    var body: some View {
        content.frame(width: width).padding(12)
            .font(.system(size: 13)).buttonStyle(.plain).foregroundStyle(.primary)
            .tint(Color(red: 0.4, green: 0.72, blue: 1))
            .background(Color(white: 0.14)).preferredColorScheme(.dark)
    }
}

private struct IslandTodoCreateCard: View {
    private enum Option { case date, time, alarm, notes, organize, url
        var floats: Bool { self != .notes && self != .url }
    }
    @State private var draft: TodoDraft
    @State private var dateEnabled: Bool
    @State private var timeEnabled = false
    @State private var dueDate: Date
    @State private var alarmEnabled = false
    @State private var alarmDate = Date().addingTimeInterval(3600)
    @State private var option: Option?
    @FocusState private var titleFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var lists: [TodoList]
    var error: String
    var inline: Bool
    var inputMonitor: TodoInputMonitor?
    var onDraftChange: (TodoDraft) -> Void
    var onManage: () -> Void
    var showCompleted: Bool
    var onShowCompleted: () -> Void
    var onCancel: () -> Void
    var onSave: (TodoDraft) -> Void
    init(initial: TodoDraft, lists: [TodoList], error: String, inline: Bool = false, inputMonitor: TodoInputMonitor? = nil, onManage: @escaping () -> Void = {}, showCompleted: Bool = false, onShowCompleted: @escaping () -> Void = {}, onDraftChange: @escaping (TodoDraft) -> Void = { _ in }, onCancel: @escaping () -> Void, onSave: @escaping (TodoDraft) -> Void) {
        _draft = State(initialValue: initial)
        let calendar = Calendar.current
        var date = calendar.date(byAdding: .day, value: initial.bucket == .week ? 1 : 0, to: Date())!
        if var components = TodoGrouping.dateComponents(initial.date, calendar: calendar) {
            let time = initial.details.time.split(separator: ":").compactMap { Int($0) }
            components.hour = time.count == 2 ? time[0] : calendar.component(.hour, from: date)
            components.minute = time.count == 2 ? time[1] : calendar.component(.minute, from: date)
            date = calendar.date(from: components) ?? date
        }
        _dateEnabled = State(initialValue: !initial.date.isEmpty || initial.bucket != .later)
        _timeEnabled = State(initialValue: !initial.details.time.isEmpty)
        _dueDate = State(initialValue: date)
        _alarmEnabled = State(initialValue: initial.details.alarm != nil)
        _alarmDate = State(initialValue: initial.details.alarm ?? Date().addingTimeInterval(3600))
        self.lists = lists; self.error = error; self.inline = inline; self.inputMonitor = inputMonitor; self.onDraftChange = onDraftChange; self.onManage = onManage; self.showCompleted = showCompleted; self.onShowCompleted = onShowCompleted; self.onCancel = onCancel; self.onSave = onSave
    }
    private func field(_ label: String, _ value: Binding<String>, title: Bool = false) -> some View {
        Group {
            if title {
                TextField("", text: value, prompt: Text(label).foregroundColor(Color(white: 0.68))).onSubmit(save)
            } else {
                TextField("", text: value, prompt: Text(label).foregroundColor(Color(white: 0.68)), axis: .vertical).lineLimit(1...3)
            }
        }.font(.system(size: title ? 12 : 11))
            .textFieldStyle(.plain).foregroundStyle(Color(white: 0.97)).padding(.vertical, 2).accessibilityLabel(label)
    }
    private func tool(_ value: Option, _ icon: String, _ label: String, active: Bool = false) -> some View {
        Button { option = option == value ? nil : value } label: {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 11))
                if value == .date && dateEnabled && !inline { Text(dueDate, format: .dateTime.month().day()).font(.system(size: 10)) }
                if value == .time && dateEnabled && timeEnabled && !inline { Text(timeText).font(.system(size: 10)).monospacedDigit() }
            }.padding(.horizontal, inline ? 4 : 6).frame(height: inline ? 22 : 24)
                .foregroundStyle(active ? Color(red: 0.35, green: 0.7, blue: 1) : Color(white: 0.85))
                .background(Color.white.opacity(option == value || active ? 0.08 : 0), in: Capsule())
        }.help(label).accessibilityLabel(label).accessibilityValue(option == value ? "已展开" : "已收起")
            .popover(isPresented: Binding(get: { value.floats && option == value }, set: { if !$0 && option == value { option = nil } }), arrowEdge: .bottom) {
                TodoOptionPopover(width: value == .time ? 200 : 270) { optionFields(value) }
            }
    }
    private var timeText: String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "HH:mm"
        return formatter.string(from: dueDate)
    }
    private func selectDate(_ date: Date) {
        let calendar = Calendar.current
        let time = calendar.dateComponents([.hour, .minute], from: dueDate)
        dueDate = calendar.date(bySettingHour: time.hour ?? 9, minute: time.minute ?? 0, second: 0, of: date) ?? date
        dateEnabled = true
    }
    private func selectTime(_ hour: Int) {
        guard let date = Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: dueDate) else { return }
        dueDate = date; dateEnabled = true; timeEnabled = true; option = nil
    }
    private func choice(_ title: String, icon: String, subtitle: String? = nil, selected: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon).foregroundStyle(.secondary).frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).monospacedDigit()
                    if let subtitle { Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 0)
                if selected { Image(systemName: "checkmark").foregroundStyle(.tint) }
            }.padding(.horizontal, 8).padding(.vertical, 7).contentShape(Rectangle())
                .background(selected ? Color.white.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 8))
        }.accessibilityLabel(subtitle.map { title + "，" + $0 } ?? title)
    }
    @ViewBuilder private func optionFields(_ value: Option) -> some View {
        if value == .date {
            VStack(spacing: 10) {
                choice("无日期", icon: "calendar.badge.minus", selected: !dateEnabled) { dateEnabled = false; timeEnabled = false; option = nil }
                HStack(spacing: 8) {
                    Button { selectDate(Date()); option = nil } label: {
                        Text("今天").frame(maxWidth: .infinity).frame(height: 28).contentShape(Rectangle())
                    }
                    Button { selectDate(Calendar.current.date(byAdding: .day, value: 1, to: Date())!); option = nil } label: {
                        Text("明天").frame(maxWidth: .infinity).frame(height: 28).contentShape(Rectangle())
                    }
                }.foregroundStyle(.tint).buttonStyle(.bordered)
                Divider()
                DatePicker("日期", selection: Binding(get: { dueDate }, set: { selectDate($0) }), displayedComponents: .date).datePickerStyle(.graphical).labelsHidden()
                    .padding(8).frame(maxWidth: .infinity).background(Color(white: 0.11), in: RoundedRectangle(cornerRadius: 10))
            }
        }
        if value == .time {
            VStack(spacing: 0) {
                choice("无", icon: "clock", selected: !timeEnabled) { timeEnabled = false; option = nil }
                ForEach([9, 12, 15, 18, 21], id: \.self) { hour in
                    choice(String(format: "%02d:00", hour), icon: "clock", subtitle: [9: "上午", 12: "中午", 15: "下午", 18: "晚上", 21: "夜间"][hour], selected: dateEnabled && timeEnabled && timeText == String(format: "%02d:00", hour)) { selectTime(hour) }
                }
                Divider().padding(.vertical, 6)
                HStack {
                    Text("自定")
                    Spacer()
                    DatePicker("自定时间", selection: Binding(get: { dueDate }, set: { dueDate = $0; dateEnabled = true; timeEnabled = true }), displayedComponents: .hourAndMinute).labelsHidden()
                }.padding(.horizontal, 8).padding(.vertical, 6)
            }
        }
        if value == .alarm {
            HStack { Text("提醒我"); Spacer(); if alarmEnabled { DatePicker("提醒时间", selection: $alarmDate).labelsHidden() }; Toggle("提醒我", isOn: $alarmEnabled).labelsHidden().toggleStyle(.switch) }
        }
        if value == .organize {
            VStack(spacing: 10) {
                HStack { Text("列表"); Spacer(); Picker("列表", selection: $draft.listID) { Text("系统默认").tag(""); ForEach(lists) { Text($0.title).tag($0.id) } }.labelsHidden().pickerStyle(.menu).buttonStyle(.bordered).frame(maxWidth: 240) }
                Divider()
                HStack { Text("优先级"); Spacer(); Picker("优先级", selection: $draft.details.priority) { Text("无").tag(0); Text("低").tag(9); Text("中").tag(5); Text("高").tag(1) }.labelsHidden().pickerStyle(.menu).buttonStyle(.bordered).frame(maxWidth: 240) }
            }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                field("todo？tobo！", $draft.title, title: true).focused($titleFocused).accessibilityLabel("任务标题")
                if inline {
                    Button(action: onCancel) { Image(systemName: "xmark").font(.system(size: 9)).foregroundStyle(Color(white: 0.65)).frame(width: 16, height: 18) }.accessibilityLabel("取消编辑")
                } else {
                TodoMoreMenu(showCompleted: showCompleted, onManage: onManage, onShowCompleted: onShowCompleted, onCancel: onCancel)
                }
            }
                VStack(alignment: .leading, spacing: 8) {
                    if option == .notes || !draft.details.notes.isEmpty { field("备注", $draft.details.notes) }
                    if option == .url || !draft.details.url.isEmpty { field("URL", $draft.details.url) }
                    if !error.isEmpty { Text(error).font(.system(size: 11)).foregroundStyle(.orange) }
                    if lists.isEmpty { Text("没有可写列表，请在提醒事项中先创建列表。").font(.system(size: 11)).foregroundStyle(.orange) }
                }.font(.system(size: 11))
            HStack(spacing: 4) {
                HStack(spacing: 2) {
                    if !inline {
                        Button { TodoNavigation.open() } label: { TodoRemindersMark(size: 16).frame(width: 24, height: 24) }.help("打开提醒事项").accessibilityLabel("提醒事项")
                    }
                    tool(.date, "calendar", "日期", active: dateEnabled)
                    tool(.time, "clock", "时间", active: dateEnabled && timeEnabled)
                    tool(.alarm, "bell", "提醒时间", active: alarmEnabled)
                    tool(.notes, "note.text", "备注", active: !draft.details.notes.isEmpty)
                    tool(.organize, "list.bullet", "列表与优先级", active: draft.details.priority > 0)
                    tool(.url, "link", "URL", active: !draft.details.url.isEmpty)
                }
                Spacer(minLength: 0)
                Button(action: save) { Image(systemName: "return").font(.system(size: 11)).foregroundStyle(Color.white).frame(width: inline ? 22 : 28, height: inline ? 22 : 24).background(Color.blue.opacity(0.65), in: Capsule()) }
                    .disabled((draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !(inline && draft.isEmpty)) || lists.isEmpty).accessibilityIdentifier("island-todo-create")
                    .accessibilityLabel(inline ? (draft.isEmpty ? "删除空白事项" : "保存提醒事项") : "添加提醒事项").help(inline ? "回车保存" : "回车添加")
            }
        }.padding(.horizontal, inline ? 0 : 16).padding(.vertical, inline ? 0 : 12)
            .background(TodoInputRegion(monitor: inputMonitor))
            .animation(reduceMotion ? nil : .timingCurve(0.2, 0.8, 0.2, 1, duration: 0.18), value: option)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: dateEnabled)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: alarmEnabled)
            .onChange(of: draft) { _ in changed() }
            .onChange(of: dueDate) { _ in changed() }
            .onChange(of: dateEnabled) { _ in changed() }
            .onChange(of: timeEnabled) { _ in changed() }
            .onChange(of: alarmEnabled) { _ in changed() }
            .onChange(of: alarmDate) { _ in changed() }
            .task {
                // 原生 field editor 不参与胶囊的淡入 / 缩放，等展开落定后再获取焦点。
                if !inline && !reduceMotion {
                    do { try await Task.sleep(nanoseconds: 180_000_000) } catch { return }
                } else { await Task.yield() }
                guard !Task.isCancelled else { return }
                titleFocused = true
            }.onExitCommand(perform: onCancel)
    }
    private func changed() { onDraftChange(value()) }
    private func value() -> TodoDraft {
        var result = draft
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        result.date = dateEnabled ? formatter.string(from: dueDate) : ""
        if !dateEnabled { result.bucket = .later }
        formatter.dateFormat = "HH:mm"
        result.details.time = dateEnabled && timeEnabled ? formatter.string(from: dueDate) : ""
        result.details.alarm = alarmEnabled ? alarmDate : nil
        return result
    }
    private func save() {
        guard (!draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (inline && draft.isEmpty)), !lists.isEmpty else { return }
        onSave(value())
    }
}
