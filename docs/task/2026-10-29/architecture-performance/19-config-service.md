---
task_id: "19"
date: 2026-10-29
status: done
owner: Antigravity
depends_on: [18]
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
review_item: A3
---

### Task 19：ConfigService 单一权威配置

**背景**
- 一次启动中 `config.json` 会被读取 3 次：`readLoggingPreferences`、`readAppearanceIconFileName`、`AppController.start` 中的 `loadConfig`；配置路径也被解析了 2 次。
- 同一份配置在 4 处维护副本：`AppController.config`、`createWindowPortAdapter` 的 `lastConfig`、`registerConfigIpc` 的 `lastConfig`、`WindowManager.targetUrl` 和 `security`。这违反了 `rules/architecture.md`“共享状态只有一个权威所有者”的规定。

**Files**
- Create: `src/main/config/config-service.ts`
- Modify: `src/main/config/config-ipc.ts`：通过 ConfigService 读取和保存，删除本地 `lastConfig`
- Modify: `src/main/app-controller.ts`：从注入的 ConfigService 获取配置和路径，删除 `resolvePaths` / `loadConfig` 依赖
- Modify: `src/main.ts`：bootstrap 先创建 ConfigService 并 `load()` 一次，logger 级别和图标文件名都从结果中读取；删除 `readLoggingPreferences`、`readAppearanceIconFileName`；`createWindowPortAdapter` 删除 `lastConfig`
- Test: `tests/unit/config/config-service.test.ts`（新增）
- Test: `tests/unit/config/config-ipc.test.ts`、`tests/integration/app-controller.test.ts`、`tests/integration/startup-flow.test.ts`

**Interfaces**
```ts
interface ConfigService {
  readonly paths: ResolvedConfigPaths;
  load(): Promise<ConfigLoadResult>;     // 首次读盘并缓存；重复调用返回缓存结果
  reload(): Promise<ConfigLoadResult>;   // 显式重新读盘（配置界面打开时使用）
  current(): AppConfig | undefined;
  save(next: AppConfig): Promise<void>;  // 校验 + 原子写入 + 更新缓存 + 通知订阅者
  onChange(listener: (next: AppConfig, prev: AppConfig | undefined) => void): () => void;
}
```

- [x] **Step 1：为 ConfigService 编写失败测试**：`load` 只读盘一次；`save` 失败时缓存不变且不通知订阅者；`save` 成功后 `current()` 更新并通知；取消订阅生效
- [x] **Step 2：实现 ConfigService（复用 `config-store` 的 `loadConfig` / `saveConfig`）**
- [x] **Step 3：迁移 config-ipc 与 AppController，并更新对应测试**
- [x] **Step 4：迁移 main.ts 装配；通过在测试中给 fs 计数，确认启动只读一次 `config.json`**
- [x] **Step 5：通用门禁**
- [x] **Step 6：提交**：`refactor: 引入 ConfigService 作为配置唯一权威`

> [!NOTE]
> 本任务不改变“保存后重启”的行为（这属于任务 22 的范围）；`onChange` 在本任务中只需要提供能力，可以暂时没有订阅者。

## 验证命令与结果

1. **类型检查**:
   - `npm run typecheck` -> 退出码 0，无任何类型错误。
2. **代码风格与规范门禁**:
   - `npm run lint` -> 退出码 0，ESLint 检查通过。
3. **单元与集成测试**:
   - `npx vitest run tests/unit/config/config-service.test.ts` -> 5 passed (单次读盘缓存、reload 重新读盘、save 原子写入与通知、取消订阅)。
   - `npm test` -> 22 test files passed, 561 tests passed (0 failures)。
4. **生产构建**:
   - `npm run build` -> electron-vite 构建主进程、预加载脚本与渲染进程成功。

