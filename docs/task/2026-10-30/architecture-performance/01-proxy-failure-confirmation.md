---
task_id: "2026-10-30-01"
date: 2026-10-30
status: in_progress
owner: Codex
depends_on: [2026-10-29-20]
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
review_item: Task 20 独立审查：启动代理应用失败后无条件继续建窗
---

### 启动代理应用失败确认

**背景**

Task 20 优化后，代理仍是创建远程业务窗口前的关键前置条件；但代理应用失败当前只记错误并继续启动，可能让用户误以为代理已生效。产品行为已由用户确认并更新至规格 v2.1.4：启动失败时先提示，用户同意才创建远程窗口；拒绝则进入配置页面。失败及用户选择必须登记日志。配置 schema 不增加持久化忽略选项；运行中代理热切换失败行为不在本任务范围。

**Files**
- Modify: `docs/electron-desktop-shell-product-spec-v2.1-cross-platform.md`
- Modify: `src/main/app-controller.ts`
- Modify: `src/main.ts`
- Test: `tests/integration/app-controller.test.ts`
- Test: `tests/integration/recovery-flow.test.ts`

**验收**
- [x] 先添加失败测试并确认 RED，再实现。
- [x] 启动代理应用失败后，在用户选择完成前不得创建远程窗口。
- [x] 用户同意后继续启动并创建远程窗口；拒绝后打开配置页、状态为 `configuring`，且不建远程窗口。
- [x] 日志登记代理应用失败与用户选择；日志和提示不得包含代理凭据或未经脱敏的错误原文。
- [x] 运行中代理热切换沿用现有失败处理，不弹启动确认。
- [x] 窄范围测试、`npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 均通过。
- [x] 完成独立审查并处理结论：修正 `proxyApplied` 阶段计时不应包含用户确认等待的问题，并添加回归断言。
- [ ] 完成后创建只含本任务文件的中文提交；不推送。

## 验证命令与结果

实际执行结果：

- RED：`npm test -- --run tests/integration/app-controller.test.ts tests/integration/recovery-flow.test.ts`，代理失败时未调用确认、拒绝后仍运行的 3 项新断言失败（75 项中 3 项失败）。
- GREEN / 窄范围：同一命令通过，2 个测试文件、76 项通过。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm test`：24 个测试文件、626 项通过。
- `npm run build`：通过（main、preload、renderer 均完成构建）。
- 独立审查：无 Critical / Important 问题；提出的启动阶段计时精度 Minor 已修复。审查确认 `config-service.ts` 与 `session-policy.ts` 为范围外既有差异，未纳入本任务。
