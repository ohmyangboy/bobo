import Foundation
import IOKit
import IOKit.pwr_mgt
import Darwin

enum AwakeError: Error, LocalizedError {
    case message(String, Int32)
    var errorDescription: String? { switch self { case .message(let text, _): return text } }
    var code: Int32 { switch self { case .message(_, let code): return code } }
}

enum AwakeDuration {
    // 返回 nil 表示永久；拒绝零、负数、溢出和模糊单位。
    static func parse(_ text: String) throws -> TimeInterval? {
        if ["永久", "forever"].contains(text) { return nil }
        guard let unit = text.last, let scale = ["s": 1.0, "m": 60.0, "h": 3600.0][String(unit)],
              !text.dropLast().isEmpty, text.dropLast().allSatisfy({ $0.isASCII && $0.isNumber }),
              let value = Double(text.dropLast()), value > 0, value * scale <= 315_360_000 else {
            throw AwakeError.message("时长应为 10s、30m、1h 或永久（最长十年）", 2)
        }
        return value * scale
    }
}

struct AwakeState: Codable, Equatable {
    var pid: Int32
    var startedAt: Date
    var endsAt: Date?
    var allowDisplaySleep: Bool
    var allowSystemSleepOnDisplayOff: Bool
    var heartbeat: Date
    // PID 会被复用，结合内核记录的进程出生时间识别持有者，不能只看 kill(pid, 0)。
    var processStartedAt: Double
    var sessionID: String
}

struct AwakeStatus: Codable, Equatable {
    var active = false
    var phase = "idle"
    var state: AwakeState?
    var error: String?
    static func make(state: AwakeState?, ownerAlive: Bool) -> AwakeStatus {
        AwakeStatus(active: state != nil && ownerAlive, phase: state == nil ? "idle" : ownerAlive ? "active" : "orphaned", state: state)
    }
}

enum AwakeJSON {
    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }
    static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(type, from: data)
    }
}

struct AwakePaths {
    var home: URL
    init(home: URL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["AWAKE_HOME"] ?? ProcessInfo.processInfo.environment["BOBO_HOME"] ?? NSHomeDirectory())) { self.home = home }
    var directory: URL { home.appendingPathComponent("Library/Application Support/awake") }
    var state: URL { directory.appendingPathComponent("state.json") }
    var settings: URL { home.appendingPathComponent(".bobo/awake.json") }
}

struct AwakeSettings: Codable, Equatable {
    var defaultDuration = "1h"
    var allowDisplaySleep = false
    var allowSystemSleepOnDisplayOff = false
    var launchAtLogin = false
    static func load(_ paths: AwakePaths) throws -> AwakeSettings {
        guard FileManager.default.fileExists(atPath: paths.settings.path) else { return AwakeSettings() }
        return try AwakeJSON.decode(AwakeSettings.self, Data(contentsOf: paths.settings))
    }
}

// 唯一的私有 API 调用点。12 = kPMSetClamshellSleepState，type 0 的 IOPMrootDomain user client。
// 已取证的 Apple Silicon 内核分支没有特权 / entitlement 检查，所以无需 root；Intel 效果不保证。
// 这是 powerd 共享的全局位，关闭连接或进程退出不会清除；SIGKILL 后必须 repair，且会与同类工具互相影响。
func awakeSetClamshellSleepDisabled(_ disabled: Bool) throws {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
    guard service != 0 else { throw AwakeError.message("找不到电源管理服务", 1) }
    defer { IOObjectRelease(service) }
    var connection: io_connect_t = 0
    var result = IOServiceOpen(service, mach_task_self_, 0, &connection)
    guard result == KERN_SUCCESS else { throw AwakeError.message("无法打开电源管理服务：\(result)", 1) }
    defer { IOServiceClose(connection) }
    var input: UInt64 = disabled ? 1 : 0
    result = IOConnectCallScalarMethod(connection, 12, &input, 1, nil, nil)
    guard result == KERN_SUCCESS else { throw AwakeError.message("合盖状态写入失败：\(result)", 1) }
}

func awakeProcessStart(_ pid: Int32) -> Double? {
    guard pid > 1 else { return nil }
    var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.stride
    var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&name, 4, &info, &size, nil, 0) == 0, size > 0, info.kp_proc.p_stat != SZOMB else { return nil }
    let time = info.kp_proc.p_starttime
    return Double(time.tv_sec) + Double(time.tv_usec) / 1_000_000
}

