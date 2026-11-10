# uni-shell 隐式状态机盘点报告

- 日期：2026-11-10
- 范围：`src/` 全部源码（main / preload / renderer / shared，约 9.8k 行）与 `tests/` 对照
- 方法：逐文件通读 + 按「状态集合 → 迁移事件 → 跨模块耦合 → 非法/失同步状态 → 测试覆盖」五个维度分析，所有 `file:line` 引用均对当前代码核实
- 结论速览：共盘点 **27 处状态机**，其中 1 处半显式（`AppController.AppState`）、26 处隐式（由布尔标志、计数器、锁存器、可空句柄与散落的 `if` 守卫组合而成）。测试整体覆盖扎实（765 项），但发现 **4 个高风险缺口**（R1、R15、R2、R4，见第 6 章），均为「状态迁移未被任何一方完整感知」类问题，而非逻辑错误。

## 1. 判定标准与不在范围内的项

**判定为隐式状态机**：行为上存在一组互斥/渐进的状态和受守卫的迁移，但状态没有被命名、集中持有或统一转移——而是分散在多个标志位、计数器、可空句柄里，由不同模块各自 `if` 判断。典型形态：`quitting` + `pendingQuit`、`crashHistory` + `crashRecoveryStopped`、`unavailable` + `closed` + `sinkPath`。

**不列为状态机**：配置枚举（`proxyMode` / `cacheMode` / `windowMode` / `closeAction` / `initialState` 等）是数据状态，本身不承载迁移；但它们驱动 S16/S18/S5/S6/S25 的行为切换，在各节中作为输入事件出现。Zod schema 迁移注册表（`config-schema.ts:335-341`）与 IPC 白名单双保险（`ipc-contract.ts:34-39`、`config-ipc.ts:255-265`）是显式设计，仅作对照说明。

## 2. 总览表

| # | 状态机 | 位置 | 形态 | 风险 | 测试覆盖 |
|---|---|---|---|---|---|
| S1 | 应用生命周期（AppController） | app-controller.ts:60-67,181-197,256-964 | 半显式 | **高**（R2/R4/R5） | 高 |
| S2 | 崩溃恢复锁存器 | app-controller.ts:193-196,444-448,675-749,794-812 | 隐式（锁存） | 中（R3） | 高 |
| S3 | 无响应强制结束 | app-controller.ts:197,758-786 | 隐式（单定时器） | 低 | 高 |
| S4 | 重试退避 | retry-controller.ts:74-185 | 隐式（计数器+锁存） | 低 | 高 |
| S5 | 窗口关闭生命周期 | window-manager.ts:371-372,617-634,744-771 | 隐式（双标志） | 低 | 高 |
| S6 | 首屏显示时序 InitialReveal | window-manager.ts:296-348,864-894 | 隐式（ready/disposed/pending） | 低 | 高 |
| S7 | 窗口句柄与资源生命周期 | window-manager.ts:358-372,844-858 | 隐式（可空句柄+Map） | 低 | 中 |
| S8 | 配置服务加载状态 | config-service.ts:49-52,60-119 | 隐式（缓存+在途） | 低 | 高 |
| S9 | 配置 IPC 草稿状态 | config-ipc.ts:87-118,165-170,267 | 隐式（双源） | 低 | 高 |
| S10 | 保存分级应用流 | config-diff.ts:17-50 + config-ipc.ts:106-160 | 显式分类+隐式编排 | 低 | 高 |
| S11 | 装配期一次性锁存与竞态 | main.ts:62-73,150-158,186-199,212-221,261-263 | 隐式 | **高**（R1） | 无 |
| S12 | 单实例锁 | single-instance.ts:104-123 | 隐式 | 中（与 R1 叠加） | 高 |
| S13 | 日志器 | logger.ts:408-573 | 隐式（多标志+锁存） | 中（R7） | 高 |
| S14 | 托盘实例生命周期 | tray-manager.ts:53-94 + electron-tray-port.ts:37-74 | 隐式 | 低 | 高 |
| S15 | 快捷键绑定生命周期 | shortcut-host.ts:34-98 + tray-manager.ts:179-202 | 隐式 | 中（R8） | 高 |
| S16 | 代理应用 | proxy-manager.ts:270-385 + app-controller.ts:505-552 | 端口+纯逻辑 | 低 | 高 |
| S17 | 证书校验策略 | cert-policy.ts:75-97 + app-controller.ts:566-577 | 端口+纯逻辑 | 低 | 高 |
| S18 | 缓存策略句柄 | cache-policy.ts:111-154 + window-manager.ts:579-614 | 隐式（installed 守卫） | 低 | 高 |
| S19 | 登录项双源状态 | startup-manager.ts:121-147 + app-controller.ts:476-497 | 隐式 | 低 | 高 |
| S20 | 延迟启动 | startup-manager.ts:32-79 | 隐式（cancelled/fired） | 低 | 高 |
| S21 | 网络在线边沿检测 | main.ts:212-221 + app-controller.ts:637-644 | 隐式（边沿） | 低 | 中 |
| S22 | 电源唤醒门控 | app-controller.ts:820-835 | 隐式 | **高**（R15） | 中 |
| S23 | 配置表单 Phase | App.tsx:60,383-435,485-539,625-651 | 半显式 | 低 | 高 |
| S24 | draft/baseline 脏检查 | App.tsx:385-386,466-479,541-552 | 隐式（派生） | 低 | 高 |
| S25 | 表单条件显隐 | App.tsx:652-654,835-951,1019-1027 | 派生视图状态 | 低 | 高 |
| S26 | 日志查看器轮询 | App.tsx:398-464,614-623 | 隐式（tab 生命周期） | 低 | 中 |
| S27 | 契约与 schema 迁移 | ipc-contract.ts:34-39, config-schema.ts:335-459 | 显式（对照项） | — | 高 |

