---
task_id: "2"
date: 2026-10-28
status: pending
owner: unassigned
depends_on: [1]
plan: ../../../superpowers/plans/2026-10-28-electron-shell-cross-platform.md
spec: ../../../electron-desktop-shell-product-spec-v2.1-cross-platform.md
---

### Task 2: 实现配置模型与跨平台持久化

**Files:**
- Create: `src/main/config/config-types.ts`
- Create: `src/main/config/config-schema.ts`
- Create: `src/main/config/config-store.ts`
- Create: `src/main/platform/config-paths.ts`
- Create: `resources/config.example.json`
- Test: `tests/unit/config/config-schema.test.ts`
- Test: `tests/unit/config/config-store.test.ts`

**Interfaces:**
- `type AppConfig = ...` exactly matching v2.1 JSON.
- `validateConfig(input: unknown): ValidationResult<AppConfig>`
- `migrateConfig(input: unknown): AppConfig`
- `resolveConfigPaths(options: ResolveConfigPathsOptions): ResolvedConfigPaths`
- `loadConfig(options: LoadConfigOptions): Promise<ConfigLoadResult>`
- `saveConfig(config: AppConfig, options: SaveConfigOptions): Promise<void>`

- [ ] **Step 1: Write failing schema tests**

  Cover URL protocol/host rules, enum values, delay range, unknown fields, defaults, and migration.

- [ ] **Step 2: Implement schema and defaults**

  Use Zod and preserve unknown fields only when the spec allows compatibility without conflicting with typed fields.

- [ ] **Step 3: Write failing path and persistence tests**

  Cover `--config-dir`, environment override, Windows exe directory, Linux `$APPIMAGE`, macOS `.app` sibling, XDG config, macOS Application Support, read-only paths, invalid JSON backup, atomic write, and `.bak`.

- [ ] **Step 4: Implement path resolution and store**

  Never write into `.app` bundles, AppImage mount directories, or protected system paths. Return actionable permission errors.

- [ ] **Step 5: Run config tests**

  Run: `npm test -- --run tests/unit/config`

- [ ] **Step 6: Commit**

  `git add src/main/config src/main/platform/config-paths.ts resources tests/unit/config && git commit -m "feat: add cross-platform config storage"`

