/**
 * 配置 schema、默认值与迁移。
 *
 * 规则来源：规格 v2.1 §5.3（读取与校验）与 §6（配置结构）。
 * 该模块是纯 TypeScript，不依赖 Electron、renderer 或具体 OS API。
 */

import { z } from 'zod';

import {
  CONFIG_SCHEMA_VERSION,
  type AppConfig,
  type AlwaysOnTopLevel,
  type InitialState,
  type LogLevel,
  type ProxyMode,
  type WindowCloseAction,
  type WindowMode,
} from './config-types';

export { CONFIG_SCHEMA_VERSION };
export type { AppConfig } from './config-types';

export interface ValidationIssue {
  /** 点号路径，根级字段为空字符串。 */
  path: string;
  message: string;
  code: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

/** 校验或迁移失败时抛出，携带可供配置界面直接展示的 issues。 */
export class ConfigValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`配置无效：${issues.map((issue) => `${issue.path || '(root)'} ${issue.message}`).join('；')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/** 解析 http/https 地址并确保包含主机名；不合法时返回 null。 */
function parseHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname.length === 0) return null;
  return url;
}

const httpUrlSchema = z.string().superRefine((value, ctx) => {
  if (parseHttpUrl(value) === null) {
    ctx.addIssue({
      code: 'custom',
      message: '必须是包含主机名的 http:// 或 https:// 地址',
    });
  }
});

/** 授权源：http/https 裸源，即 scheme://host[:port]，不带路径、查询或片段。 */
const bareOriginSchema = z.string().superRefine((value, ctx) => {
  const url = parseHttpUrl(value);
  if (url === null) {
    ctx.addIssue({ code: 'custom', message: '授权源必须是包含主机名的 http:// 或 https:// 地址' });
    return;
  }
  if (url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) {
    ctx.addIssue({ code: 'custom', message: '授权源必须是裸源（scheme://host[:port]），不能带路径、查询或片段' });
  }
});

const positiveIntSchema = z.int().min(1, '必须是大于 0 的整数');

/** 去除首尾空白后仍须非空，避免空白字符串被当成有效值。 */
const nonEmptyStringSchema = z.string().trim().min(1, '不能为空');

/** 接口域名数量上限，避免误粘贴超大列表导致 PAC 策略膨胀。 */
const MAX_API_PROXY_HOSTS = 100;

const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

function isDomainName(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return value.split('.').every((label) => label.length > 0 && label.length <= 63 && HOST_LABEL_PATTERN.test(label));
}

function isIpv4Literal(value: string): boolean {
  if (!IPV4_PATTERN.test(value)) return false;
  return value.split('.').every((part) => Number.parseInt(part, 10) <= 255);
}

/** 归一化：去空白、小写；`.example.com` 前导点形式统一为 `*.example.com` 子域通配。 */
function normalizeApiProxyHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('.') ? `*${trimmed}` : trimmed;
}

/**
 * 接口域名校验（规格 §7）：主机名、IPv4 或 `*.domain` 子域通配；
 * 拒绝协议、端口、路径、凭据、空标签等写法——PAC 策略只按主机名匹配。
 */
function isValidApiProxyHost(value: string): boolean {
  if (value.startsWith('*.')) return isDomainName(value.slice(2));
  return isDomainName(value) || isIpv4Literal(value);
}

/**
 * 配置目录中的图标文件名（规格 §5.4）：裸文件名，仅 PNG/ICO/ICNS。
 * 允许用户自命名文件，但必须是安全裸名，杜绝路径穿越与绝对路径。
 */
const ICON_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|ico|icns)$/;

export function isIconFileName(value: string): boolean {
  if (value.length === 0 || value.length > 100) return false;
  if (value.includes('..')) return false;
  return ICON_FILE_NAME_PATTERN.test(value);
}

/** fixed 模式支持的代理协议（PAC 可表达的类型；quic 无 PAC 对应关键字，不再支持）。 */
const PROXY_ENDPOINT_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks5:']);

/**
 * 校验 fixed 模式的单个代理服务器地址（规格 §7）。
 * 合法返回 null，否则返回可直接展示的错误信息；
 * 拒绝按协议路由（`http=a;https=b`）与多级回退（`a,b`）——接口代理只需要一个代理。
 */
export function validateProxyEndpointValue(value: string): string | null {
  const endpoint = value.trim();
  if (endpoint === '') return 'fixed 代理模式必须填写 proxyServer';
  if (/[=;,]/.test(endpoint)) {
    return 'proxyServer 只支持单个代理服务器地址（如 http://proxy.internal:8080），不支持按协议路由或多级回退';
  }

  const candidate = endpoint.includes('://') ? endpoint : `http://${endpoint}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return 'proxyServer 必须是有效的代理服务器地址';
  }
  if (!PROXY_ENDPOINT_PROTOCOLS.has(url.protocol)) {
    return 'proxyServer 使用了不支持的协议（支持 http/https/socks4/socks5）';
  }
  if (!url.hostname || url.username || url.password) {
    return 'proxyServer 必须包含主机名且不能包含代理凭据';
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    return 'proxyServer 代理地址不能包含路径、查询参数或片段';
  }
  return null;
}