---

## 3. 核心运行状态机（S1–S7）

### S1 应用生命周期状态机（AppController）

- **位置**：`src/main/app-controller.ts:60-67`（`AppState` 类型）、`:181-197`（状态字段）、`:256-324`（start）、`:941-964`（shutdown）
- **形态**：全应用唯一显式命名的状态机，但**迁移没有转移表也没有守卫**——7 个状态由 10 余个方法各自赋值。
- **隐含状态集合**：`state ∈ {idle, starting, awaiting-delay, running, configuring, shutting-down, stopped}`，外加 `started`（一次性）、`mainWindowCreated`（主窗口是否由本控制器创建）、`config`（undefined=无有效配置）、`delayHandle`（undefined=无挂起倒计时）。
- **主要迁移**：
  - `start()`：idle→starting（`started` 幂等守卫，`:257-258`）；
  - 配置不可用：starting→**configuring**（`:288-296`，此子态 `config===undefined`）；
  - 启动代理失败且用户拒绝：starting→**configuring**（`:315-319`，此子态 `config` 已加载）；
  - `shouldApplyDelay` 为真：starting→awaiting-delay（`delayHandle` 挂起）；
  - `onDelayElapsed`：awaiting-delay→running（`showAfterDelay=false` 时直接转，`:355-359`）；
  - `showAndFocusMain` / `handleSecondLaunch`：任意非终态→running 或改开配置窗；
  - `shutdown`：→shutting-down→stopped（幂等，`:941-964`）；
  - `applySavedConfig`：**不改变状态**，只做副作用分发（`:202-236`）。
- **跨模块耦合**：WindowPort、TrayPort、RetryController、S2 崩溃锁存、powerMonitor、shortcut、loginItem、proxy/cert 端口——控制器的 `state` 是这些模块动作的门控（如 `reportNetworkOnline` 要求 `state==='running'`，`:638`）。
- **风险**：
  - **R4（中）configuring 二分子态**：两个入口下 `config` 可用性不同，后续以 `this.config` 为前提的分支行为分裂。代理失败子态中 `startRetryController()` 尚未执行（`:320` 在代理成功之后），`reportLoadFailure` 只累计 `loadFailures` 而无动作（`:662-671`，`retryController` 为 undefined）；此后用户改 `retryIntervalSec` 保存会启动重试（`:216-219`），重试的 `reloadMain` 可经窗口端口**重建主窗口**（见 R2）。
  - **R2（高）`mainWindowCreated` 与真实窗口脱同步**：`window-port.ts:150-177` 的 `showAndFocusMain`/`reloadMain` 在窗口不存在时按 `configService.current()` **重建窗口**（有单测固化该行为：`tests/unit/window/window-port.test.ts:91,112`），但控制器不感知——`mainWindowCreated` 仍为 `false`、`AppState` 可能仍为 `configuring`。后果：`showMainWindow({revealAfterCreate})` 分流与实际窗口状态不符；`reportNetworkOnline`、powerMonitor resume 等 `state` 门控与真实运行态不一致。触发路径：configuring 状态保存 reload 级配置、崩溃重载定时器在窗口销毁后触发。
  - **R5（中）`applySavedConfig` 无终态守卫**：IPC 保存与关闭竞态时，`shutting-down/stopped` 之后仍会执行代理应用、`startRetryController()`（新建控制器与定时器）、reload 页面。`performRetryAttempt` 等回调有终态检查（`:611,630`），保存入口却没有。
- **测试覆盖**：`tests/integration/app-controller.test.ts` 60+ 用例（启动各路径、延迟矩阵、二次启动、托盘、崩溃恢复）+ `recovery-flow.test.ts` + `startup-flow.test.ts`。**未覆盖**：configuring 子态差异、shutdown 后保存、窗口端口重建后的控制器同步。
- **显式化建议**：抽 `app-lifecycle.ts` 纯状态机（状态×事件→迁移表，非法迁移抛错或记日志），把「配置加载结果」「代理结果」作为事件输入；`mainWindowCreated` 改为查询 `windowManager.getMainWindow()`；`applySavedConfig` 入口加 `shutting-down/stopped` 早退。

### S2 崩溃恢复锁存器

- **位置**：`app-controller.ts:193-196`（`crashHistory`/`crashRecoveryStopped`/`crashReloadTimer`）、`:444-448`（`prepareExplicitReload`）、`:675-684`（loadSuccess 复位）、`:694-749`（`reportRendererGone`）、`:794-812`（重载定时器）；纯判定在 `crash-guard.ts:48-61`。
- **隐含状态集合**：正常计数（`crashHistory` 60s 滑窗累计）／重载挂起（`crashReloadTimer`）／**已降级锁存**（`crashRecoveryStopped=true`）。
- **迁移**：`render-process-gone`（可恢复原因）→ `decideCrashRecovery` → 窗口内 <3 次：`scheduleCrashReload`；≥3 次：置锁存 + 展示离线页 + 清定时器（`:725-740`）；**恢复仅两条路**：托盘手动重载/清除缓存重载（`prepareExplicitReload` 全清）或 `reportLoadSuccess`（`:680-681`）；旧记录滑出窗口**不**复活（锁存而非计数器，Task 15 返工 `89e3c57` 的既定设计）。
- **跨模块耦合**：`render-process-gone` 事件（page-loader.ts:137-139）、离线页、重试间隔配置、S3。
- **风险**：
  - **R3（中）注释与行为漂移**：`scheduleCrashReload` 注释称「窗口已销毁时 loadURL 会 reject，这里只留痕」（`:801-802`），实际 `window-port.reloadMain` 会**重建窗口并显示**（`window-port.ts:164-177`）。崩溃恢复在窗口销毁后会自动重建窗口——可能是保靶行为，但注释误导，且与 R2 叠加。
  - 降级后离线页展示失败不阻塞锁存（`:736-739`，窗口停在崩溃页）——设计取舍，可接受。
