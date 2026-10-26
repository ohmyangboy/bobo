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

test('单行顶栏：按钮与红黄绿区域透传，只有同尺寸的顶栏空白可以拖动', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct TitlebarHitMap {','// 原生拖动与双击缩放'),`
let size = NSSize(width: 760, height: 52)
let payload: [String: Any] = ["width": 760.0, "height": 52.0, "controls": [[134.0, 8.0, 90.0, 36.0], [712.0, 8.0, 36.0, 36.0]]]
let map = TitlebarHitMap(payload: payload)!
precondition(map.canDrag(at: NSPoint(x: 500, y: 26), size: size))
precondition(!map.canDrag(at: NSPoint(x: 180, y: 26), size: size), "导航按钮不能变成拖动窗口")
precondition(!map.canDrag(at: NSPoint(x: 730, y: 26), size: size), "设置按钮必须透传")
precondition(!map.canDrag(at: NSPoint(x: 60, y: 26), size: size), "红黄绿区域交给系统")
precondition(!map.canDrag(at: NSPoint(x: 500, y: 60), size: size), "正文不能拖动窗口")
precondition(!map.canDrag(at: NSPoint(x: 500, y: 26), size: NSSize(width: 900, height: 52)), "缩放期间旧范围不能挡按钮")
precondition(TitlebarHitMap(payload: [:]) == nil)
precondition(TitlebarHitMap(payload: ["width": Double.nan, "height": 52.0, "controls": [[Double]]()]) == nil)
precondition(TitlebarHitMap(payload: ["width": 760.0, "height": 52.0, "controls": [[134.0, 8.0, -90.0, 36.0]]]) == nil)
`);
});

test('通知岛省电：折叠常驻静态，只有可见展开态允许呼吸', {skip:process.platform!=='darwin'}, async()=>{
 const declarations=await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {');
 const model=await swiftSlice('enum IslandDetailKind:','// 通知岛面板：黑色卡片贴住刘海');
 await checkSwift(declarations+'\n'+model,`
let model = IslandModel()
precondition(model.onScreen && !model.motionActive)
model.hovering = true
precondition(model.motionActive)
model.screenAwake = false
precondition(!model.motionActive)
model.screenAwake = true
precondition(model.motionActive)
model.yielding = true
precondition(!model.motionActive)
model.yielding = false
model.settings.notch = false
precondition(!model.motionActive)
model.settings.notch = true
model.hovering = false
model.autoRevealed = true
precondition(model.motionActive)
model.settings.autoExpand = false
precondition(!model.motionActive)
model.settings.hideWhenIdle = true
model.hovering = true
precondition(!model.motionActive)
`);
});

test('管家多项目列表：兼容旧快照，紧凑视口不随历史增长，全部项目可滚动查看', {skip:process.platform!=='darwin'}, async()=>{
 const declarations=await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','// 悬停明细卡的内容类型');
 const model=await swiftSlice('enum IslandDetailKind:','// 通知岛面板：黑色卡片贴住刘海');
 await checkSwift(declarations+'\n'+model,`
let legacy = try JSONDecoder().decode(IslandSnapshot.self, from: Data(#"{"connected":false,"sessions":[],"settings":{}}"#.utf8))
precondition(legacy.butler == nil)
let payload = #"{"enabled":true,"revision":3,"status":"ready","message":"自动更新","lead":{"id":"p","name":"项目","text":"构建通过，需要验收","updatedAt":1000,"summaryAt":1000}}"#
let butler = try JSONDecoder().decode(IslandButler.self, from: Data(payload.utf8))
precondition(butler.text == "项目：构建通过，需要验收")
precondition(butler.projects.count == 1 && butler.height == 88, "旧单行快照兼容为一张项目卡片")
var multiple = butler
multiple.recentProjects = (0..<8).map { IslandButlerLead(id: "p\\($0)", name: "项目\\($0)", text: "有新进展", updatedAt: 1000, summaryAt: 1000) }
precondition(multiple.projects.count == 8, "超过三项的项目不能丢弃")
precondition(multiple.height == 192, "最近三项决定初始视口，其余滚动；不能无限增加窗口高度")
multiple.recentProjects = []
precondition(multiple.projects.isEmpty && multiple.height == 64, "显式空列表不能错误地恢复旧 lead")
let model = IslandModel()
model.butler = butler
precondition(model.butlerHeight == 0 && !model.expanded, "管家更新不能自己展开刘海")
model.hovering = true
precondition(model.butlerHeight == 88)
multiple.recentProjects = [butler.lead!, butler.lead!]
model.butler = multiple
precondition(model.butlerHeight == 140, "项目数量变化时窗口高度随之变化")
model.butler?.enabled = false
precondition(model.butlerHeight == 0)
model.butler = butler
model.hovering = false
model.autoRevealed = true
precondition(model.butlerHeight == 88)
model.settings.autoExpand = false
precondition(model.butlerHeight == 0)
`);
});

test('管家消息流：同项目多条消息保持独立，空消息不恢复旧摘要，视口有上限', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandButlerLead:','struct IslandSnapshot:'),`
let payload = #"{"enabled":true,"revision":2,"status":"ready","message":"新进展","lead":{"id":"legacy","name":"旧摘要","text":"旧文案","updatedAt":1000,"summaryAt":1000},"messages":[{"id":"m1","projectId":"bobo","name":"bobo","text":"已调整布局。","at":1000,"summaryAt":1000,"role":"butler","source":"codex"},{"id":"m2","projectId":"bobo","name":"bobo","text":"继续验证。","at":2000,"summaryAt":0,"role":"user","source":"codex","delivery":"sent"}]}"#
var butler = try JSONDecoder().decode(IslandButler.self, from: Data(payload.utf8))
precondition(butler.displayMessages.map(\\.id) == ["m1", "m2"])
precondition(butler.displayMessages[1].delivery == "sent" && butler.height == 140)
let template = butler.displayMessages[0]
butler.messages = (0..<80).map { i in var message = template; message.id = "m\\(i)"; return message }
precondition(butler.displayMessages.count == 80 && butler.height == 192, "历史增长不能撑高窗口")
butler.messages = []
precondition(butler.displayMessages.isEmpty && butler.height == 64, "显式空消息不能退回旧摘要")
var withRequest = template
withRequest.request = String(repeating: "原始指令\\n", count: 40)
butler.messages = (0..<80).map { i in var message = withRequest; message.id = "q\\(i)"; return message }
precondition(butler.visibleListHeight(measured: 5000) == 184 && butler.visibleListHeight(measured: 5000, replying: true) == 112, "长引用和大量历史不能撑高通知岛；回复时收紧消息区")
precondition(butler.visibleListHeight(measured: 60) == 60 && butler.visibleListHeight(measured: .nan) == butler.listHeight, "短消息按测得的高度显示，不补齐固定行数")
butler.enabled = false
precondition(butler.height == 0)
`);
});

test('通知岛便捷回复：收起保留草稿，按回执清空或保留；编辑时保持展开且高度有限', {skip:process.platform!=='darwin'}, async()=>{
 const declarations=await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {');
 const model=await swiftSlice('enum IslandDetailKind:','// 通知岛面板：黑色卡片贴住刘海');
 await checkSwift(declarations+'\n'+model,`
let message = IslandButlerMessage(id: "m1", projectId: "bobo", name: "bobo", text: "已完成布局调整。", at: 1000, summaryAt: 1000, role: "butler", source: "codex")
var draft = IslandButlerReplyDraft()
precondition(!draft.isOpen && draft.height == 0 && !draft.canSend)
draft.open(message: message)
draft.edit("继续验证\\n保留当前布局")
let requestId = draft.requestId
draft.isOpen = false
draft.isOpen = true
precondition(draft.text == "继续验证\\n保留当前布局" && draft.message?.id == "m1" && draft.requestId == requestId, "收起 / 重开不能丢草稿或产生新的发送请求")
draft.sending = true
draft.edit("不能覆盖发送中的指令")
precondition(draft.text.contains("继续验证") && !draft.canSend)
func receipt(_ json: String) throws -> IslandButlerReplyReceipt { try JSONDecoder().decode(IslandButlerReplyReceipt.self, from: Data(json.utf8)) }
draft.receive(try receipt(#"{"status":"failed","reason":"原会话未找到","retryable":true,"target":{"name":"bobo","source":"codex","title":"开发管家"}}"#))
precondition(!draft.sending && draft.canSend && draft.text.contains("继续验证") && draft.requestId == requestId)
draft.receive(try receipt(#"{"status":"failed","reason":"Otty 未开启程序输入","retryable":true,"action":"enable-otty-input"}"#))
precondition(draft.needsOttyInput && draft.canSend && !draft.enableOttyInput, "只能显示开启按钮，不能自动授权")
draft.enableOttyInput = true
draft.receive(try receipt(#"{"status":"failed","reason":"原会话已关闭","retryable":true}"#))
precondition(!draft.needsOttyInput && !draft.enableOttyInput && draft.requestId == requestId, "回执清除授权意图但保留原请求防重")
draft.receive(try receipt(#"{"status":"failed","reason":"未确认送达","retryable":false}"#))
precondition(draft.uncertain && !draft.canSend && draft.requestId == requestId, "未知送达不能自动重发")
draft.edit("继续进行真机验证")
precondition(draft.canSend && draft.requestId != requestId && !draft.uncertain)
draft.open(message: nil)
draft.receive(try receipt(#"{"status":"choose","candidates":[{"id":"codex:one","name":"bobo","source":"codex","title":"管家开发"},{"id":"claude:two","name":"paper-blog","source":"claude","title":"发布博客"}]}"#))
precondition(draft.candidates.count == 2 && draft.targetId == nil && draft.text == "继续进行真机验证")
draft.choose(draft.candidates[1])
precondition(draft.targetId == "claude:two" && draft.canSend)
draft.receive(try receipt(#"{"status":"sent","target":{"name":"paper-blog","source":"claude","title":"发布博客"}}"#))
precondition(draft.text.isEmpty && draft.message == nil && draft.candidates.isEmpty && !draft.canSend && draft.hint.contains("paper-blog"), "实际 API 回执没有目标 id，仍需正确解码并清空草稿")
draft.edit(String(repeating: "字", count: 4200))
precondition(draft.text.count == 4096)
draft.edit("")
draft.addImages([Data([1, 2, 3])])
precondition(draft.canSend && draft.images.count == 1, "支持纯图片草稿")
let imageRequest = draft.requestId
draft.isOpen = false; draft.isOpen = true
precondition(draft.images.count == 1 && draft.requestId == imageRequest)
draft.receive(try receipt(#"{"status":"failed","reason":"未送达","retryable":true}"#))
precondition(draft.images.count == 1, "失败保留图片")
draft.removeImage(draft.images[0].id)
precondition(!draft.canSend && draft.requestId != imageRequest)
draft.addImages([Data([1])]); draft.receive(try receipt(#"{"status":"sent"}"#))
precondition(draft.images.isEmpty, "发送成功清空图片")
let model = IslandModel()
model.settings.autoExpand = false; model.settings.hideWhenIdle = true
model.butler = IslandButler(enabled: true, revision: 1, status: "ready", message: "新进展", messages: [message])
precondition(!model.expanded && !model.visible && model.butlerHeight == 0)
model.butlerReply.open(message: message)
precondition(model.expanded && model.visible && model.butlerHeight == 88 + model.butlerReply.height, "打字时鼠标离开不能收起便捷回复")
model.butlerContentHeight = 70
model.butlerComposerHeight = 100
precondition(model.butlerHeight == 206, "窗口高度要采用原生排版的实际测量值")
model.butlerContentHeight = 5000
precondition(model.butlerHeight == 248, "展开回复时消息区最多 112 点，不能被大量历史撑开")
model.butlerReply.receive(try receipt(#"{"status":"failed","reason":"未送达","retryable":true}"#))
precondition(model.butlerReply.height <= 230)
model.butlerReply.isOpen = false
precondition(!model.expanded && model.butlerHeight == 0)
`);
});

test('管家原生排版：引用按内容撑高，最多三行，换行与窄宽度均不留固定空白', {skip:process.platform!=='darwin'}, async()=>{
 const declarations=await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot:');
 const views=await swiftSlice('struct IslandButlerList:','// 会话行：悬停高亮');
 const avatar=await swiftSlice('struct IslandAvatarFace: View {','struct IslandAvatar: View {');
 await checkSwift(declarations+'\n'+avatar+'\n'+views,`
NSApplication.shared.setActivationPolicy(.prohibited)
func rowHeight(_ request: String?, width: CGFloat = 560) -> CGFloat {
    let message = IslandButlerMessage(id: "preview", projectId: "bobo", name: "bobo", text: "已修复，待验收。", at: 1000, summaryAt: 1000, role: "butler", request: request)
    let host = NSHostingView(rootView: IslandButlerMessageRow(message: message, avatarImage: nil, onFocus: {}, onQuote: {}).frame(width: width))
    host.frame = NSRect(x: 0, y: 0, width: width, height: 200)
    host.layoutSubtreeIfNeeded()
    return host.fittingSize.height
}
let plain = rowHeight(nil)
let one = rowHeight("翻译这个选项")
let two = rowHeight("翻译这个选项\\n检查音量键")
let three = rowHeight("翻译这个选项\\n检查音量键\\n编译后部署")
let forty = rowHeight((["翻译这个选项", "检查音量键", "编译后部署"] + Array(repeating: "不要额外展示", count: 37)).joined(separator: "\\n"))
precondition(plain < one && one < two && two < three, "一行、两行引用必须分别更矮，不能预留三行的高度")
precondition(abs(three-forty) < 1, "超过三行只截断，不能继续增加气泡高度")
precondition(plain < 50 && one < 65 && three < 95, "头像、气泡留白与行间距应保持紧凑")
precondition(rowHeight("用业界常用的术语翻译一下这个音频调整选项", width: 300) > rowHeight("用业界常用的术语翻译一下这个音频调整选项"), "窄面板要按实际换行撑高")
precondition(rowHeight("   \\n  ") == plain, "空白引用不应占高度")
let requests = ["翻译这个选项", "翻译这个选项\\n检查音量键", "翻译这个选项\\n检查音量键\\n编译后部署"]
let messages = requests.enumerated().map { index, request in
    IslandButlerMessage(id: "m\\(index)", projectId: "bobo", name: "bobo", text: "已修复，待验收。", at: 1000, summaryAt: 1000, role: "butler", request: request)
}
let butler = IslandButler(enabled: true, revision: 1, status: "ready", message: "新进展", messages: messages)
var measured: CGFloat = 0
let host = NSHostingView(rootView: IslandButlerList(butler: butler, onSelect: {}, onMeasure: { measured = $0 }).frame(width: 560))
host.frame = NSRect(x: 0, y: 0, width: 560, height: butler.height)
let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
window.contentView = host
host.layoutSubtreeIfNeeded()
RunLoop.main.run(until: Date().addingTimeInterval(0.1))
precondition(abs(measured - ceil(one+two+three+20)) < 2, "窗口的测量值必须来自相同宽度下的自然排版，而非被视口高度压缩")
precondition(measured > 184 && butler.visibleListHeight(measured: measured) == 184, "长引用仍按自然高度滚动，原生窗口保持高度上限")
`);
});

test('悬停明细：展开后重新检查真实图标区域，离开不误弹，旧圆环退出不取消新来源', {skip:process.platform!=='darwin'}, async()=>{
 const declarations=await swiftSlice('enum IslandDetailKind:', '// 通知岛的状态：');
 const hover=await swiftSlice('    private func detailHoverChanged(', '    // 明细卡固定在触发图标下方');
 await checkSwift(declarations+`
enum NSEvent { static var mouseLocation = NSPoint.zero }
enum IslandMetrics { static let detailDelay = 3600.0 }
final class ProbePanel {
 var isVisible = true
 var frame = NSRect(x: 0, y: 0, width: 100, height: 100)
 func orderOut(_ sender: Any?) { isVisible = false }
}
final class ProbeModel {
 var onScreen = true
 var detail: IslandDetailKind?
 var quotaFocus: String?
 var detailMetrics = DetailMetrics()
}
final class DetailProbe {
 var islandModel = ProbeModel()
 var notchWindow: ProbePanel? = ProbePanel()
 var detailWindow: ProbePanel? = ProbePanel()
 var isHopping = false, islandQuotaDragging = false, pointerMoved = true
 var detailHover: IslandDetailTarget?
 var detailHoverRegion: IslandHoverRegion?
 var detailShownTarget: IslandDetailTarget?
 var detailShownRegion: IslandHoverRegion?
 var detailShowWork: DispatchWorkItem?, detailHideWork: DispatchWorkItem?
 var detailAnchor = NSPoint.zero
 var refreshes = 0
 func islandPointerMoved() -> Bool { pointerMoved }
 func refreshDetail(_ kind: IslandDetailKind) { refreshes += 1 }
 func applyDetail(_ metrics: DetailMetrics) { detailWindow?.isVisible = true }
 func hover(_ target: IslandDetailTarget, _ value: Bool, _ region: IslandHoverRegion) { detailHoverChanged(target, value, region: region) }
 func finishShow() { detailShowWork?.perform() }
 func finishHide() { detailHideWork?.perform() }
 func queueHide() { scheduleDetailHide() }
`+hover+'\n}',`
var rect: NSRect? = NSRect(x: 400, y: 950, width: 22, height: 22)
let region = IslandHoverRegion(rect: { rect })
let probe = DetailProbe()
NSEvent.mouseLocation = NSPoint(x: 411, y: 961)
probe.hover(.quota("codex"), true, region)
rect = NSRect(x: 500, y: 950, width: 22, height: 22)
probe.finishShow()
precondition(probe.islandModel.detail == nil && probe.refreshes == 0, "展开把图标移走后，旧 enter 不能弹出或刷新额度")
NSEvent.mouseLocation = NSPoint(x: 511, y: 961)
probe.hover(.quota("codex"), true, region)
NSEvent.mouseLocation = NSPoint(x: 511, y: 700)
probe.finishShow()
precondition(probe.islandModel.detail == nil && probe.refreshes == 0, "漏掉 exit 时，移到消息区域也不能误弹")
NSEvent.mouseLocation = NSPoint(x: 511, y: 961)
probe.hover(.quota("codex"), true, region)
let nextRect = NSRect(x: 530, y: 950, width: 22, height: 22)
let next = IslandHoverRegion(rect: { nextRect })
NSEvent.mouseLocation = NSPoint(x: 541, y: 961)
probe.hover(.quota("claude"), true, next)
probe.hover(.quota("codex"), false, region)
probe.finishShow()
precondition(probe.islandModel.detail == .quota && probe.islandModel.quotaFocus == "claude" && probe.refreshes == 1, "不同额度图标必须各自判断，旧退出不能取消新来源")
precondition(probe.detailAnchor == NSPoint(x: 541, y: 950), "卡片应锚定在真实图标底边中心")
NSEvent.mouseLocation = NSPoint(x: 600, y: 700)
probe.queueHide(); probe.finishHide()
precondition(probe.islandModel.detail == nil, "旧悬停状态不能让卡片一直保留")
NSEvent.mouseLocation = NSPoint(x: 511, y: 961)
probe.hover(.device, true, region)
rect = nil
probe.finishShow()
precondition(probe.islandModel.detail == nil && probe.refreshes == 1, "旧控件卸载后不能弹出")
rect = NSRect(x: 500, y: 950, width: 22, height: 22)
for mode in 0...2 {
 let hidden = DetailProbe()
 if mode == 0 { hidden.islandModel.onScreen = false }
 if mode == 1 { hidden.islandQuotaDragging = true }
 if mode == 2 { hidden.pointerMoved = false }
 hidden.hover(.network, true, region); hidden.finishShow()
 precondition(hidden.islandModel.detail == nil && hidden.refreshes == 0, "让位、拖动或被动展开不能误触悬停刷新")
}
`);
});

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
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {'),`
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
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {'),`
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
// 设备占标准一格，网络按窄条宽度计算。
test('通知岛额度：并排显示的固定上限与自适应数量', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {'),`
 let wide: CGFloat = 1512, keepOut: CGFloat = 214
 // 没有可用来源 → 0 枚；只有一家 → 1 枚（不并排，但也不隐藏）。
 precondition(IslandBarGeometry.quotaChips(count: 0, limit: 0, screenWidth: wide, keepOut: keepOut, device: true, network: true, actionButtons: true) == 0)
 precondition(IslandBarGeometry.quotaChips(count: 1, limit: 0, screenWidth: wide, keepOut: keepOut, device: true, network: true, actionButtons: true) == 1)
 // 固定上限：3 家封顶时 5 家只排 3 枚；上限大于来源数时按来源数。
 precondition(IslandBarGeometry.quotaChips(count: 5, limit: 3, screenWidth: wide, keepOut: keepOut, device: true, network: true, actionButtons: true) == 3)
 precondition(IslandBarGeometry.quotaChips(count: 3, limit: 7, screenWidth: wide, keepOut: keepOut, device: true, network: true, actionButtons: true) == 3)
 // 自适应：内置刘海屏（1512 宽）上 5 家都排得下。
 precondition(IslandBarGeometry.quotaChips(count: 5, limit: 0, screenWidth: wide, keepOut: keepOut, device: true, network: true, actionButtons: true) == 5)
 // 窄屏 / 有刘海时按空间收缩：600 宽、设备 + 网络占两格、中轴线到右缘剩 159pt，
 // 4 枚额度 + 设备 + 网络 = 147pt（再来一枚 174pt 就放不下）。
 precondition(IslandBarGeometry.quotaChips(count: 8, limit: 0, screenWidth: 600, keepOut: keepOut, device: true, network: true, actionButtons: false) == 4)
 precondition(IslandBarGeometry.quotaChips(count: 8, limit: 0, screenWidth: 600, keepOut: keepOut, device: true, network: false, actionButtons: false) == 5)
 // 遍历各种屏幕宽度与悬停状态：数量在 1...count 之间，且排出来的宽度不越过中轴线。
 for width in stride(from: 320.0, through: 1800.0, by: 40.0) {
  for device in [false, true] {
   for network in [false, true] {
    for hover in [false, true] {
     let shown = IslandBarGeometry.quotaChips(count: 8, limit: 0, screenWidth: width, keepOut: keepOut, device: device, network: network, actionButtons: hover)
     precondition(shown >= 1 && shown <= 8, "自适应数量越界")
     if shown > 1 {
      let used = IslandBarGeometry.contentWidths(faces: 0, hidden: 0, quota: shown, device: device, network: network, actionButtons: hover).right
      let space = (width - IslandMetrics.screenEdgeMargin * 2) / 2 - keepOut / 2 - IslandMetrics.barEdge
      precondition(used <= space + 0.0001, "并排显示越过了展开后的中轴线")
     }
    }
   }
  }
 }
 // 固定上限同样受空间约束：窄屏上即使选了 7 家也不会越过中轴线。
 let capped = IslandBarGeometry.quotaChips(count: 8, limit: 7, screenWidth: 400, keepOut: keepOut, device: true, network: true, actionButtons: true)
 precondition(capped < 7 && capped >= 1)
`);
});

// 网络指示（三枚垂直灯珠：延迟 / 下载 / 上传）：等级归一化、颜色取用与速率 / 延迟文案，
// 以及快照缺字段时的兜底（认不出的等级按空闲灰、没有读数不误报红色）。
test('通知岛网络：三枚灯珠的等级、配色与文案', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {'),`
 func net(_ json: String) throws -> IslandNetwork { try JSONDecoder().decode(IslandNetwork.self, from: Data(json.utf8)) }
 let live = try! net(#"{"available":true,"online":true,"interface":{"name":"en0","kind":"wifi","label":"Wi-Fi","address":"192.168.1.2"},"latency":{"ms":25.4,"level":"ok","source":"icmp"},"download":{"bytesPerSec":123456,"level":"warn"},"upload":{"bytesPerSec":0,"level":"idle"},"totals":{"download":1234567,"upload":2048}}"#)
 precondition(live.interface?.name == "en0" && live.interface?.kind == "wifi")
 precondition(live.latency?.source == "icmp")
 // 文案：延迟一位小数只留给 10ms 以内，速率 / 累计流量按 1024 进制分档。
 precondition(IslandNetwork.latencyText(live.latency?.ms) == "25 ms")
 precondition(IslandNetwork.latencyText(4.26) == "4.3 ms")
 precondition(IslandNetwork.latencyText(nil) == "—")
 precondition(IslandNetwork.rate(0) == "0 B/s")
 precondition(IslandNetwork.rate(512) == "512 B/s")
 precondition(IslandNetwork.rate(123456) == "121 KB/s")
 precondition(IslandNetwork.rate(2*1024*1024) == "2.0 MB/s")
 precondition(IslandNetwork.rate(150*1024*1024) == "150 MB/s")
 precondition(IslandNetwork.rate(2*1024*1024*1024) == "2.00 GB/s")
 precondition(IslandNetwork.bytes(1234567) == "1.2 MB")
 precondition(IslandNetwork.bytes(2048) == "2.0 KB")
 // 等级归一化：三档 + 空闲，nil / 认不出的值都按空闲（暗灰）处理。
 precondition(IslandMetrics.beadLevel("ok") == "ok" && IslandMetrics.beadLevel("warn") == "warn" && IslandMetrics.beadLevel("low") == "low")
 precondition(IslandMetrics.beadLevel("idle") == "idle")
 precondition(IslandMetrics.beadLevel(nil) == "idle" && IslandMetrics.beadLevel("") == "idle" && IslandMetrics.beadLevel("weird") == "idle")
 // 缺字段（例如平台不支持、刚启动还没探过）时没有延迟、没有接口，也不会崩。
 let bare = try! net(#"{"available":false,"online":null,"error":"网络监控目前支持 macOS 与 Linux"}"#)
 precondition(bare.latency == nil && bare.interface == nil)
 precondition(IslandMetrics.beadLevel(bare.latency?.level) == "idle")
 precondition(bare.error?.isEmpty == false)
`);
});

// 每枚圆环各自显示一档窗口：快照里的 range（服务端记住）决定这一家画哪一档，
// 认不出的范围退回 5 小时、再退回第一档；并排显示的来源只算「可用 + 开启」，顺序稳定。
test('通知岛额度：圆环显示的范围与并排来源的取舍', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {'),`
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
 precondition(quota.provider(id: "opencode-go") == nil, "关掉的来源不该出现在明细卡里")
 precondition(quota.provider(id: "agy")?.displayWindow?.key == "week")
 // Cursor / Grok 沿用来源启停与顺序；Total / On-demand 留在明细，不画成订阅圆环。
 let cursor = try! provider(#"{"id":"cursor","available":true,"range":"total","windows":[{"key":"cursor-models","remainingPercent":87.5},{"key":"other-models","remainingPercent":60},{"key":"total","remainingPercent":80,"aside":true}]}"#)
 precondition(cursor.showable && cursor.displayWindow?.key == "cursor-models")
 precondition(cursor.windows.last?.aside == true && !cursor.windows[0].aside)
 let grok = try! provider(#"{"id":"grok","available":true,"range":"allowance","windows":[{"key":"allowance","remainingPercent":57.5},{"key":"on-demand","remainingPercent":75,"aside":true}]}"#)
 precondition(grok.showable && grok.displayWindow?.key == "allowance")
 var extended = quota
 extended.providers = [grok, cursor]
 extended.selected = "grok"
 precondition(extended.subscriptions.map { $0.id } == ["grok", "cursor"] && extended.displayed?.id == "grok")
 extended.providers[0].enabled = false
 precondition(extended.subscriptions.map { $0.id } == ["cursor"] && extended.displayed?.id == "cursor")
`);
});

// 刘海两翼共同扩展；头像随空间增长，溢出徽标占最后一格。
test('通知岛几何：两翼对称展开，头像按屏幕空间自适应', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {'),`
 let collapsed = IslandBarGeometry.layout(left: 50, right: 76, notch: 179)
 let expanded = IslandBarGeometry.layout(left: 50, right: 184, notch: 179, minWidth: 560)
 precondition(collapsed.left == collapsed.right && expanded.left == expanded.right)
 precondition(expanded.left > collapsed.left && expanded.keepOut == collapsed.keepOut)
 precondition(IslandBarGeometry.envelope(expanded) >= 560)
 let a = NSRect(x: 735-IslandBarGeometry.envelope(collapsed)/2, y: 968, width: IslandBarGeometry.envelope(collapsed), height: 32)
 let b = NSRect(x: 735-IslandBarGeometry.envelope(expanded)/2, y: 800, width: IslandBarGeometry.envelope(expanded), height: 200)
 for i in 0...60 {
  let step = IslandLayoutTween.sample(from: a, to: b, fromLayout: collapsed, toLayout: expanded, progress: IslandLayoutTween.progress(Double(i)/60))
  precondition(abs(step.frame.midX-735) < 0.00001 && abs(step.frame.maxY-1000) < 0.00001)
  precondition(step.layout.left == step.layout.right)
 }
 precondition(IslandLayoutTween.progress(0) == 0 && IslandLayoutTween.progress(1) == 1)
 for width in stride(from: 400.0, through: 1800.0, by: 40.0) {
  let cap = IslandBarGeometry.avatarCapacity(screenWidth: width, keepOut: 193)
  let plan = IslandBarGeometry.avatars(100, cap: cap)
  precondition(plan.shown + plan.hidden == 100 && plan.shown + 1 == cap)
  let content = IslandBarGeometry.contentWidths(faces: plan.shown, hidden: plan.hidden, quota: 0, device: false, network: false, actionButtons: false)
  precondition(content.left + IslandMetrics.barEdge <= (width-40-193)/2)
 }
 precondition(IslandBarGeometry.avatarCapacity(screenWidth: 1470, keepOut: 193) > 4)
 let tight = IslandBarGeometry.avatars(10, cap: 1)
 precondition(tight.shown == 0 && tight.hidden == 10)
 let all = IslandBarGeometry.avatars(6, cap: 8)
 precondition(all.shown == 6 && all.hidden == 0)
`);
});

// 菜单栏让位（防遮挡状态栏图标）的触发阈值：鼠标在「面板可见部分 + 左右各折叠态宽度一半」的安全带里
// 不算遮挡（面板附近横向移动、擦着边缘路过都不该把面板收走），超出安全带才让位；菜单栏高度之外不触发。
test('通知岛让位：菜单栏触发的左右安全区', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {'),`
 let bar = NSRect(x: 0, y: 970, width: 1512, height: 30)
 // 面板可见栏 220pt 居中（646...866），折叠态宽度 220 → 左右各 110pt 的安全区。
 let visible = NSRect(x: 646, y: 970, width: 220, height: 30)
 func yields(_ x: CGFloat, _ y: CGFloat, folded: CGFloat = 220) -> Bool {
  IslandBarGeometry.menuBarYields(mouse: NSPoint(x: x, y: y), menuBar: bar, visibleBar: visible, foldedWidth: folded)
 }
 // 面板上、以及左右安全带里：不触发让位。
 precondition(!yields(700, 985))
 precondition(!yields(537, 985))
 precondition(!yields(975, 985))
 // 再往外一点（还在菜单栏高度里）：让位。
 precondition(yields(535, 985))
 precondition(yields(977, 985))
 // 菜单栏高度之外（例如面板下方的桌面）：不触发——让位只管菜单栏那一条。
 precondition(!yields(535, 900))
 // 折叠宽度为 0 的兜底：退化成「面板可见部分之外就触发」。
 precondition(yields(900, 985, folded: 0))
`);
});

// 点刘海上的头像要跳到主窗口的哪个分栏（与 index.html 的 data-island-pane 对齐），以及圆环拖动排序
// 提交给服务端前的「完整顺序」怎么合并：只动并排显示的那几家，未显示的保持原位。
test('通知岛跳转：头像分栏与额度排序的合并顺序', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {'),`
 precondition(IslandMetrics.islandPane(forSource: nil) == "settings")
 precondition(IslandMetrics.islandPane(forSource: "opencode") == "opencode")
 precondition(IslandMetrics.islandPane(forSource: "codex") == "codex")
 precondition(IslandMetrics.islandPane(forSource: "omp") == "omp")
 precondition(IslandMetrics.islandPane(forSource: "claude") == "claude")
 precondition(IslandMetrics.islandPane(forSource: "dsh") == "dsh")
 precondition(IslandMetrics.islandPane(forSource: "agy") == "agy")
 precondition(IslandMetrics.islandPane(forSource: "认不出的来源") == "settings")
 // 顺序没变、整个翻转、以及夹杂未显示来源的三种合并。
 precondition(IslandMetrics.mergedQuotaOrder(full: ["a","b","c","d"], shown: ["a","b"]) == ["a","b","c","d"])
 precondition(IslandMetrics.mergedQuotaOrder(full: ["a","b","c","d"], shown: ["b","a"]) == ["b","a","c","d"])
 precondition(IslandMetrics.mergedQuotaOrder(full: ["a","x","b","y"], shown: ["b","a"]) == ["b","x","a","y"])
 // 草稿里多出来的 id 不会冒出来；空顺序也稳。
 precondition(IslandMetrics.mergedQuotaOrder(full: ["a","b"], shown: ["a","b","c"]) == ["a","b"])
 precondition(IslandMetrics.mergedQuotaOrder(full: [], shown: ["a"]) == [])
 precondition(IslandMetrics.mergedQuotaOrder(full: ["codex","cursor","claude","grok"], shown: ["grok","cursor"]) == ["codex","grok","claude","cursor"])
`);
});

// 会话行右侧的线路指示：会话的 link id 与 links 快照的解码、短文案 / 风控值的格式化、悬停提示的内容。
test('通知岛：会话线路指示的解码与文案', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {'),`
let sessionJSON = #"{"id":"s1","state":"working","source":"codex","link":"codex"}"#
let session = try JSONDecoder().decode(IslandSession.self, from: Data(sessionJSON.utf8))
precondition(session.link == "codex" && session.source == "codex")
let linksJSON = #"{"updatedAt":1790000000000,"rows":[{"id":"codex","kind":"service","name":"Codex","ok":true,"bars":2,"level":"warn","ms":379,"ip":"2407:cdc0:d002::1","ipSource":"trace","healthText":"偏慢","info":{"typeText":"VPN","typeShort":"VPN","level":"low","grade":"dirty","risk":66}},{"id":"proxy","kind":"exit","name":"代理出口","ok":false,"bars":0,"level":"low","error":"超时"}]}"#
let links = try JSONDecoder().decode(IslandLinks.self, from: Data(linksJSON.utf8))
precondition(links.rows.count == 2 && links.link(id: "codex")?.ok == true)
let codex = links.link(id: "codex")
precondition(codex?.bars == 2 && codex?.ms == 379)
precondition(codex?.info?.risk == 66 && codex?.info?.grade == "dirty")
precondition(IslandMetrics.linkType(codex?.info) == "VPN")
precondition(IslandMetrics.linkRisk(codex?.info?.risk) == "66")
precondition(IslandMetrics.linkRisk(nil) == nil)
// 悬停提示带齐读数；失败的行说明原因；没映射 / 还没探到的不画指示。
precondition(codex?.help.contains("首字节 379 ms") == true)
precondition(codex?.help.contains("出口 2407:cdc0:d002::1") == true)
precondition(codex?.help.contains("VPN · 风控 66") == true)
precondition(codex?.help.contains("偏慢") == true)
precondition(links.link(id: "proxy")?.help.contains("探测失败：超时") == true)
precondition(links.link(id: "") == nil && links.link(id: nil) == nil && links.link(id: "nope") == nil)
// 类型短文案缺了退回长文案；风控值为小数也能读。
let fallbackJSON = #"{"rows":[{"id":"x","ok":true,"bars":4,"level":"ok","ms":88,"info":{"typeText":"住宅 / 家宽","level":"ok","grade":"clean","risk":12.5}}]}"#
let fallback = try JSONDecoder().decode(IslandLinks.self, from: Data(fallbackJSON.utf8))
precondition(IslandMetrics.linkType(fallback.link(id: "x")?.info) == "住宅 / 家宽")
precondition(IslandMetrics.linkRisk(fallback.link(id: "x")?.info?.risk) == "13")
`);
});

// 屏幕通知可能连续到达；同屏刷新与状态重排都只更新几何，不能重播换屏的缩放 / 淡出。
test('通知岛刷新：同屏反复刷新不换屏，目标屏幕改变才跳转', {skip:process.platform!=='darwin'}, async()=>{
 const refresh=await swiftSlice('    private func refreshScreen(', '    private func positionNotch()');
 await checkSwift(`
struct ProbeScreen { var signature: String }
final class Probe {
 var islandDragging = false
 var currentScreenSignature = "main"
 var selected: ProbeScreen? = ProbeScreen(signature: "main")
 var layouts = 0, hops = 0
 func chosenScreen() -> ProbeScreen? { selected }
 static func signature(_ screen: ProbeScreen) -> String { screen.signature }
 func updateIslandLayout() { layouts += 1 }
 func hopToScreen(_ screen: ProbeScreen) { hops += 1; currentScreenSignature = screen.signature }
 func refresh() { refreshScreen() }
`+refresh+`
}`,`
let probe = Probe()
for _ in 0..<8 { probe.refresh() }
precondition(probe.hops == 0, "同屏刷新错误地重播了缩放与淡出")
precondition(probe.layouts == 8, "同屏刷新仍需更新状态变化后的布局")
probe.selected = ProbeScreen(signature: "external")
probe.refresh()
precondition(probe.hops == 1 && probe.currentScreenSignature == "external")
probe.refresh()
precondition(probe.hops == 1 && probe.layouts == 9)
probe.islandDragging = true
probe.selected = ProbeScreen(signature: "main")
probe.refresh()
precondition(probe.hops == 1 && probe.layouts == 9)
probe.islandDragging = false
probe.selected = nil
probe.refresh()
precondition(probe.hops == 1 && probe.layouts == 9)
`);
});

test('通知岛全屏：只认前台最上面的可见普通窗口，忽略后面的全屏与透明残窗', {skip:process.platform!=='darwin'}, async()=>{
 await checkSwift(await swiftSlice('enum IslandWindowGeometry {','// 顶栏命中范围'),`
let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
let normal = CGRect(x: 40, y: 38, width: 1400, height: 900)
func window(_ rect: CGRect, pid: pid_t = 42, layer: Int = 0, alpha: Double = 1) -> [String: Any] {
 [kCGWindowOwnerPID as String: pid, kCGWindowLayer as String: layer, kCGWindowAlpha as String: alpha,
  kCGWindowBounds as String: rect.dictionaryRepresentation as NSDictionary]
}
let normalFirst = IslandWindowGeometry.frontmostBounds([window(normal), window(display)], pid: 42, displays: [display])!
precondition(normalFirst == normal && !IslandWindowGeometry.isFullScreen(normalFirst, displays: [display]), "后面的全屏窗口不能继续让位")
let fullFirst = IslandWindowGeometry.frontmostBounds([window(display), window(normal)], pid: 42, displays: [display])!
precondition(IslandWindowGeometry.isFullScreen(fullFirst, displays: [display]))
let recovered = IslandWindowGeometry.frontmostBounds([window(display, pid: 9), window(display, layer: 25), window(display, alpha: 0), window(.zero), window(normal)], pid: 42, displays: [display])
precondition(recovered == normal, "透明残窗、菜单与其它应用不能遮住前台普通窗口的状态")
precondition(IslandWindowGeometry.frontmostBounds([window(display, pid: 9)], pid: 42, displays: [display]) == nil)
let upper = CGRect(x: -100, y: -1080, width: 1920, height: 1080)
precondition(IslandWindowGeometry.isFullScreen(upper, displays: [display, upper]), "上下排列使用 Quartz 显示器坐标")
precondition(!IslandWindowGeometry.isFullScreen(normal, displays: [display, upper]))

// 现场 Chrome 网页全屏：屏幕外的 47pt 标题条、屏幕内的 115pt 工具栏都排在主窗口前面。
let chromeDisplay = CGRect(x: 0, y: 0, width: 2048, height: 1152)
let titleStrip = CGRect(x: 0, y: -47, width: 2048, height: 47)
let toolbar = CGRect(x: 0, y: 0, width: 2048, height: 115)
let chromeFull = IslandWindowGeometry.frontmostBounds([window(titleStrip), window(toolbar), window(chromeDisplay)], pid: 42, displays: [chromeDisplay])!
precondition(chromeFull == chromeDisplay && IslandWindowGeometry.isFullScreen(chromeFull, displays: [chromeDisplay]), "全屏工具栏不能冒充视频主窗口")
let chromeNormal = CGRect(x: 63, y: 30, width: 1985, height: 1122)
let chromeRecovered = IslandWindowGeometry.frontmostBounds([window(titleStrip), window(toolbar), window(chromeNormal), window(chromeDisplay)], pid: 42, displays: [chromeDisplay])!
precondition(chromeRecovered == chromeNormal && !IslandWindowGeometry.isFullScreen(chromeRecovered, displays: [chromeDisplay]), "工具栏残留也不能让后面的旧全屏窗口继续让位")
let smallWindow = CGRect(x: 300, y: 0, width: 900, height: 115)
precondition(IslandWindowGeometry.frontmostBounds([window(smallWindow), window(chromeDisplay)], pid: 42, displays: [chromeDisplay]) == smallWindow, "短小的普通窗口不能当作全屏工具栏跳过")
precondition(IslandWindowGeometry.frontmostBounds([window(toolbar)], pid: 42, displays: [chromeDisplay]) == toolbar, "没有对应全屏主窗口时保留顶边窗口")
precondition(IslandWindowGeometry.frontmostBounds([window(titleStrip)], pid: 42, displays: [chromeDisplay]) == nil)
let upperToolbar = CGRect(x: upper.minX, y: upper.minY, width: upper.width, height: 115)
precondition(IslandWindowGeometry.frontmostBounds([window(upperToolbar), window(upper)], pid: 42, displays: [display, upper]) == upper, "上下排列的屏幕也要跳过全屏工具栏")
`);
});

// 直接执行鼠标采样入口、全屏缓存、悬停与自动回缩回调；窗口 / 鼠标 / 全屏信号都是内存里的假值。
test('通知岛恢复：无激活或 Space 事件也能进入 / 退出全屏，漏掉 mouseExited 后自动回缩', {skip:process.platform!=='darwin'}, async()=>{
 const declarations=await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {');
 const model=await swiftSlice('enum IslandDetailKind:', '// 通知岛面板：黑色卡片贴住刘海');
 const cache=await swiftSlice('    private func frontmostFullScreenCached(', '    private func frontmostAppFullScreen()');
 const space=await swiftSlice('    private func handleSpaceChange()', '    // 网页播放器切换全屏');
 const fullscreen=await swiftSlice('    private func recheckFullScreenYield()', '    // 重判面板该在哪块屏幕');
 const hover=await swiftSlice('    private func islandHovering(', '    // MARK: 悬停明细卡');
 const reveal=await swiftSlice('    private func revealIslandTemporarily(', '    private func scheduleIslandLayout()');
 const monitor=await swiftSlice('    private func updateMenuBarYield()', '    // 折叠（未激活）态的面板宽度');
 await checkSwift(declarations+'\n'+model+`
enum NSEvent { static var mouseLocation = NSPoint(x: 300, y: 700) }
final class IslandReplyTextView {
 var lastInputAt = Date.distantPast
 var marked = false
 func hasMarkedText() -> Bool { marked }
}
struct ProbeScreen { var frame = NSRect(x: 0, y: 0, width: 1512, height: 1000) }
final class ProbePanel {
 var firstResponder: Any?
 var isVisible = true
 var frame = NSRect(x: 476, y: 790, width: 560, height: 210)
 var screen: ProbeScreen? = ProbeScreen()
}
final class Probe {
 let islandModel = IslandModel()
 var notchWindow: ProbePanel? = ProbePanel(), detailWindow: ProbePanel?
 var islandDragging = false, islandQuotaDragging = false, isHopping = false
 var islandLayoutTimer: Timer?, islandDisplayDriver: AnyObject?
 var islandCollapse: DispatchWorkItem?, islandAutoCollapse: DispatchWorkItem?
 var menuBarYielding = false, menuBarLeftAt: Date?
 var fullScreenCached = false, fullScreenCheckedAt: Date?
 var passiveRevealMouse: NSPoint?
 var fullScreen = false, scans = 0, layouts = 0, refreshes = 0
 func frontmostAppFullScreen() -> Bool { scans += 1; return fullScreen }
 func scheduleIslandLayout() { layouts += 1 }
 func refreshScreen() { refreshes += 1 }
 func hideDetail() {}
 func closeButlerReply() { islandModel.butlerReply.isOpen = false }
 func stopTerminalWatch() {}
 func islandBarHeight(_ screen: ProbeScreen) -> CGFloat { 30 }
 func collapsedIslandWidth(for screen: ProbeScreen) -> CGFloat { 220 }
 func tick() { updateMenuBarYield() }
 func spaceChanged() { handleSpaceChange() }
 func hover(_ value: Bool) { islandHovering(value) }
 func reveal() { revealIslandTemporarily(seconds: 3600) }
 func finishReveal() { islandAutoCollapse?.perform() }
 func finishLeave() { islandCollapse?.perform() }
 func contains(_ point: NSPoint) -> Bool { islandContainsPointer(point) }
`+[cache,space,fullscreen,hover,reveal,monitor].join('\n')+'\n}',`
let full = Probe()
full.tick()
precondition(full.scans == 1 && full.layouts == 0 && !full.fullScreenCached)
full.fullScreen = true
full.tick()
precondition(full.scans == 1, "进入全屏的复查不能超过每秒一次")
full.fullScreenCheckedAt = Date().addingTimeInterval(-2)
full.isHopping = true
full.tick()
precondition(full.fullScreenCached && full.scans == 2 && full.layouts == 1, "没有焦点 / Space 事件也要发现进入全屏，不能被动画 guard 截住")
full.fullScreen = false
full.tick()
precondition(full.scans == 2, "退出全屏的复查不能超过每秒一次")
full.fullScreenCheckedAt = Date().addingTimeInterval(-2)
full.notchWindow?.isVisible = false
full.tick()
precondition(!full.fullScreenCached && full.scans == 3 && full.layouts == 2, "隐藏或动画期间仍能发现退出全屏并恢复")
full.isHopping = false
full.fullScreenCheckedAt = Date().addingTimeInterval(-2)
full.tick()
precondition(full.scans == 4 && full.layouts == 2, "普通窗口也继续低频复查，状态未变化不重排布局")
full.islandModel.screenAwake = false
full.fullScreenCheckedAt = Date().addingTimeInterval(-2)
full.tick()
precondition(full.scans == 4, "屏幕休眠时不查窗口")
full.islandModel.screenAwake = true
full.islandModel.settings.notch = false
full.tick()
precondition(full.scans == 4, "关闭通知岛时不查窗口")

let replying = Probe()
replying.islandModel.butlerReply.isOpen = true
replying.islandModel.butlerReply.edit("保留文字")
let input = IslandReplyTextView()
replying.notchWindow?.firstResponder = input
input.marked = true
replying.hover(false); replying.finishLeave()
precondition(replying.islandModel.butlerReply.isOpen, "离开时正在选词不能关闭")
input.marked = false; input.lastInputAt = Date()
replying.finishLeave()
precondition(replying.islandModel.butlerReply.isOpen, "正在打字时不能关闭")
input.lastInputAt = Date.distantPast
replying.finishLeave()
precondition(!replying.islandModel.butlerReply.isOpen && replying.islandModel.butlerReply.text == "保留文字", "移出并停止输入后关闭，保留草稿")

let delayed = Probe()
delayed.fullScreen = true
delayed.spaceChanged()
delayed.fullScreen = false
RunLoop.main.run(until: Date().addingTimeInterval(0.55))
precondition(delayed.scans == 2 && !delayed.fullScreenCached && delayed.refreshes == 2, "延迟复查不能复用一秒内的旧全屏缓存")

let passive = Probe()
NSEvent.mouseLocation = NSPoint(x: 300, y: 700)
passive.reveal()
precondition(passive.islandModel.expanded && passive.layouts == 1)
NSEvent.mouseLocation = NSPoint(x: 350, y: 700)
passive.tick()
precondition(passive.passiveRevealMouse == NSPoint(x: 300, y: 700), "在别处移动鼠标不能取消被动展开保护")
passive.reveal()
passive.notchWindow?.frame = NSRect(x: 200, y: 600, width: 560, height: 400)
passive.hover(true)
precondition(!passive.islandModel.hovering, "自动展开长到静止光标下方不算主动悬停")
passive.finishReveal()
precondition(!passive.islandModel.expanded, "没有操作的通知展开要按时回缩")

let lostExit = Probe()
NSEvent.mouseLocation = NSPoint(x: 650, y: 900)
lostExit.hover(true)
precondition(lostExit.islandModel.hovering)
NSEvent.mouseLocation = NSPoint(x: 300, y: 700)
lostExit.tick()
lostExit.finishLeave()
precondition(!lostExit.islandModel.expanded, "漏掉 mouseExited 也必须解除旧悬停")
lostExit.islandModel.hovering = true
lostExit.reveal()
precondition(!lostExit.islandModel.hovering && lostExit.islandModel.autoRevealed, "旧悬停不能阻止新通知安排回缩")
lostExit.islandModel.hovering = true
lostExit.finishReveal()
precondition(!lostExit.islandModel.expanded, "回缩截止时再次校正旧悬停")

let active = Probe()
NSEvent.mouseLocation = NSPoint(x: 300, y: 700)
active.reveal()
NSEvent.mouseLocation = NSPoint(x: 650, y: 900)
active.hover(true)
precondition(active.islandModel.hovering && !active.islandModel.autoRevealed && active.islandAutoCollapse?.isCancelled == true)
active.hover(false)
active.finishLeave()
precondition(active.islandModel.expanded, "鼠标实际还在面板里，误报的退出事件不能收回")
active.reveal()
precondition(active.islandModel.hovering && active.islandModel.expanded, "用户主动查看时保持展开")
active.islandModel.yielding = true
active.islandModel.hovering = false
active.hover(true)
precondition(!active.islandModel.hovering, "透明让位窗口不能接管悬停")
active.islandModel.yielding = false
active.islandModel.barLayout = IslandBarLayout(left: 60, keepOut: 200, right: 60, notched: true)
precondition(!active.contains(NSPoint(x: 480, y: 900)) && active.contains(NSPoint(x: 650, y: 900)), "透明包络两侧不能维持悬停")
NSEvent.mouseLocation = NSPoint(x: 480, y: 900)
active.hover(true)
precondition(!active.islandModel.hovering)
NSEvent.mouseLocation = NSPoint(x: 650, y: 900)
active.tick()
precondition(active.islandModel.hovering, "从透明包络走到可见面板，没有新的 mouseEntered 也要接管悬停")
`);
});

// 回答完成只结束自动亮起；鼠标主动停在面板上时继续展开。测试直接运行快照处理入口。
test('通知岛状态：回答完成保留主动悬停，自动亮起则正常收回', {skip:process.platform!=='darwin'}, async()=>{
 const declarations=await swiftSlice('struct IslandSession: Identifiable, Decodable, Equatable {','struct IslandSnapshot: Decodable, Equatable {');
 const snapshots=await swiftSlice('struct IslandSnapshot: Decodable, Equatable {','// 悬停明细卡的内容类型');
 const model=await swiftSlice('enum IslandDetailKind:', '// 通知岛面板：黑色卡片贴住刘海');
 const apply=await swiftSlice('    private func applyIsland(', '    // 描边高亮：收到提醒');
 await checkSwift(declarations+'\n'+snapshots+'\n'+model+`
final class Probe {
 let islandModel = IslandModel()
 var islandAutoCollapse: DispatchWorkItem?
 var launchTime = Double.greatestFiniteMagnitude
 var lastNoticeKey = "", notchState = "", notchLabel = "", notchCount = 0
 var layouts = 0
 func updateHighlights(from before: [IslandSession]) {}
 func revealIslandTemporarily(seconds: Double) { islandModel.autoRevealed = true }
 func justFinished(from before: [IslandSession]) -> Bool { false }
 func postNotice(_ notice: IslandNotice) {}
 func closeButlerReply() { islandModel.butlerReply.isOpen = false }
 func syncStatusItem(_ enabled: Bool) {}
 func updateNotchStatus(_ state: String, label: String, count: Int) {}
 func refreshScreen() {}
 func scheduleIslandLayout() { layouts += 1 }
 func apply(_ snapshot: IslandSnapshot) { applyIsland(snapshot) }
`+apply+'\n}',`
func snapshot(_ state: String) throws -> IslandSnapshot {
 try JSONDecoder().decode(IslandSnapshot.self, from: Data((#"{"connected":true,"settings":{},"sessions":[{"id":"s1","state":""# + state + #""}]}"#).utf8))
}
let waiting = try snapshot("waiting"), working = try snapshot("working")
let active = Probe()
active.apply(waiting)
active.islandModel.hovering = true
active.apply(working)
precondition(active.islandModel.hovering && active.islandModel.expanded, "回答完成不该清掉主动悬停")
precondition(!active.islandModel.autoRevealed)
let passive = Probe()
passive.apply(waiting)
precondition(passive.islandModel.autoRevealed && passive.islandModel.expanded)
passive.apply(working)
precondition(!passive.islandModel.hovering && !passive.islandModel.autoRevealed && !passive.islandModel.expanded)
var enabled = working
enabled.butler = IslandButler(enabled: true, revision: 1, status: "ready", message: "新进展")
active.apply(enabled)
active.islandModel.butlerReply.isOpen = true
active.islandModel.butlerReply.edit("保留草稿")
active.apply(working)
precondition(!active.islandModel.butlerReply.isOpen && active.islandModel.butlerReply.text == "保留草稿", "关闭管家要收起便捷回复，但保留草稿")
`);
});

test('原生回复输入：中文组合词不发送，提交后可发送；图片粘贴不污染文字', {skip:process.platform!=='darwin'}, async()=>{
 const editor=await swiftSlice('final class IslandReplyTextView: NSTextView {','struct IslandButlerComposer: View {');
 await checkSwift(editor,`
let app = NSApplication.shared
let editor = IslandReplyTextView(frame: NSRect(x: 0, y: 0, width: 440, height: 80))
let window = NSWindow(contentRect: editor.frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = editor
var sends = 0
var closes = 0
editor.onSend = { sends += 1 }; editor.onClose = { closes += 1 }
let commandReturn = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\\r", charactersIgnoringModifiers: "\\r", isARepeat: false, keyCode: 36)!
editor.setMarkedText("zhongwen", selectedRange: NSRange(location: 8, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
precondition(editor.hasMarkedText())
precondition(editor.performKeyEquivalent(with: commandReturn))
precondition(sends == 0 && closes == 0 && editor.hasMarkedText(), "候选词不能被发送快捷键吞掉")
let escape = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\\u{1b}", charactersIgnoringModifiers: "\\u{1b}", isARepeat: false, keyCode: 53)!
editor.keyDown(with: escape)
precondition(closes == 0, "Esc 取消选词不能关闭回复框")
editor.string = ""
editor.setMarkedText("zhongwen", selectedRange: NSRange(location: 8, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
editor.insertText("中文", replacementRange: NSRange(location: NSNotFound, length: 0))
precondition(!editor.hasMarkedText() && editor.string == "中文")
precondition(editor.performKeyEquivalent(with: commandReturn) && sends == 1)
let board = NSPasteboard.withUniqueName()
defer { board.releaseGlobally() }
editor.imagePasteboard = board
let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=")!
board.setData(png, forType: .png)
var images: [Data] = []
editor.onImages = { images = $0 }
let pasteItem = NSMenuItem(title: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
precondition(editor.validateUserInterfaceItem(pasteItem), "纯图片剪贴板也必须启用粘贴菜单")
let pasteKey = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "v", charactersIgnoringModifiers: "v", isARepeat: false, keyCode: 9)!
precondition(editor.performKeyEquivalent(with: pasteKey), "非激活面板必须直接接住 Command V")
precondition(images.count == 1 && NSImage(data: images[0]) != nil && editor.string == "中文")
images = []; editor.keyDown(with: pasteKey)
precondition(images.count == 1, "直接进入 keyDown 的粘贴也要接住")
let imageFile = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString + ".png")
try png.write(to: imageFile)
defer { try? FileManager.default.removeItem(at: imageFile) }
board.clearContents(); board.writeObjects([imageFile as NSURL]); images = []
editor.paste(nil)
precondition(images.count == 1, "Finder 复制的图片文件也能粘贴")
editor.isEditable = false; images = []; editor.paste(nil)
precondition(images.isEmpty, "发送中不能修改附件")
`);
});