const apiProxyHostsSchema = z
  .array(z.string())
  .transform((entries) => {
    const normalized: string[] = [];
    for (const entry of entries) {
      const value = normalizeApiProxyHost(entry);
      if (!normalized.includes(value)) normalized.push(value);
    }
    return normalized;
  })
  .superRefine((hosts, ctx) => {
    if (hosts.length > MAX_API_PROXY_HOSTS) {
      ctx.addIssue({
        code: 'custom',
        message: `接口域名最多 ${MAX_API_PROXY_HOSTS} 个`,
      });
      return;
    }
    for (const host of hosts) {
      if (!isValidApiProxyHost(host)) {
        ctx.addIssue({
          code: 'custom',
          message: `接口域名格式不正确：${host === '' ? '(空)' : host}（应为 api.example.com 或 *.example.com，不带协议、端口和路径）`,
        });
      }
    }
  });

const iconFileNameSchema = z.string().superRefine((value, ctx) => {
  if (value === '') return;
  if (!isIconFileName(value)) {
    ctx.addIssue({
      code: 'custom',
      message: '图标必须是配置目录中的 PNG/ICO/ICNS 文件名（如 app-icon.png），不能带路径',
    });
  }
});

function proxyServerContainsCredentials(value: string): boolean {
  const endpoints = value.split(';').flatMap((group) => {
    const routeSeparator = group.indexOf('=');
    const urlSchemeSeparator = group.indexOf('://');
    const separator =
      routeSeparator !== -1 && (urlSchemeSeparator === -1 || routeSeparator < urlSchemeSeparator)
        ? routeSeparator
        : -1;
    return (separator === -1 ? group : group.slice(separator + 1)).split(',');
  });

  return endpoints.some((endpoint) => {
    if (endpoint === 'direct://') return false;
    const candidate = endpoint.includes('://') ? endpoint : `http://${endpoint}`;
    const authority = candidate.replace(/^[^:]+:\/\//, '').split(/[/?#]/, 1)[0];
    if (authority.includes('@')) return true;

    try {
      const url = new URL(candidate);
      return Boolean(url.username || url.password);
    } catch {
      return false;
    }
  });
}

/*
 * 嵌套配置统一使用 `.prefault({})` 而非 `.default({})`：
 * Zod 4 的 `.default()` 在输入为 undefined 时原样返回默认值，不会再过一次内部 schema，
 * 于是缺失的整段嵌套配置会得到 `{}` 而不是补齐默认字段的对象。
 * `.prefault({})` 会把默认值交给内部 schema 解析，从而真正补齐默认值。
 */
const windowSchema = z
  .object({
    mode: z.enum(['window', 'fullscreen', 'kiosk'] satisfies WindowMode[]).default('window'),
    alwaysOnTop: z.boolean().default(false),
    alwaysOnTopLevel: z
      .enum(['normal', 'floating', 'pop-up-menu', 'screen-saver'] satisfies AlwaysOnTopLevel[])
      .default('normal'),
    display: nonEmptyStringSchema.default('primary'),
    closeAction: z.enum(['hide', 'quit'] satisfies WindowCloseAction[]).default('hide'),
  })
  .prefault({});

const networkSchema = z
  .object({
    proxyMode: z.enum(['direct', 'system', 'fixed', 'pac'] satisfies ProxyMode[]).default('direct'),
    proxyServer: z.string().default(''),
    proxyBypass: z.string().default(''),
    apiProxyHosts: apiProxyHostsSchema.default([]),
    retryIntervalSec: positiveIntSchema.default(3),
    requestTimeoutSec: positiveIntSchema.default(20),
    offlinePageEnabled: z.boolean().default(true),
  })
  .prefault({})
  .superRefine((network, ctx) => {
    if (proxyServerContainsCredentials(network.proxyServer)) {
      ctx.addIssue({
        code: 'custom',
        path: ['proxyServer'],
        message: '代理账号密码不能写入 config.json',
      });
    }

    if (network.proxyMode === 'fixed' && !network.proxyServer.trim()) {
      ctx.addIssue({ code: 'custom', path: ['proxyServer'], message: 'fixed 代理模式必须填写 proxyServer' });
    }

    if (network.proxyMode === 'fixed') {
      const problem = validateProxyEndpointValue(network.proxyServer);
      if (problem !== null) {
        ctx.addIssue({ code: 'custom', path: ['proxyServer'], message: problem });
      }
    }

    if (network.proxyMode === 'pac' && parseHttpUrl(network.proxyServer) === null) {
      ctx.addIssue({ code: 'custom', path: ['proxyServer'], message: 'PAC 地址必须是包含主机名的 http:// 或 https:// 地址' });
    }
  });

const startupSchema = z
  .object({
    openAtLogin: z.boolean().default(false),
    initialState: z.enum(['tray', 'minimized'] satisfies InitialState[]).default('tray'),
    delaySec: z.int().min(0, 'delaySec 不能小于 0').max(3600, 'delaySec 不能大于 3600').default(0),
    delayOnlyOnLogin: z.boolean().default(false),
    showAfterDelay: z.boolean().default(true),
  })
  .prefault({});

const maintenanceSchema = z
  .object({
    hotkeyEnabled: z.boolean().default(true),
    hotkey: nonEmptyStringSchema.default('Ctrl+Alt+Shift+F12'),
    trayConfigEnabled: z.boolean().default(true),
  })
  .prefault({});

const securitySchema = z
  .object({
    allowedOrigins: z.array(bareOriginSchema).default([]),
    allowExternalLinks: z.boolean().default(false),
    allowPopups: z.boolean().default(false),
    allowDownloads: z.boolean().default(false),
  })
  .prefault({});

const loggingSchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error'] satisfies LogLevel[]).default('info'),
    retentionDays: positiveIntSchema.default(14),
  })
  .prefault({});

