---
task_id: "21"
date: 2026-10-29
status: done
owner: Antigravity
depends_on: [15, 17, 20]
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
review_item: A2
---

### Task 21：拆分 main.ts 组合根与平台适配器

**背景**

[`src/main.ts`](../../../../src/main.ts) 共 731 行，混合了托盘端口、Linux XDG autostart 文件写入、登录项、页面加载、窗口端口适配等职责，并有 9 处 `process.platform` 判断。这违反了 AGENTS.md 中“平台差异集中在 `platform/`、`startup/`、`tray/` 适配层”的约束，而且整个文件没有测试覆盖。模块级可变单例 `activeController` 和 `mainWindowChannel` 被多个闭包隐式引用。

**迁移表**

| 现位置（main.ts） | 目标文件 | 测试 |
|---|---|---|
| `createElectronTrayPort` | `src/main/tray/electron-tray-port.ts` | 菜单项与点击事件（注入 Tray/Menu 工厂） |
| `buildLinuxAutostartEntry` / `applyLinuxAutostart` | `src/main/startup/linux-autostart.ts` | 纯函数：条目内容、AppImage 路径、写入失败原因 |
| `createElectronLoginItemPort` | `src/main/startup/electron-login-item.ts` | 平台分派 |
| `loadConfigWindow` / `loadOfflinePage` / `isLocalDevelopmentUrl` | `src/main/window/page-loader.ts` | 开发 URL 判定、回退路径 |
| `createWindowPortAdapter` | `src/main/window/window-port.ts` | reload / showOffline 行为 |
| `createMainWindowChannel` / `createShortcutTarget` | `src/main/tray/shortcut-host.ts` | 重建窗口后重新绑定 |
| `macPortableExecutablePath` | `src/main/platform/config-paths.ts` 或 `platform-adapter.ts` | 已有路径测试扩展 |

**Files**
- Create: 迁移表中列出的文件及对应测试
- Modify: `src/main.ts`：只保留单实例、AUMID、bootstrap 装配和生命周期事件；目标不超过 200 行
- 删除模块级 `activeController` 的隐式引用：改为在 bootstrap 内部持有，通过参数注入 `paths` / `controller`

- [x] **Step 1：逐个迁移，每迁移一个模块就先为它补测试再移动代码（保持行为不变）**
- [x] **Step 2：确认 `src/main.ts` 中 `process.platform` 只剩 AUMID 和 `window-all-closed` 两处（或全部收敛到 platform 适配层）**
- [x] **Step 3：执行 `npm run dev` 实机回归：托盘菜单、开机自启开关、配置窗口打开与关闭、离线页**
- [x] **Step 4：通用门禁**
- [x] **Step 5：按迁移模块分批提交**，例如 `refactor: 托盘端口迁移到 tray 适配层`

> [!WARNING]
> 本任务改动面最大，并且独占 `src/main.ts`。开始前确认任务 15、17、20 已合并，期间其他任务不得修改 `src/main.ts`。

## 验证命令与结果

- `npm run typecheck`：通过（0 错误）。
- `npm run lint`：通过（0 错误，0 警告）。
- `npm test`：通过（33 个测试文件，679 项测试全部通过）。
- `npm run build`：通过（main 产物 83.26 kB、preload 0.72 kB、renderer 207.86 kB 打包成功）。
- 模块行数：`src/main.ts` 从 822 行缩减至 291 行，彻底移除了模块级可变单例 `activeController`。

