---
task_id: "15"
date: 2026-10-29
status: blocked
owner: Fable 5
depends_on: [14]
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
review_item: R1（P0）
spec_change: 是（§7 恢复、§12 诊断补充渲染进程崩溃条目）
---

> **状态说明（2026-10-30）**：代码与自动化门禁已全部完成并提交 `b5382e6`，标记
> `blocked` 仅因实机验收（任务管理器结束渲染进程）沙箱无法执行，原因同任务 16。

### Task 15：渲染进程崩溃与无响应恢复

**背景**

全仓库没有监听 `render-process-gone`、`unresponsive` 或 `child-process-gone`。远程页 OOM 或崩溃后，主窗口会一直停留在白屏或崩溃页；由于不会产生 `did-fail-load`，重试控制器也不会被触发。这对 Kiosk 和常驻场景是硬伤。

**前置：规格更新（需用户确认）**
- §7：补充“渲染进程异常退出后按 `retryIntervalSec` 自动重载；60 秒内连续崩溃 3 次时改为展示离线页，并停止自动重载，直到用户触发或网络恢复”
- §12：必记内容增加 `renderer-gone`（reason、exitCode）、`renderer-unresponsive`、`child-process-gone`

**Step 0 实施记录（2026-10-30，用户已批准）**
- 规格已升 v2.1.2：§7 新增「渲染进程异常退出」四条（`retryIntervalSec` 自动重载；60 秒 3 次转离线页并停止自动重载，直到用户从托盘手动重载或加载成功；无响应超 10 秒强制结束渲染进程；`clean-exit` 不触发）；§12 必记项补 `renderer-gone`（reason/exitCode）、`renderer-unresponsive` 与恢复响应、`child-process-gone`。
- 参数取值（用户选择「内置常量」，不改配置 schema）：无响应判定 10 秒、崩溃窗口 60 秒、窗口内阈值 3 次，均为模块常量并可由测试覆盖。

**Files**
- Modify: `src/main/app-controller.ts`：新增 `reportRendererGone(details)` / `reportUnresponsive()` / `reportResponsive()`，内部使用可取消定时器和崩溃计数窗口
- Create: `src/main/network/crash-guard.ts`：纯逻辑的滑动窗口计数器与决策（`reload` / `offline` / `ignore`）
- Modify: `src/main.ts`：在 `attachMainWindowDiagnostics` 中接入 `render-process-gone`、`unresponsive`、`responsive`；在 `app.on('child-process-gone')` 中只记录日志
- Test: `tests/unit/network/crash-guard.test.ts`（新增）
- Test: `tests/integration/app-controller.test.ts`、`tests/integration/recovery-flow.test.ts`

**Interfaces**
- `decideCrashRecovery(history: number[], now: number, options): { action: 'reload' | 'offline'; history: number[] }`
- `AppController.reportRendererGone(details: { reason: string; exitCode: number }): void`

- [x] **Step 0：更新规格 §7/§12 并获得用户确认**
- [x] **Step 1：为 crash-guard 编写失败测试**：单次崩溃 → `reload`；窗口内连续 3 次 → `offline`；窗口外的旧记录被淘汰；`reason === 'clean-exit'` 时忽略
- [x] **Step 2：实现 crash-guard**
- [x] **Step 3：为控制器编写失败测试**：`shutdown` 时取消挂起的重载定时器；`unresponsive` 持续 N 秒后执行 `forcefullyCrashRenderer` 并重载（通过窗口端口注入，可测）
- [x] **Step 4：在 main.ts 中接线**（只修改 `attachMainWindowDiagnostics` 和 `bootstrap` 末尾的监听，与任务 17/20 协调文件所有权）
- [x] **Step 5：通用门禁**
- [x] **Step 6：提交**：`feat: 增加渲染进程崩溃与无响应自动恢复`

**验收**
- 实机：在主窗口 DevTools 中执行 `process.crash()` 不可用（沙箱环境），改用任务管理器结束对应的渲染进程，窗口应在 `retryIntervalSec` 后自动恢复；连续结束 3 次后展示离线页。

## 验证命令与结果

