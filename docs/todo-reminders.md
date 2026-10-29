# Todo 与系统提醒事项

## 调研结论

可行。由 `bobo.app` 的 Swift 壳持有一个 `EKEventStore`，读取未完成的 `EKReminder`；新增通过 `save(_:commit:)` 写回用户选择的现有提醒事项列表。系统提醒事项、bobo 与支持提醒事项的日历共享系统数据，不另建待办数据库。Node 服务、AI 管家和浏览器模式不接触这些数据。

- **权限**：macOS 14+ 使用 `requestFullAccessToReminders`，13 使用 `requestAccess(to: .reminder)`。同时提供 `NSRemindersFullAccessUsageDescription` 与 `NSRemindersUsageDescription`；签名带 `com.apple.security.personal-information.calendars`，保持现有非沙盒架构。只在用户点击“连接提醒事项”时请求；拒绝后引导到系统设置，不反复弹窗，也不申请日历事件权限。
- **日历可见性**：macOS 15 Sequoia 起，带日期的提醒事项可显示在日历；用户须在日历侧栏勾选“计划的提醒事项”。无日期项不会出现在日历；具体账户支持与 iCloud 同步速度由系统决定。不会为同一待办额外创建日历事件。
- **跳转**：公开的 EventKit API 没有“在提醒事项中选中此项”。对 UUID 标识尝试 `x-apple-reminderkit://REMCDReminder/<UUID>/details`（非公开稳定协议，系统版本可能改变），由 `NSWorkspace` 指定交给 `com.apple.reminders`；无法构造或系统拒绝时打开原生 App。界面始终保留“打开提醒事项”入口。不能以 URL 被接受证明系统已定位到具体项。
- **同步**：监听 `EKEventStoreChanged`、日期/时区变化与唤醒，回到 bobo 或手动刷新时复查权限和数据；异步加载合并重复刷新，关闭或撤权时丢弃在途结果。仅内存保留标题与日期，开关存应用偏好。

依据：[Apple EventKit 权限](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)、[请求提醒事项权限](https://developer.apple.com/documentation/eventkit/ekeventstore/requestfullaccesstoreminders(completion:))、[保存提醒事项](https://developer.apple.com/documentation/eventkit/ekeventstore/save(_:commit:))、[Calendar entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.calendars)、[日历用户指南](https://support.apple.com/guide/calendar/welcome/mac)。单项深链是兼容性尝试，不是 Apple 公开 API 保证。

## 交互与分类

“通知岛 → 相关 → Todo”连接系统提醒事项、开关岛内显示、浏览全部事项、新增标题与可选日期（写入现有可写列表）。浏览器与 v2 壳显示需要 macOS 原生 App 的提示。

岛展开后按 **稍后 → 本周 → 今天** 从左到右显示，每列最多三条，更多项可进入 Todo 查看；点击标题打开原生提醒事项，不会把事项标成已完成。

- 今天：今天到期和所有逾期的未完成项；逾期有明确标记。
- 本周：明天至系统日历设置的本周末，排除今天。
- 稍后：无日期，或下周及以后的事项。

所有系统可读列表的未完成事项都会进入分类；日期优先、同日期按优先级和标题排序。全天日期按本地日历解释，带时区的时间保留其时区。原生岛不随事项数量无限增高，关闭 Todo 不删除系统数据。

## 验证边界

`node --test macos/todo.test.mjs` 用注入的假仓库验证分类、日期边界、权限、加载竞争、真实 EventKit 适配器编译与原生布局，不读取真实提醒事项。`npm test` 覆盖网页桥接与现有功能；`node --test macos/island-layout.test.mjs` 覆盖现有通知岛几何。实际 TCC 授权、系统账户同步、日历显示和具体项深链定位需要签名 App 上人工验收。