/** 外观段：自定义图标文件名；缺省使用内置默认图标（规格 §5.4）。 */
const appearanceSchema = z
  .object({
    icon: iconFileNameSchema.default(''),
  })
  .prefault({});

/**
 * 根对象使用 looseObject：未知顶层字段原样保留，便于跨版本配置往返，
 * 同时不会因为多余字段导致启动失败（规格 §5.3）。
 * 嵌套对象使用默认的 strip 语义，避免未知嵌套字段渗入类型化结构。
 */
export const appConfigSchema = z.looseObject({
  schemaVersion: z.int().min(1).max(CONFIG_SCHEMA_VERSION),
  targetUrl: httpUrlSchema,
  window: windowSchema,
  network: networkSchema,
  startup: startupSchema,
  maintenance: maintenanceSchema,
  security: securitySchema,
  appearance: appearanceSchema,
  logging: loggingSchema,
});

export type AppConfigSchema = typeof appConfigSchema;

/** 由版本号到迁移函数的注册表；键为「来源版本」。 */
const migrations = new Map<number, (input: Record<string, unknown>) => Record<string, unknown>>();

/**
 * v2.1 之前的配置没有 `schemaVersion`，也没有统一的分层结构。
 * 迁移动作是由默认值补齐缺失字段，未知字段原样保留。
 */
