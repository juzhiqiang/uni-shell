---
task_id: "7"
date: 2026-10-28
status: deprecated
plan: ../../../superpowers/plans/2026-10-28-electron-shell.md
spec: ../../../electron-desktop-shell-product-spec-v2.0.md
---

### Task 7: 完成本地配置界面和受控保存流程

**Files:**
- Modify: `src/renderer/config/main.tsx`
- Create: `src/renderer/config/App.tsx`
- Create: `src/renderer/config/styles.css`
- Modify: `src/preload/config-preload.ts`
- Modify: `src/main/app-controller.ts`
- Test: `tests/unit/config/config-form.test.tsx`

**Interfaces:**
- `window.shellApi.getConfig(): Promise<AppConfig>`。
- `window.shellApi.validateConfig(input: unknown): Promise<ValidationResult>`。
- `window.shellApi.saveConfig(input: unknown): Promise<SaveResult>`。
- `window.shellApi.resetConfig(): Promise<AppConfig>`。
- `window.shellApi.testConnection(url: string, network: NetworkConfig): Promise<ConnectionResult>`。

- [ ] **Step 1: Write failing form tests**

  覆盖：初始值加载、URL 校验、延迟范围、代理字段按模式显示、保存失败提示、恢复默认值、未保存关闭不改文件。

- [ ] **Step 2: Run form tests to verify failure**

  Run: `npm test -- --run tests/unit/config/config-form.test.tsx`

  Expected: FAIL because the form and IPC bridge are not implemented.

- [ ] **Step 3: Implement preload API**

  只暴露上面定义的配置操作，不暴露 `ipcRenderer`、Node API 或任意文件系统访问。

- [ ] **Step 4: Implement React configuration form**

  表单按配置结构分区；字段错误就地显示；保存按钮只有在校验通过后可用；展示当前配置实际路径和保存错误。

- [ ] **Step 5: Implement controlled save/restart**

  主进程收到保存请求后执行 schema 校验、原子写入、日志记录，然后关闭旧窗口并按新配置受控重启；写入失败不重启。

- [ ] **Step 6: Run tests**

  Run: `npm test -- --run tests/unit/config/config-form.test.tsx`

  Expected: PASS。

- [ ] **Step 7: Commit**

  `git add src/renderer/config src/preload src/main/app-controller.ts tests/unit/config && git commit -m "feat: add local configuration UI"`