- **测试覆盖**：高。`app-controller.test.ts:1026-1208` 覆盖阈值降级、滑窗淘汰、滑出不复活、loadSuccess 恢复、offlinePageEnabled=false、**托盘手动重载恢复完整配额**（:1208）。
- **显式化建议**：将 `crashHistory`+`stopped`+timer 收进独立纯状态机模块（完全仿 `crash-guard.ts` 模式：纯函数 + 调用方持有历史），由端口触发现实动作；同时明确「崩溃重载是否允许重建窗口」的产品语义并修正注释。

### S3 无响应强制结束

- **位置**：`app-controller.ts:151`（10s 常量）、`:758-772`（reportUnresponsive）、`:780-786`（reportResponsive）；执行端 `window-port.ts:201-209`。
- **隐含状态集合**：无计时器／强制结束挂起（`unresponsiveTimer`）／已取消。
- **迁移**：`unresponsive` 事件→建 10s 定时器（重复事件只保留一个，`:764-765`）→`forcefullyCrashRenderer()`→交 S2；`responsive`→清定时器并记录 `cancelledForceCrash`。终态守卫齐全（`:760,767`）。
- **风险（低）**：强制结束时窗口已不存在则 `forcefullyCrashRenderer` 空转，不会产生 `render-process-gone`，恢复链中断（仅日志留痕）。概率极低。
- **测试覆盖**：`recovery-flow.test.ts:821-859`、`app-controller.test.ts` 崩溃组。
- **建议**：与 S2 合并为「进程级故障恢复」文档；无需代码改动。

### S4 重试退避状态机（RetryController）

- **位置**：`retry-controller.ts:74-185`；编排在 `app-controller.ts:585-632`。
- **隐含状态集合**：stopped／running-idle／retrying（`attempts>0` 且定时器挂起）／失败周期内离线页已展示（`offlinePageShown` 单向锁存）。
- **迁移**：`onLoadFailed`→首次失败展示离线页（一次，`:134-137`）+`scheduleRetry`（`attempts++`，`delay=min(base×2^(n-1),300s)×(1±20% jitter)`）；定时器触发→补排下一轮+`onRetry`；`onLoadSucceeded`→attempts 归零、锁存清除、定时器清除；`retryNow`→清定时器，若正在重试则补排下一轮，立即执行（`:151-159`）；`stop`→全清。控制器侧 `performRetryAttempt` 先 HEAD 探测再重载（`:610-632`），`reportNetworkOnline` 仅在 running 且 isRetrying 时 `retryNow`（`:637-644`）。
- **风险（低）**：`isRetrying` 是派生值（`:110-112`），`retryNow` 在 `!running` 时静默 no-op；`offlinePageShown` 失败周期内只展示一次是规格意图（防闪烁）。
- **测试覆盖**：高（`retry-controller.test.ts` 纯逻辑 + `recovery-flow.test.ts:386-581` 探测/在线恢复/子框架/关闭清理）。
- **建议**：已最接近显式（纯逻辑+可注入随机源）；补一张 attempt 状态图即可。

### S5 窗口关闭生命周期

- **位置**：`window-manager.ts:371-372`（`quitting`/`pendingQuit`）、`:617-634`（beginShutdown/closeAll）、`:744-771`（close/closed 监听）。
- **隐含状态集合**：运行中（`quitting=false`，关闭被拦截）／退出中（`quitting=true`）／待退出（`pendingQuit=true`，已放行关闭等 closed 消费）。
- **迁移**：close → Kiosk 或 `closeAction=hide` → `preventDefault`+hide（`:754-758`）；`closeAction=quit` → `pendingQuit=true` 放行 → closed → `quitApp()`（`:761-769`）；`beginShutdown`/`closeAll` → `quitting=true` 后续 close 不拦截。
- **风险（低）**：`pendingQuit` 依赖 closed 事件消费；Electron 语义下 close 放行后 closed 必触发，无实际残留路径。
- **测试覆盖**：`window-manager.test.ts:653-719` 全覆盖（hide/quit/Kiosk 强制隐藏/beginShutdown/closeAll）。
- **建议**：纳入窗口状态机文档，无需改动。

### S6 首屏显示时序（InitialReveal）

