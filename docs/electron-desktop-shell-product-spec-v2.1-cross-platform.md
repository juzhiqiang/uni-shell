# Electron 跨平台通用桌面客户端产品规格说明书

**文档版本：** v2.1.4
**编制日期：** 2026-10-28  
**修订日期：** 2026-10-29（v2.1.1：代理语义修正为接口代理，新增自定义应用图标，IPC 白名单增至六个通道）；2026-10-30（v2.1.2：新增渲染进程崩溃与无响应的自动恢复规则与对应诊断必记项；v2.1.3：远程与本地会话分区隔离，断网重试改为指数退避、后台探测与恢复事件立即重试；v2.1.4：启动时代理策略应用失败须询问用户，记录失败和用户决定）
**替代版本：** v2.0.0 Windows 单平台规格  
**产品形态：** Windows / macOS / Linux Electron 桌面客户端  
**交付形态：** 平台安装包 + 可预配置绿色/便携包

## 1. 产品目标

封装一个高可靠、易部署、可现场配置的跨平台 Electron 桌面外壳，用于承载指定的 HTTP/HTTPS Web 业务系统。

客户端应支持：

- 交付前预置配置，客户开箱即用；
- 配置缺失、损坏或目标网址无效时进入本地配置界面；
- 适配办公 PC、展厅大屏、触控一体机和无人值守场景；
- 支持接口代理（仅接口域名走代理）、断网重试、托盘驻留、全屏/Kiosk、置顶、开机自启和延迟唤醒；
- 支持自定义应用图标（窗口、任务栏、托盘与 Dock 使用用户提供的图标）；
- 支持单实例运行和现场运维入口；
- Windows、Linux、macOS 使用同一配置结构和同一安全边界；
- 平台差异通过适配层处理，业务配置不直接暴露操作系统细节。

## 2. 支持平台基线

| 平台 | 最低版本 | 架构 | 必测桌面环境 |
|---|---|---|---|
| Windows | Windows 10 21H2 | x64 | 桌面、任务栏自动隐藏、多显示器 |
| macOS | macOS 13 | x64、arm64、Universal | 菜单栏、多显示器、休眠唤醒 |
| Linux | Ubuntu 22.04 | x64 | GNOME X11、GNOME Wayland |

Linux 额外兼容 Debian 12；其他发行版仅提供“尽力支持”，不作为发布阻塞。Windows ARM64、Linux ARM64、macOS Rosetta 长期运行模式不在本版承诺内。

## 3. 范围与非目标

### 3.1 本期范围

- 跨平台桌面客户端主程序；
- 平台化配置文件管理；
- 本地可视化配置界面；
- Web 页面加载、离线重试和窗口管理；
- 系统托盘/菜单栏、单实例、开机自启和延迟展示；
- Windows、macOS、Linux 安装与便携交付；
- 本地日志和基础故障诊断。

### 3.2 本期不包含

- 独立 API 反向代理服务器；
- 业务系统登录、权限和数据逻辑；
- Windows Shell 替换、Linux Window Manager 替换或 macOS Shell 替换；
- 企业 MDM 批量部署；
- 自动更新服务，除非另行增加更新服务器、签名和回滚方案；
- 移动端和平板端原生客户端。

## 4. 总体运行流程

```text
启动
  -> 获取单实例锁
  -> 识别操作系统、启动来源和运行模式
  -> 解析平台配置路径
  -> 读取并校验 config.json
      -> 失败：打开配置界面
      -> 成功：进入启动策略
  -> 初始驻留状态（托盘/最小化）
  -> 等待延迟时间
  -> 创建或显示主窗口
  -> 应用代理、全屏/Kiosk、置顶和显示器策略
  -> 加载目标网址
      -> 成功：正常运行
      -> 失败：显示离线页并按间隔重试
```

第二次启动不得创建新窗口，应向已有实例发送唤醒请求。已有实例隐藏时显示并聚焦；正在倒计时时取消倒计时并立即显示；配置窗口已打开时聚焦配置窗口。

## 5. 配置文件管理

### 5.1 配置解析优先级

配置文件名固定为 `config.json`。程序按以下顺序解析：

