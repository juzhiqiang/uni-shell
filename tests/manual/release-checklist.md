# 跨平台发布检查清单

所有正式产物都必须从受信任的 CI runner 构建。签名材料只通过受保护的 CI secrets 注入，不提交到仓库。

## GitHub Actions

- 在仓库 Actions 页面手动运行 `Cross-platform packages` workflow；仅使用 `main` 分支的工作流定义。
- 配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 和 `UNI_SHELL_LINUX_MAINTAINER` secrets。
- 等待 Windows、macOS、Linux 构建及 macOS 汇总 job 全部成功；下载 `release-all-platforms`，确认其中有三平台分目录产物和根目录 `release-manifest.json`。
- workflow 失败、签名/公证失败或任何平台产物缺失时，不将任务或发布标为完成。

## Windows

- 在 Windows x64 runner 上运行 `npm run build:win`，确认输出一个 NSIS `.exe` 和一个 `.zip`。
- 安装器默认采用当前用户安装，可更改目录；确认无需管理员权限且默认目录不在 `C:\Program Files`。
- 在便携目录旁放置有效 `config.json` 后运行 ZIP 包，确认客户端读取该文件。
- 对已配置安装执行升级，确认安装前的旁置 `config.json` 字节内容不变；检查 `%APPDATA%\UniShell\config.json.install-backup` 不遗留。
- 如已提供 Windows 代码签名证书，验证 NSIS `.exe` 的 Authenticode 状态；未配置证书时清单必须显示未签名。

## macOS

- 在 macOS runner 注入 Developer ID 与 Apple notarization secrets，运行 `npm run build:mac`。
- 确认生成 Universal `.dmg` 和 `.zip`，且 ZIP 中 `.app` 通过 `codesign --verify --deep --strict`。
- 确认 `xcrun stapler validate` 对 `.app` 和 `.dmg` 均成功；未签名或未公证的产物不得作为正式发布。
- ZIP 便携运行时在 `.app` 同级放置 `config.json` 并验证读取；DMG 安装首次运行验证用户配置不写入 `.app` 包。
- 在已配置用户目录执行升级，确认现有配置和备份均保留。

## Linux

- 在 Ubuntu 22.04+ x64 runner（或受控 Linux build image）运行 `npm run build:linux`，确认生成 `.deb` 与 `.AppImage`。
- 通过 `UNI_SHELL_LINUX_MAINTAINER` 提供真实的 `Name <email>` 维护者元数据；不得将占位地址用于发布。
- 在 GNOME X11 与 GNOME Wayland 各执行一次实机安装/启动验证。
- 在 AppImage 文件同级放置有效 `config.json`，验证客户端读取旁置配置且不尝试写入运行时挂载目录。
- 安装 DEB 后确认配置只写入 XDG 用户目录；升级前后比较配置与 `.bak` 内容。
- 对每个 Linux 产物执行 SHA-256 校验，并与 `release/release-manifest.json` 一致。

## 通用

- `npm run verify:release` 必须验证三个平台完整产物；平台单独 CI job 可使用 `node scripts/verify-release.ts --platform <platform>` 生成部分清单。
- 清单应记录版本、平台、架构、文件大小、SHA-256 和签名/公证状态。
- 检查 `config.example.json` 的 `schemaVersion` 为 1；发布验证不得创建、替换或覆盖活跃的 `config.json`。
- 将 OS 版本、runner、架构、桌面环境、产物摘要和未解决问题写入任务 11 验收报告。
