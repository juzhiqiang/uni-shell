---
task_id: "2"
date: 2026-10-28
status: deprecated
plan: ../../../superpowers/plans/2026-10-28-electron-shell.md
spec: ../../../electron-desktop-shell-product-spec-v2.0.md
---

### Task 2: 实现配置模型、校验和持久化

**Files:**
- Create: `src/main/config/config-types.ts`
- Create: `src/main/config/config-schema.ts`
- Create: `src/main/config/config-store.ts`
- Create: `resources/config.example.json`
- Test: `tests/unit/config/config-schema.test.ts`
- Test: `tests/unit/config/config-store.test.ts`

**Interfaces:**
- `AppConfig`：与规格书推荐 JSON 结构一致。
- `validateConfig(input: unknown): { success: true; data: AppConfig } | { success: false; issues: string[] }`。
- `loadConfig(options: LoadConfigOptions): Promise<ConfigLoadResult>`。
- `saveConfig(config: AppConfig, options: SaveConfigOptions): Promise<void>`。
- `resolveConfigPaths(options: ConfigPathOptions): ConfigPaths`。
- `migrateConfig(input: unknown): AppConfig`。

- [ ] **Step 1: Write failing schema tests**

  覆盖：合法 HTTPS URL、非法协议、缺少主机名、延迟范围 0～3600、未知字段兼容、代理模式枚举和默认值填充。

- [ ] **Step 2: Run schema tests to verify failure**

  Run: `npm test -- --run tests/unit/config/config-schema.test.ts`

  Expected: FAIL because `AppConfig` and `validateConfig` are not defined.

- [ ] **Step 3: Implement schema and migration**

  使用 Zod 进行运行时校验；所有默认值集中在 `DEFAULT_CONFIG`；`schemaVersion` 低于当前版本时执行显式迁移。

- [ ] **Step 4: Write failing persistence tests**

  覆盖：主路径优先、备用路径选择、缺失文件、JSON 损坏备份、临时文件原子替换、只读文件返回明确错误、未知字段保留/忽略策略。

- [ ] **Step 5: Run persistence tests to verify failure**

  Run: `npm test -- --run tests/unit/config/config-store.test.ts`

  Expected: FAIL because path resolution and atomic persistence are not implemented.

- [ ] **Step 6: Implement `config-store.ts`**

  主路径使用程序目录同级 `config.json`；Portable 场景使用显式的可执行目录；所有写操作先写 `.tmp`，成功后替换原文件，并保留 `.bak`。

- [ ] **Step 7: Run all config tests**

  Run: `npm test -- --run tests/unit/config`

  Expected: PASS。

- [ ] **Step 8: Commit**

  `git add src/main/config resources tests/unit/config && git commit -m "feat: add validated config storage"`


