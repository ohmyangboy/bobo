import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('番茄入口在 tobo 胶囊左侧，时长与提醒选项属于 tobo 设置',async()=>{
 const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
 const shell=html.slice(html.indexOf('id="todoInputShell"'),html.indexOf('<dialog id="todoDetail"'));
 assert.ok(shell.indexOf('id="todoFocusToggle"')<shell.indexOf('id="todoInputContent"'));
 const settings=shell.slice(shell.indexOf('id="todoSettings"'));
 assert.match(settings,/番茄专注/);assert.match(settings,/id="todoFocusMinutes"/);assert.match(settings,/id="todoFocusNotify"/);
});

test('番茄专注：配置迁移、暂停、专注休息循环、持久计数和长按序列使用内存偏好与注入时钟', {skip:process.platform!=='darwin',timeout:90000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-focus-test-'));
 try{
  const probe=path.join(dir,'probe.swift'),binary=path.join(dir,'probe');
  await fs.writeFile(probe,String.raw`
import Foundation
import AppKit
import Combine

private final class MemoryDefaults: UserDefaults {
 var values:[String:Any] = [:]
 init(memory:Bool) { super.init(suiteName:"bobo.focus.test.\(UUID())")! }
 override func bool(forKey key:String) -> Bool { values[key] as? Bool ?? false }
 override func data(forKey key:String) -> Data? { values[key] as? Data }
 override func set(_ value:Any?, forKey key:String) { values[key] = value }
 override func removeObject(forKey key:String) { values.removeValue(forKey:key) }
}
@MainActor private final class Repository: TodoRepository {
 var authorization = TodoAuthorization.denied
 var onChange:(()->Void)?
 func requestAccess() async throws -> Bool { fatalError("专注不能请求提醒事项权限") }
 func fetch(includeCompleted:Bool) async throws -> [TodoReminder] { fatalError("专注不能读取提醒事项") }
 func writableLists() -> [TodoList] { [] }
 func defaultListID() -> String { "" }
 func create(title:String,due:DateComponents?,listID:String,details:TodoDetails) throws { fatalError() }
 func update(id:String,title:String,due:DateComponents?,listID:String,details:TodoDetails,preserveDue:Bool) throws { fatalError() }
 func complete(id:String,completed:Bool) throws { fatalError() }
 func remove(id:String) throws { fatalError() }
}
@main enum Probe {
 @MainActor static func main() throws {
  let decoder = JSONDecoder()
  let oldSettings = try decoder.decode(TodoFocusSettings.self,from:Data(#"{"minutes":45,"notify":false}"#.utf8))
  precondition(oldSettings == TodoFocusSettings(minutes:45,notify:false),"旧设置补上默认休息时长")
  let legacyModeSettings = try decoder.decode(TodoFocusSettings.self,from:Data(#"{"minutes":45,"notify":false,"systemMode":"old-unused-mode"}"#.utf8))
  precondition(legacyModeSettings == oldSettings,"旧持久数据中已移除的字段可以忽略")
  let oldSession = try decoder.decode(TodoFocusSession.self,from:Data(#"{"startedAt":2000000000,"endsAt":2000000060}"#.utf8))
  precondition(oldSession.phase == "focus" && !oldSession.isPaused && oldSession.valid)
  let legacyModeSession = try decoder.decode(TodoFocusSession.self,from:Data(#"{"startedAt":2000000000,"endsAt":2000000060,"systemMode":"old-unused-mode"}"#.utf8))
  precondition(legacyModeSession.valid && legacyModeSession.phase == "focus")
  for value in [TodoFocusSession(startedAt:1,endsAt:0),TodoFocusSession(startedAt:1,endsAt:20,phase:"invalid"),TodoFocusSession(startedAt:1,endsAt:20,pausedRemaining:-1)] { precondition(!value.valid) }
  let defaults = MemoryDefaults(memory:true)
  var now = Date(timeIntervalSince1970:2_000_000_000)
  var calendar = Calendar(identifier:.gregorian); calendar.timeZone = TimeZone(secondsFromGMT:0)!
  func store(_ defaults:MemoryDefaults) -> TodoStore { TodoStore(repository:Repository(),defaults:defaults,now:{now},calendar:{calendar},observeSystem:false) }
  let timer = store(defaults)
  precondition(timer.snapshot.focusSettings == TodoFocusSettings() && timer.snapshot.focus == nil)
  func settings(_ extra:[String:Any] = [:]) -> [String:Any] {
   var value:[String:Any] = ["minutes":1,"notify":true,"breakMinutes":5,"systemNotify":true,"sound":true]
   value.merge(extra){_,new in new};return value
  }
  for value in [settings(["minutes":0]),settings(["minutes":181]),settings(["minutes":25.5]),settings(["minutes":true]),settings(["notify":"true"]),settings(["extra":1]),settings(["breakMinutes":0]),settings(["breakMinutes":61]),settings(["breakMinutes":1.5]),settings(["breakMinutes":true]),settings(["systemNotify":"true"]),settings(["sound":1]),["minutes":25,"notify":true]] {
   precondition(!timer.saveFocusSettings(value))
   precondition(timer.snapshot.focusSettings == TodoFocusSettings(),"非法配置不能部分保存")
  }
  precondition(timer.saveFocusSettings(TodoFocusSettings(minutes:25,notify:true,breakMinutes:5)))
  var notices = 0
  timer.onFocusFinished = { _ in notices += 1 }
  timer.toggleFocus()
  let first = timer.snapshot.focus!
  precondition(first.endsAt-first.startedAt == 1500 && first.label(at:now) == "25:00")
  now.addTimeInterval(0.2)
  precondition(first.label(at:now) == "25:00","秒数向上取整，开始时不能立即掉一秒")
  now.addTimeInterval(0.8)
  precondition(first.label(at:now) == "24:59")
  var publications = 0
  let observation = timer.$snapshot.sink { _ in publications += 1 }
  let before = publications
  timer.finishFocusIfNeeded()
  precondition(publications == before,"没有到期时不发布逐秒快照")
  timer.toggleFocus()
  let paused = timer.snapshot.focus!
  precondition(paused.id == first.id && paused.isPaused && paused.remaining(at:now) == 1499)
  now.addTimeInterval(3600)
  timer.finishFocusIfNeeded()
  precondition(timer.snapshot.focus == paused && paused.remaining(at:now) == 1499,"暂停时间不能流逝或完成")
  precondition(timer.saveFocusSettings(TodoFocusSettings(minutes:45,notify:false,breakMinutes:10)))
  precondition(timer.snapshot.focus == paused,"修改设置不能重置倒计时")
  let restored = store(defaults)
  precondition(restored.snapshot.focus == paused && restored.snapshot.focusSettings.minutes == 45)
  // 恢复实例退出后不再参与同一份内存偏好的后续操作。
  restored.stopFocus()
  timer.toggleFocus()
  let resumed = timer.snapshot.focus!
  precondition(!resumed.isPaused && resumed.id == first.id && resumed.endsAt == now.timeIntervalSince1970 + 1499)
  precondition(resumed.endsAt-resumed.startedAt == 1500)
  now = Date(timeIntervalSince1970:resumed.endsAt + 60)
  timer.finishFocusIfNeeded()
  let rest = timer.snapshot.focus!
  precondition(rest.isRest && rest.endsAt-rest.startedAt == 600 && rest.startedAt == now.timeIntervalSince1970)
  precondition(timer.snapshot.focusCompleted == 1 && timer.snapshot.focusCompletedToday == 1 && notices == 0,"关闭提醒仍要计数并休息")
  timer.finishFocusIfNeeded();timer.finishFocusIfNeeded()
  precondition(timer.snapshot.focusCompleted == 1,"重复检查不能再次结算")
  now = Date(timeIntervalSince1970:rest.endsAt)
  timer.finishFocusIfNeeded()
  let waiting = timer.snapshot.focus!
  precondition(waiting.isReady && waiting.valid && waiting.remaining(at:now) == 0,"休息结束只进入等待确认")
  now.addTimeInterval(3600)
  timer.finishFocusIfNeeded();timer.refresh()
  precondition(timer.snapshot.focus == waiting && timer.snapshot.focusCompleted == 1,"等待期间不自动计时或补出完成数")
  let waitingRestored = store(defaults)
  precondition(waitingRestored.snapshot.focus == waiting,"重启保留等待，不能自动开始下一轮")
  waitingRestored.stopFocus()
  timer.toggleFocus()
  let next = timer.snapshot.focus!
  precondition(!next.isReady && !next.isRest && next.id != first.id && next.endsAt-next.startedAt == 2700,"手动点击后才使用新设置开始下一轮")
  precondition(timer.snapshot.focusCompleted == 1 && notices == 0)
  timer.stopFocus();timer.stopFocus()
  precondition(timer.snapshot.focus == nil && timer.snapshot.focusCompleted == 1 && notices == 0,"手动结束不计数、不提醒")
  precondition(timer.saveFocusSettings(settings(["minutes":1,"breakMinutes":1])))
  timer.toggleFocus()
  now.addTimeInterval(61)
  timer.finishFocusIfNeeded();timer.finishFocusIfNeeded()
  precondition(timer.snapshot.focus?.isRest == true && notices == 1 && timer.snapshot.focusCompleted == 2)
  let state = defaults.data(forKey:"todoFocusState")!
  let json = try JSONSerialization.jsonObject(with:state) as! [String:Any]
  precondition(json["completed"] as? Int == 2 && json["focus"] != nil && defaults.data(forKey:"todoFocusSession") == nil,"计数和下一阶段必须保存在同一份记录")
  let snapshotJSON = try JSONSerialization.jsonObject(with:JSONEncoder().encode(timer.snapshot)) as! [String:Any]
  precondition(snapshotJSON["focusCompleted"] as? Int == 2 && snapshotJSON["focusCompletedToday"] as? Int == 2)
  let persisted = store(defaults)
  precondition(persisted.snapshot.focus == timer.snapshot.focus && persisted.snapshot.focusCompleted == 2)
  persisted.stopFocus();timer.stopFocus()
  now = calendar.date(byAdding:.day,value:1,to:now)!
  timer.finishFocusIfNeeded()
  precondition(timer.snapshot.focusCompletedToday == 0 && timer.snapshot.focusCompleted == 2,"跨日只重置今日数量")
  timer.toggleFocus()
  now.addTimeInterval(10 * 24 * 3600)
  timer.finishFocusIfNeeded()
  precondition(timer.snapshot.focus?.isRest == true && timer.snapshot.focusCompleted == 3 && timer.snapshot.focusCompletedToday == 0,"晚醒只结算一轮，并归入其截止日")
  timer.stopFocus()

  let migration = MemoryDefaults(memory:true)
  migration.set(try JSONEncoder().encode(oldSession),forKey:"todoFocusSession")
  let migrated = store(migration)
  precondition(migrated.snapshot.focus?.isRest == true && migrated.snapshot.focusCompleted == 1)
  precondition(migration.data(forKey:"todoFocusSession") == nil)
  let migratedAgain = store(migration)
  precondition(migratedAgain.snapshot.focusCompleted == 1 && migratedAgain.snapshot.focus == migrated.snapshot.focus,"重启后不能重复计数已过期的旧格式会话")
  migrated.stopFocus();migratedAgain.stopFocus()

  let deadlineDefaults = MemoryDefaults(memory:true)
  let realNow = Date().timeIntervalSince1970
  deadlineDefaults.set(try JSONEncoder().encode(TodoFocusSession(startedAt:realNow,endsAt:realNow+0.4)),forKey:"todoFocusSession")
  let deadline = TodoStore(repository:Repository(),defaults:deadlineDefaults,observeSystem:false)
  var delivered = 0
  deadline.onFocusFinished = { _ in delivered += 1 }
  RunLoop.main.run(until:Date().addingTimeInterval(0.8))
  precondition(deadline.snapshot.focus?.isRest == true && deadline.snapshot.focusCompleted == 1 && delivered == 1,"真实截止定时器要切换休息并回调一次")
  deadline.stopFocus()

  let restDefaults = MemoryDefaults(memory:true)
  let restNow = Date().timeIntervalSince1970
  restDefaults.set(try JSONEncoder().encode(TodoFocusSession(startedAt:restNow,endsAt:restNow+0.3,phase:"rest")),forKey:"todoFocusSession")
  let restDeadline = TodoStore(repository:Repository(),defaults:restDefaults,observeSystem:false)
  var restDelivered = 0
  restDeadline.onFocusFinished = { phase in precondition(phase.isRest); restDelivered += 1 }
  RunLoop.main.run(until:Date().addingTimeInterval(0.7))
  precondition(restDeadline.snapshot.focus?.isReady == true && restDeadline.snapshot.focusCompleted == 0 && restDelivered == 1)
  RunLoop.main.run(until:Date().addingTimeInterval(0.2))
  precondition(restDeadline.snapshot.focus?.isReady == true && restDelivered == 1,"真实休息定时器到点后必须等待手动开始")
  restDeadline.stopFocus()

  let alerts = store(MemoryDefaults(memory:true))
  precondition(alerts.saveFocusSettings(TodoFocusSettings(minutes:1,notify:false,breakMinutes:1,systemNotify:false,sound:true)))
  var phases:[String] = []
  alerts.onFocusFinished = { phases.append($0.phase) }
  alerts.toggleFocus();now.addTimeInterval(61);alerts.finishFocusIfNeeded()
  precondition(phases == ["focus"] && alerts.snapshot.focus?.isRest == true,"只开声音仍派发完成事件")
  now.addTimeInterval(61);alerts.finishFocusIfNeeded();alerts.finishFocusIfNeeded()
  precondition(phases == ["focus","rest"] && alerts.snapshot.focus?.isReady == true,"休息结束提醒一次，但不启动下一轮")
  alerts.stopFocus()
  let settingsJSON = try JSONSerialization.jsonObject(with:JSONEncoder().encode(alerts.snapshot.focusSettings)) as! [String:Any]
  precondition(settingsJSON["notify"] as? Bool == false && settingsJSON["systemNotify"] as? Bool == false && settingsJSON["sound"] as? Bool == true)

  var press = TodoFocusPress()
  precondition(press.begin() && !press.begin())
  precondition(press.release(),"单击发一次暂停或继续")
  precondition(press.begin() && press.complete() && !press.complete())
  precondition(!press.release(),"长按结束后的抬起不能再暂停或重启")
  precondition(press.begin() && !press.move(distance:8) && press.move(distance:9))
  precondition(!press.complete() && !press.release(),"移出容差取消长按和点击")
  let center = NotificationCenter()
  let tracker = TodoFocusMenuTracker(center:center)
  var tracking:[Bool] = []
  func drain(until expected:[Bool]) {
   let limit = Date().addingTimeInterval(1)
   while tracking != expected && Date() < limit { RunLoop.main.run(until:Date().addingTimeInterval(0.01)) }
  }
  tracker.onChange = { tracking.append($0) }
  let menu = NSMenu()
  menu.addItem(withTitle:TodoFocusMenuTracker.settingsTitle,action:nil,keyEquivalent:"")
  let submenu = NSMenu(), other = NSMenu()
  center.post(name:NSMenu.didBeginTrackingNotification,object:menu)
  center.post(name:NSMenu.didBeginTrackingNotification,object:submenu)
  center.post(name:NSMenu.didEndTrackingNotification,object:submenu)
  center.post(name:NSMenu.didBeginTrackingNotification,object:other)
  center.post(name:NSMenu.didEndTrackingNotification,object:other)
  drain(until:[true])
  precondition(tracking == [true],"子菜单或其它菜单结束不能提前解除番茄菜单保护")
  center.post(name:NSMenu.didEndTrackingNotification,object:menu)
  drain(until:[true,false])
  precondition(tracking == [true,false],"原生菜单结束后必须解除保护，不能卡住通知岛")
  withExtendedLifetime(observation) {}
  print("focus checks passed")
 }
}
`);
  execFileSync('/usr/bin/xcrun',['swiftc','-suppress-warnings','-parse-as-library',new URL('../macos/Todo.swift',import.meta.url).pathname,probe,'-o',binary,'-framework','AppKit','-framework','WebKit','-framework','EventKit'],{stdio:'pipe',timeout:60000});
  assert.match(execFileSync(binary,[],{encoding:'utf8',timeout:10000,env:{...process.env,HOME:dir,CFFIXED_USER_HOME:dir}}),/focus checks passed/);
 }catch(error){throw new Error(`${error.message}\n${error.stdout||''}\n${error.stderr||''}`);}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});