1. 显式参数 `--config-dir=<目录>`；
2. 环境变量 `UNI_SHELL_CONFIG_DIR`；
3. Windows：可执行文件同级目录；
4. Linux AppImage：`$APPIMAGE` 同级目录；
5. 各平台用户配置目录；
6. 上述路径均不可用时，进入配置界面并显示明确错误。

用户配置目录：

- Windows：`%APPDATA%\UniShell\config.json`
- Linux：`$XDG_CONFIG_HOME/uni-shell/config.json`，未设置时使用 `~/.config/uni-shell/config.json`
- macOS：`~/Library/Application Support/UniShell/config.json`

配置界面必须显示当前实际读取和写入的路径。

### 5.2 预置配置交付规则

| 平台 | 预置方式 |
|---|---|
| Windows | NSIS 安装目录或 ZIP 目录中保留 `config.json` |
| Linux AppImage | `config.json` 与 `.AppImage` 文件同级，启动时读取 |
| Linux DEB | 安装模板到系统只读配置路径，首次运行复制到 XDG 用户配置目录 |
| macOS ZIP | `config.json` 与 `.app` 同级，且该目录可写时读取 |
| macOS DMG | 首次运行从应用内置模板复制到 Application Support |

写入必须采用临时文件加原子替换，并保留最近一次有效配置备份。主路径不可写时不得静默失败。

配置保存成功后按变更字段决定生效方式：`security.*`、`window.*`、`network.*`、`maintenance.*`、`logging.level` 热应用，不刷新页面；`targetUrl` 变更重新加载主窗口页面；`appearance.icon`、`startup.*`（`startup.openAtLogin` 除外）、`logging.retentionDays` 变更后重启客户端。`startup.openAtLogin` 继续通过现有保存副作用同步应用。多类字段同时变更时采用最高影响级别：重启高于页面重载，页面重载高于热应用。保存 IPC 返回 `applied: 'hot' | 'reload' | 'restart'`，配置界面按结果提示“配置已生效”“页面正在重新加载”或“客户端即将重启”。配置首次创建时按完整配置判定所需动作。

### 5.3 读取与校验规则

- 文件不存在、JSON 语法错误、字段类型错误或目标网址无效时，打开配置界面；
- 无效文件先保存为 `config.json.invalid.<时间戳>`；
- 未知字段兼容，不因多余字段导致启动失败；
- 使用 `schemaVersion` 管理配置迁移；
- 配置界面未保存关闭时，不得修改原配置；
- 同一配置文件可在三个平台间迁移，平台专属字段必须可选。

### 5.4 自定义应用图标

- 用户在配置界面选择图标文件（支持 PNG、ICO、ICNS），客户端把文件复制到配置目录并统一命名为 `app-icon.<扩展名>`；
- 配置只记录文件名（如 `app-icon.png`），不记录绝对路径，保证配置跨机器、跨目录可迁移；
- 图标在保存配置并重启客户端后生效，应用于主窗口、配置窗口、Windows 任务栏、macOS Dock 与三平台托盘；
- 图标文件缺失、损坏或超出大小上限时，回退到客户端内置默认图标，并记录日志，不得阻断启动；
- 升级与重新安装不得覆盖或删除配置目录中的用户图标；未引用自定义图标时，客户端清理残留的 `app-icon.*` 文件。

## 6. 配置结构

```json
{
  "schemaVersion": 1,
  "targetUrl": "https://example.com",
  "window": {
    "mode": "fullscreen",
    "alwaysOnTop": false,
    "alwaysOnTopLevel": "normal",
    "display": "primary",
    "closeAction": "hide"
  },
  "network": {
    "proxyMode": "direct",
    "proxyServer": "",
    "proxyBypass": "",
    "apiProxyHosts": [],
    "retryIntervalSec": 3,
    "requestTimeoutSec": 20,
    "offlinePageEnabled": true
  },
  "startup": {
    "openAtLogin": false,
    "initialState": "tray",
    "delaySec": 0,
    "delayOnlyOnLogin": false,
    "showAfterDelay": true
  },
  "maintenance": {
    "hotkeyEnabled": true,
    "hotkey": "Ctrl+Alt+Shift+F12",
    "trayConfigEnabled": true
  },
  "security": {
    "allowedOrigins": [],
    "allowExternalLinks": false,
    "allowPopups": false,
    "allowDownloads": false
  },
  "appearance": {
    "icon": ""
  },
  "logging": {
    "level": "info",
    "retentionDays": 14
  }
}
```

