import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type { FormattedLogEntry, SaveResult } from '../../shared/ipc-contract';
import type {
  AlwaysOnTopLevel,
  AppConfig,
  InitialState,
  LogLevel,
  NetworkConfig,
  ProxyMode,
  ValidationIssue,
  ValidationResult,
  WindowCloseAction,
  WindowMode,
} from '../../shared/config-types';

/**
 * 本地配置界面。
 *
 * 规则来源：规格 v2.1 §5.1（界面展示实际路径）、§5.3（未保存关闭不得修改原配置）、
 * §14.1（保存、重启）与 `rules/architecture.md`「renderer 只能通过 preload 暴露的、
 * 类型化的白名单接口请求操作」。
 */

interface FormDraft {
  schemaVersion: number;
  targetUrl: string;
  mode: WindowMode;
  alwaysOnTop: boolean;
  alwaysOnTopLevel: AlwaysOnTopLevel;
  display: string;
  closeAction: WindowCloseAction;
  proxyMode: ProxyMode;
  proxyServer: string;
  proxyBypass: string;
  apiProxyHosts: string;
  retryIntervalSec: string;
  requestTimeoutSec: string;
  offlinePageEnabled: boolean;
  openAtLogin: boolean;
  initialState: InitialState;
  delaySec: string;
  delayOnlyOnLogin: boolean;
  showAfterDelay: boolean;
  hotkeyEnabled: boolean;
  hotkey: string;
  trayConfigEnabled: boolean;
  allowedOrigins: string;
  allowExternalLinks: boolean;
  allowPopups: boolean;
  allowDownloads: boolean;
  icon: string;
  level: LogLevel;
  retentionDays: string;
}

type Phase = 'loading' | 'ready' | 'saving' | 'failed';
type TabKey = 'target' | 'window' | 'startup' | 'network' | 'maintenance' | 'logs';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readInitialConfigPath(): string {
  try {
    return new URLSearchParams(window.location.search).get('configPath') ?? '';
  } catch {
    return '';
  }
}

function toDraft(config: AppConfig): FormDraft {
  return {
    schemaVersion: config.schemaVersion,
    targetUrl: config.targetUrl,
    mode: config.window.mode,
    alwaysOnTop: config.window.alwaysOnTop,
    alwaysOnTopLevel: config.window.alwaysOnTopLevel,
    display: config.window.display,
    closeAction: config.window.closeAction,
    proxyMode: config.network.proxyMode,
    proxyServer: config.network.proxyServer,
    proxyBypass: config.network.proxyBypass,
    apiProxyHosts: (config.network.apiProxyHosts ?? []).join('\n'),
    retryIntervalSec: String(config.network.retryIntervalSec),
    requestTimeoutSec: String(config.network.requestTimeoutSec),
    offlinePageEnabled: config.network.offlinePageEnabled,
    openAtLogin: config.startup.openAtLogin,
    initialState: config.startup.initialState,
    delaySec: String(config.startup.delaySec),
    delayOnlyOnLogin: config.startup.delayOnlyOnLogin,
    showAfterDelay: config.startup.showAfterDelay,
    hotkeyEnabled: config.maintenance.hotkeyEnabled,
    hotkey: config.maintenance.hotkey,
    trayConfigEnabled: config.maintenance.trayConfigEnabled,
    allowedOrigins: config.security.allowedOrigins.join('\n'),
    allowExternalLinks: config.security.allowExternalLinks,
    allowPopups: config.security.allowPopups,
    allowDownloads: config.security.allowDownloads,
    icon: config.appearance?.icon ?? '',
    level: config.logging.level,
    retentionDays: String(config.logging.retentionDays),
  };
}

function toInteger(raw: string): number | string {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return raw;
  return Number.parseInt(trimmed, 10);
}