- **位置**：`window-manager.ts:77`（3s 兜底常量）、`:296-348`（类）、`:864-894`（挂载/revealWindow）。
- **隐含状态集合**：等待首帧（`pending` 槽位或 null）／就绪（`ready`）／已释放（`disposed`）。
- **迁移**：构造→挂 `ready-to-show` + 3s 兜底（任一先到 `markReady`，执行 pending 仅一次）；`request`→ready 则立即执行，否则**覆盖** pending；close 被拦截（close-to-hide）→`dropPending`（不得再把窗口弹出）；closed→`dispose`（清定时器丢弃动作）。
- **风险（低）**：pending 是**单槽**——就绪前多次主动显示只保留最后一个（当前调用方均为 show/focus 组合，无害）。
- **测试覆盖**：`window-manager.test.ts:842-1002`（隐藏创建、兜底显示、tray 驻留兜底也不显示、主动显示挂起、close-to-hide 后兜底不弹出、销毁后定时器释放、重建后同样时序）。
- **建议**：注释中明示单槽语义。

### S7 窗口句柄与资源生命周期

- **位置**：`window-manager.ts:358-372`（字段）、`:392-498`（创建/复用）、`:844-858`（releaseWindow）。
- **隐含状态集合**：窗口 absent（null 或 `isDestroyed()`）→ created → destroyed → recreated；资源分两层——**窗口级**（guards/reveals，closed 时释放）与**会话级**（`remoteSessionPolicy`/`remoteCachePolicy` 跨窗口周期持有，分区持久，仅 `closeAll` 释放；`configSessionPolicy` 配置窗关闭即释放）。
- **风险（低）**：`getMainWindow()` 把已销毁当 absent（`:376-379`）——销毁后 `mainWindow` 字段在 releaseWindow 前仍非 null，但所有读取都经过滤，安全。`clearRemoteCache` 无窗口时返回 true（「无需清除」）语义正确（`:596-599`）。
- **测试覆盖**：中（复用、销毁重开、销毁后 showMainWindow 返回 false 有用例；会话级句柄跨周期主要靠设计注释保证）。
- **建议**：把「窗口级 vs 会话级资源释放矩阵」补进 `rules/architecture.md`。

---

## 4. 主进程模块级状态机（S8–S22）

### S8 配置服务加载状态

- **位置**：`config-service.ts:49-52`（cachedResult/cachedConfig/inFlightLoad）、`:60-89`、`:95-119`。
- **隐含状态集合**：未加载／加载中（inFlight，并发去重）／已缓存／已保存（save 直接改缓存并通知）。
- **迁移**：`load()` 幂等+在途复用；`reload()` 清缓存再 load（配置界面打开时）；`save()` 原子写成功后更新缓存并广播 `onChange`。
- **风险（低）**：`onChange` 订阅机制**无生产订阅方**（生产走 `config-ipc` 的 `onSaved` 回调），是预留 API；save 后 `cachedResult.source` 取读路径来源而非写路径，诊断字段轻微不准。
- **测试覆盖**：`config-service.test.ts` 高。

### S9 配置 IPC 草稿状态

- **位置**：`config-ipc.ts:87`（uiDraft）、`:89-104`、`:118`、`:165-170`、`:267`。
- **隐含状态集合**：无草稿（用权威配置）／空白草稿（`blankConfig()`，加载失败时）。
- **迁移**：`handleGetConfig` 失败→建空白草稿；再次 getConfig 成功或保存成功→清除；`handleResetConfig` 以 `current() ?? uiDraft` 保 targetUrl；`getLastConfig` 回落 `service.current() ?? uiDraft`。
- **风险（低）**：权威配置与草稿双源；配置窗口打开期间文件被外部修复/破坏，UI 不感知（需重开窗口）。
- **测试覆盖**：`config-ipc.test.ts` 高。

### S10 保存分级应用流

- **位置**：`config-diff.ts:17-50`（分级）、`config-ipc.ts:106-160`（编排）、`main.ts:269-305`（装配）。
- **状态机**：保存 → 校验 → 原子落盘 → `onSaved` 副作用（登录项）→ 分级 `hot|reload|restart` → restart：closeStaleWindows + relaunch；reload：`applySavedConfig(config, true)`；hot：`applySavedConfig(config, false)`。
- **分级规则**：RESTART_PATHS = {`appearance.icon`, `logging.retentionDays`, `network.allowUntrustedCertificates`} + `startup.*`（除 `openAtLogin`）+ `schemaVersion`；`targetUrl`→reload；其余 hot；`prev===undefined`（首次保存）→restart。
- **风险（低）**：首次保存触发重启是既有流程设计（配置界面驻留启动→保存→重启加载新配置）；数组字段经 JSON.stringify 后比较，稳定。
- **测试覆盖**：`config-diff.test.ts` + `config-ipc.test.ts` + `app-controller.test.ts:388-425`（含「仅切证书字段也走 restart」回归）。
- **评价**：全应用**分级最清晰**的隐式状态机，是其他模块的范例。

### S11 装配期一次性锁存与竞态（main.ts）

- **位置**：`main.ts:62-73`（单实例+secondLaunchHandler）、`:150-158`（firstLoadRecorded）、`:186-199`（iconCleanupScheduled）、`:212-221`（wasOnline 边沿+轮询）、`:261-263`（handler 赋值）。
- **隐含状态集合**：四个一次性锁存（未触发→已触发）+ `secondLaunchHandler`（undefined→已赋值）+ `wasOnline` 布尔。
- **风险**：
  - **R1（高）二次启动唤醒竞态**：`acquireSingleInstance` 在**模块加载时**就注册了 `onSecondInstance`（`:64-67`），而 `secondLaunchHandler` 要到 controller 构造完成后才赋值（`:261`）。二次启动若落在这个窗口内，`secondLaunchHandler?.(payload)` **静默丢弃**唤醒请求——首实例可能正驻留托盘，用户看不到任何反馈，也永远等不到窗口。该窗口覆盖整个 bootstrap（读配置、建 logger、解析图标、建窗口管理器），现场自启+手动双击的场景完全可能命中。
  - `effectiveAppId` 依赖 `appIcon.source`（自定义图标→AppUserModelID 加后缀，`:137-144`）：Windows 任务栏归属随图标配置变化，隐式耦合但启动期一次解析，可接受。
