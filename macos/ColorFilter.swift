import Combine
import Darwin
import Foundation

// 系统「色彩滤镜」没有公开开关。设置面板调用 MediaAccessibility 写入偏好并通知
// universalaccessd；守护进程没在听时，用 libUniversalAccess 的 _UniversalAccessDStart 叫醒它。
// 类型与系统设置里的菜单一致，取值是位标记：1 灰度、2 红/绿、4 绿/红、8 蓝/黄、16 色调。
// 关掉时保留类型；没选过（类型为 0）再打开才写成灰度。符号缺失就整组不可用。
enum ColorFilterKind: Int32, CaseIterable {
    case grayscale = 1
    case protanopia = 2
    case deuteranopia = 4
    case tritanopia = 8
    case tint = 16
    var title: String {
        switch self {
        case .grayscale: return "灰度"
        case .protanopia: return "红/绿（红色盲）"
        case .deuteranopia: return "绿/红（绿色盲）"
        case .tritanopia: return "蓝/黄（蓝色盲）"
        case .tint: return "色调"
        }
    }
}

enum ColorFilterAction {
    static let category: Int32 = 1
    static let grayscale = ColorFilterKind.grayscale.rawValue
    static let wakeMagic: Int32 = 8
    static func next(enabled: Bool, type: Int32) -> (enabled: Bool, type: Int32?) {
        guard !enabled else { return (false, nil) }
        return (true, type == 0 ? grayscale : nil)
    }
}

struct ColorFilterSymbols {
    var getEnabled: (Int32) -> Bool
    var setEnabled: (Int32, Bool) -> Void
    var getType: (Int32) -> Int32
    var setType: (Int32, Int32) -> Void
    var wake: (Int32) -> Void
    var getIntensity: (Int32) -> Double = { _ in 1 }
    var setIntensity: (Int32, Double) -> Void = { _, _ in }
    var intensityRange: (Int32) -> (min: Double, max: Double) = { _ in (0.25, 1) }
    var getHue: () -> Double = { 0 }
    var setHue: (Double) -> Void = { _ in }
    var adjustable = false

    static func load() -> ColorFilterSymbols? {
        guard let media = dlopen("/System/Library/Frameworks/MediaAccessibility.framework/MediaAccessibility", RTLD_LAZY),
              let access = dlopen("/usr/lib/libUniversalAccess.dylib", RTLD_LAZY),
              let getEnabled = dlsym(media, "MADisplayFilterPrefGetCategoryEnabled"),
              let setEnabled = dlsym(media, "MADisplayFilterPrefSetCategoryEnabled"),
              let getType = dlsym(media, "MADisplayFilterPrefGetType"),
              let setType = dlsym(media, "MADisplayFilterPrefSetType"),
              let wake = dlsym(access, "_UniversalAccessDStart") else { return nil }
        let readEnabled = unsafeBitCast(getEnabled, to: (@convention(c) (Int32) -> UInt8).self)
        let writeEnabled = unsafeBitCast(setEnabled, to: (@convention(c) (Int32, UInt8) -> Void).self)
        let readType = unsafeBitCast(getType, to: (@convention(c) (Int32) -> Int32).self)
        let writeType = unsafeBitCast(setType, to: (@convention(c) (Int32, Int32) -> Void).self)
        let start = unsafeBitCast(wake, to: (@convention(c) (Int32) -> Void).self)
        let adjustment = intensitySymbols(media)
        return ColorFilterSymbols(
            getEnabled: { readEnabled($0) != 0 },
            setEnabled: { writeEnabled($0, $1 ? 1 : 0) },
            getType: { readType($0) },
            setType: { writeType($0, $1) },
            wake: { start($0) },
            getIntensity: adjustment.get,
            setIntensity: adjustment.set,
            intensityRange: adjustment.range,
            getHue: adjustment.hue,
            setHue: adjustment.setHue,
            adjustable: adjustment.adjustable)
    }

