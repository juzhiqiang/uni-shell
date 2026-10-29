---
task_id: "16"
date: 2026-10-29
status: done
owner: Fable 5
depends_on: []
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
review_item: P2、P4
accepted_at: "2026-10-30"
---

### Task 16：首屏无白闪与构建产物压缩

**背景**
1. [`WindowManager.createMainWindow`](../../../../src/main/window/window-manager.ts) 使用 `show: true` 且没有设置 `backgroundColor`，窗口先以白底显示再加载页面，产生白屏闪烁；配置窗口同样如此。
2. `dist/renderer/config/assets/index-*.js` 为 584 KB、13,173 行，没有经过 minify；main 和 preload 产物同样未压缩。

**Files**
- Modify: `src/main/window/window-manager.ts`：两类窗口改为 `show: false` 加 `backgroundColor`；在 `ready-to-show` 时按 `startup.initialState` 决定 `show()`、`showInactive()` 或保持隐藏；增加兜底超时（例如 3 秒内未触发 `ready-to-show` 也显示），避免远程页挂起导致窗口永不出现
- Modify: `BrowserWindowLike` / `BrowserWindowConstructorOptions`：增加 `once('ready-to-show')` 与 `backgroundColor`
- Modify: `vite.config.ts`：`renderer.build.minify = 'esbuild'`；main 和 preload 同样开启（保留 sourcemap 选项，按需输出）
- Test: `tests/integration/window-manager.test.ts`（FakeWindow 增加 `once` 与 ready 事件模拟）
- **越界修改（需集成负责人知悉，见下方「越界文件」）**：`src/main/app-controller.ts`、`src/main.ts`、`tests/integration/app-controller.test.ts`

- [x] **Step 1：编写失败测试**：创建主窗口后 `show` 未被调用；触发 `ready-to-show` 后才调用；`initialState: 'tray'` 时不调用；超时兜底生效
- [x] **Step 2：实现窗口显示时序**
- [x] **Step 3：开启 minify，执行 `npm run build`，记录产物体积对比（目标为 renderer JS 不超过 220 KB）**
- [x] **Step 4：执行 `npm run dev` 实机确认配置窗口与主窗口均无白闪** —— 2026-10-30 用户实机确认通过（见「实机验收」）
- [x] **Step 5：通用门禁**
- [x] **Step 6：提交**：分为两个提交：`perf: 主窗口就绪后再显示，消除白屏闪烁`、`perf: 开启构建产物压缩`

> [!NOTE]
> 与任务 15 的关系：`ready-to-show` 超时兜底使用的定时器必须在窗口 `closed` 时清除，遵守 `rules/architecture.md`“所有资源必须可释放”。

## 实施记录

### 越界文件（`app-controller.ts` / `main.ts`）

`startup.initialState` 的 schema 默认值是 `tray`，而窗口按初始驻留状态隐藏创建后**必须有人显式显示它**。控制器 `showMainWindow()` 原先只建窗不显示（建窗前调用的 `hideMain()` 在窗口不存在时是空操作），因此只改窗口层会让默认配置启动后窗口永不出现。

用「真实 `WindowManager` + 控制器窗口端口」做过正反两步验证（临时测试，未入库）：保留控制器建窗后显式显示时窗口可见；把控制器改回「只建窗不显示」时窗口保持隐藏。故本任务必须越界改这两个文件：

- `src/main/app-controller.ts`：`showMainWindow({ revealAfterCreate })`。托盘、二次启动唤醒、焦点快捷键等**显式**请求一律创建后显示并聚焦；延迟到期这类**隐性**展示在 `initialState=minimized` 时交给窗口层的 `showInactive`（不抢焦点）。
- `src/main.ts`：窗口端口适配里两条「按最近配置重建窗口」的路径（`showAndFocusMain`、`reloadMain`）在重建后显式显示；`focusConfigWindow` 改走 `WindowManager.focusConfigWindow()`，让配置窗口也受首屏时序保护。

文件所有权上 `app-controller.ts` 归属任务 14/15/19/20/24、`main.ts` 归属 15/17/20/21。任务 18（`6f40de3`）已在本次提交之后完成同文件的再导出清理，两边改动区域不重叠、无冲突；仍需集成负责人在合并时确认。

