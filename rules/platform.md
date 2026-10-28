# 跨平台实现规则

## 支持矩阵

以 `docs/electron-desktop-shell-product-spec-v2.1-cross-platform.md` 的平台表为准。任何扩大最低版本、CPU 架构或桌面环境范围的改动都要同步更新测试矩阵和发布计划。

## 路径与配置

- 路径解析顺序：`--config-dir`、`UNI_SHELL_CONFIG_DIR`、平台便携路径、平台用户配置目录。
- Windows、Linux AppImage、macOS ZIP 的旁置配置只用于便携交付。
- 安装应用不得写入 macOS `.app` bundle、只读 AppImage 挂载目录、`/usr`、`/opt` 或 Windows 受保护目录。
- DEB/DMG 等安装模式首次运行时，把随包模板复制到用户配置目录；配置升级保留用户数据。
- 统一使用 Node `path` 和 Electron `app.getPath()` 等平台 API；避免手写路径分隔符和字符串拼路径。
- 路径不可写时给出可操作错误，并显示实际读取/写入路径。

## 平台适配

- Windows 登录启动使用当前用户范围；macOS 使用登录项/LaunchAgent；Linux 使用 XDG Autostart。
- 延迟启动由应用内部状态机控制，不能依赖各操作系统精度不同的调度器。
- 托盘需覆盖 Windows 通知区域、macOS 菜单栏和 Linux StatusNotifier；托盘不可用不得导致主程序退出。
- Linux 必须区分 X11 与 Wayland。Wayland 下 Electron 不支持 always-on-top 时，按规格降级并记录日志。
- `setAlwaysOnTop` 层级含义依平台而异；不得承诺覆盖系统安全桌面、锁屏或系统保护界面。
- 多显示器、休眠唤醒、屏幕分辨率变化后重新读取显示器列表并恢复窗口策略。
- 不要只凭 `process.platform` 判断能力；同时检测系统版本、架构和桌面环境，并允许检测失败时安全降级。

## 打包与签名

- Windows：NSIS 当前用户安装 + ZIP；禁止默认安装到 `C:\Program Files`。
- macOS：Universal DMG + ZIP；发布包需 Developer ID 签名和 notarization。
- Linux：DEB + AppImage；AppImage 旁置配置路径需单独验证。
- 构建脚本、证书和签名状态按平台隔离；密钥只通过受保护的 CI secret 注入。
- 每个平台升级验证都必须确认配置不被覆盖，并记录产物架构和 SHA-256。