- **测试覆盖**：**无**（main.ts 装配层无单测，`tests/smoke/project.test.ts` 只验项目结构）。
- **显式化建议**：模块级 `let pendingSecondLaunch: SecondLaunchPayload | undefined`，bootstrap 尾部（handler 赋值后）消费；或把「单实例获取」挪到 controller 就绪之后（需评估锁语义）。

### S12 单实例锁

- **位置**：`single-instance.ts:104-123`、`main.ts:64-73`、`electron-ports.ts:20-33`。
- **隐含状态集合**：未获取（第二个实例，退出）／已获取（运行）／已释放（shutdown→`release()`，`:958`）。
- **风险（中）**：与 R1 竞态叠加——锁已获得但唤醒通道未就绪。`app.quit()` 路径（非首实例）不释放锁，由 OS 回收，可接受。
- **测试覆盖**：`single-instance.test.ts`（argv 解析、payload 构造）+ `app-controller.test.ts:922`（shutdown 释放锁）。

### S13 日志器

- **位置**：`logger.ts:408-416`（closed/unavailable/closePromise/buffer/bufferPath/sink/sinkPath/flushChain/timer）、`:418-428`（init）、`:437-444`（degrade）、`:446-511`（flush 链）、`:513-550`（enqueue）、`:560-573`（close）。
- **隐含状态集合**：初始化中／可用（流式或 appendFile 回写）／**不可用（unavailable 单向锁存）**／已关闭（closed 锁存）；写入面：sink 未开／路径匹配／跨自然日需轮换（`bufferPath !== path` 先把旧批整体刷出，`:535`）。
- **迁移**：enqueue（级别过滤→脱敏→序列化→入缓冲→50 条或 200ms 阈值 flush）；flush（同步摘缓冲→链入串行队列，`:502-511`）；writeEntries（endSink→openSink→write）；degrade（init/开流/单批/流出错任一失败→**单向锁存**，丢缓冲停定时器）；close（幂等，await init→flush→endSink，永不 reject）。
- **风险（中，R7）**：degrade 后到进程退出前**日志真空**——只有 `onError` 的控制台线索，现场排查出现「日志突然没有了」。是「日志失败不影响主流程」的取舍，但可更优雅。
- **测试覆盖**：高（`logger.test.ts`：跨天轮换、级别过滤、脱敏、批量失败降级、close 幂等与落盘等待）。
- **建议**：降级时回退 `appendFile` 逐批直写而非全丢（低优先）；`closed/unavailable` 可显式为 `status` 字段便于断言。

### S14 托盘实例生命周期

- **位置**：`tray-manager.ts:53-94`（createTray 决策）、`electron-tray-port.ts:37-74`（实例）、`app-controller.ts:389-415, 229-233`（创建/重建）。
- **隐含状态集合**：无托盘（能力不可用→degraded，不持 handle）／已创建／已销毁。
- **迁移**：`create` 幂等（先 destroy 旧再建，`electron-tray-port.ts:41-42`）；`trayConfigEnabled` 变更→destroy+create（`app-controller.ts:229-233`）；shutdown→destroy。菜单在创建时快照 `configEnabled`（`:48`）——运行中改配置走重建，一致。
- **风险（低）**：Linux 无托盘协议时 degraded，保留窗口内入口（规格 §10）。
- **测试覆盖**：`tray-manager.test.ts` + `electron-tray-port.test.ts` + `app-controller.test.ts:849-865`。

### S15 快捷键绑定生命周期

- **位置**：`tray-manager.ts:179-202`（installFocusedShortcut）、`shortcut-host.ts:34-98`（channel+target）、`app-controller.ts:451-468`（安装/重装）。
- **隐含状态集合**：未安装／已绑定（**按窗口实例**，`bound` 记录当前绑定窗口）／已 dispose（`disposed` 标志）；channel：`current=null`→set(window)→closed 时 set(null)（main.ts:203）→重建窗口 `emitReady` 重绑。
- **风险（中，R8 代码卫生）**：`createMainWindowChannel.onReady`（`shortcut-host.ts:52-59`）是**死条件分支**——`if (bound === current) { handler(current) } else { bound = current; handler(current) }` 两支完全等价，`bound` 在这里不去重；同一 handler 在窗口已存在时重复注册会重复绑定 `before-input-event`（`onInvoke` 触发两次；当前唯一调用方 `showAndFocusMain` 幂等所以无害）。真正的去重守卫在 `emitReady`（`:61-66`）。
- **测试覆盖**：`shortcut-host.test.ts`（派发、已存在窗口即时绑定、同窗口不重复派发、重建重绑、焦点复核）。
- **建议**：删除死分支，或按 handler 维度去重。

### S16 代理应用

