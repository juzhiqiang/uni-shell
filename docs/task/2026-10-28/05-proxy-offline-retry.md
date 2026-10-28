---
task_id: "5"
date: 2026-10-28
status: deprecated
plan: ../../../superpowers/plans/2026-10-28-electron-shell.md
spec: ../../../electron-desktop-shell-product-spec-v2.0.md
---

### Task 5: 实现网络代理、离线页和重试控制

**Files:**
- Create: `src/main/network/proxy-manager.ts`
- Create: `src/main/network/retry-controller.ts`
- Create: `src/renderer/offline/offline.html`
- Test: `tests/unit/network/proxy-manager.test.ts`
- Test: `tests/unit/network/retry-controller.test.ts`

**Interfaces:**
- `applyProxy(session: Session, config: NetworkConfig): Promise<void>`。
- `class RetryController { start(); stop(); reset(); onLoadFailed(error): void; onLoadSucceeded(): void; }`。
- `classifyLoadFailure(details: LoadFailureDetails): LoadFailureKind`。

- [ ] **Step 1: Write failing proxy tests**

  覆盖 `direct`、`system`、`fixed`、`pac` 四种模式、代理参数校验和切换时清理旧连接。

- [ ] **Step 2: Run proxy tests to verify failure**

  Run: `npm test -- --run tests/unit/network/proxy-manager.test.ts`

  Expected: FAIL because proxy manager is not implemented.

- [ ] **Step 3: Implement proxy manager**

  将配置映射为 Electron session 代理设置；代理账号密码不进入配置文件；代理切换后显式刷新/关闭旧连接。

- [ ] **Step 4: Write failing retry tests**

  覆盖主框架失败启动重试、成功加载停止重试、HTTP/TLS/DNS 错误分类、重复失败不创建多个 timer、停止后不再重试。

- [ ] **Step 5: Implement retry controller and offline page**

  默认间隔 3 秒；离线页只作为主框架失败时的本地 fallback；重试状态通过受限 IPC 或页面初始化参数展示。

- [ ] **Step 6: Run network tests**

  Run: `npm test -- --run tests/unit/network`

  Expected: PASS。

- [ ] **Step 7: Commit**

  `git add src/main/network src/renderer/offline tests/unit/network && git commit -m "feat: add proxy and offline retry handling"`


