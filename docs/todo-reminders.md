# Todo 与系统提醒事项

## 调研结论

可行。由 `bobo.app` 的 Swift 壳持有一个 `EKEventStore`，读取未完成的 `EKReminder`；新增通过 `save(_:commit:)` 写回用户选择的现有提醒事项列表。系统提醒事项、bobo 与支持提醒事项的日历共享系统数据，不另建待办数据库。Node 服务、AI 管家和浏览器模式不接触这些数据。

- **权限**：macOS 14+ 使用 `requestFullAccessToReminders`，13 使用 `requestAccess(to: .reminder)`。同时提供 `NSRemindersFullAccessUsageDescription` 与 `NSRemindersUsageDescription`；签名带 `com.apple.security.personal-information.calendars`，保持现有非沙盒架构。只在用户点击“连接提醒事项”时请求；拒绝后引导到系统设置，不反复弹窗，也不申请日历事件权限。
- **日历可见性**：macOS 15 Sequoia 起，带日期的提醒事项可显示在日历；用户须在日历侧栏勾选“计划的提醒事项”。无日期项不会出现在日历；具体账户支持与 iCloud 同步速度由系统决定。不会为同一待办额外创建日历事件。
- **次要系统入口**：主路径点击事项打开 bobo Todo 详情；只有显式点击“在系统提醒事项中打开”才调用系统 App。公开的 EventKit API 没有“在提醒事项中选中此项”。对 UUID 标识尝试 `x-apple-reminderkit://REMCDReminder/<UUID>/details`（非公开稳定协议，系统版本可能改变），由 `NSWorkspace` 指定交给 `com.apple.reminders`；无法构造或系统拒绝时打开原生 App。界面在设置与详情底部保留系统入口。不能以 URL 被接受证明系统已定位到具体项。
- **同步**：监听 `EKEventStoreChanged`、日期/时区变化与唤醒，回到 bobo 或手动刷新时复查权限和数据；异步加载合并重复刷新，关闭或撤权时丢弃在途结果。仅内存保留事项快照，开关存应用偏好。

依据：[Apple EventKit 权限](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)、[请求提醒事项权限](https://developer.apple.com/documentation/eventkit/ekeventstore/requestfullaccesstoreminders(completion:))、[保存提醒事项](https://developer.apple.com/documentation/eventkit/ekeventstore/save(_:commit:))、[Calendar entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.calendars)、[日历用户指南](https://support.apple.com/guide/calendar/welcome/mac)。单项深链是兼容性尝试，不是 Apple 公开 API 保证。

## 交互与分类

“通知岛 → 近况 → Todo”（位于 bobo 管家下方）是「今日｜近七｜事务」三列看板；连接、岛显示开关、已完成切换与系统入口收在右上角设置中。每列独立滚动，侧栏、标题与空列使用系统提醒事项图标；底部输入默认收缩，点击后原位展开；标题按 Return 直接添加，各列加号可指定初始日期。创建和编辑聚焦标题与备注，底部图标按需展开日期与时间、提醒、列表与优先级、URL，字段沿用本机提醒事项，支持标题、备注、URL、日期、时间、提醒、优先级及现有可写列表。未提供系统原生子任务、标签、紧急闹钟等无法直接写入的字段；编辑保留未暴露的系统字段。

- 今日：日期为今天或已逾期；全天事项跨天才算逾期。
- 近七：明天至今天+7天，包含第七天全天，不受系统每周起始日影响。
- 事务：无日期或今天+7天之后的事项。

默认隐藏已完成，可在主窗设置或岛头切换查看；圆形按钮单独完成/恢复事项，标题点击始终进入 bobo 详情，详情可编辑。新建默认事务无日期，今日默认今天，近七默认明天；修改日期后按实际日期归列。

岛展开后使用同样顺序，以有留白和描边的独立模块底板、列容器、任务卡片与底部输入适配深色环境。所有事项保留在可滚动列内，不以「还有 N 项」截断。底部输入和列头加号在岛内原位展开输入与设置，不弹二次创建卡片，共用 EventKit 仓库。输入和创建时固定面板，避免悬停或输入法候选窗使草稿消失。浏览器与 v2 壳显示需要 macOS 原生 App 的提示。

所有系统可读列表的事项按日期、优先级和标题排序，完成项排在未完成之后；只读列表可查看但不可编辑。日期按本地日历归列，未修改截止时间时保留原时区信息。原生岛保持固定高度，输入框在底部向上展开覆盖列表，不挤压三列布局，关闭 Todo 不删除系统数据。

## 验证边界

`node --test macos/todo.test.mjs` 用注入的假仓库验证分类、日期边界、权限、加载竞争、真实 EventKit 适配器编译与原生布局，不读取真实提醒事项。`npm test` 覆盖网页桥接与现有功能；`node --test macos/island-layout.test.mjs` 覆盖现有通知岛几何。实际 TCC 授权、系统账户同步、日历显示和具体项深链定位需要签名 App 上人工验收。