- **位置**：`proxy-manager.ts:260-385`（applyProxy/degradeToDirect/applyProxyMode）、`app-controller.ts:505-552`（启动确认/热切换）、`electron-ports.ts:42-50`（端口）。
- **隐含状态集合**：会话级 `direct`／`pac-installed`（data URL PAC，仅接口域名）；结果 `effective: direct|pac` + `notes[]` 降级说明。
- **迁移**：启动失败→`confirmProxyFailure`→continue（继续建窗）/configure（转配置界面）；热切换失败→返回 false→保存告警；每次应用后 `closeAllConnections`；任何失败先 `degradeToDirect` 再抛（`:374-385`，保证确定性的直连终态）。
- **风险（低）**：system 模式逐域名 `resolveProxy` 部分失败→该域名直连+notes（部分降级，已测）；会话代理是进程内共享状态，主窗口与 HEAD 探测同分区所以一致（设计）。
- **测试覆盖**：`proxy-manager.test.ts` + `recovery-flow.test.ts:582-693`。

### S17 证书校验策略

- **位置**：`cert-policy.ts:75-97`、`app-controller.ts:566-577`、`electron-ports.ts:68-80`。
- **隐含状态集合**：installed（放行 proc）／null（Chromium 默认校验）；**重启级**（config-diff RESTART_PATHS）。
- **风险（低）**：网络服务按主机缓存校验结果——运行中切换不生效（Task 28 返工根因，规格 §7 已明示）；启动时安装失败不阻断（仅诊断，`:573-576`）。
- **测试覆盖**：`cert-policy.test.ts` + `app-controller.test.ts:362-425`。

### S18 缓存策略句柄

- **位置**：`cache-policy.ts:111-154`、`window-manager.ts:363-366, 579-614`。
- **隐含状态集合**：监听 installed/uninstalled（`installed` 守卫防重复注册）；`lastCacheMode`；句柄跨窗口周期（分区持久）；clear-on-start 仅建窗时执行一次。
- **迁移**：`update(mode)`：keep→uninstall；revalidate/clear→install（幂等）；`dispose` 仅 closeAll。保存热切换只改请求头策略，clear 的清除动作下次启动（规格 §5.2，`window-port.ts:142-143`）。
- **风险（低）**：无窗口时 `updateCachePolicy` 仍记录 lastCacheMode 并尝试装到 undefined session（`:611-614` 早退）。
- **测试覆盖**：`cache-policy.test.ts` + `window-manager.test.ts`（remote-cache-cleared/failed 事件）。

### S19 登录项双源状态

- **位置**：`startup-manager.ts:121-147`、`app-controller.ts:476-497`、`electron-login-item.ts:32-52`。
- **隐含状态集合**：配置期望（`openAtLogin`）vs OS 实际（`port.query()`）；`setOpenAtLogin` 幂等（相同则跳过写入，`:133-135`）。
- **风险（低）**：`openAtLogin=false` 时启动**不主动清理** OS 侧登录项（避免覆盖用户手动设置，`:470-475` 注释阐明）；OS 侧改动不同步回配置。可在配置界面展示 `query()` 实际态作为增强。
- **测试覆盖**：`startup-manager.test.ts` + `startup-flow.test.ts`。

### S20 延迟启动

- **位置**：`startup-manager.ts:32-79`（文件头自述「延迟逻辑由应用内部状态机控制」）、`app-controller.ts:327-365`。
- **隐含状态集合**：不延迟（no-op stub，pending 恒 false）／pending／fired／cancelled。
- **迁移**：`shouldApplyDelay`（`delaySec>0` 且（`!delayOnlyOnLogin` 或 `source==='login'`））；timer 到点→fired→onReady；cancel→cancelled（clearTimeout，fired 后 cancel 空转）；pending 由 `!cancelled && !fired` 派生。
- **风险（低）**：cancel 与 fired 竞态由 `cancelled` 标志防护（timer 回调内检查，`:64-66`）。
- **测试覆盖**：`app-controller.test.ts:572-765`（延迟矩阵、取消、showAfterDelay、initialState 组合）+ `startup-flow.test.ts`。

### S21 网络在线边沿检测

- **位置**：`main.ts:212-221`（2s 轮询+上升沿）、`app-controller.ts:637-644`（reportNetworkOnline）。
- **隐含状态集合**：`wasOnline` 布尔；只认 false→true 上升沿。
- **迁移**：上升沿→`reportNetworkOnline`→`state==='running'` 且 `retryController.isRetrying`→`retryNow`；掉线无事件（由 `did-fail-load` 驱动重试）。
- **风险（低）**：非 running 状态（如 configuring）恢复在线不重试——与 R4 叠加时该状态本就没有重试控制器。轮询 unref，will-quit 清理（`:221`）。
- **测试覆盖**：中（`recovery-flow.test.ts:474-535` 覆盖在线恢复 retryNow；轮询边沿本身在 main.ts 无单测）。

### S22 电源唤醒门控

- **位置**：`app-controller.ts:820-835`、`electron-ports.ts:87-102`。
- **隐含状态集合**：订阅后常驻（无自有状态）；resume→`state==='running'`→`reloadMain()`。
- **风险（高，R15）**：**驻留托盘 + `showAfterDelay=false` 组合下，`state='running'` 但主窗口从未创建**（`onDelayElapsed` 直接转 running，`:355-359`）。此时一次休眠唤醒→`reloadMain`→`window-port.ts:164-177` 在无窗口时**按当前配置重建并显示主窗口**——用户没有点托盘，电脑睡醒窗口自己弹出来了，与「延迟到期仍保持驻留，等待用户从托盘触发」的规格意图冲突。`app-controller.test.ts:630` 覆盖了驻留不显示、`recovery-flow.test.ts:711` 覆盖了倒计时中唤醒不抢建窗，但 **「running+无窗口+唤醒」组合是测试盲区**。
- **测试覆盖**：中。
- **显式化建议**：resume 重载前要求窗口已存在（窗口端口增加 `reloadIfExists` 语义，或控制器经 `WindowPort` 查询窗口存在性）；或产品明确「唤醒即展示」并补测试。

