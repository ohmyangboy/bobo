import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Todo：日期分类、权限、写回、系统变更、异步竞争与原生布局（隔离系统提醒事项）',{skip:process.platform!=='darwin'},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-todo-'));
 try{
  const file=path.join(dir,'Check.swift'),binary=path.join(dir,'check');
  await fs.writeFile(file,String.raw`
import AppKit
import SwiftUI

@MainActor final class FakeRepository: TodoRepository {
    var authorization = TodoAuthorization.notDetermined
    var onChange: (() -> Void)?
    var requests = 0, reads = 0
    var permissionResult = TodoAuthorization.allowed
    var items: [TodoReminder]? = []
    var failure = false
    var pending: [CheckedContinuation<[TodoReminder], any Error>] = []
    var writes: [(String, DateComponents?, String)] = []
    var savedDetails = TodoDetails()
    var requestedCompleted = false
    var updates: [String] = []
    var completions: [(String, Bool)] = []
    var deletions: [String] = []
    var removeFailure = false
    var preservedDue = false
    func requestAccess() async throws -> Bool { requests += 1; authorization = permissionResult; return authorization == .allowed }
    func fetch(includeCompleted: Bool) async throws -> [TodoReminder] {
        requestedCompleted = includeCompleted
        reads += 1
        if failure { throw TodoError.message("测试读取失败") }
        if let items { return items }
        return try await withCheckedThrowingContinuation { pending.append($0) }
    }
    func writableLists() -> [TodoList] { [TodoList(id: "inbox", title: "收件箱")] }
    func defaultListID() -> String { "inbox" }
    func create(title: String, due: DateComponents?, listID: String, details: TodoDetails) throws {
        guard listID == "inbox" else { throw TodoError.message("列表已删除") }
        writes.append((title, due, listID)); savedDetails = details
    }
    func update(id: String, title: String, due: DateComponents?, listID: String, details: TodoDetails, preserveDue: Bool) throws {
        guard listID == "inbox" else { throw TodoError.message("列表已删除") }
        updates.append(id); savedDetails = details; preservedDue = preserveDue
    }
    func complete(id: String, completed: Bool) throws { completions.append((id, completed)) }
    func remove(id: String) throws { if removeFailure { throw TodoError.message("测试删除失败") }; deletions.append(id) }
    func finish(_ items: [TodoReminder]) { pending.removeFirst().resume(returning: items) }
}

@main struct TodoCheck {
    @MainActor static func main() async throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        calendar.firstWeekday = 2
        func date(_ value: String) -> DateComponents { TodoGrouping.dateComponents(value, calendar: calendar)! }
        let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 29, hour: 12))!
        func reminder(_ id: String, _ due: String? = nil, priority: Int = 0, completed: Bool = false) -> TodoReminder {
            TodoReminder(id: id, title: id, list: "收件箱", due: due.map(date), priority: priority, completed: completed, listID: "inbox")
        }
        let input = [reminder("none"), reminder("past", "2026-10-28"), reminder("today", "2026-10-29"), reminder("tomorrow", "2026-10-30"), reminder("sunday", "2026-11-01"), reminder("next-week", "2026-11-02"), reminder("done", "2026-10-29", completed: true)]
        let board = TodoGrouping.columns(input, now: now, calendar: calendar)
        precondition(board.map(\.bucket) == [.today, .week, .later])
        precondition(board[0].items.map(\.id) == ["past", "today"])
        precondition(board[1].items.map(\.id) == ["tomorrow", "sunday", "next-week"])
        precondition(board[2].items.map(\.id) == ["none"])
        precondition(board[0].items[0].overdue && !board[0].items[1].overdue, "全天提醒直到跨天才算逾期")
        var timed = reminder("morning", "2026-10-29"); timed.due?.hour = 9
        let timedBoard = TodoGrouping.columns([timed], now: now, calendar: calendar)
        precondition(timedBoard[0].items[0].overdue && timedBoard[0].items[0].dateText.contains("09:00"))
        var editingItem = timedBoard[0].items[0]
        editingItem.notes = "保留备注"; editingItem.priority = 5; editingItem.url = "https://example.com"; editingItem.alarm = "2026-10-29T01:00:00Z"
        let editingDraft = TodoDraft.editing(editingItem, bucket: .today)
        precondition(editingDraft.title == editingItem.title && editingDraft.listID == "inbox" && editingDraft.date == "2026-10-29" && editingDraft.details.time == "09:00")
        precondition(editingDraft.details.notes == "保留备注" && editingDraft.details.priority == 5 && editingDraft.details.url == editingItem.url && editingDraft.details.alarm != nil, "原位编辑须保留已有日期、时间、列表与提醒字段")
        var blank = editingDraft; blank.title = " \n"; blank.details.notes = ""; blank.details.url = ""
        precondition(blank.isEmpty, "空白清理忽略日期、提醒与优先级")
        blank.details.notes = "备注仍在"; precondition(!blank.isEmpty, "备注不能因清空标题被自动删除")
        blank.details.notes = ""; blank.details.url = "https://example.com"; precondition(!blank.isEmpty)
        let boundary = TodoGrouping.columns([reminder("seventh", "2026-11-05"), reminder("eighth", "2026-11-06")], now: now, calendar: calendar)
        precondition(boundary[1].items.map(\.id) == ["seventh"] && boundary[2].items.map(\.id) == ["eighth"], "包含未来第七天，排除第八天")
        precondition(TodoGrouping.dateComponents("2026-02-30", calendar: calendar) == nil)
        precondition(TodoGrouping.dateComponents("2026-1-1", calendar: calendar) == nil)
        precondition(TodoGrouping.dateComponents("2028-02-29", calendar: calendar) != nil)
        var sundayCalendar = calendar; sundayCalendar.firstWeekday = 1
        precondition(TodoGrouping.columns([reminder("sunday", "2026-11-01")], now: now, calendar: sundayCalendar)[1].items.count == 1, "近七不受每周起始日影响")
        let lastDay = calendar.date(from: DateComponents(year: 2026, month: 12, day: 31, hour: 12))!
        precondition(TodoGrouping.columns([reminder("next-year", "2027-01-01")], now: lastDay, calendar: calendar)[1].items.count == 1)
        var la = calendar; la.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let dstNow = la.date(from: DateComponents(year: 2026, month: 3, day: 8, hour: 12))!
        let tomorrow = TodoReminder(id: "dst", title: "明天", list: "", due: DateComponents(year: 2026, month: 3, day: 9))
        precondition(TodoGrouping.columns([tomorrow], now: dstNow, calendar: la)[1].items.count == 1, "夏令时用日历加天，明天仍归近七")
        var zoned = reminder("timezone", "2026-10-30"); zoned.due?.hour = 0; zoned.due?.timeZone = TimeZone(secondsFromGMT: 14 * 3600)
        precondition(TodoGrouping.columns([zoned], now: now, calendar: calendar)[0].items.count == 1, "带时区截止时间按本地日期归类")
        let priority = TodoGrouping.columns([reminder("normal", "2026-10-29"), reminder("urgent", "2026-10-29", priority: 1)], now: now, calendar: calendar)
        precondition(priority[0].items.first?.id == "urgent")

        let suite = "local.bobo.todo-test." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let repository = FakeRepository()
        let store = TodoStore(repository: repository, defaults: defaults, now: { now }, calendar: { calendar }, observeSystem: false)
        func settle(_ condition: () -> Bool) async throws {
            for _ in 0..<500 { if condition() { return }; try await Task.sleep(nanoseconds: 1_000_000) }
            preconditionFailure("异步操作未完成")
        }
        store.refresh(); precondition(repository.requests == 0 && repository.reads == 0, "启动和刷新不能触发权限弹窗或未授权读取")
        repository.permissionResult = .denied
        await store.connect()
        precondition(repository.requests == 1 && !store.snapshot.enabled && store.snapshot.authorization == .denied)
        await store.connect(); precondition(repository.requests == 1, "拒绝后不能反复请求权限")
        repository.authorization = .allowed; repository.items = input
        await store.connect(); try await settle { !store.snapshot.loading }
        precondition(store.snapshot.enabled && store.snapshot.count == 6 && store.snapshot.defaultList == "inbox")
        precondition(defaults.bool(forKey: "todoEnabled") && !store.snapshot.showCompleted && !repository.requestedCompleted)
        store.setShowCompleted(true); try await settle { !store.snapshot.loading }
        precondition(store.snapshot.count == 7 && repository.requestedCompleted)
        precondition(store.snapshot.columns[0].items.last?.completed == true)
        store.setShowCompleted(false); try await settle { !store.snapshot.loading }
        precondition(store.snapshot.count == 6 && !repository.requestedCompleted)
        store.complete(id: "today", completed: true)
        precondition(repository.completions.last?.0 == "today" && repository.completions.last?.1 == true)
        store.complete(id: "unknown", completed: true); precondition(repository.completions.count == 1)
        precondition(store.create(title: "改标题", date: "2026-10-29", listID: "inbox", details: TodoDetails(notes: "保留备注", time: "", url: "https://example.com"), editingID: "today"))
        precondition(repository.updates == ["today"] && repository.preservedDue && repository.savedDetails.url == "https://example.com")
        precondition(!store.create(title: "无日期时间", date: "", listID: "inbox", details: TodoDetails(time: "12:30")))
        precondition(!store.create(title: "错误时间", date: "2026-10-30", listID: "inbox", details: TodoDetails(time: "25:30")))
        precondition(store.create(title: "定时", date: "2026-10-30", listID: "inbox", details: TodoDetails(time: "12:30")))
        precondition(repository.writes.last!.1?.hour == 12 && repository.writes.last!.1?.minute == 30)
        repository.writes.removeAll()
        precondition(store.create(title: "  新待办  ", date: "2026-10-30", listID: "inbox"))
        precondition(repository.writes.count == 1 && repository.writes[0].0 == "新待办" && repository.writes[0].1?.day == 30)
        precondition(!store.create(title: "", date: "", listID: "inbox"))
        precondition(!store.create(title: "错误日期", date: "2026-02-30", listID: "inbox"))
        precondition(!store.create(title: "错误列表", date: "", listID: "deleted") && repository.writes.count == 1)
        precondition(store.create(title: "稍后新增", date: "", listID: "inbox", bucket: .later) && repository.writes.last!.1 == nil)
        precondition(store.create(title: "今天新增", date: "", listID: "inbox", bucket: .today) && repository.writes.last!.1?.day == 29)
        let details = TodoDetails(notes: "备注", checklist: "第一步\n第二步", tags: "bobo #工作", priority: 1, alarm: now.addingTimeInterval(3600))
        precondition(store.create(title: "本周新增", date: "", listID: "inbox", bucket: .week, details: details) && repository.writes.last!.1?.day == 30)
        precondition(repository.savedDetails.savedNotes == "备注\n\n☐ 第一步\n☐ 第二步\n\n#bobo #工作" && repository.savedDetails.priority == 1 && repository.savedDetails.alarm != nil)
        precondition(store.create(title: "指定日期覆盖列", date: "2026-11-02", listID: "inbox", bucket: .today) && repository.writes.last!.1?.month == 11)
        precondition(store.create(title: "系统默认列表", date: "", listID: "", bucket: .today) && repository.writes.last!.1?.day == 29 && repository.writes.last!.2 == "inbox", "未指定列表时写入系统默认列表，今日归类按本地日期计算")
        let sunday = calendar.date(from: DateComponents(year: 2026, month: 11, day: 1))!
        let sundayStore = TodoStore(repository: repository, defaults: defaults, now: { sunday }, calendar: { calendar }, observeSystem: false)
        await sundayStore.connect(); try await settle { !sundayStore.snapshot.loading }
        precondition(sundayStore.create(title: "周末边界", date: "", listID: "inbox", bucket: .week) && repository.writes.last!.1?.day == 2, "周日近七默认明天，不按本周末截断")
        // 恢复原 store 的变更订阅。
        repository.onChange = { store.refresh() }
        try await settle { !store.snapshot.loading }
        repository.items = [reminder("changed")]; repository.onChange?()
        try await settle { !store.snapshot.loading }
        precondition(store.snapshot.count == 1 && store.snapshot.columns[2].items[0].id == "changed")
        precondition(!store.remove(id: "unknown") && repository.deletions.isEmpty)
        repository.removeFailure = true; precondition(!store.remove(id: "changed") && repository.deletions.isEmpty)
        repository.removeFailure = false; precondition(store.remove(id: "changed") && repository.deletions == ["changed"])
        try await settle { !store.snapshot.loading }
        repository.failure = true; store.refresh(); try await settle { !store.snapshot.loading }
        precondition(!store.snapshot.error.isEmpty && store.snapshot.count == 1, "读取失败不能伪装成空列表")
        repository.failure = false; repository.items = nil
        store.refresh(); try await settle { !repository.pending.isEmpty }
        let reads = repository.reads
        store.refresh(); store.refresh(); repository.finish([reminder("stale")])
        try await settle { repository.reads == reads + 1 && !repository.pending.isEmpty }
        repository.finish([reminder("latest")]); try await settle { !store.snapshot.loading }
        precondition(store.snapshot.columns[2].items[0].id == "latest", "重复系统变更合并为一轮补查")
        store.refresh(); try await settle { !repository.pending.isEmpty }
        store.setEnabled(false); repository.finish(input)
        try await Task.sleep(nanoseconds: 10_000_000)
        precondition(!store.snapshot.enabled && store.snapshot.count == 0 && store.snapshot.height == 0, "关闭后在途读取不能恢复数据")
        store.setEnabled(true); try await settle { !repository.pending.isEmpty }
        repository.authorization = .denied; repository.finish(input)
        try await settle { !store.snapshot.loading }
        precondition(store.snapshot.authorization == .denied && store.snapshot.count == 0 && store.snapshot.lists.isEmpty, "撤权后清除数据")
        precondition(!store.create(title: "拒绝写入", date: "", listID: "inbox"))
        repository.authorization = .allowed; repository.items = input; store.refresh()
        try await settle { !store.snapshot.loading }
        repository.items = nil; store.refresh(); try await settle { !repository.pending.isEmpty }
        repository.authorization = .denied
        repository.pending.removeFirst().resume(throwing: TodoError.message("权限已撤回"))
        try await settle { !store.snapshot.loading }
        precondition(store.snapshot.authorization == .denied && store.snapshot.count == 0, "撤权导致查询失败时也不能保留旧数据")

        precondition(TodoWebBridge.trusted(URL(string: "http://127.0.0.1:4318/?app=1")))
        for invalid in ["https://127.0.0.1:4318/", "http://localhost:4318/", "http://127.0.0.1:99/", "http://127.0.0.1:4318/other"] { precondition(!TodoWebBridge.trusted(URL(string: invalid))) }
        precondition(TodoNavigation.reminderURL("../../x") == nil && TodoNavigation.reminderURL("x-apple-reminder://abc") == nil)
        precondition(TodoNavigation.reminderURL("11111111-2222-3333-4444-555555555555")?.absoluteString == "x-apple-reminderkit://REMCDReminder/11111111-2222-3333-4444-555555555555/details")

        NSApplication.shared.setActivationPolicy(.prohibited)
        var snapshot = TodoSnapshot(); snapshot.enabled = true; snapshot.authorization = .allowed
        snapshot.columns = TodoGrouping.columns((0..<40).map { reminder("待办\($0)", "2026-10-29") }, now: now, calendar: calendar)
        precondition(snapshot.height == 216 && snapshot.count == 40, "缩略布局有高度上限但保留全部事项")
        for width: CGFloat in [300, 480, 760] {
            let host = NSHostingView(rootView: IslandTodoView(snapshot: snapshot, onManage: {}, onOpen: { _ in }).frame(width: width))
            host.frame = NSRect(x: 0, y: 0, width: width, height: snapshot.height)
            host.layoutSubtreeIfNeeded()
            precondition(abs(host.fittingSize.height - snapshot.height) < 1 && host.fittingSize.width <= width + 1)
        }
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as! [String: Any]
        precondition((json["columns"] as! [[String: Any]]).map { $0["bucket"] as! String } == ["today", "week", "later"])
        print("Todo checks passed")
    }
}
`.replaceAll('\u{5c}','\\'));
  try{
   execFileSync('/usr/bin/xcrun',['swiftc','-parse-as-library',fileURLToPath(new URL('./Todo.swift',import.meta.url)),file,'-o',binary,'-framework','AppKit','-framework','WebKit','-framework','EventKit'],{stdio:'pipe',timeout:60000});
   const output=execFileSync(binary,[],{encoding:'utf8',timeout:30000});assert.match(output,/Todo checks passed/);
  }catch(error){throw new Error(`${error.message}\n${error.stdout||''}\n${error.stderr||''}`);}
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
