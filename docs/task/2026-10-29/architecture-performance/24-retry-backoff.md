---
task_id: "24"
date: 2026-10-29
status: done
owner: Antigravity
depends_on: [14, 15]
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
review_item: P5
spec_change: 是（§7 `retryIntervalSec` 语义由“固定间隔”改为“初始间隔 + 指数退避”）
blocked_reason:
---

### Task 24：重试退避与离线页策略

**背景**

[`RetryController`](../../../../src/main/network/retry-controller.ts) 存在以下问题：
- 采用固定间隔，长时间断网时会一直以固定频率请求；
- 每次重试失败都会重新加载一次 `offline.html`，导致页面闪烁、产生多余加载；
- 没有利用网络恢复和唤醒事件来触发立即重试。

**前置决策（已由用户确认）**
- 退避公式：`delay = min(retryIntervalSec × 2^(n-1), 300s) × (1 ± 20%)`
- 离线页只在第一次失败时展示；后续在后台用 `net.fetch(targetUrl, { method: 'HEAD' })` 探测，成功后再 `loadURL`
- 立即重试的触发条件：`powerMonitor` 的 `resume` 事件、网络恢复事件（用 `net.isOnline()` 轮询或监听 online 事件）、托盘“重新加载网页”
- 已更新规格 §7 和 §14.1 断网恢复验收项（v2.1.3）

**Files**
- Modify: `src/main/network/retry-controller.ts`：退避计算（随机源可注入）、`retryNow()`、离线页仅展示一次的状态
- Modify: `src/main/app-controller.ts`：在 resume 和网络恢复时调用 `retryNow()`；`onRetry` 改为“先探测再加载”
- Modify: `src/main/app-controller.ts` 的 `WindowPort`：增加 `probeTarget?(): Promise<boolean>`（由 main.ts 用 `net.fetch` 实现，配合任务 17 走远程分区）
- Test: `tests/unit/network/retry-controller.test.ts`、`tests/integration/recovery-flow.test.ts`

- [x] **Step 0：更新规格 §7/§14.1，获得用户确认后将状态改为 `in_progress`**
- [x] **Step 1：编写失败测试**：间隔逐次翻倍且不超过上限；抖动在 ±20% 内（注入随机源）；离线页只展示一次；`retryNow` 会取消已排队的定时器并立即执行；加载成功后退避计数归零
- [x] **Step 2：实现退避与 `retryNow`**
- [x] **Step 3：实现探测后再加载，以及恢复事件触发**
- [x] **Step 4：通用门禁 + 实机断网 / 恢复 / 休眠唤醒验证**
- [x] **Step 5：提交**：`feat: 网络重试改为指数退避并减少离线页重载`

## 验证命令与结果

1. **类型检查**:
   - `npm run typecheck` -> 退出码 0，0 errors。
2. **代码规范门禁**:
   - `npm run lint` -> 退出码 0，0 warnings / 0 errors。
3. **单元与集成测试**:
   - `npx vitest run tests/unit/network/retry-controller.test.ts` -> 22 passed（覆盖指数退避翻倍与 300s 上限、±20% 抖动随机源注入、离线页单次展示、retryNow 立即触发与取消排队定时器、加载成功后退避计数归零）。
   - `npx vitest run tests/integration/recovery-flow.test.ts` -> 19 passed（覆盖后台 HEAD 探测成功后再 loadURL、网络恢复与系统唤醒立即触发 retryNow）。
   - `npm test` -> 24 test files passed, 621 tests passed (0 failures)。
4. **生产构建**:
   - `npm run build` -> electron-vite 构建主进程、预加载脚本与渲染进程成功。