字段规则：

- `targetUrl` 必填，仅允许 `http://` 或 `https://`，必须包含主机名；
- `window.mode` 可选 `window`、`fullscreen`、`kiosk`；
- `alwaysOnTopLevel` 可选 `normal`、`floating`、`pop-up-menu`、`screen-saver`；
- `startup.initialState` 可选 `tray`、`minimized`；
- `startup.delaySec` 为 0～3600 的整数；
- `network.apiProxyHosts` 为接口域名列表，每项为主机名（如 `api.example.com`）或子域通配（如 `*.example.com`），不带协议、端口和路径；含义见 §7；
- `appearance.icon` 为配置目录中的图标文件名（如 `app-icon.png`），留空表示使用内置默认图标；
- 代理账号密码不得明文写入 `config.json`。

## 7. 网络行为

代理是**接口代理**，不是网络代理：只有 `network.apiProxyHosts` 命中的请求经过代理，页面导航、静态资源和其余流量一律直连。三平台通过同一套 PAC 策略实现，不依赖操作系统代理设置细节。

- `direct`：不使用代理，全部直连；
- `system`：逐个接口域名解析操作系统代理设置，按解析结果为对应域名固定代理，其余直连；
- `fixed`：`proxyServer` 指定的单个代理服务器（如 `http://proxy.internal:8080`、`socks5://proxy.internal:1080`）仅对接口域名生效；
- `pac`：仅接口域名按 PAC 地址的判定结果走代理，其余流量直连；
- `proxyBypass`：跳过代理的地址列表，优先级高于上述代理判定；
- `apiProxyHosts` 为空时，代理不生效（等同直连），配置界面需明确提示。

代理切换必须对后续请求生效，并关闭或刷新旧连接。跨平台不承诺自动补 CORS 响应头，也不内置业务 API 反向代理。

页面加载失败时：

- 仅处理主框架失败；首次失败时展示本地离线页（`offlinePageEnabled=true` 时），不停留在 Chromium 默认错误页，后续重试不再重复加载离线页以避免页面闪烁；
- 采用指数退避重试，初始间隔为 `network.retryIntervalSec`（默认 3 秒），公式为 `delay = min(retryIntervalSec × 2^(n-1), 300s) × (1 ± 20%)`；
- 离线页展示期间，后台先对 `targetUrl` 发起 `HEAD` 连通性探测，探测可达后再执行页面加载（`loadURL`）；
- 系统休眠唤醒（`powerMonitor.resume`）、网络恢复（online 事件）或用户点击托盘「重新加载网页」时，取消排队中的退避等待并立即重试；
- 成功加载后取消重试定时器并将退避计数与离线页状态归零；
- DNS、连接拒绝、TLS、HTTP 404/500 需分类记录。
- 启动时应用代理策略失败，客户端必须记录代理应用失败并向用户提示；用户确认继续后才创建远程业务窗口，并记录其选择；用户拒绝后打开配置界面、保持 `configuring` 状态且不得创建远程业务窗口，并记录其选择。提示不得展示或日志记录代理凭据。运行期间保存配置触发的代理热切换失败继续沿用当前错误处理，不触发启动确认。

渲染进程异常退出（崩溃、内存不足被结束、被外部结束）时：

- 按 `network.retryIntervalSec` 自动重载目标网页，不停留在白屏或 Chromium 崩溃页；
- 60 秒内连续崩溃 3 次时改为展示本地离线页，并停止自动重载，直到用户从托盘手动重载或加载成功后恢复自动重载；崩溃记录滑出 60 秒窗口不构成恢复条件；
- `offlinePageEnabled=false` 时同样停止自动重载且不展示离线页，窗口停留在崩溃页，仅保留托盘「重新加载网页」这一恢复入口；
- 渲染进程被检测为无响应后持续 10 秒未恢复时，强制结束该渲染进程，随后按上述崩溃恢复流程处理；
- `clean-exit` 属于预期退出（如窗口关闭、正常销毁），不触发自动重载。