struct AwakeEnvironment {
    var now: () -> Date = Date.init
    var setClamshell: (Bool) throws -> Void = awakeSetClamshellSleepDisabled
    var processStart: (Int32) -> Double? = awakeProcessStart
    var signal: (Int32) -> Int32 = { Darwin.kill($0, SIGTERM) }
    var createAssertion: (Bool) throws -> IOPMAssertionID = { display in
        var id: IOPMAssertionID = 0
        let result = IOPMAssertionCreateWithName((display ? "PreventUserIdleDisplaySleep" : "PreventUserIdleSystemSleep") as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn), (display ? "awake (Display)" : "awake (System)") as CFString, &id)
        guard result == kIOReturnSuccess else { throw AwakeError.message("创建电源断言失败：\(result)", 1) }
        return id
    }
    var releaseAssertion: (IOPMAssertionID) -> Void = { _ = IOPMAssertionRelease($0) }
    func ownerAlive(_ state: AwakeState) -> Bool {
        guard let started = processStart(state.pid) else { return false }
        return abs(started - state.processStartedAt) < 0.00001
    }
}

// 锁文件永不 unlink，防止另一个进程拿到不同 inode；会话锁由常驻进程一直持有。
final class AwakeLock {
    private let fd: Int32
    init(_ url: URL) throws {
        fd = Darwin.open(url.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw AwakeError.message("无法打开 awake 锁文件", 1) }
    }
    func acquire(wait: Bool = false) -> Bool { flock(fd, LOCK_EX | (wait ? 0 : LOCK_NB)) == 0 }
    func unlock() { flock(fd, LOCK_UN) }
    deinit { Darwin.close(fd) }
}

