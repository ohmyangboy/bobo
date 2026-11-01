# awake：Amphetamine 合盖不休眠的原理与实现方案

> 取证设备：MacBook Air `Mac14,2`（Apple M2），macOS 27.0.1（26A434），arm64。
> 取证对象：`/Applications/Amphetamine.app` 5.3.2（Build 9416，Mac App Store 沙盒版，`com.if.Amphetamine`）。
> 取证方式：Mach-O 反汇编（`objdump`/`otool`）、字符串、SDK 头文件、XNU 内核源码、本机 IOKit 运行时探针。
> 结论等级：**已确认** = 反汇编 + 内核源码 + 运行时三者一致；**推断** = 仅反汇编/字符串。

---

## 0. TL;DR

Amphetamine 的「合盖不休眠」不是黑魔法，也不是 kext，而是：

1. **普通会话**：用 `IOPMAssertionCreateWithName` 持有 `PreventUserIdleSystemSleep` / `PreventUserIdleDisplaySleep`，只解决「空闲睡眠」。
2. **合盖不休眠（Closed-Display Mode）**：向 `IOPMrootDomain` 的 user client 发一个**私有 external method**，`selector = 12`（`kPMSetClamshellSleepState`），`scalarInput[0] = 1`。
   内核把 `clamshellSleepDisableMask` 的「powerd」位置 1，于是 `shouldSleepOnClamshellClosed()` 恒为 `false`——合盖不再睡。
   **这条路径在 Apple Silicon 上不需要 root，也不需要 entitlement**（内核处理函数没有 `clientHasPrivilege` 检查）。
3. **Intel 机型**：内核这条路不够，改为安装 `Power Protect`（`/etc/sudoers.d/amphetamine_PowerProtect` + `powerProtect.scpt`），用免密 sudo 执行 `pmset -a disablesleep 1`，并额外写一个 Enhancer 标记文件做崩溃兜底。

因此 `awake` 完全可以做成一个**无 root、无内核扩展、单文件 Swift 的 CLI**，再由 bobo 通知岛调用。合盖能力是内核级全局状态，**进程退出不会自动清除**，必须显式发 `0` 复位——这是整个方案唯一必须认真处理的坑（崩溃/被 kill 后机器会继续「合盖不睡」，在包里会发热掉电）。

---

## 1. Amphetamine 的完整实现拆解

### 1.1 会话层：两个电源断言

运行中的实时读数（`pmset -g assertions`）：

```
pid 23156(Amphetamine): PreventUserIdleSystemSleep named: "Amphetamine (Single-Use - System)"
pid 23156(Amphetamine): PreventUserIdleDisplaySleep named: "Amphetamine (Single-Use - Display)"
```

对应的反汇编字符串：

```
-[AmphSession startSinglePowerAssertions:]   "PreventUserIdleSystemSleep"
-[AmphSession startSingleDisplayPA]          "PreventUserIdleDisplaySleep"
-[AmphSession startTriggerPowerAssertions:]  "Amphetamine (Trigger - System)"
```

`pmset -g` 同时显示：

```
sleep       1 (sleep prevented by sharingd, Amphetamine, codex, powerd)
displaysleep 5 (display sleep prevented by Amphetamine)
```

**结论**：这一层等价于 `caffeinate -d -i`，只能防「用户空闲导致的睡眠」，管不了合盖（合盖是 clamshell 事件，不走 idle 计时器）。

### 1.2 合盖层：IOPMrootDomain 的私有 selector 12

`-[AmphSession enableCDM:]`（arm64 切片，`0x1000802a0`）的关键指令：

```asm
10008065c  add  x0, x0, #0x835      ; "IOPMrootDomain"
100080660  bl   _IOServiceMatching
10008066c  bl   _IOServiceGetMatchingService
100080684  bl   _IOServiceOpen        ; type = 0
100080694  mov  w8, w21               ; w21 = enable ? 1 : 0
100080698  str  x8, [sp, #0x20]       ; scalarInput[0]
1000806a4  mov  w1, #0xc              ; selector = 12
1000806a8  mov  w3, #0x1              ; scalarInputCount = 1
1000806b0  bl   _IOConnectCallScalarMethod
1000806bc  bl   _IOServiceClose
```

配套字符串：

```
IOPMrootDomain called and executed
IOPMrootDomain called and skipped      ← 受隐藏偏好 skipIOPMrootDomain2 控制
Mac is not Intel, not calling runPowerProtectScript
Calling createClosedDisplayModeEnhancerFile / removeClosedDisplayModeEnhancerFile
```

