import type { AppConfig } from './config-schema';

export type ConfigApplyLevel = 'hot' | 'reload' | 'restart';

export interface ConfigChangeClassification {
  level: ConfigApplyLevel;
  changedPaths: string[];
}

const RESTART_PATHS = new Set(['appearance.icon', 'logging.retentionDays']);

function flatten(value: unknown, prefix = '', result: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, result);
  } else {
    result.set(prefix, Array.isArray(value) ? JSON.stringify(value) : value);
  }
  return result;
}

function levelForPath(path: string): ConfigApplyLevel {
  if (RESTART_PATHS.has(path) || path.startsWith('startup.') && path !== 'startup.openAtLogin' || path === 'schemaVersion') {
    return 'restart';
  }
  if (path === 'targetUrl') return 'reload';
  return 'hot';
}

export function classifyConfigChange(prev: AppConfig | undefined, next: AppConfig): ConfigChangeClassification {
  if (prev === undefined) return { level: 'restart', changedPaths: [...flatten(next).keys()] };

  const before = flatten(prev);
  const after = flatten(next);
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => !Object.is(before.get(path), after.get(path)))
    .sort();
  const rank: Record<ConfigApplyLevel, number> = { hot: 0, reload: 1, restart: 2 };
  const level = changedPaths.reduce<ConfigApplyLevel>(
    (current, path) => rank[levelForPath(path)] > rank[current] ? levelForPath(path) : current,
    'hot',
  );
  return { level, changedPaths };
}
