import Foundation
import ServiceManagement

enum BoboLoginState: String, Codable {
    case enabled, notRegistered, requiresApproval, notFound
}

struct BoboLoginSnapshot: Codable, Equatable {
    var supported: Bool
    var enabled: Bool
    var registered: Bool
    var requiresApproval: Bool
    var status: BoboLoginState
    var reason: String
    init(_ state: BoboLoginState) {
        status = state
        supported = state != .notFound
        enabled = state == .enabled
        requiresApproval = state == .requiresApproval
        registered = enabled || requiresApproval
        switch state {
        case .enabled: reason = "已开启，登录 Mac 后自动启动 bobo"
        case .notRegistered: reason = "已关闭，登录 Mac 后不自动启动 bobo"
        case .requiresApproval: reason = "需要在系统设置的登录项中允许 bobo"
        case .notFound: reason = "系统找不到应用的登录项，请从已安装的 bobo.app 重试"
        }
    }
}

struct BoboLoginEnvironment {
    var status: () -> BoboLoginState = {
        switch SMAppService.mainApp.status {
        case .enabled: return .enabled
        case .notRegistered: return .notRegistered
        case .requiresApproval: return .requiresApproval
        case .notFound: return .notFound
        @unknown default: return .notFound
        }
    }
    var register: () throws -> Void = { try SMAppService.mainApp.register() }
    var unregister: () throws -> Void = { try SMAppService.mainApp.unregister() }
    var openSettings: () -> Void = { SMAppService.openSystemSettingsLoginItems() }
}

enum BoboLoginItem {
    // 操作后重新读取系统状态，不另外保存一个可能与系统设置不同步的布尔值。
    static func perform(_ action: String, environment: BoboLoginEnvironment = BoboLoginEnvironment()) throws -> BoboLoginSnapshot {
        let current = environment.status()
        switch action {
        case "status": break
        case "enable":
            if current != .enabled && current != .requiresApproval { try environment.register() }
        case "disable":
            if current == .enabled || current == .requiresApproval { try environment.unregister() }
        case "settings": environment.openSettings()
        default: throw NSError(domain: "bobo.login-item", code: 2, userInfo: [NSLocalizedDescriptionKey: "未知登录项操作"])
        }
        return BoboLoginSnapshot(environment.status())
    }

    // 本机 HTTP 服务调用同一 App 内的可执行文件；在 NSApplication 初始化前处理，查询和设置不会打开第二个窗口。
    static func runIfRequested(_ args: [String]) -> Int32? {
        guard args.first == "--login-item" else { return nil }
        guard args.count == 2, ["status", "enable", "disable", "settings"].contains(args[1]) else {
            fputs("登录项参数无效\n", stderr); return 2
        }
        guard Bundle.main.bundleIdentifier == "local.bobo.app", Bundle.main.bundleURL.pathExtension == "app" else {
            fputs("登录项功能需要从 bobo.app 运行\n", stderr); return 1
        }
        do {
            let result = try perform(args[1])
            print(String(decoding: try JSONEncoder().encode(result), as: UTF8.self))
            return 0
        } catch {
            fputs("登录项操作失败：\(error.localizedDescription)\n", stderr)
            return 1
        }
    }
}
