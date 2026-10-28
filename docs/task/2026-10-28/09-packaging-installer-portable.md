---
task_id: "9"
date: 2026-10-28
status: deprecated
plan: ../../../superpowers/plans/2026-10-28-electron-shell.md
spec: ../../../electron-desktop-shell-product-spec-v2.0.md
---

### Task 9: 打包、安装版和绿色版交付

**Files:**
- Create: `electron-builder.yml`
- Create: `build/installer.nsh`
- Modify: `package.json`
- Modify: `resources/config.example.json`
- Create: `tests/manual/windows-acceptance.md`
- Create: `tests/manual/release-checklist.md`

**Interfaces:**
- `npm run build:dir`：生成未安装目录包。
- `npm run build:win`：生成 NSIS 安装包和 ZIP 绿色包。
- `npm run verify:release`：检查产物、配置文件位置、版本和校验摘要。

- [ ] **Step 1: Write release verification script/test**

  验证构建输出同时包含 NSIS `.exe` 和 ZIP；解压 ZIP 后存在主程序、`config.json` 和资源目录；安装构建配置为当前用户默认而非强制 per-machine。

- [ ] **Step 2: Run verification to verify failure**

  Run: `npm run verify:release`

  Expected: FAIL because electron-builder configuration and artifacts do not exist.

- [ ] **Step 3: Implement electron-builder configuration**

  配置 NSIS assisted installer、当前用户安装、可修改安装目录、根目录 `config.json` 和 ZIP 绿色版；配置升级时保留配置文件。

- [ ] **Step 4: Add installer script and signing hooks**

  安装脚本只负责安装、快捷方式、卸载和配置文件保护；签名证书通过 CI secret 注入，不把证书或密码提交到仓库。

- [ ] **Step 5: Implement release verification**

  检查产物名称、文件大小、SHA-256、配置文件位置和版本号，并生成 `release-manifest.json`。

- [ ] **Step 6: Write Windows manual acceptance checklist**

  按规格书覆盖 Windows 10/11、标准用户、中文路径、非系统盘、双显示器、任务栏、断网恢复、代理、开机自启、快捷键和单实例。

- [ ] **Step 7: Build artifacts and run verification**

  Run: `npm run build:win` and `npm run verify:release`

  Expected: both artifacts are generated and verification passes。

- [ ] **Step 8: Commit**

  `git add electron-builder.yml build package.json resources tests/manual && git commit -m "build: add windows installer and portable zip"`