migrations.set(0, (input) => ({ ...input }));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

type SchemaVersionInspection =
  | { ok: true; version: number | undefined }
  | { ok: false; issues: ValidationIssue[] };

/** 在交给 Zod 之前识别「配置由更新版本写入」这类需要明确提示的情况。 */
function inspectSchemaVersion(input: Record<string, unknown>): SchemaVersionInspection {
  const raw = input.schemaVersion;

  if (raw === undefined) return { ok: true, version: undefined };

  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return {
      ok: false,
      issues: [
        {
          path: 'schemaVersion',
          message: '必须是大于等于 1 的整数',
          code: 'invalid_type',
        },
      ],
    };
  }

  if (raw > CONFIG_SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        {
          path: 'schemaVersion',
          message: `配置由更新版本的客户端写入（schemaVersion=${raw}），当前支持的最高版本为 ${CONFIG_SCHEMA_VERSION}；请升级客户端或手动修正配置`,
          code: 'unsupported_version',
        },
      ],
    };
  }

  return { ok: true, version: raw };
}

/**
 * 校验未知输入。成功时返回补齐默认值后的配置；
 * 未知顶层字段被保留，未知嵌套字段被剔除。
 */
export function validateConfig(input: unknown): ValidationResult<AppConfig> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      issues: [{ path: '', message: '配置必须是 JSON 对象', code: 'invalid_type' }],
    };
  }

  const inspection = inspectSchemaVersion(input);
  if (!inspection.ok) return { ok: false, issues: inspection.issues };

  const parsed = appConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: toIssues(parsed.error) };
  }

  return { ok: true, value: parsed.data as AppConfig };
}

/**
 * 迁移未知输入到当前 schemaVersion 并补齐默认值。
 * 输入非法时抛出 `ConfigValidationError`，issues 可直接展示给用户。
 */
export function migrateConfig(input: unknown): AppConfig {
  if (!isPlainObject(input)) {
    throw new ConfigValidationError([
      { path: '', message: '配置必须是 JSON 对象', code: 'invalid_type' },
    ]);
  }

  const inspection = inspectSchemaVersion(input);
  if (!inspection.ok) throw new ConfigValidationError(inspection.issues);

  const fromVersion = inspection.version ?? 0;
  if (fromVersion > CONFIG_SCHEMA_VERSION) {
    // inspectSchemaVersion 已覆盖，此处仅作类型收敛。
    throw new ConfigValidationError([
      { path: 'schemaVersion', message: '不支持的配置版本', code: 'unsupported_version' },
    ]);
  }

  let working: Record<string, unknown> = { ...input };
  for (let version = fromVersion; version < CONFIG_SCHEMA_VERSION; version += 1) {
    const migration = migrations.get(version);
    if (!migration) {
      throw new ConfigValidationError([
        {
          path: 'schemaVersion',
          message: `缺少从 schemaVersion=${version} 到 ${version + 1} 的迁移规则`,
          code: 'missing_migration',
        },
      ]);
    }
    working = migration(working);
  }

  working.schemaVersion = CONFIG_SCHEMA_VERSION;

  const result = validateConfig(working);
  if (!result.ok) throw new ConfigValidationError(result.issues);
  return result.value;
}

/** 生成一份完整默认配置；`targetUrl` 由调用方提供。 */
export function createDefaultConfig(targetUrl: string): AppConfig {
  return migrateConfig({ targetUrl });
}
