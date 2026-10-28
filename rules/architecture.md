# 架构与模块边界

## 分层职责

- `src/main/`：Electron 主进程应用服务，负责生命周期和系统能力编排。
- `src/main/platform/`：操作系统、桌面环境和能力探测；禁止承载业务页面逻辑。
- `src/main/config/`：配置类型、校验、迁移、路径和持久化。
- `src/main/window/`：窗口创建、导航守卫和窗口状态策略。
- `src/main/network/`：代理设置、加载错误分类和重试控制。
- `src/main/startup/`、`src/main/tray/`：登录启动、延迟和托盘适配。
- `src/preload/`：本地 renderer 所需的最小化 IPC 桥接。
- `src/renderer/config/`：本地配置界面；不得直接访问 Electron 或 Node API。
- `src/renderer/offline/`：本地离线状态界面，不依赖远程网络。

## 依赖方向

- 配置 schema 和纯状态模块不得依赖 Electron DOM、renderer 或具体 OS API。
- 主进程可以依赖纯逻辑和平台接口；平台实现不得反向依赖 `app-controller`。
- renderer 只能通过 preload 暴露的、类型化的白名单接口请求操作。
- 远程业务页面不得加载配置 preload。
- 共享状态只有一个权威所有者；派生状态应计算，不要在多个模块重复维护。

## 设计原则

- 先使用明确接口组合模块；只有出现真实重复或复杂度下降时才引入抽象。
- 平台差异通过能力对象表达，业务代码不要散布 `process.platform` 和桌面环境判断。
- 能力不可用时返回明确的降级结果，不要静默伪装成功。
- 配置结构保持跨平台；平台专属配置必须可选且有明确迁移规则。
- 状态机使用可取消的 timer 和显式关闭流程；所有资源必须可释放。