把 selector 对回 SDK 头（`IOKit/pwr_mgt/IOPMLibDefs.h:43`）：

```c
#define kPMSetClamshellSleepState       12
```

再对回 XNU 内核（`iokit/Kernel/RootDomainUserClient.cpp:525`）：

```cpp
case kPMSetClamshellSleepState:
    me->fOwner->setClamShellSleepDisable(arguments->scalarInput[0] ? true : false,
        IOPMrootDomain::kClamshellSleepDisablePowerd);
    ret = kIOReturnSuccess;
    break;
```

**注意：这里没有 `clientHasPrivilege()`、没有 entitlement 检查，参数也只用真值判断**——传 1 置位、传 0 清位，具体 bit 由内核写死。

`iokit/Kernel/IOPMrootDomain.cpp:4458`：

```cpp
bool IOPMrootDomain::shouldSleepOnClamshellClosed(void) {
    if (!clamshellExists) return false;
    return !clamshellDisabled && !(desktopMode && acAdaptorConnected)
           && !clamshellSleepDisableMask;      // ← 非 0 就永不因合盖而睡
}
```

`setClamShellSleepDisable()`（同文件 4541 行）只做位运算；**mask 是全局变量，不跟连接生命周期绑定**，`clientClose()` 里不会清理。所以：

- 发 `1` 之后，合盖不会触发 sleep；
- 直到有人发 `0`、或重启，状态才恢复；
- Amphetamine 崩溃时正是因此需要 Enhancer 兜底（官方帮助原文也警告「可能需要重启」）。

### 1.3 Intel 机型：Power Protect

字符串证据：

```
/etc/sudoers.d/amphetamine_PowerProtect
powerProtect.scpt
installing power protect sudo override...
Mac is not Intel, not calling runPowerProtectScript
pmset -g | awk '/SleepDisabled/{print $2}'
```

流程：在 Intel 上安装一个 AppleScript + sudoers 规则，用**免密 sudo**执行 `pmset -a disablesleep 1`（即 `IOPMrootDomain` 的 `SleepDisabled` 全局位），并在 `pmset -g` 里回读确认。

本机 `/etc/sudoers.d/` 只有 `mole`，说明用户**没有安装** Power Protect——也印证了 Apple Silicon 上不需要它。

### 1.4 盖状态检测与兜底

```
ioreg -r -k AppleClamshellState -d 4 | grep AppleClamshellState | head -1
com.if.Amphetamine.ClosedDisplaySleepMonitor
IOServiceAddInterestNotification(IOPMrootDomain, ...)
```

- 初始状态用 `ioreg` 读 `AppleClamshellState`；
- 之后订阅 `IOPMrootDomain` 的 general interest 通知；
- 另有 59 秒轮询兜底（`displayJustOpenedTimer`）。

兜底文件（给第三方 Amphetamine Enhancer 看的标记）：

```
/cdmPowerAdapter/cdmPowerAdapter.amphetamine
```

App 崩溃后，Enhancer 检测到标记文件但进程不在，就代为复位。

---

## 2. 本机运行时验证（不是只读代码）

### 2.1 参数签名探针

| 调用 | 返回 |
| --- | --- |
| `IOServiceOpen(IOPMrootDomain, type=0)` | `0x0` |
| `IOConnectCallScalarMethod(sel=12, in={1}, inCnt=1, out=NULL, outCnt=0)` | `0x0`（`KERN_SUCCESS`） |
| 同上但 `outCnt=4`（带输出缓冲） | `0xe00002c2`（`kIOReturnBadArgument`） |
| `sel=999`、`inCnt=1`、`outCnt=0` | `0x0`（未定义 selector 走默认成功分支，不能作为存在性证据） |

第三种结果很关键：**只有 `inCnt=1 / outCnt=0` 的签名能通过 `IOExternalMethodDispatch` 的参数校验**，与 `kPMSetClamshellSleepState` 的声明完全一致；多给输出缓冲就直接 `BadArgument`。这证明 selector 12 在本机（macOS 27）依然有效，而不是被裁掉。

### 2.2 Swift 原型（本机编译并运行通过）

```swift
import IOKit
import IOKit.pwr_mgt

func setClamshellSleepDisabled(_ disable: Bool) -> kern_return_t {
    let svc = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
    guard svc != 0 else { return KERN_FAILURE }
    defer { IOObjectRelease(svc) }

    var conn: io_connect_t = 0
    let kr = IOServiceOpen(svc, mach_task_self_, 0, &conn)
    guard kr == KERN_SUCCESS else { return kr }
    defer { IOServiceClose(conn) }

    var input: UInt64 = disable ? 1 : 0
    // 12 = kPMSetClamshellSleepState（私有，无需 root）
    return IOConnectCallScalarMethod(conn, 12, &input, 1, nil, nil)
}
```

