/**
 * 配置服务：主进程配置的唯一权威所有者。
 *
 * 规则来源：`rules/architecture.md`「共享状态只有一个权威所有者；派生状态应计算，不要在多个模块重复维护」。
 *
 * 职责：
 * 1. 启动时仅读盘一次，并缓存有效配置与读取结果；
 * 2. 对外提供只读配置访问 `current()`；
 * 3. 统一原子写盘 `save(next)`，成功后同步更新缓存并通知 `onChange` 订阅者；
 * 4. 显式重新读盘 `reload()` 供配置界面重新打开时使用。
 */

import type { AppConfig } from '../../shared/config-types';
import type { ResolvedConfigPaths } from '../platform/config-paths';
import {
  loadConfig,
  saveConfig,
  type ConfigFileSystem,
  type ConfigLoadResult,
} from './config-store';

export type ConfigChangeListener = (next: AppConfig, prev: AppConfig | undefined) => void;

export interface ConfigService {
  readonly paths: ResolvedConfigPaths;
  /** 首次读盘并缓存；重复调用与并发调用均复用首次结果。 */
  load(): Promise<ConfigLoadResult>;
  /** 显式重新读盘（配置界面打开时使用）。 */
  reload(): Promise<ConfigLoadResult>;
  /** 当前权威配置；尚未加载或配置缺失/无效时返回 undefined。 */
  current(): AppConfig | undefined;
  /** 校验并原子写入配置；成功后更新缓存并通知订阅者。 */
  save(next: AppConfig): Promise<void>;
  /** 订阅配置变更；返回取消订阅函数。 */
  onChange(listener: ConfigChangeListener): () => void;
}

export interface ConfigServiceOptions {
  paths: ResolvedConfigPaths;
  fs?: ConfigFileSystem;
  now?: () => Date;
}

class DefaultConfigService implements ConfigService {
  readonly paths: ResolvedConfigPaths;
  private readonly fs?: ConfigFileSystem;
  private readonly now?: () => Date;

  private cachedResult: ConfigLoadResult | undefined;
  private cachedConfig: AppConfig | undefined;
  private inFlightLoad: Promise<ConfigLoadResult> | undefined;
  private readonly listeners = new Set<ConfigChangeListener>();

  constructor(options: ConfigServiceOptions) {
    this.paths = options.paths;
    this.fs = options.fs;
    this.now = options.now;
  }

  async load(): Promise<ConfigLoadResult> {
    if (this.cachedResult !== undefined) {
      return this.cachedResult;
    }
    if (this.inFlightLoad !== undefined) {
      return this.inFlightLoad;
    }

    this.inFlightLoad = (async () => {
      try {
        const result = await loadConfig({
          paths: this.paths,
          fs: this.fs,
          now: this.now,
        });
        this.cachedResult = result;
        this.cachedConfig = result.status === 'loaded' ? result.config : undefined;
        return result;
      } finally {
        this.inFlightLoad = undefined;
      }
    })();

    return this.inFlightLoad;
  }

  async reload(): Promise<ConfigLoadResult> {
    this.cachedResult = undefined;
    return this.load();
  }

  current(): AppConfig | undefined {
    return this.cachedConfig;
  }

  async save(next: AppConfig): Promise<void> {
    await saveConfig(next, {
      paths: this.paths,
      fs: this.fs,
      now: this.now,
    });

    const prev = this.cachedConfig;
    this.cachedConfig = next;
    this.cachedResult = {
      status: 'loaded',
      path: this.paths.configPath,
      source: this.paths.source,
      config: next,
    };

    for (const listener of this.listeners) {
      try {
        listener(next, prev);
      } catch (error) {
        // 订阅者异常不破坏 save 主流程
        console.error('[ConfigService] onChange listener threw error:', error);
      }
    }
  }

  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function createConfigService(options: ConfigServiceOptions): ConfigService {
  return new DefaultConfigService(options);
}
