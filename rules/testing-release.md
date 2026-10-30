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

## 版本号规则

### 格式与唯一来源

- 遵循语义化版本 `MAJOR.MINOR.PATCH`，唯一事实来源是 `package.json` 的 `version` 字段。
- 产物名（`electron-builder/*.yml` 的 `${version}`）、Git tag、GitHub Release 标题和 `release-manifest.json` 一律由该字段派生，不得手写或单独维护。
- 改版本号使用 `npm version <x.y.z> --no-git-tag-version`，确保 `package.json` 与 `package-lock.json` 同步；不手工编辑这两个文件的 `version`。

### 递增时机

- MAJOR：破坏性变更。包括 `AppConfig` `schemaVersion` 升级且不向后兼容、删除或重命名已有配置字段、移除平台或架构支持、删减 preload 暴露面导致远程页面行为不兼容、升级后用户已有配置无法沿用。
- MINOR：向后兼容的新能力。包括新增带默认值的配置字段、新增平台或架构产物、新增 IPC 通道、新增交付格式。
- PATCH：向后兼容的缺陷修复、性能优化、依赖升级、打包与 CI 配置调整。
- 0.x 阶段（当前基线）：MAJOR 固定为 0，破坏性变更升 MINOR，兼容变更升 PATCH；首个正式发布才升到 1.0.0。
- 纯文档、注释、测试或任务记录变更不单独升版。
- 一次发布只升一次版本；该版本内的多个提交合并为同一个版本号，不逐提交升版。

### 预发布

- 预发布号格式为 `x.y.z-rc.N` 或 `x.y.z-beta.N`，`N` 从 1 递增；正式发布去掉后缀，不改前面的 `x.y.z`。
- 不使用 `+build` 构建元数据，避免文件名、tag 与版本字符串不一致。
- 预发布产物名和 tag 同样带后缀，由 `${version}` 自动包含。
- 预发布不得作为正式发布通过的依据；正式版本必须重新跑完整发布门槛。

### tag 与发布绑定

- tag 格式为 `v<version>`（如 `v0.1.1`），由 CI 从 `package.json` 读取生成，不手工创建与之不一致的 tag。
- 一个版本号只发布一次。已发布版本不得复用、不得改内容重打产物、不得删 tag 重建；产物有问题时升 PATCH 重新发布。
- 发布工作流在三平台打包前查询远程精确 tag；已存在时立即失败，查询异常时也失败关闭。发布步骤只创建新 Release，不允许覆盖已有 tag 或产物。
- 创建或推送 tag、触发发布工作流，均属 `AGENTS.md` 中的 Push 授权范围，必须先获得用户明确授权。

### 升版提交

- 升版单独成一个提交，只包含 `package.json`、`package-lock.json` 和 `CHANGELOG.md`，不混入功能或修复改动。
- Commit message 固定格式：`chore: 升级版本号至 x.y.z`。
- 任务完成且验证通过后，凡涉及实质性新增功能（`feat`）或缺陷修复（`fix`），代理必须主动执行升版并提交，无需用户逐次提醒；打 tag、push 和触发发布仍需用户授权。

### CHANGELOG

- 仓库根目录维护 `CHANGELOG.md`，按版本倒序，节标题格式 `## [x.y.z] - YYYY-MM-DD`，条目使用中文。
- 每节按「新增 / 变更 / 修复 / 移除」分组，只写对外可见行为，不罗列内部重构细节。
- 尚未发布的变更先记入 `## [未发布]` 一节，升版时整体移入新版本节。
- 三平台产物清单、SHA-256 和实机验收结论记录在 `docs/release/` 的验收报告与 `release-manifest.json` 中；`CHANGELOG.md` 只做变更摘要，必要时链接过去。

## 发布门槛

- 运行任务要求的窄范围测试，以及 `typecheck`、`lint`、完整测试和对应平台构建。
- 产物验证必须检查目标平台、架构、版本、配置模板位置、签名状态和 SHA-256。
- macOS 缺少签名或 notarization 不得标记为正式发布通过。
- 构建某平台所需宿主机或凭据不可用时，记录阻塞，不得用其他平台构建冒充通过。
- 实机验收报告记录 OS 版本、架构、桌面环境、产物摘要、结果和遗留问题。

## 打包发布配置

- `electron-builder/windows.yml`、`mac.yml`、`linux.yml` 必须显式写顶层 `publish: null`；`package.json` 的构建脚本必须带 `--publish never`。
- 原因：electron-builder 26 在 CI 环境且未指定发布策略时会隐式启用发布（日志 `Implicit publishing triggered by CI detection`），并按 git 远程地址把 GitHub 推断为发布提供方；生成 block map 与自动更新元数据时构造 GitHub publisher，缺少 `GH_TOKEN` 就在产物构建完成后抛 `InvalidConfigurationError`，让整个打包失败。
- 发布到 GitHub Releases 不经过 electron-builder，而是由 `.github/workflows/package.yml` 的 `aggregate` 作业在三平台产物汇总并通过 `npm run verify:release` 后，用 `gh release create` 发布：tag 为 `v<package.json version>`，上传 Windows `.exe`/`.zip`、macOS `.dmg`/`.zip`、Linux `.deb`/`.AppImage`/`.zip` 和 `release-manifest.json`。工作流先在 `checks` 作业拒绝已存在的远程 tag，因此一个版本只发布一次。
- 发布工作流只能从 `main` 手动触发（`workflow_dispatch`），使用工作流内置的 `GITHUB_TOKEN`；触发属于 Push 授权范围，须先获得用户明确授权。
- 本基线不含自动更新基础设施：`publish: null` 跳过 `latest.yml` 等更新元数据生成，GitHub Releases 只作为安装包下载渠道；`scripts/verify-release.ts` 仍只按安装包扩展名校验产物。
- 若将来需要自动更新或改由 electron-builder 直接发布，先补齐凭据注入与发布范围决策，再改配置，并同步更新 `tests/unit/release/packaging-config.test.ts`。
