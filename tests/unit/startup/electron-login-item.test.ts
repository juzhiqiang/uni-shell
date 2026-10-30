import { describe, expect, it, vi } from 'vitest';

import { createElectronLoginItemPort } from '../../../src/main/startup/electron-login-item';
import { LOGIN_LAUNCH_FLAG } from '../../../src/main/instance/single-instance';

describe('electron-login-item', () => {
  describe('Windows / macOS 平台', () => {
    it('win32: apply 调用 app.setLoginItemSettings 并附带启动标记', async () => {
      const setLoginItemSettings = vi.fn();
      const getLoginItemSettings = vi.fn(() => ({ openAtLogin: false }));

      const port = createElectronLoginItemPort({
        platform: 'win32',
        app: { setLoginItemSettings, getLoginItemSettings },
      });

      expect(port.platform).toBe('win32');

      const result = await port.apply(true);
      expect(result).toEqual({ ok: true, location: 'app.setLoginItemSettings' });
      expect(setLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: true,
        args: [LOGIN_LAUNCH_FLAG],
      });
    });

    it('darwin: apply(false) 传入空 args', async () => {
      const setLoginItemSettings = vi.fn();
      const getLoginItemSettings = vi.fn(() => ({ openAtLogin: true }));

      const port = createElectronLoginItemPort({
        platform: 'darwin',
        app: { setLoginItemSettings, getLoginItemSettings },
      });

      const result = await port.apply(false);
      expect(result).toEqual({ ok: true, location: 'app.setLoginItemSettings' });
      expect(setLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: false,
        args: [],
      });
    });

    it('win32 / darwin: query 读取 app.getLoginItemSettings().openAtLogin', async () => {
      const getLoginItemSettings = vi.fn(() => ({ openAtLogin: true }));

      const port = createElectronLoginItemPort({
        platform: 'win32',
        app: { setLoginItemSettings: vi.fn(), getLoginItemSettings },
      });

      const queryResult = await port.query();
      expect(queryResult).toBe(true);
      expect(getLoginItemSettings).toHaveBeenCalled();
    });
  });

  describe('Linux 平台', () => {
    it('linux: 分派给 applyLinux 与 queryLinux', async () => {
      const applyLinux = vi.fn(async () => ({
        ok: true,
        location: '/home/tester/.config/autostart/uni-shell.desktop',
      }));
      const queryLinux = vi.fn(() => true);

      const port = createElectronLoginItemPort({
        platform: 'linux',
        applyLinux,
        queryLinux,
      });

      expect(port.platform).toBe('linux');

      const applyResult = await port.apply(true);
      expect(applyResult.ok).toBe(true);
      expect(applyLinux).toHaveBeenCalledWith(true);

      const queryResult = await port.query();
      expect(queryResult).toBe(true);
      expect(queryLinux).toHaveBeenCalled();
    });
  });
});