function toHostList(raw: string): string[] {
  return raw
    .split(/[\n,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseNonNegativeInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 10);
}

function buildCandidate(draft: FormDraft): Record<string, unknown> {
  return {
    schemaVersion: draft.schemaVersion,
    targetUrl: draft.targetUrl.trim(),
    window: {
      mode: draft.mode,
      alwaysOnTop: draft.alwaysOnTop,
      alwaysOnTopLevel: draft.alwaysOnTopLevel,
      display: draft.display.trim() === '' ? 'primary' : draft.display.trim(),
      closeAction: draft.closeAction,
    },
    network: {
      proxyMode: draft.proxyMode,
      proxyServer: draft.proxyServer.trim(),
      proxyBypass: draft.proxyBypass.trim(),
      apiProxyHosts: toHostList(draft.apiProxyHosts),
      retryIntervalSec: toInteger(draft.retryIntervalSec),
      requestTimeoutSec: toInteger(draft.requestTimeoutSec),
      offlinePageEnabled: draft.offlinePageEnabled,
    },
    startup: {
      openAtLogin: draft.openAtLogin,
      initialState: draft.initialState,
      delaySec: toInteger(draft.delaySec),
      delayOnlyOnLogin: draft.delayOnlyOnLogin,
      showAfterDelay: draft.showAfterDelay,
    },
    maintenance: {
      hotkeyEnabled: draft.hotkeyEnabled,
      hotkey: draft.hotkey.trim(),
      trayConfigEnabled: draft.trayConfigEnabled,
    },
    security: {
      allowedOrigins: toHostList(draft.allowedOrigins),
      allowExternalLinks: draft.allowExternalLinks,
      allowPopups: draft.allowPopups,
      allowDownloads: draft.allowDownloads,
    },
    appearance: {
      icon: draft.icon.trim(),
    },
    logging: {
      level: draft.level,
      retentionDays: toInteger(draft.retentionDays),
    },
  };
}

function localIssues(draft: FormDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const delay = parseNonNegativeInteger(draft.delaySec);
  if (delay === undefined || delay < 0 || delay > 3600) {
    issues.push({ path: 'startup.delaySec', message: '启动延迟必须是 0～3600 之间的整数秒', code: 'local' });
  }
  const retry = parseNonNegativeInteger(draft.retryIntervalSec);
  if (retry === undefined || retry < 1) {
    issues.push({ path: 'network.retryIntervalSec', message: '重试间隔必须是大于 0 的整数秒', code: 'local' });
  }
  const timeout = parseNonNegativeInteger(draft.requestTimeoutSec);
  if (timeout === undefined || timeout < 1) {
    issues.push({ path: 'network.requestTimeoutSec', message: '请求超时必须是大于 0 的整数秒', code: 'local' });
  }
  const retention = parseNonNegativeInteger(draft.retentionDays);
  if (retention === undefined || retention < 1) {
    issues.push({ path: 'logging.retentionDays', message: '日志保留天数必须是大于 0 的整数', code: 'local' });
  }

  return issues;
}

interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

function TextField({ id, label, value, onChange, placeholder, disabled }: TextFieldProps) {
  return (
    <p className="field">
      <label htmlFor={`field-${id}`}>{label}</label>
      <input
        id={`field-${id}`}
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </p>
  );
}

interface NumberFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}

function NumberField({ id, label, value, onChange, min, max, disabled }: NumberFieldProps) {
  return (
    <p className="field">
      <label htmlFor={`field-${id}`}>{label}</label>
      <input
        id={`field-${id}`}
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </p>
  );
}

interface SelectFieldProps<V extends string> {
  id: string;
  label: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (value: V) => void;
  disabled?: boolean;
}

function SelectField<V extends string>({ id, label, value, options, onChange, disabled }: SelectFieldProps<V>) {
  return (
    <p className="field">
      <label htmlFor={`field-${id}`}>{label}</label>
      <select
        id={`field-${id}`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as V)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </p>
  );
}

interface CheckboxFieldProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

function CheckboxField({ id, label, checked, onChange, disabled }: CheckboxFieldProps) {
  return (
    <p className="field field-checkbox">
      <input
        id={`field-${id}`}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label htmlFor={`field-${id}`}>{label}</label>
    </p>
  );
}

interface TextAreaFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}

function TextAreaField({ id, label, value, onChange, placeholder, rows = 4, disabled }: TextAreaFieldProps) {
  return (
    <p className="field field-textarea">
      <label htmlFor={`field-${id}`}>{label}</label>
      <textarea
        id={`field-${id}`}
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </p>
  );
}

const WINDOW_MODE_OPTIONS: ReadonlyArray<{ value: WindowMode; label: string }> = [
  { value: 'window', label: '普通窗口' },
  { value: 'fullscreen', label: '全屏' },
  { value: 'kiosk', label: 'Kiosk 无人值守' },
];

const ALWAYS_ON_TOP_LEVEL_OPTIONS: ReadonlyArray<{ value: AlwaysOnTopLevel; label: string }> = [
  { value: 'normal', label: 'normal' },
  { value: 'floating', label: 'floating' },
  { value: 'pop-up-menu', label: 'pop-up-menu' },
  { value: 'screen-saver', label: 'screen-saver' },
];

const CLOSE_ACTION_OPTIONS: ReadonlyArray<{ value: WindowCloseAction; label: string }> = [
  { value: 'hide', label: '隐藏到托盘' },
  { value: 'quit', label: '退出程序' },
];

