import { describe, expect, it } from 'vitest';
import { readRecentLogs } from '../../../src/main/logging/log-reader';

describe('readRecentLogs', () => {
  const directory = '/logs/uni-shell';

  it('按时间正序解析日志，并提取 level、event 和 message', async () => {
    const mockFiles: Record<string, string> = {
      '/logs/uni-shell/uni-shell-2026-10-30.log': [
        JSON.stringify({ time: '2026-10-30T10:00:00.000Z', level: 'info', event: 'startup', data: { message: '客户端启动完成' } }),
        JSON.stringify({ time: '2026-10-30T10:05:00.000Z', level: 'warn', event: 'network-offline', data: '网络连接断开' }),
        JSON.stringify({ time: '2026-10-30T10:06:00.000Z', level: 'error', event: 'proxy-failed', data: { reason: '连接拒绝' } }),
      ].join('\n'),
    };

    const result = await readRecentLogs({
      directory,
      readdirFn: async () => ['uni-shell-2026-10-30.log', 'other.txt'],
      readFileFn: async (path) => mockFiles[path] ?? '',
    });

    expect(result.directory).toBe(directory);
    expect(result.entries.length).toBe(3);
    expect(result.entries[0]).toMatchObject({
      level: 'INFO',
      event: 'startup',
      message: '客户端启动完成',
    });
    expect(result.entries[1]).toMatchObject({
      level: 'WARN',
      event: 'network-offline',
      message: '网络连接断开',
    });
    expect(result.entries[2]).toMatchObject({
      level: 'ERROR',
      event: 'proxy-failed',
      message: JSON.stringify({ reason: '连接拒绝' }),
    });
  });

  it('支持按 level 过滤日志条目', async () => {
    const mockFiles: Record<string, string> = {
      '/logs/uni-shell/uni-shell-2026-10-30.log': [
        JSON.stringify({ time: '2026-10-30T10:00:00.000Z', level: 'info', event: 'step1' }),
        JSON.stringify({ time: '2026-10-30T10:05:00.000Z', level: 'error', event: 'crash' }),
      ].join('\n'),
    };

    const result = await readRecentLogs({
      directory,
      level: 'ERROR',
      readdirFn: async () => ['uni-shell-2026-10-30.log'],
      readFileFn: async (path) => mockFiles[path] ?? '',
    });

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].level).toBe('ERROR');
    expect(result.entries[0].event).toBe('crash');
  });

  it('目录不可读或空目录时不抛异常返回空数组', async () => {
    const result = await readRecentLogs({
      directory,
      readdirFn: async () => {
        throw new Error('EACCES');
      },
    });

    expect(result.entries).toEqual([]);
    expect(result.directory).toBe(directory);
  });
});