    // 强度函数不带类别参数，数值在 d0；范围常量是导出的 double。缺任何一个就只保留类型切换。
    private static func intensitySymbols(_ media: UnsafeMutableRawPointer) -> (get: (Int32) -> Double, set: (Int32, Double) -> Void, range: (Int32) -> (min: Double, max: Double), hue: () -> Double, setHue: (Double) -> Void, adjustable: Bool) {
        typealias Read = @convention(c) () -> Double
        typealias Write = @convention(c) (Double) -> Void
        func read(_ name: String) -> Read? { guard let p = dlsym(media, name) else { return nil }; return unsafeBitCast(p, to: Read.self) }
        func write(_ name: String) -> Write? { guard let p = dlsym(media, name) else { return nil }; return unsafeBitCast(p, to: Write.self) }
        func number(_ name: String) -> Double? {
            guard let p = dlsym(media, name) else { return nil }
            let value = p.load(as: Double.self)
            return value.isFinite ? value : nil
        }
        let rows: [(Int32, String)] = [
            (ColorFilterKind.grayscale.rawValue, "Grayscale"),
            (ColorFilterKind.protanopia.rawValue, "RedColor"),
            (ColorFilterKind.deuteranopia.rawValue, "GreenColor"),
            (ColorFilterKind.tritanopia.rawValue, "BlueColor"),
            (ColorFilterKind.tint.rawValue, "SingleColor"),
        ]
        var readers: [Int32: Read] = [:]
        var writers: [Int32: Write] = [:]
        var ranges: [Int32: (min: Double, max: Double)] = [:]
        for (type, name) in rows {
            let getName = name == "SingleColor" ? "MADisplayFilterPrefGetSingleColorIntensity" : "MADisplayFilterPrefGet\(name)CorrectionIntensity"
            let setName = name == "SingleColor" ? "MADisplayFilterPrefSetSingleColorIntensity" : "MADisplayFilterPrefSet\(name)CorrectionIntensity"
            let minName = name == "SingleColor" ? "kMADisplayFilterPrefSingleColorIntensityMin" : "kMADisplayFilterPref\(name)IntensityMin"
            let maxName = name == "SingleColor" ? "kMADisplayFilterPrefSingleColorIntensityMax" : "kMADisplayFilterPref\(name)IntensityMax"
            guard let reader = read(getName), let writer = write(setName), let lower = number(minName), let upper = number(maxName), lower < upper else { continue }
            readers[type] = reader
            writers[type] = writer
            ranges[type] = (lower, upper)
        }
        let hue = read("MADisplayFilterPrefGetSingleColorHue")
        let setHue = write("MADisplayFilterPrefSetSingleColorHue")
        let ready = readers.count == rows.count && hue != nil && setHue != nil
        return (
            { readers[$0]?() ?? 1 },
            { writers[$0]?($1) },
            { ranges[$0] ?? (0.25, 1) },
            { hue?() ?? 0 },
            { setHue?($0) },
            ready)
    }
}

final class ColorFilterController: ObservableObject {
    @Published private(set) var available: Bool
    @Published private(set) var enabled = false
    @Published private(set) var type: Int32 = 0
    @Published private(set) var intensity = 1.0
    @Published private(set) var intensityMin = 0.25
    @Published private(set) var intensityMax = 1.0
    @Published private(set) var hue = 0.0
    @Published private(set) var error: String?
    var adjustable: Bool { symbols?.adjustable == true }
    var onAvailability: ((Bool) -> Void)?
    private let symbols: ColorFilterSymbols?
    private var observing = false

    init(symbols: ColorFilterSymbols?) {
        self.symbols = symbols
        available = symbols != nil
        if symbols != nil { refresh() }
    }

    static func system() -> ColorFilterController { ColorFilterController(symbols: ColorFilterSymbols.load()) }

    func start() {
        guard symbols != nil, !observing else { return }
        observing = true
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterAddObserver(center, Unmanaged.passUnretained(self).toOpaque(), { _, observer, _, _, _ in
            guard let observer else { return }
            let controller = Unmanaged<ColorFilterController>.fromOpaque(observer).takeUnretainedValue()
            DispatchQueue.main.async { controller.refresh() }
        }, "com.apple.mediaaccessibility.displayFilterSettingsChanged" as CFString, nil, .deliverImmediately)
        refresh()
    }