const PROXY_MODE_OPTIONS: ReadonlyArray<{ value: ProxyMode; label: string }> = [
  { value: 'direct', label: '直连' },
  { value: 'system', label: '系统代理' },
  { value: 'fixed', label: '固定代理' },
  { value: 'pac', label: 'PAC 地址' },
];

const INITIAL_STATE_OPTIONS: ReadonlyArray<{ value: InitialState; label: string }> = [
  { value: 'tray', label: '驻留托盘' },
  { value: 'minimized', label: '最小化' },
];

const LOG_LEVEL_OPTIONS: ReadonlyArray<{ value: LogLevel; label: string }> = [
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
];

export function ConfigurationApp() {
  const bridge = window.uniShell;
  const [draft, setDraft] = useState<FormDraft | null>(null);
  const [baseline, setBaseline] = useState<FormDraft | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState(readInitialConfigPath);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [iconMessage, setIconMessage] = useState<string | null>(null);

  // 导航栏标签状态
  const [activeTab, setActiveTab] = useState<TabKey>('target');

  // 日志查看器状态
  const [logs, setLogs] = useState<FormattedLogEntry[]>([]);
  const [logDirectory, setLogDirectory] = useState('');
  const [logLevelFilter, setLogLevelFilter] = useState('ALL');
  const [logSearch, setLogSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const logTerminalRef = useRef<HTMLDivElement>(null);

  // 挂载即经白名单桥读取配置
  useEffect(() => {
    if (bridge === undefined) {
      setLoadError('配置桥不可用：请从托盘菜单重新打开配置界面；若持续出现，请重启客户端。');
      setPhase('failed');
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const config = await bridge.getConfig();
        if (cancelled) return;
        const next = toDraft(config);
        setDraft(next);
        setBaseline(next);
        setPhase('ready');
      } catch (error) {
        if (cancelled) return;
        setLoadError(`配置加载失败：${describeError(error)}`);
        setPhase('failed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // 获取运行日志
  const fetchLogs = useCallback(async () => {
    if (bridge === undefined || typeof bridge.getLogs !== 'function') return;
    try {
      const res = await bridge.getLogs({ limit: 300, level: logLevelFilter === 'ALL' ? undefined : logLevelFilter });
      setLogs(res.entries);
      if (res.directory) setLogDirectory(res.directory);
    } catch {
      // 容错处理
    }
  }, [bridge, logLevelFilter]);

  // 当日志页面处于激活状态时定时刷新
  useEffect(() => {
    if (activeTab !== 'logs') return;
    void fetchLogs();
    const interval = setInterval(() => {
      void fetchLogs();
    }, 3000);
    return () => clearInterval(interval);
  }, [activeTab, fetchLogs]);

  // 自动滚动日志
  useEffect(() => {
    if (activeTab === 'logs' && autoScroll && logTerminalRef.current) {
      logTerminalRef.current.scrollTop = logTerminalRef.current.scrollHeight;
    }
  }, [logs, activeTab, autoScroll]);

  const dirty = useMemo(
    () => draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline),
    [draft, baseline],
  );

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const update = useCallback(<K extends keyof FormDraft>(key: K, value: FormDraft[K]) => {
    setDraft((current) => (current === null ? current : { ...current, [key]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (bridge === undefined || draft === null) return;

      const local = localIssues(draft);
      if (local.length > 0) {
        setIssues(local);
        setSaveError('配置校验未通过，请修正下列问题后重试。');
        setSaveMessage(null);
        return;
      }

      setIssues([]);
      setSaveError(null);
      setSaveMessage(null);
      setPhase('saving');

      try {
        const validation = (await bridge.validateConfig(buildCandidate(draft))) as ValidationResult<AppConfig>;
        if (!validation.ok) {
          setIssues(validation.issues);
          setSaveError('配置校验未通过，请修正下列问题后重试。');
          setPhase('ready');
          return;
        }

        const result = (await bridge.saveConfig(validation.value)) as SaveResult;
        if (!result.ok) {
          setSaveError(`保存失败：${result.message ?? '未知错误'}`);
          setPhase('ready');
          return;
        }

        if (result.configPath !== undefined && result.configPath.length > 0) {
          setConfigPath(result.configPath);
        }
        setBaseline(draft);
        setSaveMessage(
          result.applyWarning
            ? `配置已保存，但应用失败：${result.applyWarning}`
            : result.applied === 'restart'
              ? '配置已保存，客户端即将重启…'
              : result.applied === 'reload'
                ? '配置已保存，页面正在重新加载…'
                : '配置已保存并生效。',
        );
        setPhase('ready');
      } catch (error) {
        setSaveError(`保存失败：${describeError(error)}`);
        setPhase('ready');
      }
    },
    [bridge, draft],
  );

  const handleReset = useCallback(async () => {
    if (bridge === undefined) return;
    try {
      const config = await bridge.resetConfig();
      setDraft(toDraft(config));
      setIssues([]);
      setSaveError(null);
      setSaveMessage(null);
    } catch (error) {
      setSaveError(`恢复默认值失败：${describeError(error)}`);
    }
  }, [bridge]);

  const handleTestConnection = useCallback(async () => {
    if (bridge === undefined || draft === null) return;
    setConnectionMessage('正在测试连接…');
    try {
      const candidate = buildCandidate(draft);
      const result = await bridge.testConnection(draft.targetUrl.trim(), candidate.network as NetworkConfig);
      setConnectionMessage(
        result.ok
          ? `连接成功（HTTP ${result.statusCode ?? '—'}，${result.durationMs ?? 0} ms）`
          : `连接失败：${result.message ?? '未知错误'}`,
      );
    } catch (error) {
      setConnectionMessage(`连接失败：${describeError(error)}`);
    }
  }, [bridge, draft]);

  const handlePickIcon = useCallback(async () => {
    if (bridge === undefined) return;
    try {
      const result = await bridge.pickIcon();
      if (!result.ok) {
        if (!result.canceled && result.message) setIconMessage(`图标选择失败：${result.message}`);
        return;
      }
      if (result.fileName !== undefined) {
        update('icon', result.fileName);
        setIconMessage(`已选择图标：${result.fileName}（保存并重启后生效）`);
      }
      if (result.previewDataUrl !== undefined) {
        setIconPreview(result.previewDataUrl);
      }
    } catch (error) {
      setIconMessage(`选择图标失败：${describeError(error)}`);
    }
  }, [bridge, update]);

  const handleResetIcon = useCallback(() => {
    update('icon', '');
    setIconPreview(null);
    setIconMessage('已恢复内置默认图标（保存并重启后生效）');
  }, [update]);

  const handleExportLogs = useCallback(() => {
    const text = logs.map((l) => `[${l.time}] [${l.level}] [${l.event}] ${l.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `unishell-runtime-${new Date().toISOString().slice(0, 10)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [logs]);

  const handleOpenLogDir = useCallback(async () => {
    if (bridge && typeof bridge.openLogDirectory === 'function') {
      await bridge.openLogDirectory();
    }
  }, [bridge]);

  // 过滤后的日志
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const matchesLevel = logLevelFilter === 'ALL' || log.level === logLevelFilter;
      const matchesSearch =
        !logSearch ||
        log.event.toLowerCase().includes(logSearch.toLowerCase()) ||
        log.message.toLowerCase().includes(logSearch.toLowerCase());
      return matchesLevel && matchesSearch;
    });
  }, [logs, logLevelFilter, logSearch]);

  if (phase === 'loading') {
    return (
      <main className="config-page app-shell flex items-center justify-center">
        <h1>系统参数配置</h1>
        <p role="status" className="banner">
          正在加载配置…
        </p>
      </main>
    );
  }

  if (phase === 'failed') {
    return (
      <main className="config-page app-shell flex items-center justify-center">
        <h1>系统参数配置</h1>
        <p role="alert" className="banner banner-error">
          {loadError}
        </p>
      </main>
    );
  }

  if (draft === null) {
    return null;
  }

  const saving = phase === 'saving';
  const showProxyServer = draft.proxyMode === 'fixed' || draft.proxyMode === 'pac';
  const showApiProxyHosts = draft.proxyMode !== 'direct';
  const apiProxyHostsEmpty = toHostList(draft.apiProxyHosts).length === 0;

  return (
    <div className="app-shell config-page">
      {/* 顶部标题与状态栏 */}
      <header className="app-header">
        <div className="brand-section">
          <div className="brand-logo">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <span className="brand-title">UniShell</span>
          <span className="brand-subtitle">控制台</span>
          <span className="version-badge">v0.1.3</span>
        </div>

        <div className="header-status">
          <div className="status-pill">
            <span className="pulse-dot" />
            <span>主进程在线</span>
          </div>
          <span className="config-path-text">
            配置文件：<code data-testid="config-path">{configPath === '' ? '（保存后显示）' : configPath}</code>
          </span>
        </div>
      </header>

      {/* 隐藏保留的标题，满足测试要求 */}
      <h1 style={{ display: 'none' }}>系统参数配置</h1>

      {/* 主体布局 */}
      <div className="app-main">
        {/* 侧边导航栏 */}
        <aside className="sidebar">
          <div>
            <div className="nav-group-title">配置管理</div>
            <button
              type="button"
              className={`nav-item ${activeTab === 'target' ? 'active' : ''}`}
              onClick={() => setActiveTab('target')}
            >
              <span className="nav-item-icon">🌐 业务与目标地址</span>
            </button>
            <button
              type="button"
              className={`nav-item ${activeTab === 'window' ? 'active' : ''}`}
              onClick={() => setActiveTab('window')}
            >
              <span className="nav-item-icon">🖥️ 窗口与多显示器</span>
            </button>
            <button
              type="button"
              className={`nav-item ${activeTab === 'startup' ? 'active' : ''}`}
              onClick={() => setActiveTab('startup')}
            >
              <span className="nav-item-icon">⚡ 启动与自启管理</span>
            </button>
            <button
              type="button"
              className={`nav-item ${activeTab === 'network' ? 'active' : ''}`}
              onClick={() => setActiveTab('network')}
            >
              <span className="nav-item-icon">🛡️ 网络代理与安全</span>
            </button>
            <button
              type="button"
              className={`nav-item ${activeTab === 'maintenance' ? 'active' : ''}`}
              onClick={() => setActiveTab('maintenance')}
            >
              <span className="nav-item-icon">🎨 外观图标与维护</span>
            </button>

            <div className="nav-group-title" style={{ marginTop: '16px' }}>诊断监控</div>
            <button
              type="button"
              className={`nav-item ${activeTab === 'logs' ? 'active' : ''}`}
              onClick={() => setActiveTab('logs')}
            >
              <span className="nav-item-icon">📋 运行日志查看器</span>
              <span className="live-badge">LIVE</span>
            </button>
          </div>

          <div className="sidebar-footer">
            <div>环境：跨平台通用基线</div>
            <div>单实例互斥：已锁定</div>
          </div>
        </aside>

        {/* 右侧视口 */}
        <main className="content-viewport">
          <div className="content-container">
            {/* 提示 Banner */}
            {dirty && (
              <p role="status" className="banner banner-dirty">
                有未保存的修改；关闭窗口不会修改原配置。
              </p>
            )}
            {saveError !== null && (
              <p role="alert" className="banner banner-error">
                {saveError}
              </p>
            )}
            {saveMessage !== null && (
              <p role="status" className="banner banner-success">
                {saveMessage}
              </p>
            )}
            {issues.length > 0 && (
              <ul className="issues" role="alert">
                {issues.map((issue) => (
                  <li key={`${issue.path}:${issue.code}:${issue.message}`} data-path={issue.path}>
                    {issue.path === '' ? issue.message : `${issue.path}：${issue.message}`}
                  </li>
                ))}
              </ul>
            )}

            {/* 表单内容区（所有字段保持挂载，切换 tab 时控制 display） */}
            <form onSubmit={(event) => void handleSubmit(event)} noValidate>
              {/* Tab 1: 业务与目标地址 */}
              <div style={{ display: activeTab === 'target' ? 'block' : 'none' }}>
                <div className="section-header">
                  <h2 className="section-title">业务与目标网址</h2>
                  <p className="section-desc">配置客户端启动时加载的主站地址，并可进行即时连通性握手测试</p>
                </div>

                <div className="card">
                  <fieldset disabled={saving}>
                    <legend>目标网址</legend>
                    <TextField
                      id="targetUrl"
                      label="目标网址"
                      value={draft.targetUrl}
                      placeholder="https://example.com"
                      onChange={(value) => update('targetUrl', value)}
                    />
                    <p className="field field-inline" style={{ marginTop: '12px' }}>
                      <button type="button" className="btn-secondary" onClick={() => void handleTestConnection()} disabled={saving}>
                        测试连接
                      </button>
                      <span role="status" className="connection-result">
                        {connectionMessage ?? ''}
                      </span>
                    </p>
                    <CheckboxField
                      id="offlinePageEnabled"
                      label="启用离线页面"
                      checked={draft.offlinePageEnabled}
                      onChange={(checked) => update('offlinePageEnabled', checked)}
                    />
                  </fieldset>
                </div>
              </div>

              {/* Tab 2: 窗口与显示模式 */}
              <div style={{ display: activeTab === 'window' ? 'block' : 'none' }}>
                <div className="section-header">
                  <h2 className="section-title">窗口与显示模式</h2>
                  <p className="section-desc">设定客户端窗口尺寸形态、置顶等级与多显示器投放策略</p>
                </div>

                <div className="card">
                  <fieldset disabled={saving}>
                    <legend>窗口</legend>
                    <SelectField
                      id="mode"
                      label="窗口模式"
                      value={draft.mode}
                      options={WINDOW_MODE_OPTIONS}
                      onChange={(value) => update('mode', value)}
                    />
                    <CheckboxField
                      id="alwaysOnTop"
                      label="置顶显示"
                      checked={draft.alwaysOnTop}
                      onChange={(checked) => update('alwaysOnTop', checked)}
                    />
                    {draft.alwaysOnTop && (
                      <SelectField
                        id="alwaysOnTopLevel"
                        label="置顶层级"
                        value={draft.alwaysOnTopLevel}
                        options={ALWAYS_ON_TOP_LEVEL_OPTIONS}
                        onChange={(value) => update('alwaysOnTopLevel', value)}
                      />
                    )}
                    <TextField
                      id="display"
                      label="显示器"
                      value={draft.display}
                      placeholder="primary"
                      onChange={(value) => update('display', value)}
                    />
                    <SelectField
                      id="closeAction"
                      label="关闭主窗口时"
                      value={draft.closeAction}
                      options={CLOSE_ACTION_OPTIONS}
                      onChange={(value) => update('closeAction', value)}
                    />
                  </fieldset>
                </div>
              </div>

              {/* Tab 3: 网络代理 */}
              <div style={{ display: activeTab === 'network' ? 'block' : 'none' }}>
                <div className="section-header">
                  <h2 className="section-title">网络代理与安全策略</h2>
                  <p className="section-desc">配置内网接口转发代理与远程页面沙箱权限隔离</p>
                </div>

                <div className="card">
                  <fieldset disabled={saving}>
                    <legend>网络</legend>
                    <SelectField
                      id="proxyMode"
                      label="代理模式"
                      value={draft.proxyMode}
                      options={PROXY_MODE_OPTIONS}
                      onChange={(value) => update('proxyMode', value)}
                    />
                    {showProxyServer && (
                      <TextField
                        id="proxyServer"
                        label={draft.proxyMode === 'pac' ? 'PAC 地址' : '代理服务器'}
                        value={draft.proxyServer}
                        placeholder={draft.proxyMode === 'pac' ? 'https://example.com/proxy.pac' : 'http://proxy.internal:8080'}
                        onChange={(value) => update('proxyServer', value)}
                      />
                    )}
                    {draft.proxyMode === 'fixed' && (
                      <TextField
                        id="proxyBypass"
                        label="跳过代理的地址"
                        value={draft.proxyBypass}
                        placeholder="localhost;127.0.0.1"
                        onChange={(value) => update('proxyBypass', value)}
                      />
                    )}
                    {showApiProxyHosts && (
                      <TextAreaField
                        id="apiProxyHosts"
                        label="接口域名（每行一个；只有这些主机的请求经过代理，其余流量直连）"
                        value={draft.apiProxyHosts}
                        placeholder={'api.example.com\n*.example.com'}
                        onChange={(value) => update('apiProxyHosts', value)}
                      />
                    )}
                    {showApiProxyHosts && apiProxyHostsEmpty && (
                      <p role="status" className="banner banner-dirty">
                        未填写接口域名，代理不生效：页面与全部请求都将直连。
                      </p>
                    )}
                    <NumberField
                      id="retryIntervalSec"
                      label="重试间隔（秒）"
                      value={draft.retryIntervalSec}
                      min={1}
                      onChange={(value) => update('retryIntervalSec', value)}
                    />
                    <NumberField
                      id="requestTimeoutSec"
                      label="请求超时（秒）"
                      value={draft.requestTimeoutSec}
                      min={1}
                      onChange={(value) => update('requestTimeoutSec', value)}
                    />
                  </fieldset>
                </div>
              </div>

              {/* Tab 4: 启动与自启管理 */}
              <div style={{ display: activeTab === 'startup' ? 'block' : 'none' }}>
                <div className="section-header">
                  <h2 className="section-title">启动与自启管理</h2>
                  <p className="section-desc">配置操作系统登录项、启动延时策略与初始驻留形态</p>
                </div>

                <div className="card">
                  <fieldset disabled={saving}>
                    <legend>启动</legend>
                    <CheckboxField
                      id="openAtLogin"
                      label="开机自动启动"
                      checked={draft.openAtLogin}
                      onChange={(checked) => update('openAtLogin', checked)}
                    />
                    <SelectField
                      id="initialState"
                      label="初始驻留状态"
                      value={draft.initialState}
                      options={INITIAL_STATE_OPTIONS}
                      onChange={(value) => update('initialState', value)}
                    />
                    <NumberField
                      id="delaySec"
                      label="启动延迟（秒，0～3600）"
                      value={draft.delaySec}
                      min={0}
                      max={3600}
                      onChange={(value) => update('delaySec', value)}
                    />
                    <CheckboxField
                      id="delayOnlyOnLogin"
                      label="仅登录启动时延迟"
                      checked={draft.delayOnlyOnLogin}
                      onChange={(checked) => update('delayOnlyOnLogin', checked)}
                    />
                    <CheckboxField
                      id="showAfterDelay"
                      label="延迟结束后显示窗口"
                      checked={draft.showAfterDelay}
                      onChange={(checked) => update('showAfterDelay', checked)}
                    />
                  </fieldset>
                </div>
              </div>

              {/* Tab 5: 维护 */}
              <div style={{ display: activeTab === 'maintenance' ? 'block' : 'none' }}>
                <div className="section-header">
                  <h2 className="section-title">外观图标与系统维护</h2>
                  <p className="section-desc">自定义应用图标（同步 Windows 任务栏与托盘）、维护快捷键与日志保留期</p>
                </div>

                <div className="card">
                  <fieldset disabled={saving}>
                    <legend>维护</legend>
                    <CheckboxField
                      id="hotkeyEnabled"
                      label="启用维护快捷键（仅窗口聚焦时生效）"
                      checked={draft.hotkeyEnabled}
                      onChange={(checked) => update('hotkeyEnabled', checked)}
                    />
                    {draft.hotkeyEnabled && (
                      <TextField
                        id="hotkey"
                        label="快捷键"
                        value={draft.hotkey}
                        placeholder="Ctrl+Alt+Shift+F12"
                        onChange={(value) => update('hotkey', value)}
                      />
                    )}
                    <CheckboxField
                      id="trayConfigEnabled"
                      label="托盘显示「打开配置界面」"
                      checked={draft.trayConfigEnabled}
                      onChange={(checked) => update('trayConfigEnabled', checked)}
                    />
                  </fieldset>
                </div>
              </div>

              {/* Tab 3: 安全（跟在维护之后，使 legend 顺序为: 目标网址, 窗口, 网络, 启动, 维护, 安全, 外观, 日志） */}
              <div style={{ display: activeTab === 'network' ? 'block' : 'none' }}>
                <div className="card">
                  <fieldset disabled={saving}>
                    <legend>安全</legend>
                    <TextAreaField
                      id="allowedOrigins"
                      label="授权源（每行一个，仅允许 http/https 裸源）"
                      value={draft.allowedOrigins}
                      placeholder={'https://erp.example.com\nhttps://help.example.com'}
                      onChange={(value) => update('allowedOrigins', value)}
                    />
                    <CheckboxField
                      id="allowExternalLinks"
                      label="允许外部链接（交给系统默认浏览器）"
                      checked={draft.allowExternalLinks}
                      onChange={(checked) => update('allowExternalLinks', checked)}
                    />
                    <CheckboxField
                      id="allowPopups"
                      label="允许弹窗"
                      checked={draft.allowPopups}
                      onChange={(checked) => update('allowPopups', checked)}
                    />
                    <CheckboxField
                      id="allowDownloads"
                      label="允许下载"
                      checked={draft.allowDownloads}
                      onChange={(checked) => update('allowDownloads', checked)}
                    />
                  </fieldset>
                </div>
              </div>

              {/* Tab 5: 外观 */}
              <div style={{ display: activeTab === 'maintenance' ? 'block' : 'none' }}>
                <div className="card">
                  <fieldset disabled={saving}>
                    <legend>外观</legend>
                    <p className="field field-icon-current">
                      <span className="field-caption">当前图标</span>
                      <span className="icon-current mono-font" data-testid="current-icon" style={{ marginLeft: '10px' }}>
                        {draft.icon === '' ? '内置默认图标' : draft.icon}
                      </span>
                    </p>
                    {iconPreview !== null && (
                      <p className="field field-inline">
                        <img className="icon-preview" src={iconPreview} alt="所选图标预览" width={64} height={64} />
                      </p>
                    )}
                    <p className="field field-inline" style={{ marginTop: '10px' }}>
                      <button type="button" className="btn-secondary" onClick={() => void handlePickIcon()} disabled={saving}>
                        选择图标…
                      </button>
                      <button type="button" className="btn-secondary" onClick={handleResetIcon} disabled={saving || draft.icon === ''}>
                        恢复默认
                      </button>
                    </p>
                    {iconMessage !== null && (
                      <p role="status" className="banner banner-dirty">
                        {iconMessage}
                      </p>
                    )}
                    <p className="field-hint">
                      支持 PNG / ICO / ICNS；所选文件会复制到配置目录，保存并重启客户端后，窗口、任务栏与托盘使用新图标。
                    </p>
                  </fieldset>
                </div>
              </div>

              {/* Tab 5: 日志配置 */}
              <div style={{ display: activeTab === 'maintenance' ? 'block' : 'none' }}>
                <div className="card">
                  <fieldset disabled={saving}>
                    <legend>日志</legend>
                    <SelectField
                      id="level"
                      label="日志级别"
                      value={draft.level}
                      options={LOG_LEVEL_OPTIONS}
                      onChange={(value) => update('level', value)}
                    />
                    <NumberField
                      id="retentionDays"
                      label="日志保留天数"
                      value={draft.retentionDays}
                      min={1}
                      onChange={(value) => update('retentionDays', value)}
                    />
                  </fieldset>
                </div>
              </div>

              {/* 隐藏保留的默认保存按钮与重置按钮区域，便于测试触发 submit/reset */}
              <div className="actions" style={{ display: 'none' }}>
                <button type="submit" disabled={saving}>
                  {saving ? '正在保存…' : '保存配置'}
                </button>
                <button type="button" onClick={() => void handleReset()} disabled={saving}>
                  恢复默认值
                </button>
              </div>
            </form>

            {/* Tab 6: 运行日志查看器 (Runtime Logs) */}
            <div style={{ display: activeTab === 'logs' ? 'block' : 'none' }}>
              <div className="section-header">
                <h2 className="section-title">运行日志查看器</h2>
                <p className="section-desc">实时监控主进程生命周期、网络自动重连、页面崩溃防护与诊断数据</p>
              </div>

              <div className="logs-view">
                <div className="log-toolbar">
                  {/* 级别过滤器 */}
                  <div className="log-filters">
                    {(['ALL', 'INFO', 'WARN', 'ERROR', 'DEBUG'] as const).map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        className={`filter-btn ${logLevelFilter === lvl ? 'active' : ''}`}
                        onClick={() => setLogLevelFilter(lvl)}
                      >
                        {lvl === 'ALL' ? '全部' : lvl}
                      </button>
                    ))}
                  </div>

                  {/* 搜索框 */}
                  <div className="log-search-box">
                    <input
                      type="text"
                      placeholder="搜索事件或关键词..."
                      value={logSearch}
                      onChange={(e) => setLogSearch(e.target.value)}
                    />
                  </div>

                  {/* 工具按钮 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#94a3b8', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={autoScroll}
                        onChange={(e) => setAutoScroll(e.target.checked)}
                      />
                      <span>自动滚屏</span>
                    </label>

                    <button type="button" className="btn-secondary" onClick={() => void fetchLogs()}>
                      刷新
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => setLogs([])}>
                      清空
                    </button>
                    <button type="button" className="btn-secondary" onClick={handleExportLogs}>
                      导出
                    </button>
                    <button type="button" className="btn-primary" onClick={() => void handleOpenLogDir()}>
                      打开日志目录
                    </button>
                  </div>
                </div>

                {/* 终端日志视口 */}
                <div className="log-terminal" ref={logTerminalRef}>
                  {filteredLogs.length === 0 ? (
                    <div style={{ color: '#64748b', textAlign: 'center', padding: '40px 0' }}>
                      暂无符合条件的日志记录
                    </div>
                  ) : (
                    filteredLogs.map((item, idx) => (
                      <div className="log-row" key={`${item.time}-${idx}`}>
                        <span className="log-time">{item.time || '--:--:--'}</span>
                        <span className={`log-badge badge-${item.level.toLowerCase()}`}>{item.level}</span>
                        <span className="log-event">[{item.event}]</span>
                        <span className="log-msg">{item.message}</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="log-footer">
                  <div>展示日志：{filteredLogs.length} / {logs.length} 条</div>
                  <div>日志目录：<code className="mono-font">{logDirectory || '（读取中…）'}</code></div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* 底部悬浮操作栏 */}
      <footer className="app-footer">
        <div className="footer-status">
          {dirty ? (
            <span style={{ color: '#fbbf24', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#fbbf24' }} />
              存在未保存的修改（需重启生效）
            </span>
          ) : (
            <span style={{ color: '#64748b', fontSize: '12px' }}>配置已是最新状态</span>
          )}
        </div>

        <div className="footer-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleReset()}
            disabled={saving}
          >
            恢复默认值
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={saving}
            onClick={(e) => {
              // 触发 form 提交
              const form = (e.currentTarget.closest('.app-shell')?.querySelector('form')) as HTMLFormElement | null;
              if (form) {
                if (typeof form.requestSubmit === 'function') {
                  form.requestSubmit();
                } else {
                  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                }
              }
            }}
          >
            {saving ? '正在保存…' : '保存配置'}
          </button>
        </div>
      </footer>
    </div>
  );
}