---

## 5. 渲染进程与契约层（S23–S27）

### S23 配置表单 Phase

- **位置**：`App.tsx:60`（`loading|ready|saving|failed`）、`:383-435`（加载）、`:485-539`（提交）、`:625-651`（渲染分流）。
- **隐含状态集合**：loading／ready／saving（字段禁用）／**failed（终态）**。
- **迁移**：mount→getConfig→ready|failed（bridge 缺失也进 failed，`:410-413`）；submit→本地校验→validateConfig→saveConfig→各失败路径均回 ready；保存成功→按 `applied` 分级展示消息（restart/reload/hot，`:522-531`）。
- **风险（低）**：failed 无重试入口，只能关闭重开（产品可接受）；StrictMode 双挂载用 `cancelled` 标志防护（`:416-434`）。
- **测试覆盖**：`config-form.test.tsx` 全覆盖（加载/失败/校验/保存/重置/beforeunload/图标/连接测试）。

### S24 draft/baseline 脏检查

- **位置**：`App.tsx:385-386, 466-479, 541-552`。
- **隐含状态集合**：无草稿（loading）／干净（`draft===baseline`）／脏（`JSON.stringify` 不等，派生值）。
- **迁移**：编辑→脏；保存成功→`baseline=draft`（干净）；恢复默认→draft 变而 baseline 不变（仍脏，需保存——`:578` 测试确认该语义）；beforeunload 仅脏时拦截（`:471-479`）。
- **风险（低）**：stringify 键序敏感，但 `toDraft` 键序固定、同源比较稳定。
- **测试覆盖**：高。

### S25 表单条件显隐

- **位置**：`App.tsx:652-654, 835-843, 879-910, 947-951, 1019-1027`。
- **派生视图状态**：`proxyMode`→proxyServer/bypass/apiProxyHosts 显隐 + 空接口域名非阻塞提示；`alwaysOnTop`→层级字段；`hotkeyEnabled`→快捷键字段；`allowUntrustedCertificates`→风险提示横幅。
- **风险（低）**：纯派生，无独立状态。
- **测试覆盖**：`config-form.test.tsx:343-463`。

### S26 日志查看器轮询

- **位置**：`App.tsx:398-464, 614-623`。
- **隐含状态集合**：非 logs tab（无轮询）／logs tab（3s 轮询 + autoScroll 效果 + 级别/搜索过滤派生）。
- **风险（低）**：fetchLogs 失败静默（`:444-446`）；轮询与手动刷新无竞态防护（entries 整体替换，3s 粒度可接受）。
- **测试覆盖**：中（过滤/展示有测试；轮询生命周期靠 effect 依赖保证）。

### S27 契约与 schema 迁移（对照项，非隐式）

- `ipc-contract.ts:34-39` 白名单集合 + `config-ipc.ts:255-265` 注册双保险（表被误改时抛错）——注册期守卫。
- `config-schema.ts:335-459` 迁移注册表（0→1）+ `inspectSchemaVersion` 拒绝更新版本写入的配置（`:378-389`）——显式设计。

---

## 6. 风险清单（按优先级）

| # | 风险 | 位置 | 严重度 | 触发场景 | 建议修复 |
|---|---|---|---|---|---|
| R1 | 二次启动唤醒在 handler 就绪前被静默丢弃 | main.ts:62-73, 261-263 | **高** | 自启/慢启动期间用户再次双击图标 | 模块级 pendingSecondLaunch 队列，bootstrap 尾部消费 |
| R15 | 休眠唤醒重建并显示驻留窗口（用户未请求） | app-controller.ts:828-834 + window-port.ts:164-177 | **高** | 驻留托盘 + showAfterDelay=false + 睡醒 | resume 重载仅限窗口已存在；或产品明确「唤醒即展示」并补测试 |
| R2 | `mainWindowCreated`/`AppState` 与真实窗口脱同步 | app-controller.ts:188, 374-386 + window-port.ts:150-177 | **高** | configuring 状态保存 reload 级配置；崩溃重载时窗口已销毁 | 窗口端口回报创建/销毁事件；`mainWindowCreated` 查询化 |
| R4 | configuring 二分子态 + 代理失败路径无重试控制器 | app-controller.ts:288-296, 315-319, 585-604 | 中 | 启动代理失败→保存改重试间隔→重试重建窗口 | 拆 `configuring` 子态或统一初始化重试控制器 |
| R5 | shutdown 后 applySavedConfig 仍可执行（新建定时器/触发加载） | app-controller.ts:202-236 | 中 | 保存与退出竞态 | 入口加 `shutting-down/stopped` 早退（与 performRetryAttempt 一致） |
| R3 | scheduleCrashReload 注释与行为漂移（实际会重建窗口） | app-controller.ts:800-805 | 中 | 窗口销毁后崩溃恢复 | 明确产品语义并修正注释 |
| R7 | 日志降级后到退出前日志真空 | logger.ts:437-444 | 中 | 磁盘/流出错后 | 降级为 appendFile 逐批直写 |
| R8 | MainWindowChannel.onReady 死分支，重复注册会重复绑定 | shortcut-host.ts:52-59 | 中 | 同一 handler 重复注册 | 删除死分支或按 handler 去重 |
| R6/R9/R10/R11/R13/R14 | 单槽语义、uiDraft 双源、登录项双源、上升沿门控、failed 终态、stringify 脏检查 | 见各节 | 低 | — | 文档化即可 |

