---
task_id: "14"
date: 2026-10-29
status: done
owner: Codex
depends_on: []
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
review_item: R2（P0）
---

### Task 14：忽略 ERR_ABORTED，避免误触离线页与重试

**背景**

[`AppController.reportLoadFailure`](../../../../src/main/app-controller.ts) 与 [`classifyLoadFailure`](../../../../src/main/network/retry-controller.ts) 没有排除 Chromium 的 `ERR_ABORTED(-3)`。以下正常场景都会触发它：页面未加载完就点击其他链接、SPA 快速连续跳转、下载或导航被守卫拦截。当前行为是主窗口被切到离线页并开始重试，用户看起来像是突然断网。

**Files**
- Modify: `src/main/app-controller.ts`（`reportLoadFailure` 入口过滤）
- Modify: `src/main/network/retry-controller.ts`（新增 `'aborted'` 分类，或导出 `isIgnorableLoadFailure`）
- Test: `tests/unit/network/retry-controller.test.ts`
- Test: `tests/integration/app-controller.test.ts`

**Interfaces**
- `isIgnorableLoadFailure(details: LoadFailureDetails): boolean`：`errorCode === -3` 时返回 true

- [x] **Step 1：编写失败测试**
  - `errorCode: -3, isMainFrame: true` 不调用 `showOfflinePage` 和 `reloadMain`，不增加 `loadFailures`
  - 记录一条 `debug` 级别的 `page-load-aborted` 诊断（不写 warn，避免日志噪声）
  - 其他错误码的行为保持不变（回归保护）
- [x] **Step 2：实现过滤**
- [x] **Step 3：运行窄范围测试**：`npx vitest run tests/unit/network tests/integration/app-controller.test.ts`（80 项通过）
- [x] **Step 4：通用门禁**：`npm run typecheck`、`npm run lint`、`npm test`（21 个测试文件、533 项通过）、`npm run build` 均通过
- [x] **Step 5：提交**：`fix: 忽略导航中止错误，避免误触离线页`

**验收**
- [x] 实机验证：在稀土掘金客户端中快速切换后端、前端、Android、iOS、人工智能分类；页面正常更新至 `https://juejin.cn/ai`，未出现本地离线页。

## 验证命令与结果

自动化验证：窄范围网络与集成测试 80/80；`npm run typecheck`、`npm run lint`、`npm test`（21 个测试文件、533/533）、`npm run build` 均通过。

实机验证：2026-10-29，在 Windows Electron 客户端打开稀土掘金后，连续选择后端、前端、后端、Android、iOS、人工智能分类。导航期间可见正常加载占位内容，页面最终到达 `https://juejin.cn/ai`；全程未出现本地离线页。通过。