### 首屏显示时序设计

- 占位底色 `#f5f6f8`，与配置界面 `--color-bg`、离线页底色（`#f4f6f5`）一致，保证就绪前那一下不再是操作系统默认白底。
- `InitialReveal`：`show: false` 建窗 → `once('ready-to-show')` 或 3 秒兜底 → 执行挂起动作；主动显示请求在首帧未就绪时同样挂起，就绪后统一执行（不为抢显示而牺牲首屏质量）。
- 释放：`close` 时放弃挂起的自动显示（close-to-hide 之后不得再把窗口弹出来），`closed` 时清除兜底定时器；`releaseWindow` 同步清理 `reveals` 表。
- `resolveInitialVisibility`：`tray` → 保持隐藏、`minimized` → `showInactive`、其余 → 显示并聚焦。当前 `InitialState` 只有两个取值，第三个分支是给未来取值预留的默认行为；配置窗口固定走「显示并聚焦」（它是用户显式打开的入口）。

## 实机验收

- [x] 2026-10-30，用户在真实桌面执行 `npm run dev` 确认首屏无白闪：主窗口与配置窗口就绪前均为占位底色，不再出现白色空窗；判定**通过**。
  - 平台/桌面环境、目标站点与逐项勾选细节待用户补充后回填（`rules/testing-release.md` 要求实机验收报告记录 OS 版本、架构、桌面环境）。
  - 建议同时复核的四项时序行为：`initialState=tray`（默认）启动先驻留托盘、延迟到期后窗口出现；`initialState=minimized` 时窗口出现但不抢焦点；远程页挂起时窗口在 3 秒内仍出现（兜底）；托盘「立即显示窗口」与二次启动唤醒都能把窗口显示出来。

## 验证命令与结果

均在 `fix/ignore-err-aborted` 分支（任务 14 提交 `2fd6410` 之后、任务 18 提交 `6f40de3` 之前/之后的当前工作区）执行；沙箱为 Linux，`node_modules` 为 Windows 侧安装。

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（`tsc --noEmit` 两个工程，无输出） |
| `npm run lint` | 通过（`eslint src tests scripts vite.config.ts`，0 问题） |
| `npm test` | 通过：21 个文件 546 项全过；本任务新增 13 项（`window-manager.test.ts` 10 项 + `app-controller.test.ts` 3 项） |
| `npm run build` | 通过；产物均通过 `node --check` 语法校验 |

产物体积对比（`npm run build`，目标 renderer JS ≤ 220 KB，实际 203.0 KB）：

| 产物 | 压缩前 | 压缩后 | 变化 |
|---|---:|---:|---:|
| `dist/renderer/config/assets/index-*.js` | 583,936 B（570.6 KB） | 207,861 B（203.0 KB） | −64.4% |
| `dist/main/index.cjs` | 125,928 B（123.0 KB） | 73,118 B（71.4 KB） | −41.9% |
| `dist/preload/index.cjs` | 1,363 B | 724 B | −46.9% |
| `dist/renderer/config/assets/index-*.css` | 4,455 B | 3,579 B | −19.7% |

提交（每个提交都在临时 git worktree 中单独复跑验证可独立通过）：

| commit | 内容 | 单独验证 |
|---|---|---|
| `1a087c4` | `perf: 主窗口就绪后再显示，消除白屏闪烁` | `typecheck` + 全量 546 项测试通过 |
| `94cd8ab` | `perf: 开启构建产物压缩` | `typecheck` + `lint` + 相关 86 项测试通过 |

## 遗留事项

1. README 任务总表未由本人更新：其他负责人正在修改该文件，按 AGENTS.md 文件冲突处理惯例未触碰（该行状态已由他人置为「已完成」，负责人一栏仍为「待指派」）。
2. 安装包体积需在 Windows/macOS 宿主机复测：沙箱不能运行 electron-builder，本次只验证了 `dist/` 体积。
3. 实机验收的平台/桌面环境细节待回填（见「实机验收」）。
