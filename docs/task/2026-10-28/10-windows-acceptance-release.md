---
task_id: "10"
date: 2026-10-28
status: deprecated
plan: ../../../superpowers/plans/2026-10-28-electron-shell.md
spec: ../../../electron-desktop-shell-product-spec-v2.0.md
---

### Task 10: Windows 真实环境验收与发布基线

**Files:**
- Modify: `tests/manual/windows-acceptance.md`
- Create: `docs/release/2026-10-28-v1.0-acceptance-report.md`
- Create: `docs/release/release-manifest.json`
- Optional Modify: `.github/workflows/build-windows.yml`

**Interfaces:**
- 发布验收报告必须列出客户端版本、Electron 版本、构建时间、SHA-256、测试系统版本和通过/失败结果。

- [ ] **Step 1: Prepare clean Windows test machines**

  至少准备 Windows 10 和 Windows 11；分别使用标准用户和管理员用户；测试安装目录包含空格、中文和非系统盘。

- [ ] **Step 2: Execute functional acceptance**

  使用有效预置配置验证不弹配置窗、托盘驻留、延迟展示、全屏/置顶、目标页面加载和第二次启动唤醒。

- [ ] **Step 3: Execute failure acceptance**

  验证配置损坏、只读、断网、恢复网络、DNS/TLS/HTTP 错误、代理切换、睡眠唤醒和退出清理。

- [ ] **Step 4: Execute security acceptance**

  验证远程页面不能访问 Node、本地文件、任意 IPC；新窗口、外部链接、下载和权限请求符合配置。

- [ ] **Step 5: Record release report**

  只有所有 P0 验收项通过后，才生成发布基线、产物清单和交付包。

- [ ] **Step 6: Commit**

  `git add tests/manual docs/release .github/workflows && git commit -m "release: record windows acceptance baseline"`


