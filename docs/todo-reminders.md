# tobo 与系统提醒事项

## 调研结论

可行。由 `bobo.app` 的 Swift 壳持有一个 `EKEventStore`，读取未完成的 `EKReminder`；新增通过 `save(_:commit:)` 写回用户选择的现有提醒事项列表。系统提醒事项、bobo 与支持提醒事项的日历共享系统数据，不另建待办数据库。Node 服务、AI 管家和浏览器模式不接触这些数据。

- **权限**：macOS 14+ 使用 `requestFullAccessToReminders`，13 使用 `requestAccess(to: .reminder)`。同时提供 `NSRemindersFullAccessUsageDescription` 与 `NSRemindersUsageDescription`；签名带 `com.apple.security.personal-information.calendars`，保持现有非沙盒架构。只在用户点击“连接提醒事项”时请求；拒绝后引导到系统设置，不反复弹窗，也不申请日历事件权限。
- **日历可见性**：macOS 15 Sequoia 起，带日期的提醒事项可显示在日历；用户须在日历侧栏勾选“计划的提醒事项”。无日期项不会出现在日历；具体账户支持与 iCloud 同步速度由系统决定。不会为同一待办额外创建日历事件。
- **次要系统入口**：主路径点击可编辑事项原位展开标题、备注与设置；只有显式点击“在系统提醒事项中打开”才调用系统 App。公开的 EventKit API 没有“在提醒事项中选中此项”。对 UUID 标识尝试 `x-apple-reminderkit://REMCDReminder/<UUID>/details`（非公开稳定协议，系统版本可能改变），由 `NSWorkspace` 指定交给 `com.apple.reminders`；无法构造或系统拒绝时打开原生 App。界面在设置与详情底部保留系统入口。不能以 URL 被接受证明系统已定位到具体项。
- **同步**：监听 `EKEventStoreChanged`、日期/时区变化与唤醒，回到 bobo 或手动刷新时复查权限和数据；异步加载合并重复刷新，关闭或撤权时丢弃在途结果。仅内存保留事项快照，开关存应用偏好。

依据：[Apple EventKit 权限](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)、[请求提醒事项权限](https://developer.apple.com/documentation/eventkit/ekeventstore/requestfullaccesstoreminders(completion:))、[保存提醒事项](https://developer.apple.com/documentation/eventkit/ekeventstore/save(_:commit:))、[Calendar entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.calendars)、[日历用户指南](https://support.apple.com/guide/calendar/welcome/mac)。单项深链是兼容性尝试，不是 Apple 公开 API 保证。

## 交互与分类

“通知岛 → 近况 → tobo”（位于 bobo 管家下方）是「今日｜近七｜事务」三列看板；连接、岛显示开关、已完成切换与“打开 tobo”和“打开提醒事项”入口收在输入胶囊右侧设置中。每列独立滚动，侧栏与悬浮输入使用系统提醒事项图标；底部输入占位为“todo？tobo！”，默认收缩为小型悬浮输入，点击后原位向上展开；标题按 Return 直接添加，各列加号可指定初始日期。创建和编辑聚焦标题，备注与日期、时间、提醒、列表、优先级和 URL 均由工具栏按需展开，字段沿用本机提醒事项，支持标题、备注、URL、日期、时间、提醒、优先级及现有可写列表。未提供系统原生子任务、标签、紧急闹钟等无法直接写入的字段；编辑保留未暴露的系统字段。

- 今日：日期为今天或已逾期；全天事项跨天才算逾期。
- 近七：明天至今天+7天，包含第七天全天，不受系统每周起始日影响。
- 事务：无日期或今天+7天之后的事项。

默认隐藏已完成，可在主窗设置或岛内胶囊的更多菜单切换查看；圆形按钮单独完成/恢复事项；点击可编辑事项原位修改标题、备注、日期、时间、提醒、列表、优先级与 URL，回车保存，切换事项或点击空白时先保存；失败保留当前行和草稿；结束编辑时标题、备注与链接均为空则删除已有事项，新建空白不保存。原生岛的日期等设置由行内工具弹出小浮层，主窗在当前行展开；只读事项仅可查看。胶囊与全局新建默认今天并归入今日，列表默认为“系统默认”，不沿用上次编辑或新建时选择的项目列表；今日列默认今天，近七列默认明天，事务列默认无日期；修改日期后按实际日期归列。

岛展开后使用同样顺序，以独立模块底板、等宽列、轻分隔线与底部输入适配深色环境；统一左右基线和必要间距，避免多层描边贴叠；岛内三列等宽，列头只保留名称、数量与加号；收缩态的系统提醒事项图标和更多菜单融入底部胶囊两端；展开后图标移入底部工具栏，标题、备注与设置面板共用左对齐线。事项默认不铺卡片底色，仅悬停时突出；日期省略重复的“今天”“未设日期”，列表名称留在详情中。收缩输入不显示回车按钮，默认添加到今日；展开时沿原胶囊的底部中心放大，保持同一层材质、圆角与紧凑控件。所有事项保留在可滚动列内，不以「还有 N 项」截断。底部输入和列头加号在岛内原位展开新建输入与设置，不弹二次创建卡片，共用 EventKit 仓库。输入时鼠标移出仍保持编辑；点击输入区外收起输入框，草稿保留，重新点击胶囊继续；点击通知岛外同时收起通知岛。输入区和设置使用短距离、快起步缓收尾的过渡，遵守系统减少动态效果设置。浏览器与 v2 壳显示需要 macOS 原生 App 的提示。

所有系统可读列表的事项按日期、优先级和标题排序，完成项排在未完成之后；只读列表可查看但不可编辑。日期按本地日历归列，未修改截止时间时保留原时区信息。原生岛的 tobo 模块保持 216pt 固定高度，输入框在底部向上展开覆盖列表，不挤压三列布局；会话区从展开首帧固定为目标高度，窗口补间只裁切显示，避免中途伸长下推 tobo。没有会话时不显示空态文案、分隔线或预留高度；关闭 tobo 与 bobo 管家且没有会话时，悬停只让顶栏向左右展开。关闭 tobo 不删除系统数据。

## 验证边界

`node --test macos/todo.test.mjs` 用注入的假仓库验证分类、日期边界、权限、加载竞争、真实 EventKit 适配器编译与原生布局，不读取真实提醒事项。`npm test` 覆盖网页桥接与现有功能；`node --test macos/island-layout.test.mjs` 覆盖现有通知岛几何。实际 TCC 授权、系统账户同步、日历显示和具体项深链定位需要签名 App 上人工验收。
