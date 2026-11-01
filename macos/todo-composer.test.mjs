import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('Todo：展开落定后才聚焦，快速收起取消聚焦，行内编辑仍可输入',{skip:process.platform!=='darwin'},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-todo-focus-'));
 try{
  const source=await fs.readFile(new URL('./Todo.swift',import.meta.url),'utf8');
  const file=path.join(dir,'Check.swift'),binary=path.join(dir,'check');
  await fs.writeFile(file,source+String.raw`

@MainActor private final class ComposerProbe: ObservableObject {
    @Published var open = false
    @Published var generation = UUID()
    var appeared = false
}
private final class ComposerPanel: NSPanel { override var canBecomeKey: Bool { true } }
@MainActor private struct ComposerProbeView: View {
    @ObservedObject var probe: ComposerProbe
    var inline: Bool
    var body: some View {
        VStack {
            if probe.open {
                IslandTodoCreateCard(initial: TodoDraft(), lists: [TodoList(id: "fake", title: "测试列表")], error: "", inline: inline, onCancel: {}, onSave: { _ in })
                    .id(probe.generation).onAppear { probe.appeared = true }.transition(.opacity)
            }
        }.animation(.easeOut(duration: 0.18), value: probe.open).frame(width: 360, height: 100)
            .environment(\.colorScheme, .dark)
    }
}
@main private struct ComposerCheck {
    @MainActor static func main() async throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        func settle(_ label: String, _ condition: () -> Bool) async throws {
            for _ in 0..<500 { if condition() { return }; try await Task.sleep(nanoseconds: 2_000_000) }
            preconditionFailure(label)
        }
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        for appearance: NSAppearance.Name in [.aqua, .darkAqua] {
            NSApplication.shared.appearance = NSAppearance(named: appearance)
            for inline in [false, true] {
                let probe = ComposerProbe()
                let window = ComposerPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 100), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false; window.appearance = NSAppearance(named: .darkAqua)
                window.contentView = NSHostingView(rootView: ComposerProbeView(probe: probe, inline: inline))
                window.orderBack(nil); window.makeKey()
                try await Task.sleep(nanoseconds: 30_000_000)
                probe.open = true
                try await settle("等待输入框挂载") { probe.appeared }
                if !inline && !reduceMotion {
                    try await Task.sleep(nanoseconds: 50_000_000)
                    precondition(!(window.firstResponder is NSTextView), "胶囊展开过程中不能创建聚焦的原生 field editor")
                    probe.open = false
                    for _ in 0..<25 {
                        try await Task.sleep(nanoseconds: 10_000_000)
                        precondition(!(window.firstResponder is NSTextView), "快速收起后旧任务不能重新取得焦点")
                    }
                    probe.appeared = false; probe.generation = UUID(); probe.open = true
                    try await settle("等待重新挂载") { probe.appeared }
                }
                try await settle("等待标题框聚焦") { window.firstResponder is NSTextView }
                let editor = window.firstResponder as! NSTextView
                precondition(!editor.drawsBackground, "输入框不能绘制矩形背景")
                precondition(editor.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua)
                window.close()
            }
        }
        print("Composer focus checks passed")
    }
}
`);
  try{
   execFileSync('/usr/bin/xcrun',['swiftc','-suppress-warnings','-parse-as-library',file,'-o',binary,'-framework','AppKit','-framework','WebKit','-framework','EventKit'],{stdio:'pipe',timeout:60000});
   assert.match(execFileSync(binary,[],{encoding:'utf8',timeout:30000}),/Composer focus checks passed/);
  }catch(error){throw new Error(`${error.message}\n${error.stdout||''}\n${error.stderr||''}`);}
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
