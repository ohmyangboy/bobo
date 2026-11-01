import AppKit
import SwiftUI

// 只发布可见状态；心跳和剩余秒数不发布，倒计时交给局部 TimelineView。
final class AwakeIslandController: ObservableObject {
    @Published private(set) var status = AwakeStatus()
    @Published private(set) var settings = AwakeSettings()
    @Published private(set) var busy = false
    var onActiveChanged: ((Bool) -> Void)?
    var tokenProvider: () -> String = { "" }
    private let queue = DispatchQueue(label: "local.bobo.awake", qos: .utility)
    private let paths = AwakePaths()
    private var timer: DispatchSourceTimer?
    private var children: [Process] = []
    private var operationError: String?
    private var repairing = false
    private var executable: URL? {
        Bundle.main.resourceURL?.appendingPathComponent("bin/awake")
    }
    func start() {
        queue.async { [weak self] in
            guard let self else { return }
            do { try self.command(["repair", "--stale-only"]) } catch { self.operationError = error.localizedDescription }
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now(), repeating: .milliseconds(500), leeway: .milliseconds(30))
            timer.setEventHandler { [weak self] in self?.refresh() }
            self.timer = timer; timer.resume()
        }
    }
    func stopMonitoring() { queue.async { [weak self] in self?.timer?.cancel(); self?.timer = nil } }
    private func command(_ args: [String], resident: Bool = false) throws {
        guard let executable, FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw AwakeError.message("找不到内置 awake，请重新构建应用", 1)
        }
        let process = Process(); process.executableURL = executable; process.arguments = args
        process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice
        // 常驻进程不挂永远无人读取的管道；初始化失败会通过退出状态反馈。
        process.standardError = FileHandle.nullDevice
        if resident {
            children.append(process)
            process.terminationHandler = { [weak self] child in
                self?.queue.async { [weak self] in
                    guard let self else { return }
                    self.children.removeAll { $0 === child }
                    if child.terminationStatus != 0 { self.operationError = "awake 启动或复位失败（\(child.terminationStatus)），可从菜单重试复位" }
                    self.refresh()
                }
            }
        }
        do { try process.run() } catch { children.removeAll { $0 === process }; throw error }
        if !resident {
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw AwakeError.message("awake 操作失败（\(process.terminationStatus)），可从菜单重试复位", 1) }
        }
    }
    private func refresh() {
        var value = AwakeSession(paths: paths).status()
        if value.phase == "orphaned", !repairing {
            repairing = true
            do { try command(["repair", "--stale-only"]); value = AwakeSession(paths: paths).status() }
            catch { operationError = error.localizedDescription }
            repairing = false
        }
        // 心跳只用于恢复，不触发 SwiftUI 整体刷新。
        if var state = value.state { state.heartbeat = state.startedAt; value.state = state }
        if let operationError { value.error = operationError }
        var configuration = AwakeSettings()
        do { configuration = try AwakeSettings.load(paths) } catch { value.error = "保持唤醒设置读取失败：\(error.localizedDescription)" }
        let result = value, saved = configuration
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.status != result {
                let changed = self.status.active != result.active
                self.status = result
                if changed { self.onActiveChanged?(result.active) }
            }
            if self.settings != saved { self.settings = saved }
        }
    }
    func toggle() { perform(status.active ? "off" : "on") }
    func saveOption(_ key: String, _ value: Bool) {
        guard !busy, let url = URL(string: "http://127.0.0.1:4318/api/awake/settings") else { return }
        busy = true
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 8
        request.setValue(tokenProvider(), forHTTPHeaderField: "x-bobo-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [key: value])
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            self?.queue.async { [weak self] in
                guard let self else { return }
                if let error { self.operationError = error.localizedDescription }
                else if (response as? HTTPURLResponse)?.statusCode != 200 {
                    let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
                    self.operationError = body?["error"] ?? "保持唤醒设置保存失败"
                } else { self.operationError = nil }
                self.refresh()
                DispatchQueue.main.async { [weak self] in self?.busy = false }
            }
        }.resume()
    }
    func perform(_ action: String, duration: String? = nil) {
        guard !busy else { return }; busy = true
        let configuration = settings
        queue.async { [weak self] in
            guard let self else { return }
            self.operationError = nil
            do {
                var args = [action]
                if action == "on" {
                    args += [duration ?? configuration.defaultDuration, "--replace"]
                    if configuration.allowDisplaySleep { args.append("--allow-display-sleep") }
                    if configuration.allowSystemSleepOnDisplayOff { args.append("--allow-system-sleep-on-display-off") }
                }
                try self.command(args, resident: action == "on")
                // 等初始化落盘或退出（只占后台队列），点击后最迟半秒给出可见状态。
                if action == "on" {
                    let deadline = Date().addingTimeInterval(0.45)
                    while Date() < deadline {
                        if AwakeSession(paths: self.paths).status().active { break }
                        Thread.sleep(forTimeInterval: 0.02)
                    }
                }
            } catch { self.operationError = error.localizedDescription }
            self.refresh()
            DispatchQueue.main.async { [weak self] in self?.busy = false }
        }
    }
}

