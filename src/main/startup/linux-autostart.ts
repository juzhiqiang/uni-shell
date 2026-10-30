import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { LOGIN_LAUNCH_FLAG } from '../instance/single-instance';

const { join } = posix;

export interface LinuxAutostartFileSystem {
  mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  rm: (path: string, options: { force: boolean }) => Promise<unknown>;
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<unknown>;
  existsSync: (path: string) => boolean;
}

export interface BuildLinuxAutostartOptions {
  appImage?: string;
  execPath?: string;
  launchFlag?: string;
}

export interface LinuxAutostartOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  execPath?: string;
  fs?: LinuxAutostartFileSystem;
}

export function getLinuxAutostartFilePath(homeDir: string = homedir()): string {
  return join(homeDir, '.config', 'autostart', 'uni-shell.desktop');
}

/** Linux XDG autostart 条目内容。 */
export function buildLinuxAutostartEntry(options: BuildLinuxAutostartOptions = {}): string {
  const executable = options.appImage?.trim() || options.execPath || process.execPath;
  const flag = options.launchFlag ?? LOGIN_LAUNCH_FLAG;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=UniShell',
    `Exec="${executable}" ${flag}`,
    'X-GNOME-Autostart-enabled=true',
    'Terminal=false',
    '',
  ].join('\n');
}

/** Linux：写入或删除 `~/.config/autostart/uni-shell.desktop`。 */
export async function applyLinuxAutostart(
  enabled: boolean,
  options: LinuxAutostartOptions = {},
): Promise<{ ok: boolean; location?: string; reason?: string }> {
  const home = options.homeDir ?? homedir();
  const file = getLinuxAutostartFilePath(home);
  const directory = join(home, '.config', 'autostart');
  const fsImpl = options.fs ?? { mkdir, rm, writeFile, existsSync };

  try {
    if (!enabled) {
      await fsImpl.rm(file, { force: true });
      return { ok: true, location: file };
    }
    await fsImpl.mkdir(directory, { recursive: true });
    const content = buildLinuxAutostartEntry({
      appImage: options.env?.APPIMAGE ?? process.env.APPIMAGE,
      execPath: options.execPath ?? process.execPath,
    });
    await fsImpl.writeFile(file, content, 'utf8');
    return { ok: true, location: file };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `写入 XDG autostart 失败：${detail}` };
  }
}

export function queryLinuxAutostart(options: LinuxAutostartOptions = {}): boolean {
  const home = options.homeDir ?? homedir();
  const file = getLinuxAutostartFilePath(home);
  const exists = options.fs?.existsSync ?? existsSync;
  return exists(file);
}