    func refresh() {
        guard let symbols else { setAvailable(false); enabled = false; return }
        let category = ColorFilterAction.category
        enabled = symbols.getEnabled(category)
        type = symbols.getType(category)
        let shown = type == 0 ? ColorFilterAction.grayscale : type
        let range = symbols.intensityRange(shown)
        intensityMin = range.min
        intensityMax = range.max
        intensity = min(max(symbols.getIntensity(shown), range.min), range.max)
        hue = min(max(symbols.getHue(), 0), 1)
        setAvailable(true)
    }

    func toggle() {
        guard let symbols else { error = "色彩滤镜不可用"; return }
        let category = ColorFilterAction.category
        let next = ColorFilterAction.next(enabled: symbols.getEnabled(category), type: symbols.getType(category))
        if let type = next.type { symbols.setType(category, type) }
        symbols.setEnabled(category, next.enabled)
        symbols.wake(ColorFilterAction.wakeMagic)
        refresh()
        error = enabled == next.enabled ? nil : "色彩滤镜没有切换成功"
    }

    func setEnabled(_ on: Bool) {
        guard let symbols else { error = "色彩滤镜不可用"; return }
        let category = ColorFilterAction.category
        if on && symbols.getType(category) == 0 { symbols.setType(category, ColorFilterAction.grayscale) }
        if symbols.getEnabled(category) == on {
            refresh(); error = nil; return
        }
        symbols.setEnabled(category, on)
        symbols.wake(ColorFilterAction.wakeMagic)
        refresh()
        error = enabled == on ? nil : "色彩滤镜没有切换成功"
    }

    // 只改类型，不连带开关。设备页的类型菜单和系统设置一样，与开关分开。
    func setType(_ raw: Int32) {
        guard let symbols else { error = "色彩滤镜不可用"; return }
        guard ColorFilterKind(rawValue: raw) != nil else { error = "不支持的色彩滤镜"; return }
        let category = ColorFilterAction.category
        if symbols.getType(category) == raw { refresh(); error = nil; return }
        symbols.setType(category, raw)
        symbols.wake(ColorFilterAction.wakeMagic)
        refresh()
        error = type == raw ? nil : "色彩滤镜没有切换成功"
    }

    // 选一种滤镜就应用到屏幕上。已经开着时只换类型，关着时连开关一起打开。
    func select(_ raw: Int32) {
        guard let symbols else { error = "色彩滤镜不可用"; return }
        guard ColorFilterKind(rawValue: raw) != nil else { error = "不支持的色彩滤镜"; return }
        let category = ColorFilterAction.category
        let wasEnabled = symbols.getEnabled(category)
        symbols.setType(category, raw)
        if !wasEnabled { symbols.setEnabled(category, true) }
        symbols.wake(ColorFilterAction.wakeMagic)
        refresh()
        error = enabled && type == raw ? nil : "色彩滤镜没有切换成功"
    }

    func setIntensity(_ value: Double) {
        guard let symbols, symbols.adjustable else { error = "色彩滤镜不可用"; return }
        let category = ColorFilterAction.category
        let current = symbols.getType(category)
        let kind = current == 0 ? ColorFilterAction.grayscale : current
        guard ColorFilterKind(rawValue: kind) != nil else { error = "不支持的色彩滤镜"; return }
        let range = symbols.intensityRange(kind)
        let next = min(max(value, range.min), range.max)
        guard abs(symbols.getIntensity(kind) - next) >= 0.001 else { return }
        symbols.setIntensity(kind, next)
        symbols.wake(ColorFilterAction.wakeMagic)
        refresh()
        error = abs(intensity - next) < 0.02 ? nil : "色彩滤镜强度没有保存"
    }

    func setHue(_ value: Double) {
        guard let symbols, symbols.adjustable else { error = "色彩滤镜不可用"; return }
        guard symbols.getType(ColorFilterAction.category) == ColorFilterKind.tint.rawValue else { return }
        let next = min(max(value, 0), 1)
        guard abs(symbols.getHue() - next) >= 0.001 else { return }
        symbols.setHue(next)
        symbols.wake(ColorFilterAction.wakeMagic)
        refresh()
        error = abs(hue - next) < 0.02 ? nil : "色调没有保存"
    }

