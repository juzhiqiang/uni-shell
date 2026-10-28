# 2026-10-28 Electron Shell Tasks

> **已废弃：** 本目录下的 Windows 单平台任务已由 [跨平台任务索引](cross-platform/README.md) 替代。请勿从本索引启动新实施。

Source plan: [2026-10-28-electron-shell.md](../../superpowers/plans/2026-10-28-electron-shell.md)  
Product spec: [electron-desktop-shell-product-spec-v2.0.md](../../electron-desktop-shell-product-spec-v2.0.md)

Execute the tasks in numeric order. Each task file contains its file map, interfaces, implementation steps, verification commands, and commit boundary.

| ID | Status | Task | Deliverable |
|---:|---|---|---|
| 01 | Pending | [Initialize Electron + TypeScript project](01-initialize-electron-typescript-project.md) | Runnable project scaffold and test commands |
| 02 | Pending | [Config model, validation, persistence](02-config-model-validation-persistence.md) | Validated atomic config storage |
| 03 | Pending | [App lifecycle and single instance](03-app-lifecycle-single-instance.md) | Controlled startup and second-instance wake behavior |
| 04 | Pending | [Secure windows and configuration window](04-secure-windows-configuration.md) | Hardened remote page and local config UI windows |
| 05 | Pending | [Proxy, offline page, retry](05-proxy-offline-retry.md) | Proxy modes and bounded network recovery |
| 06 | Pending | [Startup, tray, focused shortcut](06-startup-tray-shortcut.md) | Login startup, delayed presentation, tray maintenance |
| 07 | Pending | [Configuration UI and save flow](07-configuration-ui-save-flow.md) | Local visual configuration and controlled restart |
| 08 | Pending | [Logging, diagnostics, recovery](08-logging-diagnostics-recovery.md) | Redacted logs and recoverable failure paths |
| 09 | Pending | [Packaging, installer, portable ZIP](09-packaging-installer-portable.md) | NSIS installer, ZIP package, release verification |
| 10 | Pending | [Windows acceptance and release baseline](10-windows-acceptance-release.md) | Real-machine acceptance report and release manifest |

## 状态约定

- `pending`：尚未实施。
- `in_progress`：正在实施；及时更新任务复选项。
- `blocked`：记录阻塞原因、已做检查和所需决策。
- `done`：全部验证通过，且存在对应任务提交。
- `deprecated`：历史任务，不得用于当前实现。

不得仅因实现代码存在就标记任务完成；任务文件中必须记录验证证据。
