import { readFile, readdir } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { FormattedLogEntry, LogQueryResult } from '../../shared/ipc-contract';

export interface ReadRecentLogsOptions {
  directory: string;
  limit?: number;
  level?: string;
  readFileFn?: (path: string) => Promise<string>;
  readdirFn?: (path: string) => Promise<string[]>;
}

/**
 * 读取最近的结构化运行日志，供配置界面「运行日志查看器」展示。
 * 纯逻辑函数，文件系统可注入，便于单元测试。
 */
export async function readRecentLogs(options: ReadRecentLogsOptions): Promise<LogQueryResult> {
  const { directory, limit = 200, level } = options;
  const pathApi = directory.startsWith('/') ? posix : win32;
  const readFileFn = options.readFileFn ?? ((p) => readFile(p, 'utf8'));
  const readdirFn = options.readdirFn ?? ((p) => readdir(p));

  let files: string[] = [];
  try {
    const entries = await readdirFn(directory);
    files = entries
      .filter((name) => name.endsWith('.log'))
      .sort()
      .reverse(); // 从最新的自然日日志文件开始读取
  } catch {
    return { entries: [], directory };
  }

  const entries: FormattedLogEntry[] = [];
  for (const file of files) {
    if (entries.length >= limit) break;
    const filePath = pathApi.join(directory, file);
    try {
      const content = await readFileFn(filePath);
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      // 单文件内部逆序遍历（最新的日志在最末尾）
      for (let i = lines.length - 1; i >= 0; i--) {
        if (entries.length >= limit) break;
        try {
          const parsed = JSON.parse(lines[i]);
          const entryLevel = String(parsed.level ?? 'info').toUpperCase();
          if (level && level !== 'ALL' && entryLevel !== level.toUpperCase()) {
            continue;
          }

          let message = '';
          if (typeof parsed.data === 'string') {
            message = parsed.data;
          } else if (parsed.data && typeof parsed.data.message === 'string') {
            message = parsed.data.message;
          } else if (parsed.data !== undefined) {
            message = JSON.stringify(parsed.data);
          } else {
            message = parsed.event || '';
          }

          let timeStr = '';
          if (parsed.time) {
            try {
              const d = new Date(parsed.time);
              const pad = (n: number) => String(n).padStart(2, '0');
              const padMs = (n: number) => String(n).padStart(3, '0');
              timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${padMs(d.getMilliseconds())}`;
            } catch {
              timeStr = String(parsed.time);
            }
          }

          entries.push({
            time: timeStr,
            level: entryLevel,
            event: parsed.event ?? '',
            message,
            data: parsed.data,
          });
        } catch {
          // 忽略损坏的单行
        }
      }
    } catch {
      // 忽略无法读取的文件
    }
  }

  // 恢复按时间正序排列展示
  entries.reverse();
  return { entries, directory };
}