    func snapshot() -> ColorFilterSnapshot {
        ColorFilterSnapshot(supported: available, available: available, enabled: enabled, type: type, intensity: intensity, intensityMin: intensityMin, intensityMax: intensityMax, hue: hue, adjustable: adjustable, reason: error ?? (available ? "调节会立刻作用到整块屏幕。" : "色彩滤镜不可用"))
    }

    private func setAvailable(_ value: Bool) {
        guard available != value else { return }
        available = value
        onAvailability?(value)
    }
}

struct ColorFilterSnapshot: Codable, Equatable {
    var supported: Bool
    var available: Bool
    var enabled: Bool
    var type: Int32
    var intensity: Double
    var intensityMin: Double
    var intensityMax: Double
    var hue: Double
    var adjustable: Bool
    var reason: String
}

enum ColorFilterCommand {
    // 设备页经本机 HTTP 调用同一个 App；在 NSApplication 初始化前处理，避免再开一个窗口。
    static func runIfRequested(_ args: [String]) -> Int32? {
        guard args.first == "--color-filter" else { return nil }
        guard Bundle.main.bundleIdentifier == "local.bobo.app", Bundle.main.bundleURL.pathExtension == "app" else {
            fputs("色彩滤镜需要从 bobo.app 运行\n", stderr); return 1
        }
        do {
            let result = try apply(Array(args.dropFirst()), filter: .system())
            print(String(decoding: try JSONEncoder().encode(result), as: UTF8.self))
            return 0
        } catch {
            fputs("色彩滤镜操作失败：\(error.localizedDescription)\n", stderr)
            return 1
        }
    }

    static func apply(_ args: [String], filter: ColorFilterController) throws -> ColorFilterSnapshot {
        guard let action = args.first else { throw invalid("色彩滤镜参数无效") }
        switch action {
        case "status":
            guard args.count == 1 else { throw invalid("色彩滤镜参数无效") }
        case "apply":
            let patch = try parse(Array(args.dropFirst()))
            if let type = patch.type { filter.setType(type) }
            if patch.hue != nil && filter.type != ColorFilterKind.tint.rawValue { throw invalid("只有色调滤镜可以调节色调") }
            if let intensity = patch.intensity { filter.setIntensity(intensity) }
            if let hue = patch.hue { filter.setHue(hue) }
            if let enabled = patch.enabled { filter.setEnabled(enabled) }
            if let message = filter.error { throw invalid(message) }
        default: throw invalid("色彩滤镜参数无效")
        }
        return filter.snapshot()
    }

    private static func parse(_ args: [String]) throws -> (enabled: Bool?, type: Int32?, intensity: Double?, hue: Double?) {
        guard !args.isEmpty, args.count.isMultiple(of: 2) else { throw invalid("色彩滤镜参数无效") }
        var enabled: Bool?, type: Int32?, intensity: Double?, hue: Double?
        var index = 0
        while index < args.count {
            let key = args[index], value = args[index + 1]
            index += 2
            switch key {
            case "enabled":
                guard enabled == nil, value == "true" || value == "false" else { throw invalid("色彩滤镜参数无效") }
                enabled = value == "true"
            case "type":
                guard type == nil, let raw = Int32(value), ColorFilterKind(rawValue: raw) != nil else { throw invalid("不支持的色彩滤镜") }
                type = raw
            case "intensity":
                guard intensity == nil, let number = Double(value), number.isFinite, number >= 0, number <= 1 else { throw invalid("色彩滤镜强度无效") }
                intensity = number
            case "hue":
                guard hue == nil, let number = Double(value), number.isFinite, number >= 0, number <= 1 else { throw invalid("色调无效") }
                hue = number
            default: throw invalid("色彩滤镜参数无效")
            }
        }
        return (enabled, type, intensity, hue)
    }

    private static func invalid(_ message: String) -> NSError {
        NSError(domain: "bobo.color-filter", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
