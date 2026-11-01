import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {awakeDefaults,normalizeAwakeSettings,createAwake} from '../src/awake.mjs';
const run=promisify(execFile);

test('awake 导航：设置属于设备，通知岛设置进入顶部列表',async()=>{
 const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
 const island=html.slice(html.indexOf('id="islandWorkspace"'),html.indexOf('id="deviceWorkspace"'));
 const device=html.slice(html.indexOf('id="deviceWorkspace"'),html.indexOf('id="settingsWorkspace"'));
 assert.doesNotMatch(island,/id="awakeSettings"|data-device-pane-content="awake"/);
 assert.match(device,/data-device-pane="awake"/);assert.match(device,/data-device-pane-content="awake"/);
 const nav=island.slice(island.indexOf('<nav'),island.indexOf('</nav>'));
 assert.ok(nav.indexOf('data-island-pane="settings"')<nav.indexOf('data-island-pane="butler"'));
 assert.doesNotMatch(island,/<footer class="side-foot">/);
 for(const id of ['rowAwakeDisplaySleep','rowAwakeSystemSleep','rowAwakeScreensaver','rowAwakeLogin'])assert.match(device,new RegExp('class="settings-row" id="'+id+'"><span>'));
 assert.doesNotMatch(device,/<label>\s*<input type="checkbox"/,'不能再把原生复选框放进会撑开的 label 列');
});

test('awake 设置：默认值、严格白名单与部分更新',()=>{
 assert.deepEqual(normalizeAwakeSettings({}),awakeDefaults);
 assert.equal(normalizeAwakeSettings({defaultDuration:'永久'}).defaultDuration,'永久');
 assert.equal(normalizeAwakeSettings({allowDisplaySleep:true}).allowDisplaySleep,true);
 for(const input of [{defaultDuration:'0s'},{defaultDuration:'1h;rm -rf /'},{launchAtLogin:1},{allowDisplaySleep:'true'},{allowScreensaver:true},null,[]])assert.throws(()=>normalizeAwakeSettings(input));
});

