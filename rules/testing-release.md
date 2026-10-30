# 测试与发布规则

## 自动化测试

- 纯配置、路径、状态机、错误分类和能力映射逻辑优先使用 Vitest 单元测试。
- Electron API 使用依赖注入或 adapter mock；测试不能依赖真实登录项或桌面托盘状态。
- 配置持久化测试覆盖缺失、损坏、只读、备份和原子替换。
- 网络测试覆盖断网、恢复、DNS/TLS/HTTP 错误、重复重试和退出清理。
- 安全测试覆盖来源白名单、重定向、弹窗、下载、权限和 preload 暴露面。
- UI 测试覆盖校验、保存失败、恢复默认值和未保存关闭。

## 平台验收

- Windows：Windows 10/11、标准用户、NSIS/ZIP、任务栏/托盘、自启、中文和非系统路径。
- macOS：最低支持版本及当前版本、Intel/Apple Silicon、签名公证、DMG/ZIP、菜单栏、自启、休眠唤醒。
- Linux：Ubuntu/Debian、GNOME X11/Wayland、DEB/AppImage、XDG 自启、托盘协议缺失降级。
- 三平台均测试多显示器、配置只读、断网恢复、重复启动、升级保留配置和退出清理。
- 置顶与 Kiosk 的平台差异按产品规格验证，不把无法覆盖系统界面当作实现缺陷。

## 发布门槛

- 运行任务要求的窄范围测试，以及 `typecheck`、`lint`、完整测试和对应平台构建。
- 产物验证必须检查目标平台、架构、版本、配置模板位置、签名状态和 SHA-256。
- macOS 缺少签名或 notarization 不得标记为正式发布通过。
- 构建某平台所需宿主机或凭据不可用时，记录阻塞，不得用其他平台构建冒充通过。
- 实机验收报告记录 OS 版本、架构、桌面环境、产物摘要、结果和遗留问题。

## 打包发布配置

- `electron-builder/windows.yml`、`mac.yml`、`linux.yml` 必须显式写顶层 `publish: null`；`package.json` 的构建脚本必须带 `--publish never`。
- 原因：electron-builder 26 在 CI 环境且未指定发布策略时会隐式启用发布（日志 `Implicit publishing triggered by CI detection`），并按 git 远程地址把 GitHub 推断为发布提供方；生成 block map 与自动更新元数据时构造 GitHub publisher，缺少 `GH_TOKEN` 就在产物构建完成后抛 `InvalidConfigurationError`，让整个打包失败。
- 本基地不含自动更新基础设施，产物只通过 CI artifact 分发；`publish: null` 同时跳过 `latest.yml` 等更新元数据生成，`scripts/verify-release.ts` 仍只按安装包扩展名校验产物。
- 若将来需要发布，先补齐凭据注入与发布范围决策，再改配置，并同步更新 `tests/unit/release/packaging-config.test.ts`。
