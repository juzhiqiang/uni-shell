# Electron 安全规则

## 远程内容隔离

- 加载远程业务页面的 `webPreferences` 必须设置 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。
- 远程业务窗口不得加载本地配置 preload；禁止远程页面调用任意 IPC。
- preload 只在本地配置窗口启用，并只公开具名、类型化、白名单 API。
- 不提供通用 `send(channel, payload)`、通用文件读写、Shell 或命令执行接口。

## 会话分区与策略隔离

- 远程业务窗口与本地配置窗口必须使用独立的会话分区（partition）：
  - 远程业务窗口：`persist:remote`（持久化存储凭据与缓存）；
  - 本地配置窗口：`local-config`（纯内存隔离会话，不落盘）。
- 严禁不同信任级别的窗口共用默认会话（`session.defaultSession`）。
- 会话级策略（下载拦截、权限申请请求、代理规则等）必须通过统一的 `SessionPolicy` 单点管理并挂载在对应的 session 实例上，禁止在窗口导航守卫中重复或覆盖注册。

## 导航、弹窗和权限

- 使用授权源列表限制主框架导航和重定向。
- 默认阻止新窗口、下载和权限请求；若产品明确启用，必须按来源校验并增加测试。
- 外部链接仅在配置允许时交给系统默认浏览器打开。
- 对 `will-navigate`、`setWindowOpenHandler`、权限请求和下载分别实施策略，不依赖单一事件拦截。

## 配置和日志

- 代理密码、Token、Cookie 和业务敏感值不得写入明文配置或日志。
- 配置写入先校验，再写临时文件并原子替换；保留备份，不覆盖损坏文件。
- 不信任配置文件路径、目标 URL、重定向地址和 IPC 入参；使用 schema 和 allowlist 校验。
- HTTP 目标只作为兼容选项；生产业务优先 HTTPS。
- 安全策略变更必须在 Windows、macOS、Linux 三平台测试，尤其覆盖 Linux Wayland 和 macOS 打包应用。
