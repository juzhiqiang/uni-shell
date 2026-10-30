import { app } from 'electron';
import { LOGIN_LAUNCH_FLAG } from '../instance/single-instance';
import type { LoginItemPort } from './startup-manager';
import { applyLinuxAutostart, queryLinuxAutostart } from './linux-autostart';

export interface ElectronAppLoginItemAdapter {
  setLoginItemSettings: (settings: { openAtLogin: boolean; args: string[] }) => void;
  getLoginItemSettings: () => { openAtLogin: boolean };
}

export interface CreateElectronLoginItemPortOptions {
  platform?: LoginItemPort['platform'];
  app?: ElectronAppLoginItemAdapter;
  applyLinux?: (enabled: boolean) => Promise<{ ok: boolean; location?: string; reason?: string }>;
  queryLinux?: () => boolean;
}

/**
 * 登录项端口。
 * 规格 §9：Windows 当前用户启动项、macOS 登录项/LaunchAgent、Linux XDG autostart。
 * Electron 的 `setLoginItemSettings` 覆盖 Windows 与 macOS；Linux 需自行写 .desktop。
 */
export function createElectronLoginItemPort(
  options: CreateElectronLoginItemPortOptions = {},
): LoginItemPort {
  const platform = options.platform ?? (process.platform as LoginItemPort['platform']);
  const appAdapter = options.app ?? app;
  const applyLinux = options.applyLinux ?? applyLinuxAutostart;
  const queryLinux = options.queryLinux ?? queryLinuxAutostart;

  return {
    platform,
    async apply(enabled) {
      if (platform === 'linux') {
        return applyLinux(enabled);
      }

      appAdapter.setLoginItemSettings({
        openAtLogin: enabled,
        // 登录启动必须带上标记，供 detectLaunchContext 识别来源。
        args: enabled ? [LOGIN_LAUNCH_FLAG] : [],
      });

      return { ok: true, location: 'app.setLoginItemSettings' };
    },
    async query() {
      if (platform === 'linux') {
        return queryLinux();
      }
      return appAdapter.getLoginItemSettings().openAtLogin;
    },
  };
}
