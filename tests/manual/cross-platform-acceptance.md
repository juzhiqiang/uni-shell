# 三平台实机验收清单

本清单用于任务 11（三平台实机验收与发布基线），覆盖产品规格 §14「验收标准」与 `rules/testing-release.md`「平台验收」要求。

与 `release-checklist.md` 的分工：`release-checklist.md` 负责打包、签名、CI 与产物校验（安装之前）；本清单负责产物安装到真实系统之后的客户端行为验收（安装之后）。两份清单都通过后，才允许把验收报告标记为发布基线。

使用方式：每一项都在真实系统上执行，勾选并在「结果记录」中写下实际观察（OS 版本、日期、执行人、异常现象）。任何 P0 项失败时停止该平台后续步骤，立即记录到 `docs/release/2026-10-28-v1.0-acceptance-report.md` 的遗留问题。不得基于假设或部分输出勾选。

## 1. 环境与产物准备（任务 Step 1）

系统矩阵（每台机器开测前先记录环境信息）：

- [ ] Windows 10 21H2+ 或 Windows 11，x64，标准用户（非管理员）
- [ ] macOS 13+，x64 与 arm64 各一台（使用 Universal 产物）
- [ ] Ubuntu 22.04 或 24.04，x64，GNOME X11 会话
- [ ] Ubuntu 22.04 或 24.04，x64，GNOME Wayland 会话

每台机器记录并抄入报告：

- [ ] OS 版本与构建号（Windows：`winver`；macOS：`sw_vers`；Linux：`lsb_release -a` 与 `uname -r`）
- [ ] 架构（x64 / arm64）
- [ ] 桌面环境与版本（Linux：`gnome-shell --version`；会话类型：`echo $XDG_SESSION_TYPE`，X11 与 Wayland 各一轮）
- [ ] 是否多显示器、显示器缩放比例

产物准备：

- [ ] 从 CI `release-all-platforms` 产物取得三平台安装包（不得使用本地验证构建冒充正式产物）
- [ ] 每个文件计算 SHA-256，与产物内 `release-manifest.json` 逐项一致
- [ ] `config.example.json` 随包分发（app resources 内），`schemaVersion` 为 1
- [ ] 准备可达的测试目标页（内网测试地址或本地静态服务），记下 URL
- [ ] 准备 `UNI_SHELL_LINUX_MAINTAINER` 为真实 `Name <email>` 的 Linux 构建产物（占位地址不得用于验收）

## 2. 通用验收（任务 Step 2）

以下场景在三平台每台机器上全部执行。配置路径优先级为：`--config-dir` > `UNI_SHELL_CONFIG_DIR` > 便携目录（Windows 可执行文件同级 / AppImage 同级 / macOS ZIP `.app` 同级）> 平台用户配置目录。

### 2.1 预置有效配置启动

- [ ] 在目标配置目录放置合法 `config.json`（`targetUrl` 指向测试页）
- [ ] 启动客户端：不弹出配置窗口，直接加载目标页面
- [ ] 窗口按 `window.mode` 呈现（window / fullscreen / kiosk），托盘图标出现
- [ ] 窗口关闭按钮按 `closeAction` 行为（hide 隐藏到托盘 / quit 退出进程）
- [ ] 日志记录启动来源、配置路径、代理模式、窗口能力（见 §2.15）

### 2.2 首次启动与配置界面

- [ ] 空配置目录首次启动：弹出本地配置界面，不加载远程页面
- [ ] 配置界面可修改并保存；保存成功后受控重启，加载目标页面
- [ ] 配置界面加载的是本地文件（查询参数下发实际配置路径），地址栏/开发者工具中确认无远程来源

### 2.3 配置损坏与非法内容

- [ ] `config.json` 为非法 JSON：启动给出明确错误，不崩溃、不静默退出
- [ ] `schemaVersion` 不是 1：明确提示不兼容
- [ ] 字段类型或取值非法（如 `retryIntervalSec` 为负数）：校验错误可读，指出问题字段
- [ ] 从损坏状态恢复（放置合法配置再次启动）后正常工作

### 2.4 配置只读与目录不可写

- [ ] 配置目录设为只读（或整个文件系统只读）：保存时给出「没有权限写入」类明确提示
- [ ] 提示内容包含实际配置路径，并说明可用 `--config-dir` 指定其他目录
- [ ] 只读场景下客户端不崩溃、不丢失已有配置内容

### 2.5 保存与受控重启

- [ ] 修改 `targetUrl` 保存：旧窗口资源释放，新地址加载成功
- [ ] 保存失败场景（如目标页不可达）有明确错误反馈，配置不落入半损坏状态
- [ ] 重启过程无第二个进程常驻（单实例见 §2.8）

