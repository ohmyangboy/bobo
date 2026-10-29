import Foundation
import Intents
import UserNotifications

// 所有声音都由普通通知（active）播放。Focus Status 只作额外的静音信号，
// 未授权 / 未共享并不表示可以绕过专注；最终仍由通知中心决定是否发声。
enum IslandNotifications {
    static let sounds: Set<String> = ["Ping.aiff", "Glass.aiff", "Basso.aiff", "Hero.aiff"]

    static func focusSuppressed() -> Bool? {
        let center = INFocusStatusCenter.default
        guard center.authorizationStatus == .authorized else { return nil }
        return center.focusStatus.isFocused
    }

    static func content(
        title: String, message: String, notify: Bool, sound: String?,
        isSuppressed: () -> Bool? = focusSuppressed
    ) -> UNMutableNotificationContent? {
        let content = UNMutableNotificationContent()
        if notify {
            content.title = title.isEmpty ? "bobo" : title
            content.body = message
        }
        if let sound, sounds.contains(sound), isSuppressed() != true {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(sound))
        }
        guard notify || content.sound != nil else { return nil }
        content.userInfo = ["boboNotify": notify]
        // active 遵守专注；绝不改为 timeSensitive / critical，也不在失败时退回 afplay。
        content.interruptionLevel = .active
        return content
    }

    static func presentation(
        _ content: UNNotificationContent, notify: Bool, sound: Bool,
        isSuppressed: () -> Bool? = focusSuppressed
    ) -> UNNotificationPresentationOptions {
        var options: UNNotificationPresentationOptions = []
        if notify && (content.userInfo["boboNotify"] as? Bool ?? true) { options.insert(.banner) }
        if sound && content.sound != nil && isSuppressed() != true { options.insert(.sound) }
        return options
    }
}