## 8. 窗口、全屏与置顶

通用窗口模式：

- `window`：普通可调整窗口；
- `fullscreen`：无边框全屏；
- `kiosk`：无人值守/Kiosk 模式，限制退出和新窗口。

置顶层级实现策略：

| 平台 | 实现与限制 |
|---|---|
| Windows | 支持 `normal`、`floating`、`pop-up-menu`、`screen-saver`；`pop-up-menu` 及以上可覆盖任务栏，但不覆盖 UAC、锁屏和安全桌面 |
| macOS | 映射为 Electron 支持的 NSWindow 层级；支持层级需在目标 macOS 版本实测，不覆盖系统安全界面 |
| Linux X11 | 通过窗口管理器 always-on-top hint 请求置顶；具体层级由窗口管理器决定 |
| Linux Wayland | Electron 当前不支持 always-on-top；该能力明确降级为不置顶，并记录日志 |

跨平台验收只承诺按上表实现平台能力映射和降级，不承诺三个平台都能覆盖系统任务栏、Dock 或系统安全界面。

## 9. 开机自启与延迟展示

`openAtLogin=true` 时：

- Windows 写入当前用户启动项；
- macOS 创建当前用户 LaunchAgent 或使用登录项 API；
- Linux 写入 `~/.config/autostart/*.desktop`。

延迟逻辑统一由应用内部实现，不依赖操作系统延迟任务。`delayOnlyOnLogin=true` 时延迟只对登录启动生效，手动启动立即执行。延迟期间保持托盘或最小化状态；托盘“立即显示窗口”取消倒计时。

## 10. 托盘与运维入口

托盘目标：

- Windows：系统通知区域；
- macOS：菜单栏；
- Linux：StatusNotifierItem 兼容托盘。

托盘菜单固定包含：

- 打开配置界面；
- 重新加载网页；
- 立即显示窗口；
- 退出程序。

Linux 桌面未提供托盘协议时，客户端不得崩溃；应记录能力降级日志，并保留窗口内配置入口或命令行维护参数。快捷键只在客户端窗口获得焦点时生效，不得注册系统全局快捷键。

## 11. 安全要求

- 远程网页必须关闭 Node 集成；
- 必须启用上下文隔离和沙箱；
- 远程业务窗口与本地配置窗口强制会话隔离：远程业务窗口使用持久化会话分区 `persist:remote`，本地配置窗口使用非持久化内存分区 `local-config`。两者的 Cookie、Cache、Storage 彻底隔离，代理设置、权限控制与下载策略独立单点配置，升级该版本时直接切换至独立分区，需在发布说明中提示用户重新登录一次；
- 配置窗口 preload 仅暴露具名白名单 IPC：配置读取、配置校验、配置保存、恢复默认值、连通性测试、图标选择共六个通道，不提供通用发送、文件读写、Shell 或命令执行能力；
- 默认禁止新窗口、弹窗、下载、通知、摄像头、麦克风和 USB；
- 页面导航和重定向限制在授权源内；
- 外部链接默认禁止，允许时使用系统默认浏览器；
- 日志不得记录代理密码、Cookie、Token 或业务敏感数据；
- 生产环境优先使用 HTTPS。

## 12. 日志与诊断

日志目录：

- Windows：`%APPDATA%\UniShell\logs`
- Linux：`$XDG_STATE_HOME/uni-shell/logs`，未设置时使用 `~/.local/state/uni-shell/logs`
- macOS：`~/Library/Logs/UniShell`

至少记录客户端版本、Electron 版本、操作系统、桌面环境、配置路径、启动来源、代理模式与接口域名数量、图标来源（自定义或内置默认）、窗口能力、页面加载结果、重试状态和配置保存结果。默认保留 14 天。

渲染进程异常退出（`renderer-gone`，含 `reason` 与 `exitCode`）、渲染进程无响应（`renderer-unresponsive`）与恢复响应、子进程异常退出（`child-process-gone`）同属必记内容，用于现场区分页面加载失败与进程级故障。