enum AwakePresentation {
    static func remaining(_ state: AwakeState?, now: Date) -> String {
        guard let state else { return "已关闭" }
        guard let end = state.endsAt else { return "永久" }
        let seconds = max(0, Int(ceil(end.timeIntervalSince(now))))
        return seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, seconds % 3600 / 60, seconds % 60) : String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

struct IslandAwakeChip: View {
    @ObservedObject var awake: AwakeIslandController
    var animating: Bool
    var allowsAction: () -> Bool = { true }
    var onHover: (Bool, IslandHoverRegion) -> Void
    @State private var menuShown = false
    @ViewBuilder private var menu: some View {
        ForEach([("30m", "30 分钟"), ("1h", "1 小时"), ("2h", "2 小时"), ("4h", "4 小时"), ("永久", "永久")], id: \.0) { duration, title in
            Button(title) { awake.perform("on", duration: duration) }
        }
        Divider()
        Button("关闭") { awake.perform("off") }
        Button("复位") { awake.perform("repair") }
    }
    var body: some View {
        Button { if allowsAction() { awake.toggle() } } label: {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: "cup.and.saucer.fill").font(.system(size: IslandMetrics.quotaIconSize))
                    .foregroundStyle(awake.status.active ? IslandMetrics.warnHue : .white.opacity(0.4))
                if awake.status.active { IslandDot(color: IslandMetrics.warnHue, pulsing: animating, size: 4).offset(x: 3, y: 3) }
                else if awake.status.error != nil { Circle().fill(IslandMetrics.criticalHue).frame(width: 4, height: 4).offset(x: 3, y: 3) }
            }.frame(width: IslandMetrics.itemSize, height: IslandMetrics.itemSize)
        }
        .buttonStyle(.plain).disabled(awake.busy)
        .accessibilityLabel(awake.status.active ? "关闭保持唤醒" : "开启保持唤醒")
        .contextMenu { menu }
        .highPriorityGesture(LongPressGesture(minimumDuration: 0.5).exclusively(before: TapGesture()).onEnded { value in
            guard allowsAction() else { return }
            switch value { case .first: menuShown = true; case .second: awake.toggle() }
        })
        .popover(isPresented: $menuShown) {
            VStack(alignment: .leading, spacing: 8) { menu; Divider(); IslandAwakeOptions(awake: awake) }
                .padding(12).frame(width: 350)
        }
        .background(DetailHoverReporter(onChange: onHover))
    }
}

private struct IslandAwakeOptions: View {
    @ObservedObject var awake: AwakeIslandController
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("下次开启的会话选项").font(.system(size: 10)).foregroundStyle(.secondary)
            Toggle("允许显示器睡眠", isOn: Binding(get: { awake.settings.allowDisplaySleep }, set: { awake.saveOption("allowDisplaySleep", $0) }))
            Toggle("当显示器关闭时允许系统睡眠", isOn: Binding(get: { awake.settings.allowSystemSleepOnDisplayOff }, set: { awake.saveOption("allowSystemSleepOnDisplayOff", $0) }))
            Toggle("允许屏幕保护程序在闲置 45m 后运行", isOn: .constant(false)).disabled(true)
            Text("屏幕保护程序选项即将支持").font(.system(size: 10)).foregroundStyle(.secondary)
        }.font(.system(size: 11)).toggleStyle(.checkbox).disabled(awake.busy)
    }
}

struct IslandAwakeDetail: View {
    @ObservedObject var awake: AwakeIslandController
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("保持唤醒").font(.system(size: 12, weight: .semibold))
            Text(awake.status.error ?? (awake.status.active ? "正在保持唤醒" : "已关闭"))
                .foregroundStyle(awake.status.error != nil ? IslandMetrics.criticalHue : .white.opacity(0.65))
            if let state = awake.status.state, awake.status.active {
                Text("开始：\(state.startedAt.formatted(date: .omitted, time: .shortened))")
                TimelineView(.periodic(from: .now, by: 1)) { context in Text("剩余：\(AwakePresentation.remaining(state, now: context.date))").monospacedDigit() }
                Text("允许显示器睡眠：\(state.allowDisplaySleep ? "是" : "否")")
                Text("允许合盖睡眠：\(state.allowSystemSleepOnDisplayOff ? "是" : "否")")
            }
            Text("点击切换 · 长按或右键选择时长").font(.system(size: 10)).foregroundStyle(.white.opacity(0.4))
        }.font(.system(size: 11)).foregroundStyle(.white)
    }
}
