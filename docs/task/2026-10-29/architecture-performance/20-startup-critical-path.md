---
task_id: "20"
date: 2026-10-29
status: done
owner: Codex
depends_on: [14, 15, 19]
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
review_item: P1
---

### Task 20：启动关键路径优化

**背景**

从 `whenReady` 到主窗口 `loadURL` 之间严格串行：能力探测 → 读配置 ×3 → 读图标 + `readdir` / `unlink` 清理 → 每次启动都写登录项 → 应用代理 → 建窗。其中只有**代理**是加载远程页的硬前置条件。

**Files**
- Modify: `src/main.ts`：`removeUnreferencedIconFiles` 移到主窗口创建之后，用 `setImmediate` 或空闲时执行；建窗前对 `targetUrl` 调用 `session.preconnect`
- Modify: `src/main/app-controller.ts`：
  - `ensureOpenAtLogin` 先 `query()`，状态一致时跳过写入；不再 `await` 它之后才建窗
  - `createTray`、`installShortcut`、`ensureOpenAtLogin` 与代理应用并行执行；只有 `applyProxyConfig` 阻塞 `applyStartupStrategy`
  - 增加启动耗时打点：`startup-timing` 日志，包含 ready、configLoaded、proxyApplied、windowCreated、firstLoad 各阶段的毫秒数
- Modify: `src/main/startup/startup-manager.ts`：`setOpenAtLogin` 支持“先查询后写入”
- Test: `tests/integration/app-controller.test.ts`、`tests/integration/startup-flow.test.ts`、`tests/unit/startup/startup-manager.test.ts`

- [x] **Step 1：记录基线**：当前实现临时打点并执行 3 次 Windows x64 Electron 开发态进程冷启动
- [x] **Step 2：编写失败测试**：登录项状态一致时跳过写入；未完成登录项查询时仍建窗；代理未完成时不建窗
- [x] **Step 3：实现并行化与延后清理**
- [x] **Step 4：加入 `startup-timing` 诊断（规格 §12 已有“启动”必记项，字段扩充不改变语义）**
- [x] **Step 5：复测 3 次冷启动，在本文件中记录前后对比**
- [x] **Step 6：通用门禁**
- [x] **Step 7：提交**：`perf: 缩短启动关键路径并增加启动耗时诊断`

## 验证命令与结果

实际执行命令及结果见下文。

冷启动测量环境：Windows x64、Electron 45、`npm run dev`；配置目录隔离到 `%TEMP%\uni-shell-task20-baseline`，目标地址为示例配置中的 `https://example.com`，自启关闭、代理为 direct。每次为新 Electron 进程启动，不是操作系统重启。基线 `loadURL-start` 在 `main-window-created` 事件中、调用 `loadURL` 之前采集；优化后对应阶段为 `windowCreated`。

| 阶段 | 基线 1 | 基线 2 | 基线 3 | 基线平均 | 优化后 1 | 优化后 2 | 优化后 3 | 优化后平均 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ready → `loadURL` 调用前 | 68 ms | 67 ms | 62 ms | 65.7 ms | 73 ms | 80 ms | 66 ms | 73.0 ms |
| ready → 首次 `did-finish-load` | 未采集 | 未采集 | 未采集 | — | 134 ms | 140 ms | 127 ms | 133.7 ms |

说明：前后数据来自开发态的重复进程启动，当前样本未显示可确认的启动提速（优化后 `windowCreated` 平均值高 7.3 ms）；这组启动配置没有触发登录项写入，且 direct 代理应用较快，不能验证自启写入被跳过带来的收益。该数字仅用于保留本机对照，不作为性能回归或提速结论。

验证结果：

- RED：`npm test -- --run tests/unit/startup/startup-manager.test.ts tests/integration/app-controller.test.ts tests/integration/startup-flow.test.ts`，重复写入测试与登录项启动断言失败；阶段计时断言移除计时回调后失败。
- GREEN：同一窄范围命令通过，3 个测试文件、94 项通过。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm test`：24 个测试文件、622 项通过。
- `npm run build`：通过。
