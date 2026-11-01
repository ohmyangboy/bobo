# awake 使用与验收

awake 是 macOS 本地保持唤醒工具。合盖保护仅面向已取证的 Apple Silicon；私有 selector 的证据与边界见 [设计报告](awake-amphetamine.md)。

## 构建与运行

```sh
bash scripts/build-awake.sh             # dist/awake
bash scripts/build-app.sh               # dist/bobo.app，内置 Resources/bin/awake
./dist/awake on 5s                      # 前台常驻，五秒后自动清理
./dist/awake on 1h --allow-display-sleep
./dist/awake on 永久 --replace
./dist/awake status --json
./dist/awake off
./dist/awake repair
```

`on` 不传时长表示永久；通知岛一键开启默认一小时。支持正整数 `s` / `m` / `h`，最长十年。参数错误退出码 2，已有会话而未指定 `--replace` 时退出码 3，其余失败退出码 1。

`on` 持有会话锁并常驻，收到 SIGINT / SIGTERM / SIGHUP 或到期时释放断言并清除合盖位。`off`、`repair` 都先通知活持有者退出，确认锁释放后再复位；可重复执行。内部 `repair --stale-only` 只处理没有持有者的残留，供启动自检使用，不打断正常会话。PID 出生时间用于防止 PID 复用后误发信号。

状态保存在 `~/Library/Application Support/awake/state.json`，含 PID、进程出生时间、会话 ID、开始 / 结束时间、两个睡眠选项与每秒心跳；时间为 ISO 8601。`status --json` 返回 `active`、`phase`（idle / active / orphaned / error），存在会话时附 `state`，失败时附 `error`。

## 通知岛

展开通知岛后显示咖啡杯，默认位于设置图标左侧（设备 → 网络 → awake → 设置 → 退出），已拖动保存的顺序保持不变。收起时保留额度、系统状态和网络，不显示咖啡杯或为它预留宽度。点击切换；右键或长按可选 30 分钟、1 / 2 / 4 小时、永久、关闭、复位。悬停卡显示状态、开始时间、剩余时间与睡眠选项，展开内容区不再重复一行开关。倒计时只刷新局部视图，状态在后台每 0.5 秒检查，心跳不发布到整棵视图。

额度、awake、设备、网络、设置和退出图标支持在顶栏混排拖动；系统图标位置保存在原生偏好的 `bobo.island.barOrder`，额度顺序继续同步 `usage.json` 与网页。隐藏的来源 / 按钮保留槽位，展开或重新可用后回到原位置。拖动时按各图标实际宽度计算，结束后抑制误点击。通知岛设置入口位于左栏顶部列表。

顶栏默认保持原有的两侧排列。刘海屏折叠时，若左侧头像撑宽两翼，右侧会在已有空位内补充可用的额度图标，不因此继续加宽胶囊；头像少时仍显示当前一枚。补充数量遵守并排上限，并按余额等图标的实际宽度计算。「点击切换」方式保持单枚额度显示。

长按菜单与网页「设备 → awake · 保持唤醒」共用 `~/.bobo/awake.json`；网页开关使用与其它设置相同的控件：

- `defaultDuration`：默认 `1h`。
- `allowDisplaySleep`：默认 false；开启后不创建显示器防睡眠断言。
- `allowSystemSleepOnDisplayOff`：默认 false；开启后不置合盖保护位，仍持有防空闲系统睡眠断言。这与单纯熄屏后立即睡眠有区别。
- `launchAtLogin`：默认 false。显式开启后安装 `local.bobo.awake-login` 用户登录项，立即运行一次；随后每次登录按当前默认时长开启。不设置 KeepAlive，计时结束后不会反复启动。关闭时卸载；注册失败回滚设置和 plist。设置只影响下次开启。

屏幕保护程序选项禁用，标注「即将支持」。bobo 退出后已经启动的 awake 仍独立持有会话并按时结束；可以从 CLI 关闭。

## 恢复与风险

私有 selector 12 写入的是 powerd 共用的全局位，进程死亡不会自动恢复；也无法隔离 Amphetamine 等工具的同时使用。切换或复位会影响这个共享位，应避免同时开启同类工具。仅返回成功不能证明未来 macOS 版本上仍有效。

bobo 启动时执行一次孤儿修复，运行期间每 0.5 秒检查并修复失效会话。未安装独立 LaunchAgent 看门狗：若 awake 被 SIGKILL 且 bobo 也不在运行，残留需要下次启动 bobo / awake 或手动 `awake repair` 才会清理。复位失败时保留状态文件，不把失败伪装成已清理。合盖后持续运行会耗电发热；低电量保护、温度策略与 Intel 适配不在 MVP 内。

## 验证

```sh
node --test test/awake.test.mjs          # 临时目录 + 注入时钟 / 进程 / 电源接口，不调用真实电源 API
npm test
node --test macos/island-layout.test.mjs
```

真实电源验收应先结束其它保持唤醒工具的会话，再执行 `awake on 5s`，在另一终端用 `pmset -g assertions` 确认出现 `awake (System)` / `awake (Display)`，到期后消失。另验 SIGTERM / SIGHUP、`--allow-display-sleep`、SIGKILL 后 `repair`，以及实际合盖和通知岛点击 / 长按 / 悬停。构建成功、注入测试通过与这些手动验收分别记录。