final class AwakeSession {
    let paths: AwakePaths
    let environment: AwakeEnvironment
    private var assertions: [IOPMAssertionID] = []
    private var sessionLock: AwakeLock?
    private(set) var current: AwakeState?
    init(paths: AwakePaths = AwakePaths(), environment: AwakeEnvironment = AwakeEnvironment()) {
        self.paths = paths; self.environment = environment
    }
    private func prepare() throws {
        try FileManager.default.createDirectory(at: paths.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    func readState() throws -> AwakeState? {
        guard FileManager.default.fileExists(atPath: paths.state.path) else { return nil }
        return try AwakeJSON.decode(AwakeState.self, Data(contentsOf: paths.state))
    }
    func status() -> AwakeStatus {
        do { let state = try readState(); return .make(state: state, ownerAlive: state.map(environment.ownerAlive) ?? false) }
        catch { return AwakeStatus(phase: "error", error: "无法读取 awake 状态：\(error.localizedDescription)") }
    }
    private func write(_ state: AwakeState) throws {
        try AwakeJSON.encode(state).write(to: paths.state, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.state.path)
    }
    private func removeState() throws {
        if FileManager.default.fileExists(atPath: paths.state.path) { try FileManager.default.removeItem(at: paths.state) }
    }
    // 所有命令串行；持有 command.lock 时启动 / 停止进程，清理路径只使用 session.lock，不会互等。
    func withCommand<T>(_ action: () throws -> T) throws -> T {
        try prepare()
        let lock = try AwakeLock(paths.directory.appendingPathComponent("command.lock"))
        guard lock.acquire(wait: true) else { throw AwakeError.message("无法锁定 awake 命令", 1) }
        defer { lock.unlock() }
        return try action()
    }
    // 启动自检仅清理孤儿；明确 off / repair 则先通知活持有者退出，确认锁释放后才复位。
    func repair(staleOnly: Bool) throws {
        let lock = try AwakeLock(paths.directory.appendingPathComponent("session.lock"))
        if !lock.acquire() {
            if staleOnly { return }
            guard let state = try readState(), environment.ownerAlive(state), environment.signal(state.pid) == 0 else {
                throw AwakeError.message("会话正在切换或无法确认持有者，请稍后复位", 1)
            }
            let deadline = Date().addingTimeInterval(4)
            while !lock.acquire() {
                guard Date() < deadline else { throw AwakeError.message("awake 未能正常退出，保留状态以便再次复位", 1) }
                Thread.sleep(forTimeInterval: 0.02)
            }
        }
        defer { lock.unlock() }
        if !staleOnly || FileManager.default.fileExists(atPath: paths.state.path) {
            try environment.setClamshell(false)
            try removeState()
        }
    }
    func start(duration: TimeInterval?, allowDisplaySleep: Bool, allowSystemSleepOnDisplayOff: Bool, replace: Bool) throws {
        let lock = try AwakeLock(paths.directory.appendingPathComponent("session.lock"))
        if !lock.acquire() {
            guard replace else { throw AwakeError.message("已有 awake 会话；使用 --replace 替换", 3) }
            try repair(staleOnly: false)
            guard lock.acquire() else { throw AwakeError.message("另一个 awake 会话已启动", 3) }
        }
        sessionLock = lock
        let now = environment.now()
        current = AwakeState(pid: getpid(), startedAt: now, endsAt: duration.map { now.addingTimeInterval($0) },
            allowDisplaySleep: allowDisplaySleep, allowSystemSleepOnDisplayOff: allowSystemSleepOnDisplayOff, heartbeat: now,
            processStartedAt: environment.processStart(getpid()) ?? 0, sessionID: UUID().uuidString)
        do {
            // 先落恢复凭据，再碰全局位；中途崩溃也有 orphan state 可供 repair 识别。
            try write(current!)
            try environment.setClamshell(false)
            if !allowSystemSleepOnDisplayOff { try environment.setClamshell(true) }
            assertions.append(try environment.createAssertion(false))
            if !allowDisplaySleep { assertions.append(try environment.createAssertion(true)) }
        } catch {
            let original = error
            do { try finish() } catch { throw AwakeError.message("\(original.localizedDescription)；复位也失败：\(error.localizedDescription)，请执行 awake repair", 1) }
            throw original
        }
    }
    // 断言按进程持有；显式释放后才复位。复位失败保留恢复凭据，下次启动可重试。
    func finish() throws {
        guard current != nil else { return }
        assertions.forEach(environment.releaseAssertion); assertions.removeAll()
        defer { current = nil; sessionLock = nil }
        try environment.setClamshell(false)
        try removeState()
    }
    func tick() throws -> Bool {
        guard var state = current else { return false }
        let now = environment.now()
        if let end = state.endsAt, now >= end { try finish(); return false }
        if now.timeIntervalSince(state.heartbeat) >= 1 { state.heartbeat = now; try write(state); current = state }
        return true
    }
}

enum AwakeCLI {
    private static var ownedSession: AwakeSession?
    static func run(_ arguments: [String]) -> Int32 {
        let session = AwakeSession()
        do {
            var command = arguments.first ?? "help", args = Array(arguments.dropFirst())
            // 登录项参数保持固定，设置修改不会 bootout 正在运行的登录会话。
            if command == "login-on" {
                guard args.isEmpty else { throw AwakeError.message("无效参数", 2) }
                let settings = try AwakeSettings.load(session.paths)
                guard settings.launchAtLogin else { return 0 }
                command = "on"; args = [settings.defaultDuration]
                if settings.allowDisplaySleep { args.append("--allow-display-sleep") }
                if settings.allowSystemSleepOnDisplayOff { args.append("--allow-system-sleep-on-display-off") }
            }
            var duration: TimeInterval?, allowDisplay = false, allowSystem = false, replace = false
            switch command {
            case "on":
                var value: String?
                for arg in args {
                    switch arg {
                    case "--allow-display-sleep": allowDisplay = true
                    case "--allow-system-sleep-on-display-off": allowSystem = true
                    case "--replace": replace = true
                    default:
                        guard value == nil, !arg.hasPrefix("-") else { throw AwakeError.message("未知参数：\(arg)", 2) }
                        value = arg
                    }
                }
                duration = try value.map(AwakeDuration.parse) ?? nil
            case "off", "repair":
                guard args.isEmpty || (command == "repair" && args == ["--stale-only"]) else { throw AwakeError.message("无效参数", 2) }
            case "status":
                guard args.isEmpty || args == ["--json"] else { throw AwakeError.message("无效参数", 2) }
            case "login-sync": guard args.isEmpty else { throw AwakeError.message("无效参数", 2) }
            case "help", "--help", "-h":
                print("awake on [10s|30m|45m|1h|2h|4h|8h|永久] [--allow-display-sleep] [--allow-system-sleep-on-display-off] [--replace]\nawake off | status --json | repair\non 不传时长即永久；第二个选项只关闭合盖保护，仍持有防空闲睡眠断言。")
                return 0
            default: throw AwakeError.message("未知命令：\(command)", 2)
            }
            // 注册信号后才写全局位，避免初始化窗口内 SIGTERM 直接退出留下状态。
            var stopping = false
            var signals: [DispatchSourceSignal] = []
            if command == "on" {
                ownedSession = session
                atexit { try? AwakeCLI.ownedSession?.finish() }
                for value in [SIGINT, SIGTERM, SIGHUP] {
                    Darwin.signal(value, SIG_IGN)
                    let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
                    source.setEventHandler { stopping = true }; source.resume(); signals.append(source)
                }
            }
            try session.withCommand {
                try session.repair(staleOnly: true)
                switch command {
                case "on": try session.start(duration: duration, allowDisplaySleep: allowDisplay, allowSystemSleepOnDisplayOff: allowSystem, replace: replace)
                case "off", "repair": try session.repair(staleOnly: args == ["--stale-only"])
                case "login-sync": try AwakeLogin.sync(paths: session.paths)
                default: break
                }
            }
            if command == "on" {
                defer { signals.forEach { $0.cancel() } }
                do {
                    while !stopping, try session.tick() { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
                    try session.finish()
                } catch { try? session.finish(); throw error }
            } else if command == "status" {
                let status = session.status()
                if args == ["--json"] { print(String(decoding: try AwakeJSON.encode(status), as: UTF8.self)) }
                else { print(status.error ?? (status.active ? "保持唤醒中" : "已关闭")) }
                if status.error != nil { return 1 }
            }
            return 0
        } catch {
            fputs("awake：\(error.localizedDescription)\n", stderr)
            return (error as? AwakeError)?.code ?? 1
        }
    }
}

// 仅在用户开启「登录时启动」后安装，不设置 KeepAlive（计时结束不能自动再开）。
// 默认时长与两个选项固化为参数，修改设置时原子替换并重新注册；失败回滚 plist，调用方回滚设置。
enum AwakeLogin {
    static func sync(paths: AwakePaths) throws {
        let settings = try AwakeSettings.load(paths)
        let label = "local.bobo.awake-login", domain = "gui/\(getuid())"
        let url = paths.home.appendingPathComponent("Library/LaunchAgents/\(label).plist")
        let old = try? Data(contentsOf: url)
        func exec(_ args: [String]) throws -> Int32 {
            let task = Process(); task.executableURL = URL(fileURLWithPath: "/bin/launchctl"); task.arguments = args
            task.standardOutput = FileHandle.nullDevice; task.standardError = FileHandle.nullDevice
            try task.run(); task.waitUntilExit(); return task.terminationStatus
        }
        // 未安装、未开启时完全不碰 launchd。
        if !settings.launchAtLogin {
            if old != nil {
                let removed = try exec(["bootout", "\(domain)/\(label)"])
                if removed != 0, try exec(["print", "\(domain)/\(label)"]) == 0 { throw AwakeError.message("登录项卸载失败，保留原设置", 1) }
                try FileManager.default.removeItem(at: url)
            }
            return
        }
        _ = try AwakeDuration.parse(settings.defaultDuration)
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
        let plist: [String: Any] = ["Label": label, "ProgramArguments": [executable, "login-on"], "RunAtLoad": true, "LimitLoadToSessionType": "Aqua"]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        if old == data, try exec(["print", "\(domain)/\(label)"]) == 0 { return }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // -w 会禁用新注册任务；不带 -w，且不用 KeepAlive / --replace。
        _ = try exec(["bootout", "\(domain)/\(label)"])
        do {
            try data.write(to: url, options: .atomic)
            guard try exec(["bootstrap", domain, url.path]) == 0 else { throw AwakeError.message("登录项注册失败，保持唤醒仍可手动开启", 1) }
        } catch {
            if let old { try? old.write(to: url, options: .atomic); _ = try? exec(["bootstrap", domain, url.path]) }
            else { try? FileManager.default.removeItem(at: url) }
            throw error
        }
    }
}
