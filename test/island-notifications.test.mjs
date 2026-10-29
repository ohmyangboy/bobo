import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createOpenCode} from '../src/opencode.mjs';

test('macOS 所有岛音效交给原生通知，声音与横幅开关独立',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-island-sound-'));
 const client=createOpenCode({home,platform:'darwin',soundPlayer:()=>assert.fail('macOS 不能在服务端直接播音')});
 let emitted=0;client.subscribe(()=>emitted++);
 try{
  for(const [kind,sound] of Object.entries({question:'Ping.aiff',done:'Glass.aiff',error:'Basso.aiff',reset:'Hero.aiff'})){
   client.remind(kind,'标题','正文');
   assert.deepEqual({...client.snapshot().notice,seq:0,at:0},{seq:0,kind,title:'标题',message:'正文',notify:true,sound,at:0});
  }
  await client.saveSettings({notify:false,sound:true});
  client.remind('done','只响声音','');
  assert.equal(client.snapshot().notice.notify,false);
  assert.equal(client.snapshot().notice.sound,'Glass.aiff');
  await client.saveSettings({notify:true,sound:false});
  client.remind('question','无声横幅','');
  assert.equal(client.snapshot().notice.notify,true);
  assert.equal(client.snapshot().notice.sound,null);
  await client.saveSettings({notify:false,sound:false});
  const before=client.snapshot().notice,count=emitted;
  client.remind('error','都关掉','');
  assert.equal(client.snapshot().notice,before);
  assert.equal(emitted,count,'两个开关都关掉时不推送提醒');
 }finally{client.stop();await fs.rm(home,{recursive:true,force:true});}
});

test('Windows 保留服务端声音，关闭提示音后不会播放',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-island-sound-win-')),played=[];
 const client=createOpenCode({home,platform:'win32',soundPlayer:name=>played.push(name)});
 try{
  await client.saveSettings({notify:false,sound:true});
  client.remind('question','标题','正文');
  assert.deepEqual(played,['Ping.aiff']);
  assert.equal(client.snapshot().notice,null);
  await client.saveSettings({notify:true,sound:false});
  client.remind('done','标题','正文');
  assert.deepEqual(played,['Ping.aiff']);
  assert.equal(client.snapshot().notice.sound,null,'原生横幅不能再播一遍服务端音效');
 }finally{client.stop();await fs.rm(home,{recursive:true,force:true});}
});

// 编译实际通知策略，只构造 UN 内容，不请求 TCC、不发通知、不读真实专注状态。
test('原生普通通知遵守专注信号，未知状态留给系统裁决', {skip:process.platform!=='darwin'},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-island-notifications-'));
 try{
  const source=await fs.readFile(new URL('../macos/Bobo.swift',import.meta.url),'utf8');
  const start=source.indexOf('struct IslandNotice: '),end=source.indexOf('// 额度窗口：',start);
  assert.ok(start>=0&&end>start);
  const check=path.join(dir,'Check.swift'),binary=path.join(dir,'check');
  await fs.writeFile(check,`import Foundation
import UserNotifications
${source.slice(start,end)}
@main struct Check {
 static func main() throws {
  let payload = Data(#"{"seq":1,"kind":"done","title":"标题","message":"正文","at":1}"#.utf8)
  let old = try JSONDecoder().decode(IslandNotice.self, from: payload)
  precondition(old.notify == nil && old.sound == nil, "兼容旧服务的无声通知")
  for name in ["Ping.aiff", "Glass.aiff", "Basso.aiff", "Hero.aiff"] {
   for focused: Bool? in [false, true, nil] {
    for notify in [false, true] {
     for enabled in [false, true] {
      let content = IslandNotifications.content(title: "标题", message: "正文", notify: notify,
        sound: enabled ? name : nil, isSuppressed: { focused })
      let hasSound = enabled && focused != true
      precondition((content != nil) == (notify || hasSound))
      guard let content else { continue }
      precondition(content.interruptionLevel == .active, "普通通知不突破专注")
      precondition((content.sound != nil) == hasSound)
      precondition(content.title == (notify ? "标题" : ""))
      precondition(content.body == (notify ? "正文" : ""), "只开声音不能出现横幅正文")
      let options = IslandNotifications.presentation(content, notify: true, sound: true, isSuppressed: { focused })
      precondition(options.contains(.banner) == notify)
      precondition(options.contains(.sound) == hasSound)
      let suppressed = IslandNotifications.presentation(content, notify: true, sound: true, isSuppressed: { true })
      precondition(!suppressed.contains(.sound), "投递前切换专注也要静音")
      let disabled = IslandNotifications.presentation(content, notify: false, sound: false, isSuppressed: { false })
      precondition(disabled.isEmpty, "排队后关掉开关仍不播音")
     }
    }
   }
  }
  precondition(IslandNotifications.content(title: "", message: "", notify: false, sound: "other.aiff", isSuppressed: { false }) == nil)
  precondition(IslandNotifications.content(title: "", message: "", notify: true, sound: nil, isSuppressed: { false })?.title == "bobo")
 }
}
`);
  execFileSync('/usr/bin/xcrun',['swiftc','-parse-as-library',fileURLToPath(new URL('../macos/IslandNotifications.swift',import.meta.url)),check,'-o',binary],{stdio:'pipe',timeout:60000});
  execFileSync(binary,[],{stdio:'pipe',timeout:10000});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
