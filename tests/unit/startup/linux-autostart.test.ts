import { describe, expect, it, vi } from 'vitest';

import {
  applyLinuxAutostart,
  buildLinuxAutostartEntry,
  getLinuxAutostartFilePath,
  queryLinuxAutostart,
  type LinuxAutostartFileSystem,
} from '../../../src/main/startup/linux-autostart';
import { LOGIN_LAUNCH_FLAG } from '../../../src/main/instance/single-instance';

describe('linux-autostart', () => {
  const homeDir = '/home/testuser';
  const expectedDesktopPath = '/home/testuser/.config/autostart/uni-shell.desktop';

  describe('getLinuxAutostartFilePath', () => {
    it('返回指定 home 目录下的 autostart desktop 文件路径', () => {
      expect(getLinuxAutostartFilePath(homeDir)).toBe(expectedDesktopPath);
    });
  });

  describe('buildLinuxAutostartEntry', () => {
    it('优先使用 APPIMAGE 环境变量作为 Exec 可执行路径', () => {
      const entry = buildLinuxAutostartEntry({
        appImage: '/home/testuser/Applications/UniShell.AppImage',
        execPath: '/tmp/.mount_123/usr/bin/unishell',
      });

      expect(entry).toContain(`Exec="/home/testuser/Applications/UniShell.AppImage" ${LOGIN_LAUNCH_FLAG}`);
      expect(entry).toContain('[Desktop Entry]');
      expect(entry).toContain('X-GNOME-Autostart-enabled=true');
      expect(entry).toContain('Terminal=false');
    });

    it('无 APPIMAGE 时回退到 execPath', () => {
      const entry = buildLinuxAutostartEntry({
        execPath: '/usr/bin/unishell',
      });

      expect(entry).toContain(`Exec="/usr/bin/unishell" ${LOGIN_LAUNCH_FLAG}`);
    });
  });

  describe('queryLinuxAutostart', () => {
    it('文件存在时返回 true', () => {
      const mockFs: LinuxAutostartFileSystem = {
        existsSync: vi.fn((path) => path === expectedDesktopPath),
        mkdir: vi.fn(),
        rm: vi.fn(),
        writeFile: vi.fn(),
      };

      const result = queryLinuxAutostart({ homeDir, fs: mockFs });
      expect(result).toBe(true);
      expect(mockFs.existsSync).toHaveBeenCalledWith(expectedDesktopPath);
    });

    it('文件不存在时返回 false', () => {
      const mockFs: LinuxAutostartFileSystem = {
        existsSync: vi.fn(() => false),
        mkdir: vi.fn(),
        rm: vi.fn(),
        writeFile: vi.fn(),
      };

      const result = queryLinuxAutostart({ homeDir, fs: mockFs });
      expect(result).toBe(false);
    });
  });

  describe('applyLinuxAutostart', () => {
    it('enabled 为 true 时创建目录并写入 desktop 文件', async () => {
      let writtenFile = '';
      let writtenContent = '';
      let createdDir = '';

      const mockFs: LinuxAutostartFileSystem = {
        existsSync: () => true,
        mkdir: vi.fn(async (dir) => {
          createdDir = dir;
        }),
        rm: vi.fn(),
        writeFile: vi.fn(async (file, data) => {
          writtenFile = file;
          writtenContent = data;
        }),
      };

      const result = await applyLinuxAutostart(true, {
        homeDir,
        env: { APPIMAGE: '/opt/UniShell.AppImage' },
        fs: mockFs,
      });

      expect(result).toEqual({ ok: true, location: expectedDesktopPath });
      expect(createdDir).toBe('/home/testuser/.config/autostart');
      expect(writtenFile).toBe(expectedDesktopPath);
      expect(writtenContent).toContain(`Exec="/opt/UniShell.AppImage" ${LOGIN_LAUNCH_FLAG}`);
    });

    it('enabled 为 false 时删除 desktop 文件', async () => {
      let removedFile = '';
      const mockFs: LinuxAutostartFileSystem = {
        existsSync: () => true,
        mkdir: vi.fn(),
        rm: vi.fn(async (file) => {
          removedFile = file;
        }),
        writeFile: vi.fn(),
      };

      const result = await applyLinuxAutostart(false, {
        homeDir,
        fs: mockFs,
      });

      expect(result).toEqual({ ok: true, location: expectedDesktopPath });
      expect(removedFile).toBe(expectedDesktopPath);
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('写入失败时返回明确错误原因', async () => {
      const mockFs: LinuxAutostartFileSystem = {
        existsSync: () => false,
        mkdir: vi.fn(),
        rm: vi.fn(),
        writeFile: vi.fn(async () => {
          throw new Error('EACCES: permission denied');
        }),
      };

      const result = await applyLinuxAutostart(true, {
        homeDir,
        fs: mockFs,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('写入 XDG autostart 失败：EACCES: permission denied');
    });
  });
});