### 2.6 断网与恢复

- [ ] 运行中断网：出现离线页（或明确的加载失败状态），不白屏、不崩溃
- [ ] 恢复网络后 3～10 秒内自动重新加载目标页
- [ ] 启动时即断网：同样进入可恢复状态；恢复后自动加载
- [ ] 反复断网/恢复多次：重试节奏稳定，无重试风暴，退出后无残留定时器

### 2.7 代理切换

- [ ] `proxyMode` 分别为 direct / system / fixed / pac 时目标页加载行为符合预期
- [ ] `fixed` 代理指向不可达地址：错误可辨识（区别于目标页本身故障）
- [ ] 从错误代理切回 direct：无需重启即可恢复（若实现要求重启，则重启后必须恢复）
- [ ] `proxyBypass` 按配置生效

### 2.8 单实例

- [ ] 客户端运行时再次启动：唤醒已有窗口，不产生第二个应用进程
- [ ] 窗口处于隐藏/托盘状态时第二次启动：窗口被唤起
- [ ] 使用不同 `--config-dir` 第二次启动：按实现的单实例策略行为一致（唤醒而非双开）

### 2.9 延迟启动

- [ ] `initialState=tray` 且 `delaySec>0`：启动后先进入托盘，窗口在倒计时后出现
- [ ] 倒计时期间托盘菜单「立即显示窗口」可取消倒计时并立即展示
- [ ] `delayOnlyOnLogin=true`：登录自启动走延迟，手动启动立即展示
- [ ] `showAfterDelay=false` 时延迟结束仅保留托盘入口

### 2.10 托盘与运维入口

- [ ] 托盘菜单固定四项存在：打开配置界面、重新加载网页、立即显示窗口、退出程序
- [ ] 「退出程序」真正结束进程（任务管理器/`ps` 确认无残留），退出前日志已刷新落盘
- [ ] 托盘创建失败或能力缺失时客户端不退出（降级路径）

### 2.11 安全边界

- [ ] 在目标页控制台执行 `require`、`process`、`window.uniShell`：均不可用（undefined 或抛错）
- [ ] 目标页无法读取本地文件、无法调用任意 IPC
- [ ] preload 仅暴露五个白名单通道：`uni-shell:config:get`、`uni-shell:config:validate`、`uni-shell:config:save`、`uni-shell:config:reset`、`uni-shell:network:test`（在配置窗口验证；远程窗口无桥）
- [ ] `allowExternalLinks=false` 时外链被拦截；`allowPopups`、`allowDownloads` 按配置拦截
- [ ] 远程页面重定向到非白名单来源被阻止；`allowedOrigins` 之外的导航不生效
- [ ] 新窗口（`window.open`）按 `setWindowOpenHandler` 策略拒绝或接管

### 2.12 焦点快捷键

- [ ] 客户端窗口获得焦点时按配置快捷键（默认 `Ctrl+Alt+Shift+F12`）弹出配置界面
- [ ] 客户端失焦时按同样组合不触发（未注册系统全局快捷键）
- [ ] 在系统其他应用（浏览器、终端）中按该组合无任何反应

### 2.13 窗口模式与置顶

- [ ] `window.mode` 三态（window / fullscreen / kiosk）按配置呈现
- [ ] kiosk 模式下退出路径符合规格（不提供无条件逃逸）
- [ ] `alwaysOnTopLevel` 按规格 §8 平台能力表验证；不把无法覆盖系统界面（UAC、锁屏、Dock、GNOME Shell）记为缺陷
- [ ] Linux Wayland 上 always-on-top 明确降级为不置顶且日志有记录

### 2.14 多显示器

- [ ] 窗口在显示器间拖动、跨屏放置行为正常
- [ ] `display` 配置（primary / 指定屏幕）生效

### 2.15 日志与退出清理

- [ ] 日志目录符合平台约定：Windows `%APPDATA%\UniShell\logs`、macOS `~/Library/Logs/UniShell`、Linux `$XDG_STATE_HOME/uni-shell/logs`（未设置时 `~/.local/state/uni-shell/logs`）
- [ ] 日志包含：客户端版本、Electron 版本、操作系统、桌面环境、配置路径、启动来源、代理模式、窗口能力、页面加载结果、重试状态、配置保存结果
- [ ] 日志按天滚动、默认保留 14 天；敏感信息（URL 查询参数中的令牌等）已脱敏
- [ ] 退出后无残留进程；崩溃或强制结束后的下次启动有可用的诊断信息

## 3. 平台验收（任务 Step 3）

### 3.1 Windows（NSIS / ZIP）

