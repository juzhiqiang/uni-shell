import { describe, expect, it, vi } from 'vitest';

import { createDefaultConfig } from '../../../src/main/config/config-schema';
import { createConfigService } from '../../../src/main/config/config-service';
import type { ConfigFileSystem } from '../../../src/main/config/config-store';
import type { ResolvedConfigPaths } from '../../../src/main/platform/config-paths';
import type { AppConfig } from '../../../src/shared/config-types';

function createMemoryFs(initialFiles: Record<string, string> = {}): {
  fs: ConfigFileSystem;
  files: Map<string, string>;
  readCounts: Map<string, number>;
} {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const readCounts = new Map<string, number>();

  const fs: ConfigFileSystem = {
    readFile: vi.fn(async (path: string) => {
      readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    }),
    writeFile: vi.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(from);
      files.set(to, content);
    }),
    mkdir: vi.fn(async () => {}),
    access: vi.fn(async (path: string) => {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    }),
    unlink: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  };

  return { fs, files, readCounts };
}

const PATHS: ResolvedConfigPaths = {
  configPath: '/app/config/config.json',
  directory: '/app/config',
  writePath: '/app/config/config.json',
  writeDirectory: '/app/config',
  backupPath: '/app/config/config.json.bak',
  source: 'portable',
  writeSource: 'portable',
};

describe('ConfigService', () => {
  it('load 只读盘一次，重复调用与并发调用均复用缓存', async () => {
    const validConfig = createDefaultConfig('https://example.com');
    const { fs, readCounts } = createMemoryFs({
      [PATHS.configPath]: JSON.stringify(validConfig),
    });

    const service = createConfigService({ paths: PATHS, fs });

    expect(service.current()).toBeUndefined();
    expect(service.paths).toEqual(PATHS);

    // 并发调用 load
    const [res1, res2] = await Promise.all([service.load(), service.load()]);
    expect(res1.status).toBe('loaded');
    expect(res2.status).toBe('loaded');
    expect(res1.config).toEqual(validConfig);
    expect(service.current()).toEqual(validConfig);
    expect(readCounts.get(PATHS.configPath)).toBe(1);

    // 再次调用 load，依然不读盘
    const res3 = await service.load();
    expect(res3.status).toBe('loaded');
    expect(readCounts.get(PATHS.configPath)).toBe(1);
  });

  it('配置缺失或无效时 current 返回 undefined', async () => {
    const { fs } = createMemoryFs(); // 空目录
    const service = createConfigService({ paths: PATHS, fs });

    const result = await service.load();
    expect(result.status).toBe('missing');
    expect(service.current()).toBeUndefined();
  });

  it('reload 显式重新读盘并更新缓存', async () => {
    const initialConfig = createDefaultConfig('https://initial.com');
    const updatedConfig = createDefaultConfig('https://updated.com');
    const { fs, files, readCounts } = createMemoryFs({
      [PATHS.configPath]: JSON.stringify(initialConfig),
    });

    const service = createConfigService({ paths: PATHS, fs });
    await service.load();
    expect(service.current()?.targetUrl).toBe('https://initial.com');
    expect(readCounts.get(PATHS.configPath)).toBe(1);

    // 模拟磁盘文件在外部被更改
    files.set(PATHS.configPath, JSON.stringify(updatedConfig));

    const reloaded = await service.reload();
    expect(reloaded.status).toBe('loaded');
    expect(service.current()?.targetUrl).toBe('https://updated.com');
    expect(readCounts.get(PATHS.configPath)).toBe(2);
  });

  it('save 成功后更新 current() 并通知订阅者', async () => {
    const initialConfig = createDefaultConfig('https://initial.com');
    const nextConfig = createDefaultConfig('https://next.com');
    const { fs } = createMemoryFs({
      [PATHS.configPath]: JSON.stringify(initialConfig),
    });

    const service = createConfigService({ paths: PATHS, fs });
    await service.load();

    const onChangeSpy = vi.fn();
    const unsubscribe = service.onChange(onChangeSpy);

    await service.save(nextConfig);

    expect(service.current()).toEqual(nextConfig);
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
    expect(onChangeSpy).toHaveBeenCalledWith(nextConfig, initialConfig);

    // 取消订阅生效
    unsubscribe();
    const thirdConfig = createDefaultConfig('https://third.com');
    await service.save(thirdConfig);
    expect(service.current()).toEqual(thirdConfig);
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
  });

  it('save 校验失败或写入失败时缓存不变且不通知订阅者', async () => {
    const initialConfig = createDefaultConfig('https://initial.com');
    const { fs } = createMemoryFs({
      [PATHS.configPath]: JSON.stringify(initialConfig),
    });

    const service = createConfigService({ paths: PATHS, fs });
    await service.load();

    const onChangeSpy = vi.fn();
    service.onChange(onChangeSpy);

    // 无效配置（targetUrl 非法）
    const invalidConfig = { ...initialConfig, targetUrl: 'invalid-not-a-url' } as unknown as AppConfig;
    await expect(service.save(invalidConfig)).rejects.toThrow();

    expect(service.current()).toEqual(initialConfig);
    expect(onChangeSpy).not.toHaveBeenCalled();

    // 模拟写盘报错
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const nextConfig = createDefaultConfig('https://next.com');
    await expect(service.save(nextConfig)).rejects.toThrow();

    expect(service.current()).toEqual(initialConfig);
    expect(onChangeSpy).not.toHaveBeenCalled();
  });
});
