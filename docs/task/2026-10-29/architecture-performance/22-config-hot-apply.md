---
task_id: "22"
date: 2026-10-29
status: in_progress
owner: Codex
depends_on: [19, 21]
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
review_item: A5
spec_change: 是（§5.2 保存流程、§14.1 验收项）
---

### Task 22：配置保存热更新分级

按 §5.2 对配置保存分为热应用、页面重载和客户端重启。`startup.openAtLogin` 保持原有 `onSaved` 副作用。变更分类以纯函数实现，混合变更采用最高影响级别；保存结果返回 `applied`，配置界面据此提示。

**Files**
- Create: `src/main/config/config-diff.ts`
- Modify: `src/main/config/config-ipc.ts`、`src/shared/ipc-contract.ts`、`src/main/app-controller.ts`、`src/main/window/window-port.ts`、`src/main.ts`、`src/renderer/config/App.tsx`
- Test: `tests/unit/config/config-diff.test.ts`、`config-ipc.test.ts`、`config-form.test.tsx`、`tests/integration/app-controller.test.ts`

- [x] Step 0：用户确认字段分级；更新产品规格 §5.2/§14.1。
- [x] Step 1-2：分类器逐字段/混合级别测试及实现。
- [x] Step 3-5：IPC 分级分派、窗口/安全/代理/重试/快捷键/日志级别/托盘配置热应用入口和界面提示；应用失败返回告警并登记日志。
- [ ] Step 6：自动化门禁通过；三平台实机验证未能在当前环境执行，需 Windows/macOS/Linux 主机验收。
- [x] Step 7：独立审查完成；重要发现已修复，自审复核通过。

## 验证命令与结果

- `npm test -- tests/unit/config/config-diff.test.ts tests/unit/config/config-ipc.test.ts tests/unit/config/config-form.test.tsx tests/integration/app-controller.test.ts`：通过（110 tests）。
- `npm test`：通过（34 files，686 tests）。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- 平台实机验证：未执行；当前运行环境仅可完成构建，无法代表 macOS/Linux 实机验收。