- [ ] NSIS 安装器以当前用户模式安装，不需要管理员权限
- [ ] 安装过程可更改安装目录；默认目录不在 `C:\Program Files`
- [ ] 安装后首次启动行为符合 §2.1/§2.2（视是否预置配置）
- [ ] 桌面与开始菜单快捷方式创建成功
- [ ] 任务栏行为：普通窗口占据任务栏；`pop-up-menu` 及以上置顶层级可覆盖任务栏
- [ ] 开机自启写入当前用户启动项（`shell:startup` 或注册表 `HKCU\...\Run`，以实现为准），关闭自启后彻底移除
- [ ] 全屏 / Kiosk、置顶各层级按 §8 表验证
- [ ] ZIP 便携包：解压后与 `UniShell.exe` 同级放置 `config.json`，客户端读取该旁置配置
- [ ] 中文系统路径与非系统盘路径（如 `D:\工具\UniShell`）下安装与运行正常
- [ ] 已配置代码签名证书时验证 Authenticode；未配置时确认清单记录为未签名

### 3.2 macOS（DMG / ZIP）

- [ ] Universal `.dmg` 内的 `.app` 通过 `codesign --verify --deep --strict`
- [ ] `xcrun stapler validate` 对 `.app` 与 `.dmg` 均成功（公证票据）
- [ ] 未签名或未公证的产物不得进入本清单通过项
- [ ] DMG 安装后首次运行不向 `.app` 包内写配置；配置落在用户配置目录
- [ ] ZIP 便携包：`.app` 同级放置 `config.json` 并被读取
- [ ] 菜单栏：应用菜单、托盘菜单与快捷键符合规格
- [ ] 登录启动（登录项 API 或 LaunchAgent）开/关均生效且可彻底移除
- [ ] 休眠唤醒后：窗口状态、网络重试、托盘恢复正常
- [ ] Intel 与 Apple Silicon 各验证一次（Universal 产物）
- [ ] 多显示器、Dock 隐藏与置顶层级按 §8 表记录实际表现

### 3.3 Linux（DEB / AppImage）

- [ ] `dpkg -i` 安装 DEB 成功；菜单项/图标按桌面规范注册
- [ ] 安装后配置只写入 XDG 用户目录，不写 `/usr`、`/opt` 等系统位置
- [ ] AppImage 直接可执行；同级放置 `config.json` 被读取，不尝试写入运行时挂载目录
- [ ] GNOME X11 会话完成一轮全部通用验收（§2）
- [ ] GNOME Wayland 会话完成一轮全部通用验收（§2）；托盘与置顶降级如实记录
- [ ] XDG 自启动：`openAtLogin=true` 写入 `~/.config/autostart/*.desktop`，关闭后移除
- [ ] 托盘协议缺失（无 AppIndicator/StatusNotifier 主机）时按降级策略运行，客户端不退出
- [ ] 多显示器与缩放行为正常
- [ ] DEB 维护者元数据为真实 `Name <email>`
- [ ] 对 `.deb` 与 `.AppImage` 执行 SHA-256 校验，与清单一致

## 4. 升级验收（任务 Step 4）

每个平台的安装包各执行一次：

- [ ] 安装上一版本（或先用当前版本冒充旧版），配置好 `config.json` 并记录内容哈希
- [ ] 直接运行新版本安装器升级，不卸载
- [ ] 升级后首次启动：用户配置原样保留（字节级一致），不弹出配置窗口
- [ ] 升级过程产生/清理备份文件的行为符合预期（配置目录内 `.bak`；安装器备份不遗留活跃配置旁）
- [ ] 升级后版本号、日志、自启项、托盘均正常
- [ ] 便携包升级：整体替换目录，旁置 `config.json` 字节不变
- [ ] 降级或跨架构混用安装包时的失败提示明确（不损坏现有配置）

## 5. 结果记录与通过标准

- [ ] 所有勾选项附实际观察记录（环境、日期、执行人、异常）
- [ ] 汇总结果写入 `docs/release/2026-10-28-v1.0-acceptance-report.md`（OS 版本、架构、桌面环境、产物摘要、结果、遗留问题）
- [ ] 无未关闭 P0 问题；P1 问题均有明确处置意见

问题分级：

- P0：安全边界失效；配置丢失、被覆盖或损坏；无法启动或启动崩溃；单实例失效；退出后进程残留；升级丢失配置。
- P1：平台降级不符合规格；错误提示不明确；非核心流程阻塞；产物元数据（签名、维护者）缺失。

通过标准：三平台（含 GNOME X11 与 Wayland 两个 Linux 会话）的通用验收、平台验收、升级验收全部通过且无未关闭 P0，同时 `release-checklist.md` 全部通过，方可在验收报告中登记发布基线并随正式产物提交 `docs/release/release-manifest.json`。