## 7. 显式化改造路线图

1. **快速修复（无架构变更，建议随下一个任务组落地）**：R1 pendingSecondLaunch 队列；R15 resume 守卫；R5 终态守卫；R8 删死分支；R3 注释修正。每项都可先补失败测试再修复（TDD）。
2. **短期（抽纯状态机，仿 `crash-guard.ts` 已验证的模式）**：S2+S3 合并为 `renderer-recovery.ts` 纯状态机（纯函数 + 调用方持历史，端口触发动作）；S1 抽 `app-lifecycle.ts` 转移表；R2 经窗口存在性事件同步。`crash-guard`、`retry-controller`、`config-diff` 已证明该模式在本项目成本低、收益高。
3. **中期**：configuring 子态拆分（R4）；日志器 status 显式化（R7）；配置界面展示登录项 `query()` 实际态（R19 增强）。
4. **长期**：以本报告为基线维护「状态机清单」，新增行为前过一遍五维度 checklist（状态集合/迁移/耦合/非法态/测试）；把第 3 章核心七机的状态图补进 `rules/architecture.md`。

## 8. 做得好的地方（保持）

- **崩溃锁存是锁存器而非计数器**（S2）：旧记录滑出窗口不复活自动重载，只有用户干预或加载成功才能恢复——Task 15 返工的既定设计，测试完整。
- **保存分级**（S10）：hot/reload/restart 三级 + 路径表，是全应用最清晰的隐式状态机。
- **失败关闭（fail-closed）**：导航守卫、权限、下载、快捷键焦点复核、登录项缺失端口抛错，全部默认拒绝。
- **InitialReveal**（S6）：ready-to-show + 兜底超时 + close-to-hide 放弃挂起，首屏质量与退出正确性兼顾。
- **纯逻辑可测性**：crash-guard / retry-controller / cache-policy / cert-policy / proxy-manager / config-paths 均不导入 Electron，端口注入，测试不依赖真实平台。

---

*报告完。所有 file:line 对 2026-11-10 的代码核实；后续代码变迁后引用可能漂移，以代码为准。*

---

## 9. 修复记录（2026-11-10，v0.1.10 / 规格 v2.1.9）

第 6 章风险清单已全部处置：高风险与中风险项完成了代码修复并补充回归测试，低风险项按既定策略以注释固化设计约定。

| 风险 | 处置 | 落点 |
|---|---|---|
| R1 二次启动唤醒竞态 | **已修复**：新增 `src/main/instance/second-launch-inbox.ts` 纯模块（deliver/setHandler/drain），handler 就绪前缓存载荷（仅保留最早一条），bootstrap 尾部补投递 | `second-launch-inbox.ts` + `main.ts` 接线 + 5 项单测 |
| R15 唤醒弹出驻留窗口 | **已修复**：resume 重载增加 `mainWindowCreated` 门控——没有窗口就没有页面可重载，不再按最近配置重建并显示 | `app-controller.ts` subscribePowerMonitor + recovery-flow 回归测试 |
| R2 控制器与窗口脱同步 | **已修复**：window-manager 新增 `main-window-destroyed` 事件；控制器 `syncWindowLifecycle` 以窗口层事件为准同步 `mainWindowCreated` 与 AppState | `window-manager.ts` releaseWindow + `app-controller.ts` + 4 项测试 |
| R4 configuring 二分子态 | **已修复**：窗口在 configuring 状态被重建时经事件转入 running 并补齐重试控制器；保存 reload 级配置时即使 network 未变也重新应用代理（覆盖启动降级直连） | `app-controller.ts` applySavedConfig/syncWindowLifecycle + 测试 |
| R5 shutdown 后保存 | **已修复**：`applySavedConfig` / `reloadConfiguredPage` 入口加终态守卫，关闭后不再新建重试控制器或触发加载 | `app-controller.ts` + 测试 |
| R3 注释漂移 | **已修复**：`scheduleCrashReload` 注释改为描述实际行为（端口自愈重建 + 事件同步） | `app-controller.ts` |
| R7 日志真空 | **已修复**： degrade 分流——init 失败仍硬降级；流/写入失败降级为按批 `appendFile` 直写；appendFile 也失败才真正停止。旧的「降级即全丢」测试按新语义更新 | `logger.ts` + 3 项测试（含回写再失败） |
| R8 死分支/双绑定 | **已修复**：删死分支，`boundHandlers` 按 handler 维度去重（onReady 与 emitReady 两条路径都覆盖） | `shortcut-host.ts` + 2 项测试 |
| R13 failed 终态 | **已修复**：失败页新增「重新加载」按钮，runLoad 抽出支持重试 | `App.tsx` + config-form 测试 |
| R6/R9/R10/R11/R14 | **已注释固化**：InitialReveal 单槽语义、uiDraft 双源生命周期、登录项双源、在线边沿门控、脏检查键序稳定性，均以代码注释明示 | 对应模块 |

**验证**：`npm run typecheck` / `lint` 通过；`npx vitest run` 39 文件 781 项全过（修复前 765 项，净增 16 项回归）；`npm run build` 通过（产物核实版本徽标 0.1.10、inbox 与销毁事件入 main 包）。提交（main，均未 push）：规格 v2.1.9 → 唤醒收件箱 → 窗口同步与门控 → 日志降级 → 快捷键去重 → 界面重试 → chore 0.1.10 → 本记录。