test('awake 设置落盘与登录项失败回滚：只调用注入 exec',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-awake-settings-'));
 const calls=[];let broken=false;
 const awake=createAwake({home,platform:'darwin',isolated:true,exec:async args=>{calls.push(args);if(broken)throw Error('launchctl fixture');}});
 try{
  assert.deepEqual(await awake.settings(),awakeDefaults);
  await awake.save({allowDisplaySleep:true});assert.equal(calls.length,0);
  await awake.save({launchAtLogin:true});assert.deepEqual(calls,[['login-sync']]);
  const old=await awake.settings();broken=true;
  await assert.rejects(awake.save({defaultDuration:'2h'}),/已恢复原设置/);
  assert.deepEqual(await awake.settings(),old);
  assert.equal((await fs.stat(path.join(home,'.bobo/awake.json'))).mode&0o777,0o600);
  broken=false;await awake.save({launchAtLogin:false});assert.equal((await awake.settings()).launchAtLogin,false);
  const isolated=createAwake({home,platform:'darwin',isolated:true,executable:'/should-never-execute'});
  await assert.rejects(isolated.save({launchAtLogin:true}),/需要 macOS/);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

// 直接编译交付的 Swift 核心，注入时钟、电源调用与进程身份；不运行 awake CLI、不调用 IOKit / launchctl。
test('awake Swift 核心：时长、JSON、锁、repair、替换、计时与失败恢复', {skip:process.platform!=='darwin',timeout:90000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-awake-core-'));
 try{
  const main=path.join(directory,'probe.swift'),binary=path.join(directory,'probe');
  await fs.writeFile(main,`import Foundation
import IOKit.pwr_mgt

@main enum Probe {
 static func main() throws {
  precondition(try AwakeDuration.parse("10s") == 10)
  precondition(try AwakeDuration.parse("45m") == 2700)
  precondition(try AwakeDuration.parse("8h") == 28800)
  precondition(try AwakeDuration.parse("永久") == nil)
  for value in ["", "0s", "-1h", "1.5h", "1d", "１h", "99999999999999999999h", "NaNh"] {
   do { _ = try AwakeDuration.parse(value); fatalError("必须拒绝非法时长") } catch {}
  }
  let paths = AwakePaths(home: URL(fileURLWithPath: CommandLine.arguments[1]))
  var now = Date(timeIntervalSince1970: 1_800_000_000)
  var events: [String] = [], released: [IOPMAssertionID] = []
  var sequence: IOPMAssertionID = 0
  var failEnable = false, failReset = false, failDisplay = false
  var environment = AwakeEnvironment()
  environment.now = { now }
  environment.processStart = { _ in 1234.5 }
  environment.setClamshell = { enabled in
   events.append(enabled ? "enable" : "reset")
   if (enabled && failEnable) || (!enabled && failReset) { throw AwakeError.message("电源失败 fixture", 1) }
  }
  environment.createAssertion = { display in
   if display && failDisplay { throw AwakeError.message("断言失败 fixture", 1) }
   sequence += 1; events.append(display ? "display" : "system"); return sequence
  }
  environment.releaseAssertion = { released.append($0) }
  let first = AwakeSession(paths: paths, environment: environment)
  try first.withCommand { try first.repair(staleOnly: true); try first.start(duration: 5, allowDisplaySleep: false, allowSystemSleepOnDisplayOff: false, replace: false) }
  precondition(events == ["reset", "enable", "system", "display"])
  let state = try first.readState()!
  precondition(state.heartbeat == now && state.endsAt == now.addingTimeInterval(5))
  let roundtrip = try AwakeJSON.decode(AwakeState.self, AwakeJSON.encode(state))
  precondition(roundtrip == state)
  let json = try JSONSerialization.jsonObject(with: AwakeJSON.encode(first.status())) as! [String: Any]
  precondition(json["active"] as? Bool == true && json["phase"] as? String == "active")
  let fields = json["state"] as! [String: Any]
  for key in ["pid", "startedAt", "endsAt", "allowDisplaySleep", "allowSystemSleepOnDisplayOff", "heartbeat", "processStartedAt", "sessionID"] { precondition(fields[key] != nil) }
  precondition(AwakeStatus.make(state: nil, ownerAlive: false).phase == "idle")
  precondition(AwakeStatus.make(state: state, ownerAlive: false).phase == "orphaned")
  var reused = environment; reused.processStart = { _ in 1234.6 }; precondition(!reused.ownerAlive(state))
  let second = AwakeSession(paths: paths, environment: environment)
  events.removeAll()
  try second.withCommand { try second.repair(staleOnly: true) }
  precondition(events.isEmpty, "启动自检不能打断活会话")
  do {
   try second.withCommand { try second.start(duration: nil, allowDisplaySleep: false, allowSystemSleepOnDisplayOff: false, replace: false) }
   fatalError("重复会话必须拒绝")
  } catch let error as AwakeError { precondition(error.code == 3) }
  now = now.addingTimeInterval(1)
  precondition(try first.tick()); precondition(try first.readState()!.heartbeat == now)
  now = now.addingTimeInterval(4)
  precondition(try !first.tick()); precondition(released.count == 2 && events == ["reset"])
  precondition(try first.readState() == nil)
  try second.withCommand { try second.repair(staleOnly: false); try second.repair(staleOnly: false) }
  // 模拟崩溃残留和损坏的 JSON，锁已释放时都能幂等修复。
  try AwakeJSON.encode(state).write(to: paths.state)
  events.removeAll(); try second.withCommand { try second.repair(staleOnly: true) }
  precondition(try events == ["reset"] && second.readState() == nil)
  try Data("broken".utf8).write(to: paths.state)
  precondition(second.status().phase == "error")
  try second.withCommand { try second.repair(staleOnly: true) }
  // 两个选项确实改变实际调用：不置合盖位，也不创建显示断言。
  events.removeAll()
  try second.withCommand { try second.start(duration: nil, allowDisplaySleep: true, allowSystemSleepOnDisplayOff: true, replace: false) }
  precondition(events == ["reset", "system"])
  try second.finish()
  // --replace 必须先通知已验证的持有者退出，再获得同一把会话锁。
  try first.withCommand { try first.start(duration: nil, allowDisplaySleep: true, allowSystemSleepOnDisplayOff: false, replace: false) }
  environment.signal = { pid in precondition(pid == state.pid); try! first.finish(); return 0 }
  let replacement = AwakeSession(paths: paths, environment: environment)
  try replacement.withCommand { try replacement.start(duration: 5, allowDisplaySleep: true, allowSystemSleepOnDisplayOff: false, replace: true) }
  try replacement.finish()
  failEnable = true
  do { try first.withCommand { try first.start(duration: 5, allowDisplaySleep: false, allowSystemSleepOnDisplayOff: false, replace: false) }; fatalError() } catch {}
  precondition(try first.readState() == nil)
  failEnable = false; failDisplay = true
  let before = released.count
  do { try first.withCommand { try first.start(duration: 5, allowDisplaySleep: false, allowSystemSleepOnDisplayOff: false, replace: false) }; fatalError() } catch {}
  precondition(try released.count == before + 1 && first.readState() == nil)
  failDisplay = false
  try first.withCommand { try first.start(duration: 5, allowDisplaySleep: false, allowSystemSleepOnDisplayOff: false, replace: false) }
  failReset = true
  do { try first.finish(); fatalError() } catch {}
  precondition(try first.readState() != nil, "复位失败不能删除恢复凭据")
  failReset = false
  try first.withCommand { try first.repair(staleOnly: true) }
  precondition(try first.readState() == nil)
  print("awake 核心验证通过")
 }
}
`);
  // 普通 Bool 参数在调用处求值，可直接验证 throwing 的纯函数。
  let source=await fs.readFile(main,'utf8');
  source=source.replaceAll('precondition(', 'expect(').replace('@main enum Probe {','func expect(_ value: Bool, _ message: String = "") { precondition(value, message) }\n@main enum Probe {');
  await fs.writeFile(main,source);
  const env={...process.env,CLANG_MODULE_CACHE_PATH:path.join(os.tmpdir(),'bobo-awake-module-cache'),SWIFT_MODULECACHE_PATH:path.join(os.tmpdir(),'bobo-awake-module-cache')};
  await run('/usr/bin/xcrun',['swiftc',path.resolve('macos/Awake.swift'),main,'-o',binary,'-framework','IOKit'],{env,timeout:75000,maxBuffer:1024*1024});
  const result=await run(binary,[directory],{timeout:10000});assert.match(result.stdout,/核心验证通过/);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
