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
    func requestAccess() async throws -> Bool { requests += 1; authorization = permissionResult; return authorization == .allowed }
    func fetch() async throws -> [TodoReminder] {
        reads += 1
        if failure { throw TodoError.message("测试读取失败") }
        if let items { return items }
        return try await withCheckedThrowingContinuation { pending.append($0) }
    }
    func writableLists() -> [TodoList] { [TodoList(id: "inbox", title: "收件箱")] }
    func defaultListID() -> String { "inbox" }
    func create(title: String, due: DateComponents?, listID: String) throws {
        guard listID == "inbox" else { throw TodoError.message("列表已删除") }
        writes.append((title, due, listID))
    }
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
            TodoReminder(id: id, title: id, list: "收件箱", due: due.map(date), priority: priority, completed: completed)
        }
        let input = [reminder("none"), reminder("past", "2026-10-28"), reminder("today", "2026-10-29"), reminder("tomorrow", "2026-10-30"), reminder("sunday", "2026-11-01"), reminder("next-week", "2026-11-02"), reminder("done", "2026-10-29", completed: true)]
        let board = TodoGrouping.columns(input, now: now, calendar: calendar)
        precondition(board.map(\.bucket) == [.later, .week, .today])
        precondition(board[0].items.map(\.id) == ["next-week", "none"])
        precondition(board[1].items.map(\.id) == ["tomorrow", "sunday"])
        precondition(board[2].items.map(\.id) == ["past", "today"])
        precondition(board[2].items[0].overdue && !board[2].items[1].overdue, "全天提醒直到跨天才算逾期")
        var timed = reminder("morning", "2026-10-29"); timed.due?.hour = 9
        let timedBoard = TodoGrouping.columns([timed], now: now, calendar: calendar)
        precondition(timedBoard[2].items[0].overdue && timedBoard[2].items[0].dateText.contains("09:00"))
        precondition(TodoGrouping.dateComponents("2026-02-30", calendar: calendar) == nil)
        precondition(TodoGrouping.dateComponents("2026-1-1", calendar: calendar) == nil)
        precondition(TodoGrouping.dateComponents("2028-02-29", calendar: calendar) != nil)
        var sundayCalendar = calendar; sundayCalendar.firstWeekday = 1
        precondition(TodoGrouping.columns([reminder("sunday", "2026-11-01")], now: now, calendar: sundayCalendar)[0].items.count == 1, "按系统本周边界，不是未来七天")
        let lastDay = calendar.date(from: DateComponents(year: 2026, month: 12, day: 31, hour: 12))!
        precondition(TodoGrouping.columns([reminder("next-year", "2027-01-01")], now: lastDay, calendar: calendar)[1].items.count == 1)
        var la = calendar; la.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let dstNow = la.date(from: DateComponents(year: 2026, month: 3, day: 8, hour: 12))!
        let tomorrow = TodoReminder(id: "dst", title: "明天", list: "", due: DateComponents(year: 2026, month: 3, day: 9))
        precondition(TodoGrouping.columns([tomorrow], now: dstNow, calendar: la)[0].items.count == 1, "夏令时且周日结束后，明天归稍后")
        var zoned = reminder("timezone", "2026-10-30"); zoned.due?.hour = 0; zoned.due?.timeZone = TimeZone(secondsFromGMT: 14 * 3600)
        precondition(TodoGrouping.columns([zoned], now: now, calendar: calendar)[2].items.count == 1, "带时区截止时间按本地日期归类")
        let priority = TodoGrouping.columns([reminder("normal", "2026-10-29"), reminder("urgent", "2026-10-29", priority: 1)], now: now, calendar: calendar)
        precondition(priority[2].items.first?.id == "urgent")

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
        precondition(defaults.bool(forKey: "todoEnabled"))
        precondition(store.create(title: "  新待办  ", date: "2026-10-30", listID: "inbox"))
        precondition(repository.writes.count == 1 && repository.writes[0].0 == "新待办" && repository.writes[0].1?.day == 30)
        precondition(!store.create(title: "", date: "", listID: "inbox"))
        precondition(!store.create(title: "错误日期", date: "2026-02-30", listID: "inbox"))
        precondition(!store.create(title: "错误列表", date: "", listID: "deleted") && repository.writes.count == 1)
        try await settle { !store.snapshot.loading }
        repository.items = [reminder("changed")]; repository.onChange?()
        try await settle { !store.snapshot.loading }
        precondition(store.snapshot.count == 1 && store.snapshot.columns[0].items[0].id == "changed")
        repository.failure = true; store.refresh(); try await settle { !store.snapshot.loading }
        precondition(!store.snapshot.error.isEmpty && store.snapshot.count == 1, "读取失败不能伪装成空列表")
        repository.failure = false; repository.items = nil
        store.refresh(); try await settle { !repository.pending.isEmpty }
        let reads = repository.reads
        store.refresh(); store.refresh(); repository.finish([reminder("stale")])
        try await settle { repository.reads == reads + 1 && !repository.pending.isEmpty }
        repository.finish([reminder("latest")]); try await settle { !store.snapshot.loading }
        precondition(store.snapshot.columns[0].items[0].id == "latest", "重复系统变更合并为一轮补查")
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
        precondition(snapshot.height == 192 && snapshot.count == 40, "缩略布局有高度上限但保留全部事项")
        for width: CGFloat in [300, 480, 760] {
            let host = NSHostingView(rootView: IslandTodoView(snapshot: snapshot, onManage: {}, onOpen: { _ in }).frame(width: width))
            host.frame = NSRect(x: 0, y: 0, width: width, height: snapshot.height)
            host.layoutSubtreeIfNeeded()
            precondition(abs(host.fittingSize.height - snapshot.height) < 1 && host.fittingSize.width <= width + 1)
        }
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as! [String: Any]
        precondition((json["columns"] as! [[String: Any]]).map { $0["bucket"] as! String } == ["later", "week", "today"])
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