实测：`setClamshellSleepDisabled(true)` 返回 `0`；断言进程出现在 `pmset -g assertions`，进程退出后断言自动消失。

### 2.3 未做的验证

**没有真的合盖测试**（会打断当前会话）。合盖效果由三段证据交叉确认：Amphetamine 的实际行为、内核 `shouldSleepOnClamshellClosed()` 的实现、selector/参数签名完全匹配。`awake` 落地后建议做一次 60 秒实测（见 §5）。

---

## 3. 风险与边界

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| 崩溃残留 | mask 是内核全局位，进程被 `SIGKILL` 不会清 | 启动即 `repair`；LaunchAgent 看门狗；复位命令 |
| 过热/耗电 | 合盖后机器仍在包里满载 | 低电量自动停；可选温度检查；通知岛常显剩余时间 |
| 私有 API | selector 编号随 macOS 变化 | 发调用前自检返回码；保留 `pmset` 兜底（需 root，可选） |
| 上架 | 私有 API 不能过 MAS 审核 | `awake` 是本地工具，不进 App Store；bobo 本身也是本地分发 |
| Intel | 该 selector 不足以阻止 SMC 合盖睡眠 | MVP 只保证 Apple Silicon；Intel 走可选的 `sudo pmset -a disablesleep` |

---

## 4. awake MVP 规格

### 4.1 范围

- 新增 CLI：`awake`（Swift，单文件，无第三方依赖）。
- 能力：**合盖不休眠**，支持「永久」与「定时」。
- bobo 通知岛：一枚可点击的常驻图标，**一键开关**；展开后可选择时长；显示剩余时间。
- 参考 Amphetamine 三个勾选项（截图为 UI 参考）：
  1. 允许显示器睡眠 → 不持有 `PreventUserIdleDisplaySleep`
  2. 当显示器关闭时允许系统睡眠 → 不置 clamshell mask（反向开关）
  3. 允许屏幕保护程序在闲置 45m 后运行 → **二期**（MVP 不接线，先留 UI 位）

### 4.2 CLI

```
awake on                  # 永久，直到 awake off
awake on 45m              # 定时：30m / 45m / 1h / 2h / 4h / 8h
awake on 1h --allow-display-sleep
awake off
awake status --json
awake repair              # 无条件复位内核位（启动/看门狗用）
```

退出码：`0` 成功，`2` 参数错误，`3` 已有会话（除非 `--replace`）。

### 4.3 状态机

```
idle ──on──▶ active ──(timer / off / SIGTERM)──▶ restoring ──▶ idle
                  │
                  └─ SIGKILL / crash ──▶ 内核位仍为 1
                                          └─ 下次 awake/登录时 repair
```

会话状态落盘：`~/Library/Application Support/awake/state.json`

```json
{
  "pid": 12345,
  "startedAt": "2026-11-01T12:00:00Z",
  "endsAt": "2026-11-01T13:00:00Z",
  "allowDisplaySleep": false,
  "allowScreensaver": false
}
```

### 4.4 一次 `on` 的完整动作

1. 若已有活会话：`--replace` 则先复位，否则退出。
2. 先把内核位复位为 `0`（清掉上一次的残留），再置 `1`。
3. 创建 `PreventUserIdleSystemSleep` 断言，名字 `awake (System)`。
4. 除非 `--allow-display-sleep`，再创建 `PreventUserIdleDisplaySleep`，名字 `awake (Display)`。
5. 写 `state.json`；注册 `SIGINT/SIGTERM/SIGHUP` 与 `atexit`。
6. 定时模式：`Timer` 到点调用 `off`；同时每 30 秒刷新 `heartbeat`。
7. `off`：释放断言 → 内核位写 `0` → 删 `state.json`。
8. **进程常驻**：断言是「按进程」的，所以 `awake on` 必须是一个前台/后台常驻进程（bobo 用 `Process` 以 detached 方式拉起，或用 LaunchAgent 托管）。

### 4.5 崩溃自愈

