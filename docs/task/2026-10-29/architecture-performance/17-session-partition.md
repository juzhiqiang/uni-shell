---
task_id: "17"
date: 2026-10-29
status: done
owner: Antigravity
depends_on: [16]
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
review_item: A1（P0）
spec_change: 是（§11 安全边界；用户登录态一次性迁移）
blocked_reason:
---

### Task 17：远程与本地会话分区，以及 SessionPolicy

**背景**
- 主窗口和配置窗口都没有设置 `partition`，共用 `session.defaultSession`。
- [`installNavigationGuards`](../../../../src/main/window/navigation-guard.ts) 为每个窗口在**会话级别**注册 `will-download` 和 `setPermissionRequestHandler`：
  - 配置窗口打开期间，它的“全部拒绝”下载监听器也会拦截主窗口的下载，导致 `allowDownloads: true` 失效；
  - 权限处理器由最后注册者覆盖；
  - 远程页的 Cookie、Cache、Storage 与本地配置页处在同一个会话中，不符合 `rules/architecture.md` 的隔离要求。
- [`applyProxy`](../../../../src/main.ts) 作用于 `defaultSession`，配置页的请求也会走接口代理逻辑。

**前置决策（已由用户确认）**
1. 主窗口分区名：`persist:remote`（持久化）
2. 配置窗口分区名：`local-config`（不带 `persist:`，仅在内存中）
3. 迁移策略：**方案 (a) 直接切换，并在发布说明中提示用户需要重新登录一次**。
4. 规格 §11、§14.1 与 `rules/security.md` 已完成同步更新。

**Files**
- Create: `src/main/window/session-policy.ts`：按 session 安装一次下载和权限策略；`update(security)` 支持热替换；`dispose()` 释放
- Modify: `src/main/window/navigation-guard.ts`：`installNavigationGuards` 只保留窗口级守卫（`will-navigate`、`will-redirect`、`setWindowOpenHandler`）
- Modify: `src/main/window/window-manager.ts`：两类窗口的 `webPreferences.partition`；注入 `SessionPolicy`
- Modify: `src/main.ts`：代理改为作用于 `session.fromPartition('persist:remote')`（`createElectronProxyPort`）
- Test: `tests/unit/window/session-policy.test.ts`（新增）
- Test: `tests/unit/window/navigation-guard.test.ts`、`tests/integration/window-manager.test.ts`

- [x] **Step 0：完成前置决策，更新规格与 `rules/security.md`，并将状态改为 `in_progress`**
- [x] **Step 1：编写失败测试**：两个窗口的 partition 不同；配置窗口打开时主窗口的下载按主窗口策略放行；同一 session 只注册一次 permission handler；关闭配置窗口不影响主窗口策略
- [x] **Step 2：实现 SessionPolicy，并从窗口守卫中移除会话级逻辑**
- [x] **Step 3：将代理切换到远程分区；为接口代理补充集成测试**
- [x] **Step 4：方案 a 无需 Cookie 迁移代码，确认无遗留废弃逻辑**
- [x] **Step 5：通用门禁 + 实机验证登录态、下载、接口代理**
- [x] **Step 6：提交**：`refactor: 远程与本地窗口会话分区，会话策略单点安装`

## 验证命令与结果

1. **类型检查**:
   - `npm run typecheck` -> 退出码 0，无任何类型错误。
2. **代码风格与规范门禁**:
   - `npm run lint` -> 退出码 0，ESLint 检查通过。
3. **单元与集成测试**:
   - `npx vitest run tests/unit/window/session-policy.test.ts` -> 6 passed (下载拦截与放行、Kiosk 下载禁止、权限请求一律拒绝、onDecision 诊断、dispose 释放)。
   - `npx vitest run tests/integration/window-manager.test.ts` -> 57 passed (覆盖 persist:remote 与 local-config 分区隔离、独立下载与权限策略、热替换与生命周期释放)。
   - `npm test` -> 24 test files passed, 606 tests passed (0 failures)。
4. **生产构建**:
   - `npm run build` -> electron-vite 构建主进程、预加载脚本与渲染进程成功。

