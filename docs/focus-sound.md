# 通知岛提示音与 macOS 专注

## 调研结论

`afplay` 是普通音频播放，不经过通知中心，不能自动继承勿扰、睡眠、阅读等专注的通知抑制。不能把“提示音”开关开启视作可以直接发声。

公开的 Intents API `INFocusStatusCenter`（macOS 12+）提供 `authorizationStatus` 和 `focusStatus.isFocused: Bool?`。`true` 表示用户不希望被通知打断；它不提供具体专注名称，也不是“bobo 这条通知会不会被系统允许”的完整判定。用户能关闭全局“共享专注状态”，也能分别关闭勿扰、睡眠、阅读等模式的共享，所以 `false` / `nil` / 无授权都不能作为放行 `afplay` 的依据。

如果主动请求 Focus Status，须调用 `requestAuthorization` 并在 Info.plist 提供 `NSFocusStatusUsageDescription`，用户可以拒绝或撤回授权。它与发送本地通知的授权是两回事。Apple 的通信通知示例还有 SiriKit、通信通知、时效性通知等 capabilities；这些不应为普通岛提示音启用，尤其不能用突破专注的通信或时效性通知代替静音判断。

本实现选择 `UNUserNotificationCenter` + `UNNotificationSound` + `.active` 普通本地通知。Apple 明确说明 active 不突破系统通知管理，专注允许哪些 App 发通知，由系统在投递时裁决。即使未共享 Focus Status，系统仍能执行专注规则。已有 Focus Status 授权且读到 `true` 时，再额外去掉声音；未授权或未知时只交给通知中心，不直接播音。

## 实现与权限

- 提问 `Ping`、结束 `Glass`、终止 `Basso`、额度重置 `Hero` 均沿原有 `remind` 通道传给原生壳。macOS 服务端不再启动 `afplay`。
- “系统通知”控制标题和正文；“提示音”控制声音。只开声音时发送没有标题、正文的声音通知；只开系统通知时发送无声横幅。两个都关掉就不发送。前台投递也检查开关和可用的专注抑制信号。
- 声音由 `UNNotificationSound` 命名资源播放，构建时将四个系统音复制进 app bundle。通知使用 `.active`，没有 `.timeSensitive`、`.critical`、私有 API、私有偏好文件读取或失败后的直接播放兜底。
- **无需新增 Focus Status 授权或 entitlement**：不主动请求或强制用户共享专注状态，只利用已有授权作额外抑制。依 Apple 对使用该 API 的要求，构建脚本仍添加 `NSFocusStatusUsageDescription` 文案；这本身不会申请授权或弹窗。首次启动原生 app 已有的通知授权（`.alert`、`.sound`）继续使用。
- 用户需在 **系统设置 → 通知 → bobo** 允许通知及通知声音；在 bobo **通知岛设置 → 提醒** 打开“提示音”。被系统拒绝通知或关闭通知声音时也不响，不绕过系统设置。
- 在 **系统设置 → 专注模式 → 勿扰 / 睡眠 / 阅读 → 允许通知的 App** 中，系统若抑制 bobo，它的横幅和声音就受抑制。若用户明确允许 bobo，普通通知可以按系统规则到达。无须打开“共享专注状态”。
- 当前 Swift app 是非沙盒的 Developer ID / ad-hoc 应用。普通本地通知在沙盒与非沙盒下都使用 UserNotifications 授权，不需要 APNs、通信通知、时效性或关键警报 entitlement；沙盒不是绕过 Focus / TCC 的许可。自定义声音须放在 app bundle 或应用容器 `Library/Sounds`，不能依赖任意文件访问。Focus Status 主动授权的 usage description 要求也不会因关闭沙盒而消失。
- **运行边界**：macOS 声音现在需要运行包含本实现的原生 bobo.app（即使主窗口关闭、刘海隐藏也可接收通知）。单独 `npm start` 的浏览器页面没有 UserNotifications 原生接收端，因此不会响；不再为这种场景退回绕过专注的 `afplay`。Windows 的原有声音路径保持不变。

## 验证

`test/island-notifications.test.mjs` 验证服务端四种声音、两个开关的组合及 Windows 兼容路径；macOS 上编译实际 Swift 策略，注入抑制 `true / false / nil`，检查声音、横幅、普通中断级别、投递前切换专注和关闭开关、旧 notice 解码。测试不请求 TCC、不播放声音、不修改真实专注模式。

真实验收需要使用新构建的 app，自动测试不能代替以下检查：

1. 允许 bobo 通知与声音、关闭专注。分别触发提问 / 结束 / 终止 / 额度重置，应听到对应音色，且每次只响一次。
2. 分别开启会抑制 bobo 的勿扰 / 睡眠 / 阅读；重复以上事件，确认无提示音、横幅遵守系统策略。覆盖 bobo 前台、后台、主窗口关闭和刘海隐藏。
3. 关闭“共享专注状态”，并关闭每种模式的共享，重复第 2 步，仍应静音；无需 Focus Status 弹窗。
4. 退出专注后触发新事件，恢复提示音。关闭 bobo“提示音”，专注开关都不应让它发声；只开声音不应出现正文横幅，只开系统通知不应响声。
5. 在系统通知设置关闭 bobo 的声音、或拒绝通知授权，应保持静音。切换成允许 bobo 的专注，确认普通通知按系统允许规则投递。

## 公开资料

- [INFocusStatusCenter](https://developer.apple.com/documentation/intents/infocusstatuscenter) 与 [isFocused](https://developer.apple.com/documentation/intents/infocusstatus/isfocused-8ytve)
- [Focus Status usage description](https://developer.apple.com/documentation/bundleresources/information-property-list/nsfocusstatususagedescription) 与 [通信通知及 Focus Status 示例](https://developer.apple.com/documentation/usernotifications/handling-communication-notifications-and-focus-status-updates)
- [Mac 专注共享设置](https://support.apple.com/guide/mac-help/mchl74e8c77b/mac)：可按模式关闭状态共享
- [WWDC21：通知中断级别与 Focus](https://developer.apple.com/videos/play/wwdc2021/10091/) 与 [UNNotificationInterruptionLevel](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel)
- [UNNotificationSound：声音资源位置与格式](https://developer.apple.com/documentation/usernotifications/unnotificationsound)
