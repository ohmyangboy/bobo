import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// 从 Bobo.swift 里截一段纯声明编译成小程序跑（不起 App）：验证几何与补间这些不依赖窗口的逻辑。
async function checkSwift(slice, body) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-island-layout-'));
 try{
  const file=path.join(dir,'check.swift');
  await fs.writeFile(file,'import AppKit\nimport SwiftUI\n'+slice+'\n'+body);
  execFileSync('/usr/bin/xcrun',['swift',file],{stdio:'pipe',timeout:60000});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
}
// 按起止标记从 Bobo.swift 取一段源码；标记找不到就报错，改动把切片弄断时测试会立刻失败。
async function swiftSlice(start, end) {
 const source=await fs.readFile(fileURLToPath(new URL('./Bobo.swift',import.meta.url)),'utf8');
 const from=source.indexOf(start), to=source.indexOf(end,from);
 assert.ok(from>=0&&to>from,`没有找到切片：${start} → ${end}`);
 return source.slice(from,to);
}

test('通知岛动画：非对称两翼变化时让位中心与顶边保持稳定，中途反向连续', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandBarLayout:','// 顶部栏的排布计算（纯函数'),`
func near(_ a: CGFloat, _ b: CGFloat) { precondition(abs(a-b) < 0.00001, "坐标不连续或锚点漂移") }
let collapsed = IslandBarLayout(left: 110, keepOut: 180, right: 60, notched: true)
let expanded = IslandBarLayout(left: 110, keepOut: 180, right: 114, notched: true)
let a = NSRect(x: 500-400/2, y: 1000-32, width: 400, height: 32)
let b = NSRect(x: 500-500/2, y: 1000-210, width: 500, height: 210)
for i in 0...60 {
 let step = IslandLayoutTween.sample(from: a, to: b, fromLayout: collapsed, toLayout: expanded, progress: CGFloat(i)/60)
 let top = IslandLayoutTween.barFrame(width: step.frame.width, height: 32, layout: step.layout)
 let center = step.frame.minX + top.minX + step.layout.left + step.layout.keepOut/2
 near(top.width, step.layout.left + step.layout.keepOut + step.layout.right)
 // 固定让位区两端，列表变宽不会把两组内容向外推。
 near(step.frame.minX + top.minX + step.layout.left, 410)
 near(step.frame.minX + top.minX + step.layout.left + step.layout.keepOut, 590)
 near(center, 500)
 near(step.frame.maxY, 1000)
 precondition(step.frame.width-step.layout.left-step.layout.right >= step.layout.keepOut)
}
let mid = IslandLayoutTween.sample(from: a, to: b, fromLayout: collapsed, toLayout: expanded, progress: 0.4)
let reversed = IslandLayoutTween.sample(from: mid.frame, to: a, fromLayout: mid.layout, toLayout: collapsed, progress: 0)
precondition(reversed.frame == mid.frame && reversed.layout == mid.layout)
let finish = IslandLayoutTween.sample(from: mid.frame, to: a, fromLayout: mid.layout, toLayout: collapsed, progress: 1)
near(finish.frame.minX, a.minX)
near(finish.frame.width, a.width)
near(finish.layout.right, collapsed.right)
let floating = IslandBarLayout(left: 80, keepOut: 5, right: 50)
let floatingBar = IslandLayoutTween.barFrame(width: 460, height: 32, layout: floating)
near(floatingBar.minX, 0)
near(floatingBar.width, 460)
`);
});

// 让位（防遮挡菜单栏 / 全屏应用）时窗口补间收拢到刘海正中那一小段（随后整体淡出到不可见）：
// 收拢尺寸要装得下、要整块落在刘海区域里，并且内容按整个窗口铺开——这几条决定了「缩进刘海」是不是真的收进去了。
test('通知岛让位：收拢尺寸落在刘海区域内，内容铺满整窗', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable {','struct IslandSnapshot: Decodable {'),`
func near(_ a: CGFloat, _ b: CGFloat) { precondition(abs(a-b) < 0.00001, "收拢尺寸或分区不对") }
// 高度按菜单栏 / 刘海高度往下留一点，太矮时兜底 18；宽度固定成一小段。
near(IslandBarGeometry.yieldSize(barHeight: 32).width, 44)
near(IslandBarGeometry.yieldSize(barHeight: 32).height, 26)
near(IslandBarGeometry.yieldSize(barHeight: 24).height, 18)
near(IslandBarGeometry.yieldSize(barHeight: 12).height, 18)
// 刘海屏（1600 宽、刘海 200）：收拢后居中，整块落在刘海 [700, 900] 里，最后那点内容消失在刘海区域。
let yield = IslandBarGeometry.yieldSize(barHeight: 32)
let yieldRect = NSRect(x: 800-yield.width/2, y: 1000-yield.height, width: yield.width, height: yield.height)
precondition(yieldRect.minX > 700 && yieldRect.maxX < 900 && yieldRect.maxY <= 1000)
// 让位态的分区：两翼收成 0、没有让位区，barFrame 铺满整个窗口，内容不会在收拢途中被挤到一边。
let layout = IslandBarLayout(left: 0, keepOut: 0, right: 0)
let bar = IslandLayoutTween.barFrame(width: yield.width, height: yield.height, layout: layout)
near(bar.minX, 0)
near(bar.width, yield.width)
// 从正常胶囊缩到收拢尺寸：宽度一路收窄，顶边始终贴着屏幕（不会往下掉）。
let normal = NSRect(x: 800-250/2, y: 1000-32, width: 250, height: 32)
let fromLayout = IslandBarLayout(left: 60, keepOut: 200, right: 60, notched: true)
for i in 0...60 {
 let step = IslandLayoutTween.sample(from: normal, to: yieldRect, fromLayout: fromLayout, toLayout: layout, progress: CGFloat(i)/60)
 near(step.frame.maxY, 1000)
 precondition(step.frame.width <= normal.width + 0.0001 && step.frame.width >= yield.width - 0.0001)
}
`);
});

// 会话计时（对齐 CodeIsland 的 SessionTag）：文案只看「会话开始至今」的秒数——`<1m` / `5m` / `2h` / `1d`，
// 没记到开始时间（老数据）就不显示；时钟漂移导致的负值按「刚开始」处理，不会倒着走。
test('通知岛计时：会话时长的文案分档', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable {','struct IslandSnapshot: Decodable {'),`
 let now: Double = 1_700_000_000_000
 precondition(IslandMetrics.elapsedText(nil, now: now) == nil)
 precondition(IslandMetrics.elapsedText(0, now: now) == nil)
 precondition(IslandMetrics.elapsedText(now - 30_000, now: now) == "<1m")
 precondition(IslandMetrics.elapsedText(now - 60_000, now: now) == "1m")
 precondition(IslandMetrics.elapsedText(now - 5*60_000, now: now) == "5m")
 precondition(IslandMetrics.elapsedText(now - 59*60_000, now: now) == "59m")
 precondition(IslandMetrics.elapsedText(now - 3600_000, now: now) == "1h")
 precondition(IslandMetrics.elapsedText(now - 26*3600_000, now: now) == "1d")
 precondition(IslandMetrics.elapsedText(now + 5_000, now: now) == "<1m")
`);
});

// 额度并排显示的取舍（展开并排 + 自适应）：固定上限（3 / 5 / 7）只封顶，自适应按「中轴线到屏幕边缘」
// 的剩余空间算——不管怎么变，排出来的宽度都不越过展开后的中轴线，装不下时至少留一枚。
test('通知岛额度：并排显示的固定上限与自适应数量', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable {','struct IslandSnapshot: Decodable {'),`
 let wide: CGFloat = 1512, keepOut: CGFloat = 214
 // 没有可用来源 → 0 枚；只有一家 → 1 枚（不并排，但也不隐藏）。
 precondition(IslandBarGeometry.quotaChips(count: 0, limit: 0, screenWidth: wide, keepOut: keepOut, device: true, hoverButtons: true) == 0)
 precondition(IslandBarGeometry.quotaChips(count: 1, limit: 0, screenWidth: wide, keepOut: keepOut, device: true, hoverButtons: true) == 1)
 // 固定上限：3 家封顶时 5 家只排 3 枚；上限大于来源数时按来源数。
 precondition(IslandBarGeometry.quotaChips(count: 5, limit: 3, screenWidth: wide, keepOut: keepOut, device: true, hoverButtons: true) == 3)
 precondition(IslandBarGeometry.quotaChips(count: 3, limit: 7, screenWidth: wide, keepOut: keepOut, device: true, hoverButtons: true) == 3)
 // 自适应：内置刘海屏（1512 宽）上 5 家都排得下。
 precondition(IslandBarGeometry.quotaChips(count: 5, limit: 0, screenWidth: wide, keepOut: keepOut, device: true, hoverButtons: true) == 5)
 // 窄屏 / 有刘海时按空间收缩：600 宽、设备指示占一格、中轴线到右缘剩 159pt，
 // 5 枚额度 + 设备共 6 格 = 157pt（再来一枚 184pt 就放不下）。
 precondition(IslandBarGeometry.quotaChips(count: 8, limit: 0, screenWidth: 600, keepOut: keepOut, device: true, hoverButtons: false) == 5)
 // 遍历各种屏幕宽度与悬停状态：数量在 1...count 之间，且排出来的宽度不越过中轴线。
 for width in stride(from: 320.0, through: 1800.0, by: 40.0) {
  for device in [false, true] {
   for hover in [false, true] {
    let shown = IslandBarGeometry.quotaChips(count: 8, limit: 0, screenWidth: width, keepOut: keepOut, device: device, hoverButtons: hover)
    precondition(shown >= 1 && shown <= 8, "自适应数量越界")
    if shown > 1 {
     let reserved = (device ? 1 : 0) + (hover ? 2 : 0)
     let chips = shown + reserved
     let used = CGFloat(chips) * IslandMetrics.itemSize + IslandMetrics.itemSpacing * CGFloat(max(0, chips - 1))
     let space = (width - IslandMetrics.screenEdgeMargin * 2) / 2 - keepOut / 2 - IslandMetrics.barEdge
     precondition(used <= space + 0.0001, "并排显示越过了展开后的中轴线")
    }
   }
  }
 }
 // 固定上限同样受空间约束：窄屏上即使选了 7 家也不会越过中轴线。
 let capped = IslandBarGeometry.quotaChips(count: 8, limit: 7, screenWidth: 400, keepOut: keepOut, device: true, hoverButtons: true)
 precondition(capped < 7 && capped >= 1)
`);
});

// 每枚圆环各自显示一档窗口：快照里的 range（服务端记住）决定这一家画哪一档，
// 认不出的范围退回 5 小时、再退回第一档；并排显示的来源只算「可用 + 开启」，顺序稳定。
test('通知岛额度：圆环显示的范围与并排来源的取舍', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable {','struct IslandSnapshot: Decodable {'),`
 func provider(_ json: String) throws -> IslandQuotaProvider { try JSONDecoder().decode(IslandQuotaProvider.self, from: Data(json.utf8)) }
 let three = try! provider(#"{"id":"opencode-go","available":true,"enabled":true,"range":"month","windows":[{"key":"session","remainingPercent":97},{"key":"week","remainingPercent":86},{"key":"month","remainingPercent":48}]}"#)
 precondition(three.displayWindow?.key == "month", "记住的范围没有生效")
 precondition(three.showable)
 // 认不出的范围（这家没返回这一档）退回 5 小时窗口；只有周窗口的套餐退回第一档。
 let unknown = try! provider(#"{"id":"codex","available":true,"range":"month","windows":[{"key":"session","remainingPercent":75},{"key":"week","remainingPercent":70}]}"#)
 precondition(unknown.displayWindow?.key == "session", "认不出的范围该退回 5 小时")
 let weekOnly = try! provider(#"{"id":"codex","available":true,"range":"session","windows":[{"key":"week","remainingPercent":70}]}"#)
 precondition(weekOnly.displayWindow?.key == "week", "没有 5 小时窗口该退回第一档")
 // 关掉 / 不可用的来源不画圆环。
 let off = try! provider(#"{"id":"agy","available":true,"enabled":false,"windows":[{"key":"session","remainingPercent":90}]}"#)
 precondition(!off.showable, "关掉的来源不该参与并排")
 let gone = try! provider(#"{"id":"agy","available":false,"windows":[{"key":"session","remainingPercent":90}]}"#)
 precondition(!gone.showable, "不可用的来源不该参与并排")
 // 并排显示的来源：可用 + 开启 + 有窗口，顺序照服务端；provider(id:) 只认这一组，displayed 认选中的那家。
 let quota = try! JSONDecoder().decode(IslandQuota.self, from: Data(#"{"available":true,"selected":"agy","providers":[{"id":"codex","available":true,"windows":[{"key":"session","remainingPercent":75}]},{"id":"opencode-go","available":true,"enabled":false,"windows":[{"key":"session","remainingPercent":97}]},{"id":"agy","available":true,"range":"week","windows":[{"key":"session","remainingPercent":90},{"key":"week","remainingPercent":80}]}]}"#.utf8))
 precondition(quota.subscriptions.map { $0.id } == ["codex","agy"], "并排来源的顺序或过滤不对")
 precondition(quota.displayed?.id == "agy")
 precondition(quota.switchable)
 precondition(quota.provider(id: "opencode-go") == nil, "关掉的来源不该出现在明细卡里")
 precondition(quota.provider(id: "agy")?.displayWindow?.key == "week")
`);
});
