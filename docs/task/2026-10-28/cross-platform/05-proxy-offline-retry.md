---
task_id: "5"
date: 2026-10-28
status: pending
owner: unassigned
depends_on: [2]
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 5: 实现代理、离线页与自动重试

**Files:**
- Create: `src/main/network/proxy-manager.ts`
- Create: `src/main/network/retry-controller.ts`
- Create: `src/renderer/offline/offline.html`
- Test: `tests/unit/network/proxy-manager.test.ts`
- Test: `tests/unit/network/retry-controller.test.ts`

**Interfaces:**
- `applyProxy(session: Electron.Session, config: NetworkConfig): Promise<void>`
- `classifyLoadFailure(details: Electron.DidFailLoadEvent): LoadFailureKind`
- `class RetryController { start(); stop(); onLoadFailed(details: LoadFailureDetails): void; onLoadSucceeded(): void; }`

- [ ] **Step 1: Write failing proxy tests**

  Cover direct/system/fixed/pac modes, bypass rules, invalid proxy values, and old-connection cleanup.

- [ ] **Step 2: Implement proxy manager**

  Proxy credentials must not be persisted in `config.json`; use the OS secure credential mechanism only if a later task explicitly adds authenticated proxy support.

- [ ] **Step 3: Write failing retry tests**

  Cover main-frame-only failures, retry interval, cancel-on-success, no duplicate timers, cleanup on shutdown, DNS/TLS/HTTP classification, and recovery timing.

- [ ] **Step 4: Implement retry controller and offline page**

  The offline page is local and must not require network access.

- [ ] **Step 5: Run network tests**

  Run: `npm test -- --run tests/unit/network`

- [ ] **Step 6: Commit**

  `git add src/main/network src/renderer/offline tests/unit/network && git commit -m "feat: add proxy and offline retry"`

