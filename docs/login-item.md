# bobo 登录时自动启动

入口：设置 → 通用 → 登录时自动启动 bobo。与「设备 → awake」的登录时自动开启保持唤醒分别设置。

使用 macOS 13+ 的 `SMAppService.mainApp` 管理 bobo 自身的登录项，不额外安装 LaunchAgent，不另存一份可能失效的开关值。每次打开通用设置、从系统设置回到窗口、修改开关后，都会回读系统状态。

- 已开启：后续登录 Mac 时启动 bobo。
- 已关闭：不自动启动。
- 需要允许：已注册但系统尚未允许；页面显示提示和「打开系统登录项」按钮，可在系统设置中允许，也可直接关闭开关取消注册。
- 源码运行、非 macOS 或系统无法找到应用时，开关禁用并说明原因。

`GET /api/app/login-item` 读取状态；`POST` 只接受 `{enabled: true/false}` 或 `{openSettings: true}`，受现有 token、Host、Origin 校验保护。服务端只调用当前 App 的 `Contents/MacOS/Bobo --login-item <固定操作>`，原生入口在创建 `NSApplication` 前返回，不会额外打开 bobo 窗口。

测试：`node --test test/login-item.test.mjs`。系统接口与命令执行均可注入，测试不修改真实登录项。真实启用、注销再登录的验证需在安装后由用户操作。

Apple 接口说明：[SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)。