- `awake` 每次启动先执行一次 `repair`：如果 `state.json` 里的 pid 不存活，就把内核位写 `0`。
- 登录项 / LaunchAgent `local.bobo.awake-watchdog`：每 60 秒检查 `state.json`，pid 不在且内核位可能为 1 时执行 `awake repair`。
- bobo 启动时也调用一次 `awake repair`（幂等）。
- 用户手动恢复入口：菜单栏 / 通知岛右键「复位」。

### 4.6 与 bobo 通知岛的集成

- 数据源：bobo 原生壳直接 `Process` 调 `awake status --json`，或读 `state.json`（更轻）。
- 折叠态：在额度圆环右侧、设备指示左侧加一枚「咖啡杯/太阳」图标；激活时高亮 + 呼吸点，悬停明细卡显示「已保持 N 分钟 / 剩余 M 分钟」。
- 点击：直接 `awake on`（默认 1 小时）/ `awake off` 切换。
- 长按或右键：菜单 `30 分钟 / 1 小时 / 2 小时 / 4 小时 / 永久 / 关闭 / 复位`。
- 展开态：一行「保持唤醒」开关 + 剩余时间，样式对齐现有会话行。
- 网页「通知岛」设置里加一张卡：`awake` 默认时长、是否允许显示器睡眠、开机自启。
- 构建：`scripts/build-app.sh` 增加 `macos/Awake.swift` 参与编译，并把 `awake` 二进制放进 `Contents/Resources/bin/awake`（或单独构建到 `~/.local/bin`，二选一，优先内置）。

### 4.7 测试清单

- [ ] `awake on 10s` → `pmset -g assertions` 出现 `awake (System)`/`awake (Display)`；10 秒后自动消失。
- [ ] `awake off` 后 `ioreg -n IOPMrootDomain -d 4` 状态正常，`pmset -g` 无残留。
- [ ] `kill -9` 后重新执行 `awake`，`repair` 生效。
- [ ] **合盖实测**：`awake on 2m` → 合盖 → 等 30 秒 → 外接键盘唤醒/开盖，`log show --last 2m --predicate 'eventMessage CONTAINS "Sleep"'` 无 sleep 记录；`pmset -g log | grep -i sleep` 对照。
- [ ] 通知岛点击切换、长按菜单、剩余时间刷新。
- [ ] `awake on --allow-display-sleep` 时显示器能正常休眠。

### 4.8 验收标准

1. Apple Silicon、无 root、无 kext 的前提下，合盖 2 分钟不休眠。
2. 任意退出路径（正常 / Ctrl-C / SIGTERM）都能复位内核位。
3. `kill -9` 后下一次 `awake` 或登录能自动修复。
4. 通知岛一键切换，状态 1 秒内可见。
5. 不引入第三方依赖，`swiftc` 可直接构建。

---

## 5. 二期

- 屏幕保护程序延迟（对应第三个勾选项）。
- 电池阈值自动结束、低电量提醒。
- 触发器（指定 App 运行时保持唤醒、外接显示器时保持唤醒）。
- Intel 支持（`pmset -a disablesleep` + 管理员授权）。
- 合盖状态显示（`AppleClamshellState`）与「合盖后才开始计时」。

---

## 附录 A：证据索引

| 证据 | 位置 |
| --- | --- |
| 版本 / 沙盒 entitlement | `Contents/Info.plist`、`codesign -d --entitlements` |
| `enableCDM:` 反汇编 | arm64 `0x1000802a0`–`0x1000808d4`，IOConnect 在 `0x1000806b0` |
| selector 常量 | `.../IOKit.framework/Headers/pwr_mgt/IOPMLibDefs.h:43` |
| 内核处理分支 | XNU `iokit/Kernel/RootDomainUserClient.cpp:525` |
| 合盖判定 | XNU `iokit/Kernel/IOPMrootDomain.cpp:4458`、`4541` |
| 断言实时值 | `pmset -g assertions`（pid 23156） |
| Intel 兜底 | 字符串 `/etc/sudoers.d/amphetamine_PowerProtect`、`powerProtect.scpt` |
| 崩溃兜底 | 字符串 `/cdmPowerAdapter/cdmPowerAdapter.amphetamine` |

## 附录 B：复现命令

```bash
# 1. 看当前断言
pmset -g assertions | grep -E 'Amphetamine|awake'

# 2. 看内核合盖位
ioreg -n IOPMrootDomain -d 4 | grep -E 'AppleClamshell|SleepDisabled'

# 3. 反汇编（需 Xcode CLT）
objdump --macho --arch=arm64 --disassemble /Applications/Amphetamine.app/Contents/MacOS/Amphetamine \
  | grep -A20 'IOPMrootDomain'
```
