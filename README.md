# Uni Shell

Uni Shell 是一个基于 Electron 的跨平台桌面客户端外壳，用于在 Windows、macOS 和 Linux 上承载指定的 Web 业务系统。客户端包含本地配置界面，并由主进程统一管理窗口、配置、网络策略、托盘、自启和诊断日志。

## 项目状态

仓库已包含 Electron + TypeScript + React 工程、主进程模块、配置界面、自动化测试和三平台打包配置。当前处于架构优化与验收阶段：主进程架构与性能改进任务（任务 14–21、23、24）已完成并合并到主分支，包括组合根解耦、ConfigService 单一权威配置、会话分区隔离、指数退避重试、启动关键路径优化与日志流化。

详细状态见 [2026-10-29 架构与性能任务索引](docs/task/2026-10-29/architecture-performance/README.md) 与 [2026-10-29 返工任务索引](docs/task/2026-10-29/interface-proxy-and-app-icon/README.md)。当前发布阻塞和验证记录见 [验收报告](docs/release/2026-10-28-v1.0-acceptance-report.md)。

## 功能范围

- 使用统一 JSON 配置承载目标网址、窗口策略、网络、启动、维护、安全、外观和日志选项。
- 配置缺失或无效时进入本地配置界面；配置写入包含校验、备份和原子替换。
- 提供单实例唤醒、延迟显示、托盘/菜单栏、自启和多显示器相关策略，并按平台能力降级。
- 远程网页与本地配置界面使用隔离的窗口配置；远程页面禁用 Node 集成并启用上下文隔离和沙箱。
- 支持离线提示与网络恢复重试，并记录脱敏诊断日志。
- 目标交付包括 Windows NSIS/ZIP、macOS 签名公证 DMG/ZIP、Linux DEB/AppImage；各平台产物及实机验收状态以发布报告为准。

本项目只实现客户端外壳，不包含独立反向代理服务、业务系统的登录/权限逻辑或自动更新基础设施。产品范围和行为以 [产品规格](docs/electron-desktop-shell-product-spec-v2.1-cross-platform.md) 为准。

## 环境要求

- Node.js 22.x 和 npm（仓库锁文件使用 npm）。
- Windows、macOS 或 Linux；平台打包、签名和公证还需要相应平台工具链与凭据。
- 支持基线为 Windows 10 21H2+ x64、macOS 13+ x64/arm64/Universal、Ubuntu 22.04+ x64；Linux 另兼容 Debian 12。Linux 发布验收要求覆盖 GNOME X11 和 GNOME Wayland。

不在当前支持承诺内的架构/模式包括 Windows ARM64、Linux ARM64 和 macOS Rosetta 长期运行模式。

## 快速开始

```sh
npm ci
npm run dev
```

开发启动后会打开本地配置界面。首次运行可在界面中填写目标网址；也可从 [配置模板](resources/config.example.json) 开始准备配置。模板中的 `https://example.com` 是占位地址，发布前应替换成实际业务地址。更多字段、路径优先级和平台差异见产品规格「配置文件管理」章节。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动 Electron 开发环境 |
| `npm run typecheck` | 检查前后端 TypeScript 项目 |
| `npm test` | 运行 Vitest 测试 |
| `npm run lint` | 运行 ESLint |
| `npm run build` | 构建应用 |
| `npm run build:dir` | 构建未安装的应用目录 |
| `npm run build:win` | 构建 Windows NSIS/ZIP |
| `npm run build:mac` | 预检并构建 macOS DMG/ZIP |
| `npm run build:linux` | 预检并构建 Linux DEB/AppImage |
| `npm run verify:release` | 执行类型检查、Lint、测试和发布产物校验 |

macOS 构建要求 Apple Developer ID 签名与公证配置；Linux/Windows 也有平台工具链和打包环境要求。发布验证命令不能替代实机验收。详细约束见 [测试与发布规则](rules/testing-release.md) 和 [手动验收清单](tests/manual/cross-platform-acceptance.md)。

## 代码结构

```text
src/
  main/       主进程：生命周期、配置、窗口、网络、平台适配、托盘与日志
  preload/    配置界面使用的白名单 IPC 桥接
  renderer/   本地配置界面和离线页面
tests/
  unit/       模块单元测试
  integration/跨模块集成测试
  manual/     发布与平台实机验收清单
resources/    配置模板和应用资源
electron-builder/ 三平台打包配置
docs/         产品规格、开发计划、任务记录和发布报告
rules/        按主题组织的工程规则
```

主进程持有应用生命周期和配置状态的权威实现。操作系统差异集中在平台/启动/托盘适配层；远程页面不得获得任意文件系统、Shell、Node 或 IPC 能力。参与开发前请阅读 [AI 协作规则](AGENTS.md)，并按任务类型读取 `rules/` 下的对应规则。

## 项目文档

- [产品规格 v2.1（跨平台）](docs/electron-desktop-shell-product-spec-v2.1-cross-platform.md)：当前产品行为、配置结构、支持矩阵和验收标准。
- [跨平台开发计划](docs/superpowers/plans/2026-10-28-electron-shell-cross-platform.md)：架构、交付顺序和基线任务。
- [2026-10-28 跨平台任务索引](docs/task/2026-10-28/cross-platform/README.md)：工程实现、打包和实机验收任务状态。
- [2026-10-29 返工任务索引](docs/task/2026-10-29/interface-proxy-and-app-icon/README.md)：接口代理语义和自定义图标任务。
- [2026-10-29 架构与性能改进任务索引](docs/task/2026-10-29/architecture-performance/README.md)：启动路径、会话分区、ConfigService、重试退避与 main.ts 适配器解耦。
- [验收报告草稿](docs/release/2026-10-28-v1.0-acceptance-report.md)：自动化验证、产物状态、未完成的实机验收和发布阻塞。
- [AI 协作规则](AGENTS.md)：任务执行、验证、文档维护和 Git 约定。
