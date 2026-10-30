import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import type { SaveResult } from '../../shared/ipc-contract';
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
 *
 * 设计要点：
 * - 界面不持有任何 Electron/Node 能力，全部操作经 `window.uniShell` 五个具名方法完成；
 * - 校验分两层：数值范围在本地即时反馈，权威校验（网址、代理交叉字段、授权源）
 *   一律调用 `validateConfig` 由主进程 schema 判定，避免两端规则漂移；
 * - 保存走 `saveConfig`，主进程校验落盘后才关闭陈旧窗口并重启；写入失败时原配置不变；
 * - 实际配置路径由主进程经窗口查询参数下发，保存后以 `SaveResult.configPath` 刷新。
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 主进程下发的实际配置路径（窗口加载时经查询参数注入）。 */
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

/** 非负整数字符串转为整数；无法解析时原样返回，交给主进程 schema 报 invalid_type。 */
function toInteger(raw: string): number | string {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return raw;
  return Number.parseInt(trimmed, 10);
}

/** 多行（或逗号/分号分隔）的主机列表解析为字符串数组，供接口域名与授权源复用。 */
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

/** 由草稿构造待校验配置对象；仅挑选已知字段，平台无关结构不变（规格 §6）。 */
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

/**
 * 本地即时校验：仅覆盖数值范围，其余规则（网址格式、代理交叉字段、授权源）
 * 由主进程 `validateConfig` 权威判定，避免两端规则重复与漂移。
 */
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

  // 挂载即经白名单桥读取配置；preload 缺失或读取失败都给出可操作提示。
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

  const dirty = useMemo(
    () => draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline),
    [draft, baseline],
  );

  // 规格 §5.3：存在未保存修改时阻止关闭；保存成功后基线更新，保护自动解除。
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
          // 写入失败：原配置未被修改（主进程原子写入），停留在界面继续编辑。
          setSaveError(`保存失败：${result.message ?? '未知错误'}`);
          setPhase('ready');
          return;
        }

        if (result.configPath !== undefined && result.configPath.length > 0) {
          setConfigPath(result.configPath);
        }
        setBaseline(draft);
        setSaveMessage(result.applyWarning
          ? `配置已保存，但应用失败：${result.applyWarning}`
          : result.applied === 'restart'
          ? '配置已保存，客户端即将重启…'
          : result.applied === 'reload'
            ? '配置已保存，页面正在重新加载…'
            : '配置已保存并生效。');
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
      // 只替换草稿：不写盘、不更新基线，未保存关闭保护继续生效（规格 §5.3）。
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

  // 规格 §5.4：经白名单桥打开文件选择对话框；主进程负责复制到配置目录并返回预览。
  const handlePickIcon = useCallback(async () => {
    if (bridge === undefined) return;
    setIconMessage(null);
    try {
      const result = await bridge.pickIcon();
      // 用户取消选择属正常操作，不展示错误。
      if (result.canceled) return;
      if (result.ok && result.fileName !== undefined && result.fileName !== '') {
        update('icon', result.fileName);
        setIconPreview(result.previewDataUrl ?? null);
        setIconMessage(`已选择 ${result.fileName}；保存并重启后生效。`);
        return;
      }
      setIconMessage(`图标选择失败：${result.message ?? '未知错误'}`);
    } catch (error) {
      setIconMessage(`图标选择失败：${describeError(error)}`);
    }
  }, [bridge, update]);

  const handleResetIcon = useCallback(() => {
    update('icon', '');
    setIconPreview(null);
    setIconMessage('已恢复内置默认图标；保存并重启后生效。');
  }, [update]);

  if (phase === 'loading') {
    return (
      <main className="config-page">
        <h1>系统参数配置</h1>
        <p role="status" className="banner">
          正在加载配置…
        </p>
      </main>
    );
  }

  if (phase === 'failed') {
    return (
      <main className="config-page">
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
    <main className="config-page">
      <h1>系统参数配置</h1>

      <p className="config-path">
        配置文件路径：<code data-testid="config-path">{configPath === '' ? '（保存后显示）' : configPath}</code>
      </p>
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

      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <fieldset disabled={saving}>
          <legend>目标网址</legend>
          <TextField
            id="targetUrl"
            label="目标网址"
            value={draft.targetUrl}
            placeholder="https://example.com"
            onChange={(value) => update('targetUrl', value)}
          />
          <p className="field field-inline">
            <button type="button" onClick={() => void handleTestConnection()} disabled={saving}>
              测试连接
            </button>
            <span role="status" className="connection-result">
              {connectionMessage ?? ''}
            </span>
          </p>
        </fieldset>

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
          <CheckboxField
            id="offlinePageEnabled"
            label="启用离线页面"
            checked={draft.offlinePageEnabled}
            onChange={(checked) => update('offlinePageEnabled', checked)}
          />
        </fieldset>

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

        <fieldset disabled={saving}>
          <legend>外观</legend>
          <p className="field field-icon-current">
            <span className="field-caption">当前图标</span>
            <span className="icon-current" data-testid="current-icon">
              {draft.icon === '' ? '内置默认图标' : draft.icon}
            </span>
          </p>
          {iconPreview !== null && (
            <p className="field field-inline">
              <img className="icon-preview" src={iconPreview} alt="所选图标预览" width={64} height={64} />
            </p>
          )}
          <p className="field field-inline">
            <button type="button" onClick={() => void handlePickIcon()} disabled={saving}>
              选择图标…
            </button>
            <button type="button" onClick={handleResetIcon} disabled={saving || draft.icon === ''}>
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

        <div className="actions">
          <button type="submit" disabled={saving}>
            {saving ? '正在保存…' : '保存配置'}
          </button>
          <button type="button" onClick={() => void handleReset()} disabled={saving}>
            恢复默认值
          </button>
        </div>
      </form>
    </main>
  );
}