启动时代理应用失败必须记录 `proxy-apply-failed`，以及用户决定继续或返回配置界面的诊断事件；事件仅包含代理模式和决定，不包含代理地址、凭据或异常原文。

## 13. 交付与打包

| 平台 | 标准安装包 | 便携/绿色包 |
|---|---|---|
| Windows | NSIS 当前用户安装包，允许自定义目录（可选盘符） | ZIP 目录包 |
| macOS | 签名并公证的 Universal DMG | ZIP 包，`.app` 与 `config.json` 同级 |
| Linux | DEB | AppImage，`config.json` 与 AppImage 同级 |

Windows 严禁默认安装到 `C:\Program Files`。macOS 包必须通过 Developer ID 签名和 notarization。Linux 产物至少提供 SHA-256 校验。所有平台升级不得覆盖用户配置。

三平台安装包统一使用正式应用图标（`resources/icon.ico` / `icon.icns` / `icon-512.png`）：安装程序界面、桌面与开始菜单快捷方式、macOS 磁盘映像、Linux 桌面条目均显示该图标，不再使用 Electron 默认图标。安装包图标与运行时图标（规格 §5.4 的用户自定义图标）相互独立，互不影响。

## 14. 验收标准

### 14.1 通用验收

- 三平台均可完成首次启动、配置校验、保存、重启和目标页面加载；
- 配置保存按 §5.2 的热应用、页面重载和客户端重启分级生效；
- 有效预置配置不弹出配置窗口；
- 配置损坏、只读、路径不可写时有明确错误；
- 断网时首次失败展示离线页且后续重试不重复刷新离线页；网络恢复、系统唤醒或手动重载时立即触发恢复，短暂断网恢复后 3～10 秒内自动加载；
- 第二次启动只唤醒已有实例；
- 远程页面无法访问 Node、本地文件和任意 IPC；
- 远程业务窗口（`persist:remote`）与本地配置窗口（`local-config`）会话分区相互独立，配置窗口的打开、关闭与生命周期不影响远程窗口的下载、权限及代理策略；
- 接口代理只作用于接口域名：接口域名请求经代理、页面与其余流量直连，可用抓包或代理日志验证；
- 自定义图标保存并重启后，窗口、任务栏/Dock 与托盘均显示用户图标；图标缺失或损坏时回退内置默认图标且不阻断启动。

### 14.2 平台验收

- Windows：当前用户安装（可选安装目录与盘符，不弹 UAC）、任务栏覆盖、开机自启、托盘、全屏/Kiosk、置顶；
- macOS：Universal 构建、签名公证、菜单栏、登录启动、多显示器、休眠唤醒；
- Linux：DEB 和 AppImage、GNOME X11/Wayland、XDG 自启、托盘能力降级、多显示器。

### 14.3 测试矩阵

至少覆盖：

- Windows 10/11、macOS 13+/x64/arm64、Ubuntu 22.04/24.04；
- 标准用户和管理员用户；
- 安装目录与便携目录；
- 单显示器和多显示器；
- 任务栏、Dock、GNOME Shell、X11、Wayland；
- 断网、恢复网络、代理切换；
- 配置缺失、损坏、只读、被占用；
- 睡眠唤醒和重复启动；
- 快捷键开启和关闭；
- 升级保留配置。

## 15. 发布前必须冻结的决策

1. Linux 是否必须额外提供 RPM；
2. Linux 目标发行版和桌面环境范围；
3. macOS Developer ID 签名和 notarization 凭据；
4. Windows 代码签名证书类型；
5. Linux Wayland 下置顶能力不可用时的产品降级策略；
6. Kiosk 模式各平台维护退出方式；
7. 是否允许外部链接、下载和弹窗；
8. 是否需要自动更新及回滚机制。

---

**版本结论：** v2.1 将原 Windows 方案扩展为 Windows、Linux、macOS 跨平台基线，明确了配置路径、托盘、自启、置顶、打包签名和平台能力差异，可作为三平台开发、测试和交付的统一依据。