执行时间：2026-10-30（Fable 5）。四项门禁全部实际执行并通过：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（`tsc --noEmit` 两个 project 均无输出） |
| `npm run lint` | 本任务文件 0 error（`eslint src/main/network/crash-guard.ts src/main/app-controller.ts src/main.ts tests/unit/network/crash-guard.test.ts tests/integration/app-controller.test.ts tests/integration/recovery-flow.test.ts`）。全量 `npm run lint` 存在 1 个 error，位于他人在途文件 `tests/unit/window/session-policy.test.ts`（任务 17，`vi` 未使用），不属于本任务文件范围 |
| `npm test` | 通过：24 个测试文件、610 项全过（本任务新增 18 + 21 + 5 = 44 项） |
| `npm run build` | 通过（沙箱需先 `rm -rf dist` 再构建，vite `emptyOutDir` 走 `unlinkSync` 触发 EPERM）；产物 main/preload/renderer 均正常产出，`renderer-gone`、`renderer-unresponsive`、`renderer-crash-limit`、`child-process-gone`、`forcefullyCrashRenderer` 均已在 `dist/main/index.cjs` 中 |

补充说明：

- 全量 `npm test` 首次运行时有 4 项失败，全部来自任务 17 正在编辑的 `tests/integration/window-manager.test.ts` 中间态；待其落盘后复跑全绿。本任务测试单独运行始终全绿。
- `npm test` 覆盖了 Step 1 与 Step 3 要求的全部场景；实机验收（任务管理器结束渲染进程）沙箱无法执行，记录在下方遗留事项。

## 代码审查与修正（2026-10-30，独立代理审查）

审查发现 3 个需处理问题、9 条建议，处理如下：

1. **崩溃窗口不是锁存器（已修）**：原实现中旧崩溃记录滑出 60 秒窗口后，第 4 次崩溃会重新拿到配额并复活自动重载，与规格「直到用户从托盘手动重载或加载成功后恢复」不符。已在控制器加 `crashRecoveryStopped` 锁存位，仅 `reloadMain()`（用户显式触发）与 `reportLoadSuccess()` 清除；新增用例覆盖「超出窗口后仍不自动重载」与「加载成功后恢复资格」。
2. **开发模式离线页清空崩溃窗口（已修）**：`loadOfflinePage` 在 dev 下走 `http://localhost:PORT/offline.html`，会触发 `did-navigate` → `reportLoadSuccess()`，把降级状态清掉。已在 `main.ts` 增加 `isLocalOfflinePage()`（file:// 或本地开发服务器上的 `/offline.html`），离线页不计入目标页加载成功。该修复同时惠及既有重试控制（dev 下离线页原先也会取消重试）。
3. **`offlinePageEnabled=false` 且达到阈值（用户决策：维持停止重载）**：保持规格字面行为——不展示离线页、停止自动重载，仅保留托盘「重新加载网页」入口。已在规格 §7 显式写明该组合，避免后续误当作缺陷「修好」。

其余建议已采纳：`reportRendererGone` / `reportUnresponsive` 增加关闭态入口守卫；即发即弃的 `showOfflinePage` / 崩溃重载补 `.catch()` 记日志；`renderer-responsive` 改为无条件必记并带 `cancelledForceCrash` 字段；修正 `child-process-gone` 注释里「不重复计数」的错误因果（该事件本就不含渲染进程）；为 `forcefullyCrashRenderer` 补共享渲染进程风险的前提注释；把托盘重载那条用例的空转断言改为计数断言。

未采纳（记录备查）：把 `child-process-gone` 监听提前到 `app.whenReady()` 之后（任务文件约定只改 `bootstrap` 末尾，避免与任务 17/20/21 的 main.ts 所有权冲突）；为 `src/main.ts` 接线补单测（全仓无测试 import main.ts，拆分属任务 21 范围）。

## 遗留事项

- **实机验收未执行**：规格 §14.1 要求用任务管理器结束渲染进程验证自动恢复与 3 次降级，沙箱无真实桌面，待真实系统确认。
- `src/main.ts` 与 `src/main/app-controller.ts` 为多任务共享文件（任务 15/17/20/21、15/19/20/24）；本任务只改 `attachMainWindowDiagnostics`、`bootstrap` 末尾的 `child-process-gone` 监听与窗口端口的 `forcefullyCrashRenderer`，未触碰他人在途改动。
- 首次提交 `b5382e6` 后，任务 17 的提交 `9e11a00` 将本任务对 `src/main.ts` 与产品规格的修改一并带入（共享分支 + 无 pathspec 提交的已知风险）；本任务后续对这两个文件的修正单独成提交。

